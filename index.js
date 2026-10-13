import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { fileSignatureMatches, objectFilename, parseRange, planMultipart, sanitizeFilename, MAX_R2_OBJECT_BYTES } from "./validation.js";

const FIREBASE_KEYS = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
const SIGNED_URL_SECONDS = 900;
const INCOMPLETE_TTL_MS = 24 * 60 * 60 * 1000;
const ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FILE_TYPES = Object.freeze({
  mp4: { type: "video", contentType: "video/mp4" },
  mp3: { type: "audio", contentType: "audio/mpeg" },
  wav: { type: "audio", contentType: "audio/wav" },
  jpg: { type: "image", contentType: "image/jpeg" },
  jpeg: { type: "image", contentType: "image/jpeg" },
  png: { type: "image", contentType: "image/png" },
  webp: { type: "image", contentType: "image/webp" },
  pdf: { type: "pdf", contentType: "application/pdf" }
});
const STAGE_IDS = new Set(["kg", "primary-1-2", "primary-3-4", "primary-5-6", "preparatory-secondary", "deacons-choir"]);
const SUBJECT_IDS = new Set(["coptic-hymns", "orthodox-rites"]);
const TERM_IDS = new Set(["term-1", "term-2"]);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function originSet(env) {
  return new Set(String(env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function corsHeaders(request, env) {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, HEAD, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff"
  });
  const origin = request.headers.get("Origin");
  if (origin && originSet(env).has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function json(request, env, data, status = 200, additionalHeaders = {}) {
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(additionalHeaders)) headers.set(key, value);
  return new Response(JSON.stringify(data), { status, headers });
}

function assertOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (origin && !originSet(env).has(origin)) throw new HttpError(403, "Origin is not allowed.");
}

function s3(env) {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
    throw new HttpError(503, "Storage service is not configured.");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }
  });
}

function bucket(env) { return env.R2_BUCKET_NAME; }

async function authorize(request, env) {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+([A-Za-z0-9._~-]+)$/.exec(header);
  if (!match) throw new HttpError(401, "Sign in with an administrator account.");
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new HttpError(503, "Firebase token verification is not configured.");
  try {
    const { payload } = await jwtVerify(match[1], FIREBASE_KEYS, {
      algorithms: ["RS256"], issuer: `https://securetoken.google.com/${projectId}`, audience: projectId
    });
    if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 128
      || !Number.isInteger(payload.auth_time) || payload.auth_time > Math.floor(Date.now() / 1000)
      || !Number.isInteger(payload.iat) || payload.iat > Math.floor(Date.now() / 1000)
      || payload.admin !== true) {
      throw new HttpError(403, "This Firebase account does not have the administrator claim.");
    }
    return { uid: payload.sub };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "The Firebase ID token is invalid or expired. Sign in again.");
  }
}

async function rateLimit(env, uid) {
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  await env.DB.prepare(`INSERT INTO api_rate_limits (uid, window_start, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(uid) DO UPDATE SET
        request_count = CASE WHEN window_start = excluded.window_start THEN request_count + 1 ELSE 1 END,
        window_start = excluded.window_start`).bind(uid, now).run();
  const row = await env.DB.prepare("SELECT request_count FROM api_rate_limits WHERE uid = ?").bind(uid).first();
  if (Number(row?.request_count || 0) > 600) throw new HttpError(429, "Too many requests. Wait a minute and try again.");
}

async function requestJson(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 64 * 1024) throw new HttpError(413, "Request data is too large.");
  try { return await request.json(); }
  catch { throw new HttpError(400, "Request must contain valid JSON."); }
}

function validateLessonId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new HttpError(400, "Invalid lesson identifier.");
  return value;
}

function checkFile(fileName, contentType, sizeBytes, env) {
  const extension = fileName.split(".").pop().toLowerCase();
  const definition = FILE_TYPES[extension];
  if (!definition) throw new HttpError(415, "This file type is not supported.");
  const normalizedType = String(contentType || "").split(";")[0].trim().toLowerCase();
  const aliases = definition.contentType === "audio/wav" ? ["audio/wav", "audio/x-wav"] : [definition.contentType];
  if (!aliases.includes(normalizedType)) throw new HttpError(415, "File type does not match its extension.");
  const configured = Number(env.MAX_UPLOAD_BYTES || MAX_R2_OBJECT_BYTES);
  const maximum = Number.isSafeInteger(configured) && configured > 0 ? Math.min(MAX_R2_OBJECT_BYTES, configured) : MAX_R2_OBJECT_BYTES;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maximum) {
    throw new HttpError(413, `File size must be between 1 byte and ${maximum} bytes.`);
  }
  return { ...definition, extension, maxBytes: maximum };
}

