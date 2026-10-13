export const CURRICULUM = Object.freeze({
  stages: [
    { id: "kg", ar: "كي جي", en: "KG" },
    { id: "primary-1-2", ar: "أولى وتانية ابتدائي", en: "First and Second Grade" },
    { id: "primary-3-4", ar: "تالتة ورابعة ابتدائي", en: "Third and Fourth Grade" },
    { id: "primary-5-6", ar: "خامسة وسادسة ابتدائي", en: "Fifth and Sixth Grade" },
    { id: "preparatory-secondary", ar: "إعدادي وثانوي", en: "Preparatory and Secondary" },
    { id: "deacons-choir", ar: "خورس الشمامسة", en: "Deacons' Choir" }
  ],
  subjects: [
    { id: "coptic-hymns", ar: "الألحان القبطية", en: "Coptic Hymns" },
    { id: "orthodox-rites", ar: "الطقس القبطي الأرثوذكسي", en: "Coptic Orthodox Rites" }
  ],
  terms: [
    { id: "term-1", ar: "الترم الأول", en: "First Term" },
    { id: "term-2", ar: "الترم الثاني", en: "Second Term" }
  ]
});

export const ALLOWED_FILE_TYPES = Object.freeze({
  mp4: { type: "video", contentType: "video/mp4", label: "MP4 video" },
  mp3: { type: "audio", contentType: "audio/mpeg", label: "MP3 audio" },
  wav: { type: "audio", contentType: "audio/wav", label: "WAV audio" },
  jpg: { type: "image", contentType: "image/jpeg", label: "JPEG image" },
  jpeg: { type: "image", contentType: "image/jpeg", label: "JPEG image" },
  png: { type: "image", contentType: "image/png", label: "PNG image" },
  webp: { type: "image", contentType: "image/webp", label: "WebP image" },
  pdf: { type: "pdf", contentType: "application/pdf", label: "PDF document" }
});

export function labelFor(group, id, language = "ar") {
  return CURRICULUM[group].find((item) => item.id === id)?.[language] ?? id;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toLocaleString("en", { maximumFractionDigits: power ? 1 : 0 })} ${units[power]}`;
}

export function formatDate(value) {
  const date = value?.toDate ? value.toDate() : new Date(value || Date.now());
  return new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium" }).format(date);
}
