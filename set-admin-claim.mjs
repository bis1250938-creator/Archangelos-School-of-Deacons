import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const email = process.argv[2];
const action = process.argv[3] || "grant";
if (!email || !["grant", "revoke"].includes(action)) {
  console.error("Usage: npm run set-admin -- admin@example.org [grant|revoke]");
  process.exit(2);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to a trusted Firebase service-account JSON file outside the public app folder.");
  process.exit(2);
}

initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
const auth = getAuth();
const account = await auth.getUserByEmail(email);
const claims = { ...(account.customClaims || {}) };
if (action === "grant") claims.admin = true;
else delete claims.admin;
await auth.setCustomUserClaims(account.uid, claims);
console.log(`${action === "grant" ? "Granted" : "Revoked"} admin claim for ${account.email || account.uid}. The user must refresh their Firebase ID token (sign out and back in).`);