function getSession(env, sessionId) {
  return env.DB.prepare("SELECT * FROM upload_sessions WHERE session_id = ?").bind(sessionId).first();
}

function assertOwner(row, uid) {
  if (!row) throw new HttpError(404, "Upload session not found.");
  if (row.uid !== uid) throw new HttpError(403, "This upload session belongs to another account.");
}

async function listAllParts(client, uploadId, key, env) {
  const result = [];
  let marker;
  do {
    const page = await client.send(new ListPartsCommand({
      Bucket: bucket(env), Key: key, UploadId: uploadId, PartNumberMarker: marker, MaxParts: 1000
    }));
    result.push(...(page.Parts || []));
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    if (page.IsTruncated && marker === undefined) throw new HttpError(502, "Could not list all uploaded parts.");
  } while (marker !== undefined);
  return result.sort((a, b) => a.PartNumber - b.PartNumber);
}

async function verifyObject(client, row, env) {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket(env), Key: row.object_key }));
  if (Number(head.ContentLength) !== Number(row.size_bytes)) throw new HttpError(400, "Uploaded object size does not match the requested file size.");
  const range = await client.send(new GetObjectCommand({ Bucket: bucket(env), Key: row.object_key, Range: "bytes=0-31" }));
  if (!range.Body) throw new HttpError(400, "Could not inspect the uploaded file.");
  const prefix = new Uint8Array(await new Response(range.Body).arrayBuffer());
  const definition = { extension: row.extension };
  if (!fileSignatureMatches(definition.extension, prefix)) throw new HttpError(415, "File contents do not match the supported file type.");
}

async function handleInitiate(request, env, user) {
  const body = await requestJson(request);
  let fileName;
  try { fileName = sanitizeFilename(body.fileName); }
  catch (error) { throw new HttpError(400, error.message); }
  const lessonId = validateLessonId(body.lessonId);
  const stageId = String(body.stageId || "");
  const subjectId = String(body.subjectId || "");
  const termId = String(body.termId || "");
  if (!STAGE_IDS.has(stageId) || !SUBJECT_IDS.has(subjectId) || !TERM_IDS.has(termId)) {
    throw new HttpError(400, "Choose a valid school stage, subject, and term.");
  }
  const sizeBytes = Number(body.sizeBytes);
  const definition = checkFile(fileName, body.contentType, sizeBytes, env);
  let plan;
  try { plan = planMultipart(sizeBytes); }
  catch (error) { throw new HttpError(413, error.message); }
  const warningThreshold = Number(env.STORAGE_WARNING_BYTES || 0);
  const usage = await env.DB.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes FROM upload_sessions WHERE status = 'complete'").first();
  const estimatedBytesAfterUpload = Number(usage?.total_bytes || 0) + sizeBytes;
  const storageWarning = Number.isSafeInteger(warningThreshold) && warningThreshold > 0 && estimatedBytesAfterUpload >= warningThreshold;
  const sessionId = crypto.randomUUID();
  const key = `media/${lessonId}/${sessionId}-${objectFilename(fileName)}`;
  const client = s3(env);
  const created = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket(env), Key: key, ContentType: definition.contentType,
    ContentDisposition: `inline; filename="${objectFilename(fileName)}"`,
    CacheControl: "public, max-age=300"
  }));
  if (!created.UploadId) throw new HttpError(502, "Storage did not return an upload session.");
  try {
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO upload_sessions (
      session_id, upload_id, object_key, uid, lesson_id, stage_id, subject_id, term_id,
      title_ar, title_en, file_name, extension, type, content_type, size_bytes,
      part_size_bytes, part_count, status, linked, is_published, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', 0, 0, ?, ?)`)
      .bind(sessionId, created.UploadId, key, user.uid, lessonId, stageId, subjectId, termId,
        String(body.titleAr || "").slice(0, 160), String(body.titleEn || "").slice(0, 160), fileName,
        definition.extension, definition.type, definition.contentType, sizeBytes,
        plan.partSizeBytes, plan.partCount, now, now).run();
  } catch (error) {
    await client.send(new AbortMultipartUploadCommand({ Bucket: bucket(env), Key: key, UploadId: created.UploadId })).catch(() => {});
    throw error;
  }
  return json(request, env, {
    sessionId, objectKey: key, partSizeBytes: plan.partSizeBytes, partCount: plan.partCount,
    expiresInSeconds: SIGNED_URL_SECONDS, storageWarning, estimatedBytesAfterUpload
  }, 201);
}

