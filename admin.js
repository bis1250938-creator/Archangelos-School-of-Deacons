import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  Timestamp, collection, doc, getDoc, getDocs, query, runTransaction, setDoc, updateDoc, where
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { ALLOWED_FILE_TYPES, CURRICULUM, formatBytes, formatDate, labelFor } from "./constants.js";

const config = window.ARCHANGELOS_CONFIG;
const el = (selector) => document.querySelector(selector);
const state = {
  user: null, lessonId: null, lesson: null, uploads: [], aborting: false,
  activeRequests: new Set(), replacement: null, resumeCandidate: null,
  savedKey: "archangelos.r2.sessions.v1", toastTimer: null
};

function setMessage(node, message, kind = "") {
  node.textContent = message;
  node.className = `form-message${kind ? ` ${kind}` : ""}`;
}

function showToast(message, kind = "") {
  const toast = el("#toast");
  toast.textContent = message;
  toast.className = `toast show${kind ? ` ${kind}` : ""}`;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.className = "toast", 4200);
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function refreshPublishButton() {
  const button = el("#publishButton");
  const busy = state.uploads.some((job) => job.processing);
  const pendingResources = (state.lesson?.resources || []).some((resource) => resource.visibility !== "public");
  button.disabled = !state.lessonId || busy;
  button.textContent = state.lesson?.isPublished
    ? (pendingResources ? "نشر التغييرات" : "إلغاء نشر الدرس")
    : "نشر الدرس";
}

function fillSelect(select, values, firstLabel = null) {
  const options = values.map(({ id, ar }) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = ar;
    return option;
  });
  if (firstLabel) {
    const first = document.createElement("option");
    first.value = "__new__";
    first.textContent = firstLabel;
    options.unshift(first);
  }
  select.replaceChildren(...options);
}

fillSelect(el("#stageSelect"), CURRICULUM.stages);
fillSelect(el("#subjectSelect"), CURRICULUM.subjects);
fillSelect(el("#termSelect"), CURRICULUM.terms);

