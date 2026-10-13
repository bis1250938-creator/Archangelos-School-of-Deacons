import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS || !process.env.FIREBASE_PROJECT_ID) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS and FIREBASE_PROJECT_ID before seeding curriculum data.");
  process.exit(2);
}

initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
const db = getFirestore();
const groups = {
  stages: [
    ["kg", "كي جي", "KG"], ["primary-1-2", "أولى وتانية ابتدائي", "First and Second Grade"],
    ["primary-3-4", "تالتة ورابعة ابتدائي", "Third and Fourth Grade"],
    ["primary-5-6", "خامسة وسادسة ابتدائي", "Fifth and Sixth Grade"],
    ["preparatory-secondary", "إعدادي وثانوي", "Preparatory and Secondary"],
    ["deacons-choir", "خورس الشمامسة", "Deacons' Choir"]
  ],
  subjects: [["coptic-hymns", "الألحان القبطية", "Coptic Hymns"], ["orthodox-rites", "الطقس القبطي الأرثوذكسي", "Coptic Orthodox Rites"]],
  terms: [["term-1", "الترم الأول", "First Term"], ["term-2", "الترم الثاني", "Second Term"]]
};

for (const [collectionName, entries] of Object.entries(groups)) {
  const batch = db.batch();
  entries.forEach(([id, titleAr, titleEn], order) => batch.set(db.collection(collectionName).doc(id), {
    titleAr, titleEn, order, isActive: true, updatedAt: new Date()
  }, { merge: true }));
  await batch.commit();
  console.log(`Seeded ${entries.length} ${collectionName}.`);
}