async function handleUploadStatus(request, env, user, sessionId) {
  const row = await getSession(env, sessionId);
  assertOwner(row, user.uid);
  if (row.status !== "uploading") return json(request, env, {
    sessionId, objectKey: row.object_key, status: row.status,
    partSizeBytes: Number(row.part_size_bytes), partCount: Number(row.part_count),
    fileName: row.file_name, sizeBytes: Number(row.size_bytes), linked: Boolean(row.linked)
  });
  const parts = await listAllParts(s3(env), row.upload_id, row.object_key, env);
  return json(request, env, {
    sessionId, objectKey: row.object_key, status: row.status,
    partSizeBytes: Number(row.part_size_bytes), partCount: Number(row.part_count),
    uploadedParts: parts.map((part) => Number(part.PartNumber)), sizeBytes: Number(row.size_bytes)
  });
}

async function handlePartUrl(request, env, user, sessionId) {
  const row = await getSession(env, sessionId);
  assertOwner(row, user.uid);
  if (row.status !== "uploading") throw new HttpError(409, "This upload is no longer active.");
  const { partNumber } = await requestJson(request);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > Number(row.part_count)) throw new HttpError(400, "Invalid multipart part number.");
  const command = new UploadPartCommand({ Bucket: bucket(env), Key: row.object_key, UploadId: row.upload_id, PartNumber: partNumber });
  const url = await getSignedUrl(s3(env), command, { expiresIn: SIGNED_URL_SECONDS });
  return json(request, env, { url, partNumber, expiresInSeconds: SIGNED_URL_SECONDS });
}

async function handleComplete(request, env, user, sessionId) {
  const row = await getSession(env, sessionId);
  assertOwner(row, user.uid);
  if (row.status === "complete") return json(request, env, { sessionId, objectKey: row.object_key, status: "complete" });
  if (row.status !== "uploading") throw new HttpError(409, "This upload cannot be completed.");
  const client = s3(env);
  const parts = await listAllParts(client, row.upload_id, row.object_key, env);
  const expectedCount = Number(row.part_count);
  if (parts.length !== expectedCount) throw new HttpError(409, `Upload is missing parts (${parts.length} of ${expectedCount}).`);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const partNumber = index + 1;
    const expectedSize = Math.min(Number(row.part_size_bytes), Number(row.size_bytes) - (partNumber - 1) * Number(row.part_size_bytes));
    if (Number(part.PartNumber) !== partNumber || Number(part.Size) !== expectedSize || typeof part.ETag !== "string") {
      throw new HttpError(409, "Uploaded parts do not match this file. Retry the missing parts.");
    }
  }
  await client.send(new CompleteMultipartUploadCommand({
    Bucket: bucket(env), Key: row.object_key, UploadId: row.upload_id,
    MultipartUpload: { Parts: parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })) }
  }));
  try {
    await verifyObject(client, row, env);
  } catch (error) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket(env), Key: row.object_key })).catch(() => {});
    await env.DB.prepare("UPDATE upload_sessions SET status = 'rejected', updated_at = ? WHERE session_id = ?").bind(Date.now(), sessionId).run();
    throw error;
  }
  await env.DB.prepare("UPDATE upload_sessions SET status = 'complete', upload_id = NULL, updated_at = ? WHERE session_id = ?").bind(Date.now(), sessionId).run();
  return json(request, env, { sessionId, objectKey: row.object_key, status: "complete" });
}

async function handleAbort(request, env, user, sessionId) {
  const row = await getSession(env, sessionId);
  assertOwner(row, user.uid);
  if (row.status === "uploading") {
    await s3(env).send(new AbortMultipartUploadCommand({ Bucket: bucket(env), Key: row.object_key, UploadId: row.upload_id })).catch(() => {});
    await env.DB.prepare("UPDATE upload_sessions SET status = 'aborted', updated_at = ? WHERE session_id = ?").bind(Date.now(), sessionId).run();
  }
  return json(request, env, { sessionId, status: row.status === "uploading" ? "aborted" : row.status });
}

async function handleConfirm(request, env, user, sessionId) {
  const row = await getSession(env, sessionId);
  assertOwner(row, user.uid);
  if (row.status !== "complete") throw new HttpError(409, "Complete the upload before linking it to the lesson.");
  await env.DB.prepare("UPDATE upload_sessions SET linked = 1, updated_at = ? WHERE session_id = ?").bind(Date.now(), sessionId).run();
  return json(request, env, { sessionId, linked: true });
}

