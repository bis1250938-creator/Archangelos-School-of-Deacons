// R2's platform limits page lists a 4.995 TiB multipart object cap (5 TiB minus 5 GiB).
export const MAX_R2_OBJECT_BYTES = 5 * 1024 ** 4 - 5 * 1024 ** 3;
export const MIN_PART_BYTES = 5 * 1024 ** 2;
export const MAX_PART_BYTES = 5 * 1024 ** 3 - 5 * 1024 ** 2;
export const MAX_PARTS = 10_000;
export const DEFAULT_PART_BYTES = 64 * 1024 ** 2;

export function sanitizeFilename(value) {
  if (typeof value !== "string") throw new Error("Choose a file name.");
  const clean = value.normalize("NFC").replace(/[\\/\u0000-\u001f\u007f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!clean || clean === "." || clean === "..") throw new Error("Invalid file name.");
  return clean;
}

export function objectFilename(value) {
  const name = value.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(-100);
  return name || "media-file";
}

export function planMultipart(sizeBytes) {
  const mib = 1024 ** 2;
  const partSizeBytes = Math.min(MAX_PART_BYTES, Math.max(DEFAULT_PART_BYTES, Math.ceil(sizeBytes / MAX_PARTS / mib) * mib));
  const partCount = Math.ceil(sizeBytes / partSizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_R2_OBJECT_BYTES
    || partSizeBytes < MIN_PART_BYTES || partCount < 1 || partCount > MAX_PARTS) {
    throw new Error("This object exceeds the supported multipart upload limits.");
  }
  return { partSizeBytes, partCount };
}

export function fileSignatureMatches(extension, bytes) {
  const text = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  switch (extension) {
    case "jpg": case "jpeg": return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "png": return bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10";
    case "webp": return text(0, 4) === "RIFF" && text(8, 12) === "WEBP";
    case "pdf": return text(0, 5) === "%PDF-";
    case "wav": return text(0, 4) === "RIFF" && text(8, 12) === "WAVE";
    case "mp3": return text(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    case "mp4": return text(4, 8) === "ftyp";
    default: return false;
  }
}

export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return { invalid: true };
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}
