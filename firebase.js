import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

const config = window.ARCHANGELOS_CONFIG?.firebase;
if (!config || Object.values(config).some((value) => String(value).startsWith("REPLACE_WITH"))) {
  console.warn("Set the public Firebase web configuration in app-config.js before connecting this app.");
}

export const firebaseApp = initializeApp(config);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
