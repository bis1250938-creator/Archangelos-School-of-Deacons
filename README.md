# Archangelos School of Deacons

Arabic-first learning library and administrator upload dashboard for Coptic Orthodox lessons. This is a new, standalone app: plain HTML, CSS, and JavaScript in Firebase Hosting, Firebase Authentication and Firestore for identity and lesson metadata, and a separately deployed Cloudflare Worker for private R2 storage, media delivery, and multipart upload control.

The school seal supplied with the request is in `assets/school-seal.jpeg`. Firebase Auth and Firestore use the modular Firebase JavaScript SDK, pinned to the 13.0.0 CDN release.

## What is included

- `index.html` and `admin.html`: public lesson library and admin dashboard.
- `js/`: Firebase setup, school curriculum, public browsing, and upload client.
- `firestore.rules` and `firestore.indexes.json`: public published-lesson reads and admin-only edits.
- `r2-worker/`: Firebase ID-token verification, R2 multipart URL signing, upload completion checks, recovery, cleanup, deletion, visibility control, and byte-range delivery.
- `tools/`: Firebase curriculum seeder and command-line admin custom-claim manager.
- `r2-cors-policy.json`: narrow browser CORS policy template for direct multipart part uploads.
- `firebase.json`: Firebase Hosting and Firestore deployment configuration.

No R2 credential, Firebase service account, private token, or media binary is included in browser configuration. The Firebase web configuration in `app-config.js` is public client configuration; R2 keys stay in Cloudflare Worker secrets.

## App workflow

1. A student filters published lessons by stage, subject, and term. The app fetches lesson metadata first and only requests a media URL when a lesson is opened. Videos use `preload="metadata"` and the Worker streams byte ranges so playback and seeking do not require buffering the whole file.
2. An administrator signs in with Firebase Authentication. The admin page checks the Firebase `admin` custom claim for interface access; every Worker management call independently verifies the token signature, audience, issuer, expiry, and `admin` claim.
3. The administrator creates or selects a lesson, then chooses or drops supported files. The client checks file signatures and size before it asks the Worker to start an upload.
4. The Worker generates a unique key and starts an R2 multipart upload. It returns short-lived presigned URLs for individual parts. The browser sends parts directly to R2 and reports per-file and total progress, speed, and remaining time. The Worker never receives the large media body.
5. The Worker lists and validates every uploaded part, completes the object, checks its size and file signature, and stores an upload record in D1. Firestore then receives the lesson resource metadata and stable R2 object key. If Firestore fails, the admin can retry or recover the unlinked object. A scheduled Worker task aborts stale multipart sessions and removes completed unlinked objects after seven days.
6. Publishing updates the Firestore lesson and the Worker visibility index. The public delivery endpoint returns media only when the lesson is published and the resource is linked. Replacing a resource uploads a new object first, updates Firestore, then removes the old object. Delete and publish actions require confirmation.

### Resume behavior

The Worker and R2 retain the multipart upload ID and uploaded part list. The browser saves only session metadata in local storage, not file contents. After a page refresh, an administrator selects the same file again; matching name, size, and modified time are required, followed by a SHA-256 check of the first and last 64 KiB before the client skips already uploaded parts. This boundary fingerprint is a practical file re-selection check, not a full-file cryptographic hash. Retry requests fresh presigned URLs. The file itself is not stored by the app for background or unattended upload.

## Firestore data

The app uses `lessons/{lessonId}` with:

```text
titleAr, titleEn, descriptionAr, descriptionEn,
stageId, subjectId, termId, order, thumbnailKey,
resources[], isPublished, createdBy, createdAt, updatedAt
```

Each resource stores `resourceId`, `name`, `type`, `objectKey`, `contentType`, `sizeBytes`, `originalFilename`, `createdAt`, `uploadedBy`, and `visibility`. Optional `durationSeconds` and `thumbnailKey` can be added without changing the upload service. No temporary signed URL is saved in Firestore.

Curriculum identifiers are seeded by `tools/seed-curriculum.mjs` and are also declared in `js/constants.js` for the selector UI:

- Stages: KG, grades 1–2, grades 3–4, grades 5–6, preparatory and secondary, deacons' choir.
- Subjects: Coptic hymns, Coptic Orthodox rites.
- Terms: first and second.

The stage, subject, and term collections are descriptive curriculum records. Each lesson also carries their IDs so content remains separated in Firestore queries.

## Requirements

- Node.js 22 or newer for the Firebase Admin setup tools and Wrangler.
- Firebase project with Email/Password Authentication, Cloud Firestore, and Firebase Hosting enabled.
- Cloudflare account with R2, Workers, and D1 available.
- An HTTPS origin for production. `localhost:5500` is included for local development.
- Firebase Admin SDK credentials used only by the local admin-claim/seed scripts. Keep the JSON file outside this app folder and out of source control.