async function workerRequest(path, options = {}) {
  const base = config?.mediaWorkerUrl;
  if (!base || base.includes("REPLACE_WITH")) throw new Error("أكمل عنوان Cloudflare Worker في app-config.js أولاً.");
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(new URL(path, `${base.replace(/\/$/, "")}/`), { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `تعذر إكمال الطلب (${response.status}).`);
  return payload;
}

function sessionList() {
  try { return JSON.parse(localStorage.getItem(state.savedKey) || "[]"); }
  catch { return []; }
}

function saveSession(session) {
  const all = sessionList().filter((item) => item.sessionId !== session.sessionId);
  all.unshift(session);
  localStorage.setItem(state.savedKey, JSON.stringify(all.slice(0, 30)));
  renderSavedSessions();
}

function removeSession(sessionId) {
  localStorage.setItem(state.savedKey, JSON.stringify(sessionList().filter((item) => item.sessionId !== sessionId)));
  renderSavedSessions();
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)} ث`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.ceil(seconds % 60);
  return `${minutes} د ${remainder} ث`;
}

function renderUploadItem(job) {
  const card = make("article", "upload-item");
  const top = make("div", "upload-item-top");
  const name = make("span", "upload-item-name", job.file.name);
  name.title = job.file.name;
  const status = make("span", "upload-item-status", job.statusText || "في قائمة الرفع");
  status.dataset.status = "true";
  const progress = document.createElement("progress");
  progress.max = job.file.size || 1;
  progress.value = job.bytesDone || 0;
  progress.dataset.progress = "true";
  const bottom = make("div", "upload-item-foot");
  const quantity = make("span", "", `${formatBytes(job.bytesDone || 0)} / ${formatBytes(job.file.size)}`);
  quantity.dataset.quantity = "true";
  const estimate = make("span", "", job.speedText || "بانتظار البدء");
  estimate.dataset.estimate = "true";
  bottom.append(quantity, estimate);
  if (job.error) {
    const retry = make("button", "", "إعادة المحاولة");
    retry.type = "button";
    retry.addEventListener("click", () => uploadOne(job.file, job.resume, job.replaceTarget, job));
    bottom.append(retry);
  }
  top.append(name, status);
  card.append(top, progress, bottom);
  job.node = card;
  return card;
}

function renderJobProgress(job, statusText = job.statusText) {
  if (!job.node) return;
  job.statusText = statusText;
  job.node.querySelector('[data-status="true"]').textContent = statusText;
  job.node.querySelector('[data-progress="true"]').value = Math.min(job.file.size, job.bytesDone || 0);
  job.node.querySelector('[data-quantity="true"]').textContent = `${formatBytes(job.bytesDone || 0)} / ${formatBytes(job.file.size)}`;
  job.node.querySelector('[data-estimate="true"]').textContent = job.speedText || "جارٍ الرفع";
  const oldRetry = job.node.querySelector("button");
  if (job.error && !oldRetry) {
    const retry = make("button", "", "إعادة المحاولة");
    retry.type = "button";
    retry.addEventListener("click", () => uploadOne(job.file, job.resume, job.replaceTarget, job));
    job.node.querySelector(".upload-item-foot").append(retry);
  } else if (!job.error && oldRetry) oldRetry.remove();
}

function updateOverall() {
  const total = state.uploads.reduce((sum, job) => sum + job.file.size, 0);
  const done = state.uploads.reduce((sum, job) => sum + Math.min(job.bytesDone || 0, job.file.size), 0);
  const percent = total ? Math.floor(done / total * 100) : 0;
  el("#overallProgress").value = percent;
  el("#overallProgressLabel").textContent = `${percent}%`;
  el("#overallProgressWrap").classList.toggle("hidden", !state.uploads.length);
}

function updateJob(job, bytes, status) {
  job.bytesDone = Math.max(0, Math.min(bytes, job.file.size));
  const elapsed = Math.max((Date.now() - job.startedAt) / 1000, 0.2);
  const speed = job.bytesDone / elapsed;
  const remaining = speed > 0 ? (job.file.size - job.bytesDone) / speed : Infinity;
  job.speedText = speed > 0 ? `${formatBytes(speed)}/ث · متبقٍ ${formatDuration(remaining)}` : "جارٍ الرفع";
  renderJobProgress(job, status);
  updateOverall();
}

function extensionOf(name) { return name.split(".").pop()?.toLowerCase() || ""; }

async function validateFile(file) {
  const ext = extensionOf(file.name);
  const definition = ALLOWED_FILE_TYPES[ext];
  if (!definition) throw new Error("نوع الملف غير مسموح. اختر MP4 أو MP3 أو WAV أو صورة مدعومة أو PDF.");
  if (!file.size) throw new Error("الملف فارغ.");
  if (file.size > Number(config.maxUploadBytes || 0)) throw new Error(`حجم الملف يتجاوز الحد الحالي (${formatBytes(config.maxUploadBytes)}).`);
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = (from, to) => String.fromCharCode(...bytes.slice(from, to));
  let valid = false;
  switch (ext) {
    case "jpg": case "jpeg": valid = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff; break;
    case "png": valid = bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10"; break;
    case "webp": valid = ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP"; break;
    case "pdf": valid = ascii(0, 5) === "%PDF-"; break;
    case "wav": valid = ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE"; break;
    case "mp3": valid = ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0); break;
    case "mp4": valid = ascii(4, 8) === "ftyp"; break;
  }
  if (!valid) throw new Error("محتوى الملف لا يطابق امتداده. اختر ملفاً صحيحاً من النوع المسموح.");
  return { ...definition, extension: ext };
}

function safeClientFilename(name) {
  return name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 160) || "media-file";
}

async function fileFingerprint(file) {
  const edgeBytes = 64 * 1024;
  const first = new Uint8Array(await file.slice(0, edgeBytes).arrayBuffer());
  const last = new Uint8Array(await file.slice(Math.max(0, file.size - edgeBytes), file.size).arrayBuffer());
  const sample = new Uint8Array(first.length + last.length + 8);
  new DataView(sample.buffer).setBigUint64(0, BigInt(file.size), false);
  sample.set(first, 8);
  sample.set(last, 8 + first.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", sample));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function makeStoredSession(file, result, target) {
  return {
    sessionId: result.sessionId, fileName: safeClientFilename(file.name), sizeBytes: file.size,
    lastModified: file.lastModified, lessonId: state.lessonId, stageId: state.lesson.stageId,
    subjectId: state.lesson.subjectId, termId: state.lesson.termId, partSizeBytes: result.partSizeBytes,
    partCount: result.partCount, replaceResourceId: target?.resourceId || null,
    fingerprint: await fileFingerprint(file), createdAt: Date.now()
  };
}

function sameFile(file, session) {
  return safeClientFilename(file.name) === session.fileName && file.size === Number(session.sizeBytes)
    && file.lastModified === Number(session.lastModified);
}

function xhrUpload(url, blob, onProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("تم إلغاء الرفع."));
    const xhr = new XMLHttpRequest();
    state.activeRequests.add(xhr);
    xhr.open("PUT", url, true);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded); };
    xhr.onload = () => {
      state.activeRequests.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`تعذر رفع الجزء (${xhr.status}).`));
    };
    xhr.onerror = () => { state.activeRequests.delete(xhr); reject(new Error("انقطع الاتصال أثناء رفع أحد الأجزاء.")); };
    xhr.onabort = () => { state.activeRequests.delete(xhr); reject(new Error("تم إلغاء الرفع.")); };
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

async function withConcurrency(items, concurrency, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !state.aborting) {
      const current = items[next++];
      await task(current);
    }
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

async function uploadParts(file, session, job) {
  const status = await workerRequest(`/api/uploads/${encodeURIComponent(session.sessionId)}`);
  if (status.status === "complete") return;
  if (status.status !== "uploading") throw new Error("انتهت صلاحية جلسة الرفع أو تم إلغاؤها. ابدأ رفعاً جديداً.");
  const alreadyUploaded = new Set(status.uploadedParts || []);
  const partSize = Number(status.partSizeBytes || session.partSizeBytes || config.partSizeBytes);
  const count = Number(status.partCount || session.partCount || Math.ceil(file.size / partSize));
  const parts = Array.from({ length: count }, (_, i) => i + 1).filter((part) => !alreadyUploaded.has(part));
  let confirmedBytes = [...alreadyUploaded].reduce((sum, part) => sum + Math.min(partSize, file.size - (part - 1) * partSize), 0);
  let activeBytes = 0;
  updateJob(job, Math.min(file.size, confirmedBytes), parts.length ? "استكمال الأجزاء المتبقية" : "جميع الأجزاء جاهزة");
  const controller = new AbortController();
  job.controller = controller;
  await withConcurrency(parts, Number(config.uploadConcurrency || 3), async (partNumber) => {
    if (state.aborting) return;
    const start = (partNumber - 1) * partSize;
    const end = Math.min(start + partSize, file.size);
    const blob = file.slice(start, end);
    let sent = 0;
    let uploaded = false;
    for (let attempt = 0; attempt < 4 && !uploaded && !state.aborting; attempt += 1) {
      try {
        const grant = await workerRequest(`/api/uploads/${encodeURIComponent(session.sessionId)}/part-url`, {
          method: "POST", body: JSON.stringify({ partNumber })
        });
        activeBytes -= sent;
        sent = 0;
        const adjust = (loaded) => {
          activeBytes += loaded - sent;
          sent = loaded;
          updateJob(job, Math.min(file.size, confirmedBytes + activeBytes), `رفع الجزء ${partNumber} من ${count}`);
        };
        await xhrUpload(grant.url, blob, adjust, controller.signal);
        activeBytes += blob.size - sent;
        sent = blob.size;
        confirmedBytes += blob.size;
        activeBytes -= sent;
        sent = 0;
        uploaded = true;
        updateJob(job, Math.min(file.size, confirmedBytes + activeBytes), `تم رفع ${partNumber} من ${count} جزء`);
      } catch (error) {
        activeBytes -= sent;
        sent = 0;
        if (state.aborting || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 700 * 2 ** attempt));
      }
    }
  });
  if (state.aborting) throw new Error("تم إلغاء الرفع.");
  job.controller = null;
}

async function saveResourceMetadata(session, file, fileDefinition, replaceTarget) {
  const lessonRef = doc(db, "lessons", session.lessonId);
  const resource = {
    resourceId: session.sessionId,
    name: safeClientFilename(file.name),
    type: fileDefinition.type,
    objectKey: session.objectKey,
    contentType: fileDefinition.contentType,
    sizeBytes: file.size,
    originalFilename: safeClientFilename(file.name),
    createdAt: Timestamp.now(),
    uploadedBy: state.user.uid,
    visibility: "private"
  };
  let updatedResources = [];
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(lessonRef);
    if (!snapshot.exists()) throw new Error("لم يعد سجل الدرس موجوداً في Firestore.");
    const existing = Array.isArray(snapshot.data().resources) ? snapshot.data().resources : [];
    updatedResources = existing.filter((item) => item.resourceId !== resource.resourceId && item.resourceId !== replaceTarget?.resourceId);
    updatedResources.push(resource);
    transaction.update(lessonRef, { resources: updatedResources, updatedAt: Timestamp.now() });
  });
  state.lesson.resources = updatedResources;
  refreshPublishButton();
  await workerRequest(`/api/uploads/${encodeURIComponent(session.sessionId)}/confirm`, { method: "POST", body: "{}" });
  if (replaceTarget?.objectKey) {
    try {
      await workerRequest(`/api/objects?key=${encodeURIComponent(replaceTarget.objectKey)}`, { method: "DELETE" });
    } catch (error) {
      showToast(`تم استبدال الملف، لكن تعذر تنظيف النسخة السابقة: ${error.message}`, "error");
    }
  }
  state.lesson.resources = updatedResources;
  refreshPublishButton();
  return resource;
}

async function completeUpload(session, file, definition, job, replaceTarget) {
  job.statusText = "التحقق من الأجزاء وإتمام الملف";
  renderJobProgress(job);
  const complete = await workerRequest(`/api/uploads/${encodeURIComponent(session.sessionId)}/complete`, { method: "POST", body: "{}" });
  session.objectKey = complete.objectKey;
  session.completed = true;
  saveSession(session);
  try {
    await saveResourceMetadata(session, file, definition, replaceTarget);
    removeSession(session.sessionId);
    job.error = null;
    job.bytesDone = file.size;
    updateJob(job, file.size, "اكتمل الرفع وحُفظت بيانات الملف");
    await renderResourceList();
    showToast(`تم رفع ${file.name} وحفظه في الدرس.`, "success");
  } catch (error) {
    session.metadataPending = true;
    saveSession(session);
    job.error = true;
    job.resume = session;
    job.replaceTarget = replaceTarget;
    job.bytesDone = file.size;
    renderJobProgress(job, "اكتمل الملف؛ تعذر حفظ البيانات في Firestore");
    setMessage(el("#uploadMessage"), `الملف محفوظ في R2، لكن كتابة بياناته تعثرت: ${error.message} يمكنك إعادة المحاولة أو استخدام جلسة الاستعادة.`, "error");
  }
}

async function uploadOne(file, resume = null, replaceTarget = null, existingJob = null) {
  if (!state.lessonId || !state.lesson) {
    showToast("احفظ بيانات الدرس كمسودة قبل رفع الملفات.", "error");
    return;
  }
  if (existingJob) state.aborting = false;
  if (state.aborting) return;
  const job = existingJob || { file, bytesDone: 0, statusText: "في قائمة الرفع", startedAt: Date.now() };
  job.file = file;
  job.startedAt = Date.now();
  job.error = null;
  job.processing = true;
  job.resume = resume;
  job.replaceTarget = replaceTarget;
  if (!existingJob) {
    state.uploads.push(job);
    el("#uploadQueue").append(renderUploadItem(job));
  }
  refreshPublishButton();
  el("#cancelUploads").classList.remove("hidden");
  try {
    const definition = await validateFile(file);
    if (state.aborting) throw new Error("تم إلغاء الرفع.");
    let session = resume;
    if (session && !sameFile(file, session)) throw new Error("الملف المحدد لا يطابق جلسة الرفع المحفوظة.");
    if (session?.fingerprint && await fileFingerprint(file) !== session.fingerprint) throw new Error("محتوى الملف لا يطابق الجلسة المحفوظة.");
    if (session?.completed) {
      const status = await workerRequest(`/api/uploads/${encodeURIComponent(session.sessionId)}`);
      session.objectKey = status.objectKey;
      await saveResourceMetadata(session, file, definition, replaceTarget || (session.replaceResourceId ? state.lesson.resources?.find((item) => item.resourceId === session.replaceResourceId) : null));
      removeSession(session.sessionId);
      updateJob(job, file.size, "حُفظت بيانات الملف في الدرس");
      await renderResourceList();
      return;
    }
    if (!session) {
      const response = await workerRequest("/api/uploads", {
        method: "POST",
        body: JSON.stringify({
          fileName: safeClientFilename(file.name), contentType: definition.contentType, sizeBytes: file.size,
          stageId: state.lesson.stageId, subjectId: state.lesson.subjectId, termId: state.lesson.termId,
          lessonId: state.lessonId, titleAr: state.lesson.titleAr || "", titleEn: state.lesson.titleEn || ""
        })
      });
      if (response.storageWarning) showToast(`يقترب الحجم المسجل في التطبيق من الحد التحذيري (${formatBytes(response.estimatedBytesAfterUpload)}). راجع استخدام R2 في لوحة Cloudflare.`, "warning");
      session = await makeStoredSession(file, response, replaceTarget);
      saveSession(session);
    }
    job.resume = session;
    if (state.aborting) {
      await workerRequest(`/api/uploads/${encodeURIComponent(session.sessionId)}`, { method: "DELETE" });
      removeSession(session.sessionId);
      throw new Error("تم إلغاء الرفع.");
    }
    renderJobProgress(job, "جارٍ تجهيز الرفع الآمن");
    await uploadParts(file, session, job);
    job.controller = null;
    if (state.aborting) throw new Error("تم إلغاء الرفع.");
    el("#cancelUploads").classList.add("hidden");
    await completeUpload(session, file, definition, job, replaceTarget || (session.replaceResourceId ? state.lesson.resources?.find((item) => item.resourceId === session.replaceResourceId) : null));
  } catch (error) {
    job.error = !state.aborting;
    job.resume = resume || job.resume;
    renderJobProgress(job, state.aborting ? "تم إلغاء الرفع" : error.message);
    if (!state.aborting) setMessage(el("#uploadMessage"), error.message, "error");
  } finally {
    job.controller = null;
    job.processing = false;
    updateOverall();
    if (![...state.uploads].some((item) => item.controller)) el("#cancelUploads").classList.add("hidden");
    refreshPublishButton();
  }
}

async function startFiles(files, replaceTarget = null) {
  if (!files.length) return;
  state.aborting = false;
  for (const file of files) {
    if (state.aborting) break;
    await uploadOne(file, null, replaceTarget);
    replaceTarget = null;
  }
}

async function cancelUploads() {
  state.aborting = true;
  for (const xhr of state.activeRequests) xhr.abort();
  const active = state.uploads.filter((job) => job.controller && job.resume && !job.resume.completed);
  for (const job of active) job.controller.abort();
  const results = await Promise.allSettled(active.map((job) => workerRequest(`/api/uploads/${encodeURIComponent(job.resume.sessionId)}`, { method: "DELETE" })));
  results.forEach((result, index) => {
    if (result.status === "fulfilled") removeSession(active[index].resume.sessionId);
  });
  showToast(results.some((result) => result.status === "rejected")
    ? "أُوقف الرفع. تعذر تأكيد إلغاء بعض الجلسات؛ راجع جلسات الاستعادة."
    : "أُلغي الرفع وحُذفت الأجزاء المؤقتة. يمكنك بدء رفع جديد.");
}

function currentLessonData() {
  return {
    titleAr: el("#titleAr").value.trim(), titleEn: el("#titleEn").value.trim(),
    descriptionAr: el("#descriptionAr").value.trim(), descriptionEn: el("#descriptionEn").value.trim(),
    stageId: el("#stageSelect").value, subjectId: el("#subjectSelect").value, termId: el("#termSelect").value,
    order: Math.max(0, Number.parseInt(el("#orderInput").value, 10) || 0)
  };
}

function setFormFromLesson(lesson) {
  el("#titleAr").value = lesson?.titleAr || "";
  el("#titleEn").value = lesson?.titleEn || "";
  el("#descriptionAr").value = lesson?.descriptionAr || "";
  el("#descriptionEn").value = lesson?.descriptionEn || "";
  el("#orderInput").value = lesson?.order ?? 0;
}

async function loadLessonChoices(keepId = null) {
  const stageId = el("#stageSelect").value;
  const subjectId = el("#subjectSelect").value;
  const termId = el("#termSelect").value;
  const select = el("#lessonSelect");
  select.replaceChildren(new Option("＋ إنشاء درس جديد", "__new__"));
  try {
    const result = await getDocs(query(collection(db, "lessons"), where("stageId", "==", stageId), where("subjectId", "==", subjectId), where("termId", "==", termId)));
    const lessons = result.docs.map((snapshot) => ({ id: snapshot.id, ...snapshot.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const lesson of lessons) {
      const option = new Option(`${lesson.titleAr || lesson.titleEn || "درس"}${lesson.isPublished ? " · منشور" : " · مسودة"}`, lesson.id);
      select.add(option);
    }
    if (keepId && lessons.some((lesson) => lesson.id === keepId)) select.value = keepId;
  } catch (error) {
    console.warn("Could not load lesson choices", error.code || "request-failed");
    setMessage(el("#lessonMessage"), "تعذر تحميل قائمة الدروس. تحقق من Firestore rules وindexes.", "error");
  }
}

async function chooseLesson(lessonId) {
  if (lessonId === "__new__") {
    state.lessonId = null;
    state.lesson = null;
    setFormFromLesson(null);
    el("#resourceList").replaceChildren();
    refreshPublishButton();
    return;
  }
  const snapshot = await getDoc(doc(db, "lessons", lessonId));
  if (!snapshot.exists()) return;
  state.lessonId = lessonId;
  state.lesson = { id: lessonId, ...snapshot.data() };
  setFormFromLesson(state.lesson);
  refreshPublishButton();
  await renderResourceList();
}

async function saveLesson(event) {
  event.preventDefault();
  const data = currentLessonData();
  if (!data.titleAr) return setMessage(el("#lessonMessage"), "أدخل عنوان الدرس بالعربية.", "error");
  try {
    if (state.lessonId) {
      const reference = doc(db, "lessons", state.lessonId);
      await updateDoc(reference, { ...data, updatedAt: Timestamp.now() });
      state.lesson = { ...state.lesson, ...data, updatedAt: Timestamp.now() };
    } else {
      const reference = doc(collection(db, "lessons"));
      const now = Timestamp.now();
      state.lessonId = reference.id;
      state.lesson = {
        ...data, thumbnailKey: null, resources: [], isPublished: false, createdBy: state.user.uid,
        createdAt: now, updatedAt: now
      };
      await setDoc(reference, state.lesson);
      await loadLessonChoices(state.lessonId);
      el("#lessonSelect").value = state.lessonId;
    }
    refreshPublishButton();
    setMessage(el("#lessonMessage"), "حُفظت بيانات الدرس كمسودة. يمكنك إضافة الملفات الآن.", "success");
    showToast("حُفظت المسودة.", "success");
  } catch (error) {
    console.error("Saving lesson failed", error.code || "write-failed");
    setMessage(el("#lessonMessage"), `تعذر حفظ الدرس: ${error.message}`, "error");
  }
}

async function renderResourceList() {
  const list = el("#resourceList");
  list.replaceChildren();
  if (!state.lessonId) {
    list.append(make("p", "muted", "احفظ الدرس أولاً لإضافة الملفات."));
    return;
  }
  const resources = Array.isArray(state.lesson?.resources) ? state.lesson.resources : [];
  if (!resources.length) {
    list.append(make("p", "muted", "لا توجد ملفات مضافة لهذا الدرس بعد."));
    return;
  }
  for (const resource of resources) {
    const row = make("article", "resource-row");
    const meta = make("div");
    meta.append(make("strong", "", resource.name || resource.originalFilename || "ملف"));
    meta.append(make("small", "", `${resource.contentType} · ${formatBytes(resource.sizeBytes)} · ${formatDate(resource.createdAt)}`));
    const actions = make("div", "resource-actions-admin");
    const preview = make("button", "button button-quiet", "معاينة");
    preview.type = "button";
    preview.addEventListener("click", async () => {
      try {
        const result = await workerRequest(`/api/objects/preview?key=${encodeURIComponent(resource.objectKey)}`);
        window.open(result.url, "_blank", "noopener,noreferrer");
      } catch (error) { showToast(error.message, "error"); }
    });
    const replace = make("button", "button button-outline", "استبدال");
    replace.type = "button";
    replace.addEventListener("click", () => { state.replacement = resource; el("#replaceInput").click(); });
    const remove = make("button", "button button-danger", "حذف");
    remove.type = "button";
    remove.addEventListener("click", () => deleteResource(resource));
    actions.append(preview, replace, remove);
    row.append(meta, actions);
    list.append(row);
  }
}

async function deleteResource(resource) {
  if (!window.confirm(`هل تريد حذف «${resource.name || resource.originalFilename}» من تخزين الوسائط وإزالة بياناته؟`)) return;
  try {
    await workerRequest(`/api/objects?key=${encodeURIComponent(resource.objectKey)}`, { method: "DELETE" });
    await runTransaction(db, async (transaction) => {
      const reference = doc(db, "lessons", state.lessonId);
      const snapshot = await transaction.get(reference);
      const next = (snapshot.data()?.resources || []).filter((item) => item.resourceId !== resource.resourceId);
      transaction.update(reference, { resources: next, updatedAt: Timestamp.now() });
    });
    state.lesson.resources = state.lesson.resources.filter((item) => item.resourceId !== resource.resourceId);
    refreshPublishButton();
    await renderResourceList();
    showToast("حُذف الملف وبياناته.", "success");
  } catch (error) {
    showToast(`تعذر إكمال الحذف: ${error.message}. أعد المحاولة للتحقق من حالة الملف.`, "error");
  }
}

async function togglePublish() {
  if (!state.lessonId || !state.lesson) return;
  const previousPublished = Boolean(state.lesson.isPublished);
  const previousResources = state.lesson.resources || [];
  const publishing = !previousPublished || previousResources.some((item) => item.visibility !== "public");
  const action = publishing ? "نشر هذا الدرس وكل وسائطه للعامة" : "إخفاء هذا الدرس ووسائطه عن الزوار";
  if (!window.confirm(`${action}؟`)) return;
  const button = el("#publishButton");
  button.disabled = true;
  try {
    if (publishing) {
      await updateDoc(doc(db, "lessons", state.lessonId), {
        isPublished: true, resources: (state.lesson.resources || []).map((item) => ({ ...item, visibility: "public" })), updatedAt: Timestamp.now()
      });
      try {
        await workerRequest(`/api/lessons/${encodeURIComponent(state.lessonId)}/visibility`, {
          method: "POST", body: JSON.stringify({ isPublished: true, objectKeys: (state.lesson.resources || []).map((item) => item.objectKey) })
        });
      } catch (error) {
        await updateDoc(doc(db, "lessons", state.lessonId), {
          isPublished: previousPublished, resources: previousResources, updatedAt: Timestamp.now()
        });
        throw error;
      }
    } else {
      await workerRequest(`/api/lessons/${encodeURIComponent(state.lessonId)}/visibility`, { method: "POST", body: JSON.stringify({ isPublished: false, objectKeys: [] }) });
      await updateDoc(doc(db, "lessons", state.lessonId), {
        isPublished: false, resources: (state.lesson.resources || []).map((item) => ({ ...item, visibility: "private" })), updatedAt: Timestamp.now()
      });
    }
    state.lesson.isPublished = publishing;
    state.lesson.resources = (state.lesson.resources || []).map((item) => ({ ...item, visibility: publishing ? "public" : "private" }));
    refreshPublishButton();
    showToast(publishing ? (previousPublished ? "نُشرت التغييرات وأصبحت الوسائط الجديدة متاحة." : "نُشر الدرس. أصبح محتواه متاحاً للزوار.") : "أُلغي نشر الدرس وأُخفيت وسائطه.", "success");
  } catch (error) {
    showToast(`تعذر تحديث حالة النشر: ${error.message}`, "error");
  } finally { button.disabled = false; }
}

function renderSavedSessions() {
  const host = el("#savedSessions");
  host.replaceChildren();
  const sessions = sessionList();
  if (!sessions.length) {
    host.append(make("p", "muted", "لا توجد جلسات رفع محفوظة على هذا الجهاز."));
    return;
  }
  for (const session of sessions) {
    const row = make("article", "saved-session");
    const details = make("div");
    details.append(make("strong", "", session.fileName));
    details.append(make("small", "", `${formatBytes(session.sizeBytes)} · ${labelFor("stages", session.stageId)} · ${formatDate(session.createdAt)}`));
    const actions = make("div", "resource-actions-admin");
    const resume = make("button", "button button-secondary", session.completed ? "إعادة حفظ بيانات الدرس" : "استكمال الرفع");
    resume.type = "button";
    resume.addEventListener("click", () => {
      state.resumeCandidate = session;
      el("#resumeFilePicker").click();
    });
    const cancel = make("button", "button button-danger", "إلغاء الجلسة");
    cancel.type = "button";
    cancel.addEventListener("click", async () => {
      if (!window.confirm("إلغاء جلسة الرفع وحذف الأجزاء المؤقتة؟")) return;
      try { await workerRequest(`/api/uploads/${encodeURIComponent(session.sessionId)}`, { method: "DELETE" }); }
      catch (error) { if (!session.completed) return showToast(error.message, "error"); }
      removeSession(session.sessionId);
      showToast("أُزيلت جلسة الاستعادة.");
    });
    actions.append(resume, cancel);
    row.append(details, actions);
    host.append(row);
  }
}

async function loadRecoveryItems() {
  const host = el("#recoveryItems");
  host.replaceChildren();
  try {
    const { items = [] } = await workerRequest("/api/uploads/recover");
    if (!items.length) return;
    host.append(make("h3", "", "ملفات مكتملة تحتاج إلى ربط بالدرس"));
    for (const item of items) {
      const row = make("article", "saved-session");
      const details = make("div");
      details.append(make("strong", "", item.fileName));
      details.append(make("small", "", `${formatBytes(item.sizeBytes)} · ${item.lessonId}`));
      const action = make("button", "button button-secondary", "إعادة ربط البيانات");
      action.type = "button";
      action.addEventListener("click", async () => {
        try {
          const lessonRef = doc(db, "lessons", item.lessonId);
          const lessonSnapshot = await getDoc(lessonRef);
          if (!lessonSnapshot.exists()) throw new Error("سجل الدرس غير موجود في Firestore.");
          const fileDefinition = Object.values(ALLOWED_FILE_TYPES).find((entry) => entry.contentType === item.contentType && entry.type === item.type);
          if (!fileDefinition) throw new Error("نوع الملف غير معروف.");
          const resource = {
            resourceId: item.sessionId, name: item.fileName, type: item.type, objectKey: item.objectKey,
            contentType: item.contentType, sizeBytes: item.sizeBytes, originalFilename: item.fileName,
            createdAt: Timestamp.fromMillis(item.createdAt), uploadedBy: item.uid, visibility: "private"
          };
          await runTransaction(db, async (transaction) => {
            const snapshot = await transaction.get(lessonRef);
            const resources = snapshot.data()?.resources || [];
            if (!resources.some((entry) => entry.resourceId === resource.resourceId)) resources.push(resource);
            transaction.update(lessonRef, { resources, updatedAt: Timestamp.now() });
          });
          await workerRequest(`/api/uploads/${encodeURIComponent(item.sessionId)}/confirm`, { method: "POST", body: "{}" });
          showToast("أُعيد ربط الملف بسجل الدرس.", "success");
          await loadRecoveryItems();
          if (state.lessonId === item.lessonId) { await chooseLesson(item.lessonId); }
        } catch (error) { showToast(error.message, "error"); }
      });
      row.append(details, action);
      host.append(row);
    }
  } catch (error) {
    host.append(make("p", "muted", `تعذر جلب جلسات الاستعادة: ${error.message}`));
  }
}

async function renderSaved() {
  renderSavedSessions();
  await loadRecoveryItems();
}

async function onResumeFile(event) {
  const file = event.target.files?.[0];
  const session = state.resumeCandidate;
  event.target.value = "";
  state.resumeCandidate = null;
  if (!file || !session) return;
  if (!sameFile(file, session)) return showToast("اختر الملف نفسه بالاسم والحجم ووقت التعديل لاستكمال الجلسة.", "error");
  if (session.lessonId !== state.lessonId) {
    el("#stageSelect").value = session.stageId;
    el("#subjectSelect").value = session.subjectId;
    el("#termSelect").value = session.termId;
    await loadLessonChoices(session.lessonId);
    await chooseLesson(session.lessonId);
  }
  if (!state.lessonId) return showToast("تعذر فتح الدرس المرتبط بهذه الجلسة.", "error");
  await uploadOne(file, session, session.replaceResourceId ? state.lesson.resources?.find((item) => item.resourceId === session.replaceResourceId) : null);
}

async function loadAdminIdentity(user) {
  try {
    const token = await user.getIdTokenResult(true);
    if (token.claims.admin !== true) {
      await signOut(auth);
      el("#loginPanel").classList.remove("hidden");
      el("#adminPanel").classList.add("hidden");
      setMessage(el("#loginMessage"), "تم تسجيل الدخول، لكن هذا الحساب لا يحمل صلاحية admin في Firebase custom claims.", "error");
      return;
    }
    state.user = user;
    el("#loginPanel").classList.add("hidden");
    el("#adminPanel").classList.remove("hidden");
    el("#signOutButton").classList.remove("hidden");
    el("#adminIdentity").textContent = user.email || user.uid;
    await loadLessonChoices();
    await renderSaved();
    el("#publishButton").disabled = true;
  } catch (error) {
    console.error("Admin claim check failed", error.code || "claim-check-failed");
    setMessage(el("#loginMessage"), "تعذر التحقق من صلاحيات الحساب. تحقق من إعداد Firebase.", "error");
  }
}

el("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(el("#loginMessage"), "جارٍ تسجيل الدخول…");
  try {
    await signInWithEmailAndPassword(auth, el("#emailInput").value.trim(), el("#passwordInput").value);
    await auth.currentUser?.getIdToken(true);
    await loadAdminIdentity(auth.currentUser);
  } catch (error) {
    setMessage(el("#loginMessage"), "تعذر تسجيل الدخول. تحقق من بيانات الحساب وإعداد Firebase Authentication.", "error");
  }
});

onAuthStateChanged(auth, (user) => {
  if (user) loadAdminIdentity(user);
  else {
    state.user = null;
    el("#loginPanel").classList.remove("hidden");
    el("#adminPanel").classList.add("hidden");
    el("#signOutButton").classList.add("hidden");
  }
});

el("#signOutButton").addEventListener("click", () => signOut(auth));
el("#lessonForm").addEventListener("submit", saveLesson);
el("#lessonSelect").addEventListener("change", (event) => chooseLesson(event.target.value));
for (const selector of ["#stageSelect", "#subjectSelect", "#termSelect"]) {
  el(selector).addEventListener("change", async () => { state.lessonId = null; state.lesson = null; await loadLessonChoices(); await chooseLesson("__new__"); });
}
el("#publishButton").addEventListener("click", togglePublish);
el("#cancelUploads").addEventListener("click", cancelUploads);
el("#refreshSessions").addEventListener("click", renderSaved);
el("#fileInput").addEventListener("change", async (event) => {
  const files = [...(event.target.files || [])];
  event.target.value = "";
  await startFiles(files);
});
el("#replaceInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  const target = state.replacement;
  state.replacement = null;
  if (file && target) await uploadOne(file, null, target);
});
el("#dropZone").addEventListener("dragover", (event) => { event.preventDefault(); el("#dropZone").classList.add("drag-over"); });
el("#dropZone").addEventListener("dragleave", () => el("#dropZone").classList.remove("drag-over"));
el("#dropZone").addEventListener("drop", async (event) => {
  event.preventDefault();
  el("#dropZone").classList.remove("drag-over");
  await startFiles([...event.dataTransfer.files]);
});

el("#resumeFilePicker").addEventListener("change", onResumeFile);