async function handleRecover(request, env, user) {
  const result = await env.DB.prepare(`SELECT session_id, object_key, lesson_id, stage_id, subject_id, term_id,
      file_name, type, content_type, size_bytes, created_at, uid
    FROM upload_sessions WHERE uid = ? AND status = 'complete' AND linked = 0 ORDER BY created_at DESC LIMIT 100`).bind(user.uid).all();
  return json(request, env, { items: (result.results || []).map((row) => ({
    sessionId: row.session_id, objectKey: row.object_key, lessonId: row.lesson_id, stageId: row.stage_id,
    subjectId: row.subject_id, termId: row.term_id, fileName: row.file_name, type: row.type,
    contentType: row.content_type, sizeBytes: Number(row.size_bytes), createdAt: Number(row.created_at), uid: row.uid
  })) });
}

async function handlePreview(request, env, user, url) {
  const key = url.searchParams.get("key") || "";
  const row = await env.DB.prepare("SELECT * FROM upload_sessions WHERE object_key = ? AND status = 'complete'").bind(key).first();
  if (!row) throw new HttpError(404, "Media object not found.");
  const command = new GetObjectCommand({ Bucket: bucket(env), Key: row.object_key, ResponseContentDisposition: "inline" });
  const signedUrl = await getSignedUrl(s3(env), command, { expiresIn: 300 });
  return json(request, env, { url: signedUrl, expiresInSeconds: 300, fileName: row.file_name });
}

async function handleDeleteObject(request, env, user, url) {
  const key = url.searchParams.get("key") || "";
  if (!key.startsWith("media/") || key.length > 1024) throw new HttpError(400, "Invalid media key.");
  const row = await env.DB.prepare("SELECT * FROM upload_sessions WHERE object_key = ? AND status IN ('complete', 'deleting', 'deleted')").bind(key).first();
  if (!row) throw new HttpError(404, "Media object not found.");
  if (row.status !== "deleted") {
    await env.DB.prepare("UPDATE upload_sessions SET status = 'deleting', is_published = 0, updated_at = ? WHERE session_id = ?").bind(Date.now(), row.session_id).run();
    await s3(env).send(new DeleteObjectCommand({ Bucket: bucket(env), Key: row.object_key }));
    await env.DB.prepare("UPDATE upload_sessions SET status = 'deleted', is_published = 0, updated_at = ? WHERE session_id = ?").bind(Date.now(), row.session_id).run();
  }
  return json(request, env, { deleted: true, objectKey: key });
}

async function handleLessonVisibility(request, env, user, lessonId) {
  validateLessonId(lessonId);
  const body = await requestJson(request);
  if (typeof body.isPublished !== "boolean") throw new HttpError(400, "isPublished must be a boolean.");
  if (!body.isPublished) {
    await env.DB.prepare("UPDATE upload_sessions SET is_published = 0, updated_at = ? WHERE lesson_id = ? AND status = 'complete'").bind(Date.now(), lessonId).run();
    return json(request, env, { lessonId, isPublished: false });
  }
  if (!Array.isArray(body.objectKeys) || body.objectKeys.length > 100 || body.objectKeys.some((key) => typeof key !== "string")) {
    throw new HttpError(400, "Provide the lesson's media keys to publish.");
  }
  const keys = [...new Set(body.objectKeys)];
  const verified = [];
  for (const key of keys) {
    const row = await env.DB.prepare(`SELECT session_id FROM upload_sessions
      WHERE lesson_id = ? AND object_key = ? AND status = 'complete' AND linked = 1`).bind(lessonId, key).first();
    if (!row) throw new HttpError(409, "A lesson resource has not finished uploading or linking.");
    verified.push(row.session_id);
  }
  await env.DB.prepare("UPDATE upload_sessions SET is_published = 0, updated_at = ? WHERE lesson_id = ? AND status = 'complete'").bind(Date.now(), lessonId).run();
  for (const sessionId of verified) {
    await env.DB.prepare("UPDATE upload_sessions SET is_published = 1, updated_at = ? WHERE session_id = ?").bind(Date.now(), sessionId).run();
  }
  return json(request, env, { lessonId, isPublished: true, resourceCount: verified.length });
}