## Setup and deploy

### 1. Configure Firebase

1. Create or select a Firebase project. Enable **Authentication → Email/Password** and create the Firestore database.
2. In Firebase project settings, register a web app. Copy its public web config into `app-config.js` (`apiKey`, `authDomain`, `projectId`, `appId`, and `messagingSenderId`). The web config identifies the Firebase app; it does not grant admin access.
3. Update `FIREBASE_PROJECT_ID` in the Worker secrets and record the project ID for the local commands below.
4. Install Firebase CLI, select the project, and deploy rules, indexes, and hosting:

   ```powershell
   npm install --global firebase-tools
   firebase login
   firebase use --add
   firebase deploy --only hosting,firestore:rules,firestore:indexes
   ```

5. Create the first admin user in Firebase Authentication. Download a service-account key only for the trusted setup machine; store it outside this folder. Set the environment variables and grant the custom claim:

   ```powershell
   $env:GOOGLE_APPLICATION_CREDENTIALS = 'C:\secure\firebase-admin.json'
   $env:FIREBASE_PROJECT_ID = 'your-firebase-project-id'
   Push-Location tools
   npm install
   npm run set-admin -- admin@example.org grant
   npm run seed-curriculum
   Pop-Location
   Remove-Item Env:GOOGLE_APPLICATION_CREDENTIALS
   Remove-Item Env:FIREBASE_PROJECT_ID
   ```

   To revoke admin access, run `npm run set-admin -- admin@example.org revoke`. The user should sign out and sign in again so Firebase issues a refreshed token.

6. Add the deployed Firebase Hosting domain to **Authentication → Settings → Authorized domains**.

### 2. Create the Cloudflare resources

Sign in to the existing Cloudflare account or create one, then confirm R2, Workers, and D1 are enabled. From `r2-worker/`, authenticate Wrangler and create separate development and production buckets and D1 databases:

```powershell
npm install
npx wrangler login
npx wrangler r2 bucket create archangelos-school-media
npx wrangler r2 bucket create archangelos-school-media-dev
npx wrangler d1 create archangelos-media
npx wrangler d1 create archangelos-media-dev
```

Copy the two D1 database IDs printed by Wrangler into `r2-worker/wrangler.toml`. The binding names and bucket names must match the config. Apply the D1 schema to both environments:

```powershell
npx wrangler d1 migrations apply DB --remote
npx wrangler d1 migrations apply DB --remote --env dev
```

Create an R2 API token scoped to the applicable bucket with object read/write permissions. Add these values as Worker secrets; do not put them in `wrangler.toml`, `app-config.js`, Firestore, or Git:

```powershell
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put FIREBASE_PROJECT_ID --env dev
npx wrangler secret put R2_ACCOUNT_ID --env dev
npx wrangler secret put R2_ACCESS_KEY_ID --env dev
npx wrangler secret put R2_SECRET_ACCESS_KEY --env dev
```

Wrangler prompts for each secret value. Use a development R2 token scoped only to the development bucket for the `dev` environment. Set `ALLOWED_ORIGINS` in `wrangler.toml` to exact origins, including scheme, for the deployed site. Do not use `*`.

### 3. Configure R2 browser CORS

Edit `r2-cors-policy.json`: replace the production placeholder with the exact Firebase Hosting or custom domain. Keep the development origins only if you use them. Then, from `r2-worker/`, run:

```powershell
npx wrangler r2 bucket cors set archangelos-school-media --file=../r2-cors-policy.json
npx wrangler r2 bucket cors set archangelos-school-media-dev --file=../r2-cors-policy.json
```

This permits only browser `PUT` requests from listed origins with `Content-Type`. Public playback goes through the Worker and does not require public access to the R2 bucket. Leave the bucket's `r2.dev` public URL disabled. Add a Cloudflare lifecycle rule to abort incomplete multipart uploads after seven days as a second cleanup safeguard; the Worker also runs hourly cleanup after 24 hours.

For a custom media hostname, attach a hostname such as `media.example.org` to the Worker in Cloudflare **Workers & Pages → Settings → Domains & Routes**. Point `mediaWorkerUrl` in `app-config.js` to that HTTPS hostname and add the app's exact origin to `ALLOWED_ORIGINS`. This keeps object delivery behind the Worker; do not connect a public R2 bucket domain.

### 4. Deploy the Worker and connect the app

From `r2-worker/`:

```powershell
npm test
npm run deploy:dev
npm run deploy
```

Wrangler prints the Worker URL. Set `mediaWorkerUrl` in `app-config.js` to that URL, deploy the frontend, and add the same site origin to `ALLOWED_ORIGINS`. Keep development and production Worker secrets, bucket names, database IDs, and allowed origins separate. The app can be served locally with `python -m http.server 5500` from this folder after setting development Firebase and Worker configuration.

