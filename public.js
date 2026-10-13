import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { CURRICULUM, formatDate, labelFor } from "./constants.js";

const stageSelect = document.querySelector("#stageFilter");
const subjectSelect = document.querySelector("#subjectFilter");
const termSelect = document.querySelector("#termFilter");
const lessonGrid = document.querySelector("#lessonGrid");
const statusLine = document.querySelector("#libraryStatus");
const dialog = document.querySelector("#lessonDialog");
document.querySelector("#year").textContent = new Date().getFullYear();

function fillSelect(select, options) {
  select.replaceChildren(...options.map(({ id, ar }) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = ar;
    return option;
  }));
}

fillSelect(stageSelect, CURRICULUM.stages);
fillSelect(subjectSelect, CURRICULUM.subjects);
fillSelect(termSelect, CURRICULUM.terms);

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function mediaUrl(objectKey) {
  const base = window.ARCHANGELOS_CONFIG.mediaWorkerUrl.replace(/\/$/, "");
  const url = new URL(`${base}/media`);
  url.searchParams.set("key", objectKey);
  return url.toString();
}

function showLessons(lessons) {
  lessonGrid.replaceChildren();
  if (!lessons.length) {
    const empty = make("div", "empty-state", "لا توجد دروس منشورة في هذا الاختيار حتى الآن.");
    lessonGrid.append(empty);
    return;
  }
  for (const lesson of lessons) {
    const card = make("article", "lesson-card");
    const body = make("div", "lesson-card-body");
    const subject = make("p", "eyebrow", labelFor("subjects", lesson.subjectId));
    const title = make("h3", "", lesson.titleAr || lesson.titleEn || "درس تعليمي");
    const description = make("p", "", lesson.descriptionAr || lesson.descriptionEn || "مواد تعليمية للدرس متاحة للمشاهدة والاستماع.");
    const footer = make("div", "lesson-card-footer");
    const details = make("span", "", `${(lesson.resources || []).length} مادة تعليمية · ${formatDate(lesson.updatedAt)}`);
    const open = make("button", "button button-secondary", "فتح الدرس");
    open.type = "button";
    open.addEventListener("click", () => openLesson(lesson));
    footer.append(details, open);
    body.append(subject, title, description, footer);
    card.append(body);
    lessonGrid.append(card);
  }
}

function resourceElement(resource) {
  const block = make("article", "media-block");
  const title = make("h3", "", resource.name || resource.originalFilename || "مادة تعليمية");
  const url = mediaUrl(resource.objectKey);
  let media;
  if (resource.type === "video") {
    media = document.createElement("video");
    media.controls = true;
    media.playsInline = true;
    media.preload = "metadata";
  } else if (resource.type === "audio") {
    media = document.createElement("audio");
    media.controls = true;
    media.preload = "none";
  } else if (resource.type === "image") {
    media = document.createElement("img");
    media.loading = "lazy";
    media.alt = resource.name || "صورة تعليمية";
  } else if (resource.type === "pdf") {
    media = document.createElement("iframe");
    media.title = resource.name || "مستند PDF";
    media.loading = "lazy";
  }
  if (media) {
    media.src = url;
    media.setAttribute("aria-label", resource.name || "مادة تعليمية");
    block.append(title, media);
  }
  const actions = make("div", "resource-actions");
  const info = make("span", "", `${resource.contentType || "ملف"} · ${formatDate(resource.createdAt)}`);
  const download = make("a", "pdf-link", resource.type === "pdf" ? "فتح أو تنزيل PDF" : "فتح الملف");
  download.href = url;
  download.target = "_blank";
  download.rel = "noopener noreferrer";
  actions.append(info, download);
  block.append(actions);
  return block;
}

function openLesson(lesson) {
  document.querySelector("#dialogMeta").textContent = `${labelFor("stages", lesson.stageId)} · ${labelFor("subjects", lesson.subjectId)} · ${labelFor("terms", lesson.termId)}`;
  document.querySelector("#dialogTitle").textContent = lesson.titleAr || lesson.titleEn || "درس تعليمي";
  document.querySelector("#dialogDescription").textContent = lesson.descriptionAr || lesson.descriptionEn || "";
  const container = document.querySelector("#dialogResources");
  container.replaceChildren();
  const resources = (lesson.resources || []).filter((resource) => resource.objectKey && resource.visibility !== "private");
  if (!resources.length) container.append(make("div", "empty-state", "لا توجد وسائط منشورة لهذا الدرس حالياً."));
  else resources.forEach((resource) => container.append(resourceElement(resource)));
  dialog.showModal();
}

async function loadLessons() {
  statusLine.textContent = "جارٍ تحميل الدروس…";
  lessonGrid.replaceChildren();
  try {
    const conditions = [
      where("stageId", "==", stageSelect.value),
      where("subjectId", "==", subjectSelect.value),
      where("termId", "==", termSelect.value),
      where("isPublished", "==", true)
    ];
    const snapshot = await getDocs(query(collection(db, "lessons"), ...conditions));
    const lessons = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    showLessons(lessons);
    statusLine.textContent = `${lessons.length} درس منشور`;
  } catch (error) {
    console.error("Unable to load public lessons", error.code || "request-failed");
    statusLine.textContent = "تعذر تحميل الدروس. تحقق من إعداد Firebase وFirestore rules ثم أعد المحاولة.";
    showLessons([]);
  }
}

document.querySelector("#filters").addEventListener("change", loadLessons);
document.querySelector("#closeDialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
loadLessons();
