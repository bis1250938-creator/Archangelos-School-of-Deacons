/* Public browser configuration only. Firebase web config is not a secret.
   Never put Cloudflare R2 keys, Firebase service-account keys, or admin tokens here. */
window.ARCHANGELOS_CONFIG = Object.freeze({
  firebase: {
    apiKey: "REPLACE_WITH_FIREBASE_WEB_API_KEY",
    authDomain: "REPLACE_WITH_PROJECT_ID.firebaseapp.com",
    projectId: "REPLACE_WITH_PROJECT_ID",
    appId: "REPLACE_WITH_FIREBASE_WEB_APP_ID",
    messagingSenderId: "REPLACE_WITH_SENDER_ID"
  },
  mediaWorkerUrl: "https://REPLACE_WITH_WORKER_SUBDOMAIN.workers.dev",
  // Browser-side limit should match the Worker's MAX_UPLOAD_BYTES secret/variable.
  maxUploadBytes: 5492189429760,
  partSizeBytes: 67108864,
  uploadConcurrency: 3
});