async function handleMedia(request, env, url) {
  const key = url.searchParams.get("key") || "";
  if (!key.startsWith("media/") || key.length > 1024) return json(request, env, { error: "Media not found." }, 404);
  const row = await env.DB.prepare(`SELECT object_key, file_name, content_type, size_bytes FROM upload_sessions
    WHERE object_key = ? AND status = 'complete' AND linked = 1 AND is_published = 1`).bind(key).first();
  if (!row) return json(request, env, { error: "Media not found." }, 404);
  const size = Number(row.size_bytes);
  const range = parseRange(request.headers.get("Range"), size);
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", row.content_type);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  headers.set("Content-Disposition", `inline; filename="${objectFilename(row.file_name)}"`);
  headers.set("X-Content-Type-Options", "nosniff");
  if (range?.invalid) {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (request.method === "HEAD") {
    if (range) {
      headers.set("Content-Length", String(range.end - range.start + 1));
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      return new Response(null, { status: 206, headers });
    }
    headers.set("Content-Length", String(size));
    return new Response(null, { status: 200, headers });
  }
  const object = await env.MEDIA.get(row.object_key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : {});
  if (!object) return json(request, env, { error: "Media not found." }, 404);
  headers.set("Content-Length", String(range ? range.end - range.start + 1 : size));
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    assertOrigin(request, env);
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  if ((url.pathname === "/media" || url.pathname === "/media/") && ["GET", "HEAD"].includes(request.method)) return handleMedia(request, env, url);
  if (url.pathname === "/health" && request.method === "GET") return json(request, env, { ok: true, service: "archangelos-media-worker" });
  if (!url.pathname.startsWith("/api/")) return json(request, env, { error: "Not found." }, 404);
  assertOrigin(request, env);
  const user = await authorize(request, env);
  await rateLimit(env, user.uid);

  if (url.pathname === "/api/uploads" && request.method === "POST") return handleInitiate(request, env, user);
  if (url.pathname === "/api/uploads/recover" && request.method === "GET") return handleRecover(request, env, user);
  if (url.pathname === "/api/objects/preview" && request.method === "GET") return handlePreview(request, env, user, url);
  if (url.pathname === "/api/objects" && request.method === "DELETE") return handleDeleteObject(request, env, user, url);

  const lessonMatch = /^\/api\/lessons\/([^/]+)\/visibility$/.exec(url.pathname);
  if (lessonMatch && request.method === "POST") return handleLessonVisibility(request, env, user, decodeURIComponent(lessonMatch[1]));
  const sessionMatch = /^\/api\/uploads\/([A-Za-z0-9-]+)(?:\/(part-url|complete|confirm))?$/.exec(url.pathname);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const action = sessionMatch[2] || "status";
    if (action === "status" && request.method === "GET") return handleUploadStatus(request, env, user, sessionId);
    if (action === "part-url" && request.method === "POST") return handlePartUrl(request, env, user, sessionId);
    if (action === "complete" && request.method === "POST") return handleComplete(request, env, user, sessionId);
    if (action === "confirm" && request.method === "POST") return handleConfirm(request, env, user, sessionId);
    if (action === "status" && request.method === "DELETE") return handleAbort(request, env, user, sessionId);
  }
  return json(request, env, { error: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (error) {
      if (error instanceof HttpError) return json(request, env, { error: error.message }, error.status);
      console.error("media-worker-request-failed", error?.name || "Error");
      return json(request, env, { error: "The media service could not complete this request. Try again." }, 500);
    }
  },

  async scheduled(controller, env, context) {
    context.waitUntil(cleanupExpired(env));
  }
};

async function cleanupExpired(env) {
  const now = Date.now();
  const incomplete = await env.DB.prepare(`SELECT session_id, upload_id, object_key FROM upload_sessions
    WHERE status = 'uploading' AND created_at < ? LIMIT 500`).bind(now - INCOMPLETE_TTL_MS).all();
  for (const row of incomplete.results || []) {
    try {
      await s3(env).send(new AbortMultipartUploadCommand({ Bucket: bucket(env), Key: row.object_key, UploadId: row.upload_id }));
    } catch { /* The upload may already have expired or been aborted. */ }
    await env.DB.prepare("UPDATE upload_sessions SET status = 'aborted', updated_at = ? WHERE session_id = ? AND status = 'uploading'").bind(now, row.session_id).run();
  }
  const orphans = await env.DB.prepare(`SELECT session_id, object_key FROM upload_sessions
    WHERE status = 'complete' AND linked = 0 AND created_at < ? LIMIT 200`).bind(now - ORPHAN_TTL_MS).all();
  for (const row of orphans.results || []) {
    try {
      await s3(env).send(new DeleteObjectCommand({ Bucket: bucket(env), Key: row.object_key }));
      await env.DB.prepare("UPDATE upload_sessions SET status = 'deleted', is_published = 0, updated_at = ? WHERE session_id = ? AND linked = 0").bind(now, row.session_id).run();
    } catch (error) { console.error("orphan-cleanup-failed", error?.name || "Error"); }
  }
}
