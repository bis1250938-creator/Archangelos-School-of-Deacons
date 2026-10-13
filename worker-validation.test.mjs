import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_R2_OBJECT_BYTES, MAX_PARTS, MIN_PART_BYTES, parseRange,
  fileSignatureMatches, objectFilename, planMultipart, sanitizeFilename
} from "../r2-worker/src/validation.js";

test("multipart plan supports large objects within R2 limits", () => {
  const fiveHundredMiB = planMultipart(500 * 1024 ** 2);
  assert.equal(fiveHundredMiB.partCount, 8);
  const maximum = planMultipart(MAX_R2_OBJECT_BYTES);
  assert.ok(maximum.partCount <= MAX_PARTS);
  assert.ok(maximum.partSizeBytes >= MIN_PART_BYTES);
});

test("multipart plan rejects objects beyond the R2 maximum", () => {
  assert.throws(() => planMultipart(MAX_R2_OBJECT_BYTES + 1));
});

test("multipart part count stays under 10,000 and all non-final chunks are uniform", () => {
  const bytes = 3 * 1024 ** 4;
  const plan = planMultipart(bytes);
  assert.ok(plan.partCount <= MAX_PARTS);
  assert.equal(plan.partSizeBytes % (1024 ** 2), 0);
  assert.equal(Math.ceil(bytes / plan.partSizeBytes), plan.partCount);
});

test("file signatures distinguish the supported formats", () => {
  assert.equal(fileSignatureMatches("pdf", new TextEncoder().encode("%PDF-1.7 test")), true);
  assert.equal(fileSignatureMatches("mp4", new TextEncoder().encode("0000ftypisom")), true);
  assert.equal(fileSignatureMatches("pdf", new TextEncoder().encode("not a pdf")), false);
  assert.equal(fileSignatureMatches("webp", new TextEncoder().encode("RIFFxxxxWEBP")), true);
});

test("filename cleanup prevents path separators and unsafe names", () => {
  assert.equal(sanitizeFilename("..\\lesson\u0000.mp4"), ".._lesson_.mp4");
  assert.equal(objectFilename("../../ألحان: الأحد.mp4").includes("/"), false);
  assert.equal(sanitizeFilename("../"), ".._");
  assert.throws(() => sanitizeFilename(""));
});

test("single byte ranges, suffix ranges, and invalid ranges are parsed", () => {
  assert.deepEqual(parseRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=100-", 100), { invalid: true });
  assert.deepEqual(parseRange("bytes=1-2,4-5", 100), { invalid: true });
});