## Security controls

- Firebase ID tokens are verified server-side against Google's secure-token signing keys. The Worker checks the Firebase project issuer and audience, expiration, authentication time, subject, and the signed `admin: true` custom claim. It does not accept a client-provided role or email as authorization.
- R2 access keys exist only as Worker secrets. Uploads use short-lived signed part URLs; every management route separately checks Firebase admin identity.
- Object keys are generated from a validated lesson ID, a random UUID, and a sanitized name. File extension and MIME type are checked, then the Worker reads at most the first 32 bytes after completion to validate the file signature.
- Published assets are delivered through `/media?key=...` only when the Worker D1 row is linked and published. The Worker supports byte ranges for audio/video/PDF playback and streams from R2 without buffering an entire object.
- The Worker limits upload authorization calls to 600 per administrator per minute. The configured upload size cannot exceed the app's conservative 4.995 TiB multipart cap. Lower `MAX_UPLOAD_BYTES` in Wrangler for a smaller operational cap. Set `STORAGE_WARNING_BYTES` above zero to warn against the app's tracked completed-object total; it is a D1 estimate, not an R2 account usage API.
- The public bucket endpoint is not enabled. CORS is restricted to the configured site origins and required methods.
- Lesson metadata failures leave recoverable D1 session records; completed, unlinked files are automatically cleaned up after seven days. Resource deletion first makes the Worker delivery route unavailable.

## Limits and cost notes (checked 13 October 2026)

Cloudflare's upload guide describes multipart objects up to 5 TiB; its platform limits page gives a more conservative maximum upload size of **4.995 TiB** (5 TiB minus 5 GiB). This app enforces that lower cap. Multipart supports up to **10,000 parts**; parts are at least **5 MiB**, must be uniform except for the last, and cannot exceed the documented per-request limit of **4.995 GiB**. The app selects uniform 64 MiB parts by default and increases the part size when needed to stay within 10,000 parts. R2's incomplete multipart uploads expire after seven days by default; the Worker cleanup schedule is earlier.

R2 Standard's included monthly usage is **10 GB-month storage, 1 million Class A requests, and 10 million Class B requests**. Standard R2 egress is free. Current Standard rates above included amounts are $0.015 per GB-month, $4.50 per million Class A requests, and $0.36 per million Class B requests. The free tier is limited; large lesson libraries, multipart writes, and frequent media range reads can exceed it. This app does not invent a storage-usage endpoint or promise unlimited free storage or delivery.

Worker and D1 usage are separate from R2. Cloudflare's current Workers Free allowance lists 100,000 requests per day and 10 ms CPU per invocation; the paid Workers Standard plan includes 10 million requests and 30 million CPU-ms monthly before additional usage charges. D1 also has separate read/write limits. Check the linked current pricing pages and the Cloudflare dashboard before production use.

Official references:

- [R2 upload methods and multipart limits](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [R2 platform upload limits](https://developers.cloudflare.com/r2/platform/limits/)
- [R2 pricing and free tier](https://developers.cloudflare.com/r2/pricing/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [R2 CORS configuration](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/cors/)
- [Firebase ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)

## Verification status

Local source checks completed for this handoff:

- The Worker validation suite passes all six tests for multipart sizing, supported file signatures, filename sanitization, and byte-range parsing.
- JavaScript syntax checks pass for the Worker, public library, and admin dashboard. Static checks found all referenced HTML IDs and parsed the JSON configuration files.
- Wrangler 4.150 dry-run bundled production and development Worker variants with temporary nonproduction resource IDs. Local Worker smoke checks returned `200` for `/health`, `401` for an unauthenticated upload request, `404` for an unlinked media object, `204` for preflight from an allowed origin, and `403` for an unapproved origin.
- The secret scan found no R2 access keys, Firebase service-account keys, or privileged credentials in browser configuration or frontend source.
- `npm audit` reported zero vulnerabilities for the locked Worker dependencies; the Firebase setup tools also reported zero vulnerabilities.

These checks did not use a real Firebase project, R2 bucket, deployed Worker, or browser sign-in. Still outstanding are real small-image/PDF/audio uploads, a video larger than 500 MB, multipart retry and refresh recovery against R2, Firestore persistence and recovery after metadata failure, public playback and seeking, Android/desktop browser validation, and live admin-versus-non-admin authorization checks. The Firebase web configuration, Cloudflare resource IDs, exact origins, and credentials must be configured before those can be verified; no deployment or live-service test is claimed.

## Adding lessons and materials

Administrators do not edit source code to add content. Sign in at `/admin.html`, create or select a lesson, save the draft, drop or browse files, preview them, and publish when ready. Supported media are MP4, MP3, WAV, JPEG, PNG, WebP, and PDF. The app supports multiple files on a lesson and preserves the stage, subject, and term IDs on the lesson record.
