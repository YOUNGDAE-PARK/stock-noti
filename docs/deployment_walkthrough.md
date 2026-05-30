# Firebase Deployment Walkthrough & Resolutions

This document provides a comprehensive analysis of the issues encountered during Firebase Functions deployment (`firebase deploy`) and details how they were successfully resolved.

---

## 1. Root Cause Analysis

We encountered three distinct blockers that prevented the Firebase Functions (Cloud Run containers) from starting and serving traffic:

### A. Read-only Filesystem Violations (`EROFS`)
* **Problem:** In GCP Cloud Run / Cloud Functions, the root filesystem is read-only except for `/tmp`. The module load-time logic in `src/db/db.js` previously executed directory checks and `fs.mkdirSync('./data')` immediately during file import.
* **Impact:** As soon as Firebase loaded `index.js` (which imports the DB module), the process crashed with `EROFS: read-only file system` before listening on the healthcheck port, causing container startup to fail.

### B. Directory Ignore Rule Mismatch (`ERR_MODULE_NOT_FOUND`)
* **Problem:** The `ignore` patterns in `firebase.json` included the plain pattern `"reports"`. Firebase CLI interprets this as a recursive wildcard, matching any path component. 
* **Impact:** The folder `src/services/reports/` was stripped from the uploaded ZIP file. When the container booted and parsed `index.js`, it failed immediately with:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/workspace/src/services/reports/dailyReport.js'`

### C. Native Addon GLIBC Mismatch (`GLIBC_2.38` not found)
* **Problem:** The `sqlite3@6.0.1` package publishes precompiled native `.node` binaries compiled against dynamic `GLIBC_2.38` (present in newer Linux distributions like Ubuntu 23.10+).
* **Impact:** The Google Cloud runtime environment (based on Debian Bookworm) provides `GLIBC_2.36`. Loading the native sqlite3 library failed during container startup with:
  `Error: /lib/x86_64-linux-gnu/libm.so.6: version 'GLIBC_2.38' not found (required by .../node_sqlite3.node)`

---

## 2. Implemented Solutions

We updated the application architecture to dynamically adjust path mapping and package configurations:

### A. Runtime Directory Check and Dynamic `/tmp` Routing
We created a path resolver utility [paths.js](file:///home/eins777/workspace/stock-noti/src/utils/paths.js) to dynamically route directories:
```javascript
export function getAbsoluteDbPath() {
  let dbPath = process.env.DATABASE_PATH || './data/stock_noti.db';
  if ((process.env.K_SERVICE || process.env.FIREBASE_CONFIG) && !process.env.FUNCTIONS_EMULATOR) {
    dbPath = '/tmp/stock_noti.db'; // Forces writeable directory in Cloud Run
  }
  return path.resolve(dbPath);
}
```
* **DB Deferral:** We moved `fs.mkdirSync` inside the database connection function `getDb()` in [db.js](file:///home/eins777/workspace/stock-noti/src/db/db.js). It now only executes at runtime when queries are made, and paths automatically adjust.
* **Storage Sync & Reports:** We updated [storage_sync.js](file:///home/eins777/workspace/stock-noti/src/db/storage_sync.js) and report generators to use this dynamic routing.

### B. Anchoring Ignore Rules in `firebase.json`
We updated the functions codebase packaging rules in [firebase.json](file:///home/eins777/workspace/stock-noti/firebase.json) to anchor local storage/generated folders to the project root using a leading `/`:
```json
    "ignore": [
      "**/node_modules/**",
      "**/.git/**",
      "**/.antigravitycli/**",
      "/data",
      "/reports",
      "/docs",
      "/src/public"
    ]
```
This guarantees that `src/services/reports/` is fully packaged and uploaded, while preventing root-level logs, database binaries, and front-end static pages from polluting the cloud bundle.

### C. Down-grading `sqlite3` to v5.1.7 for Compatibility
We updated `package.json` to downgrade the sqlite3 package:
* `"sqlite3": "^5.1.7"`
This downloads a precompiled binary built against older, widely supported GLIBC versions (GLIBC 2.28+), which compiles and loads correctly inside GCP Cloud Run nodes without requiring build tools or throwing library mismatches.

### D. Dynamic Schema Initialization & Default Seeding
* **Problem:** When the container starts in a clean environment (or GCP recycles instances), `/tmp/` is empty. The database was starting completely blank, causing a `SQLITE_ERROR: no such table: portfolio_asset` error.
* **Fix:** We created [schema.js](file:///home/eins777/workspace/stock-noti/src/db/schema.js) and [seed_data.js](file:///home/eins777/workspace/stock-noti/src/db/seed_data.js) containing table schemas and initial portfolios. During database bootstrap in [db.js](file:///home/eins777/workspace/stock-noti/src/db/db.js), if the main table `portfolio_asset` is missing, the system automatically runs schema migrations and inserts the initial assets.

### E. Deploying Service Account Permission Mismatch
* **Problem:** The service account key used by GitHub Actions (`firebase-adminsdk-fbsvc`) was missing deployment roles, failing the Firebase deploy step immediately.
* **Fix:** We granted the **Editor (편집자)** role to the service account `firebase-adminsdk-fbsvc@stock-f2ee7.iam.gserviceaccount.com` in GCP IAM Console to ensure successful Cloud Run and Functions deployment from GitHub.

---

## 3. Deployment Summary

The deployment completed successfully:

* **Status:** `✔ Deploy complete!`
* **Functions Deployed:**
  1. `api(us-central1)`
  2. `dailyReportCron(us-central1)`
  3. `eodCollectionCron(us-central1)`
  4. `hourlyMonitorCron(us-central1)`
  5. `weeklyBatchCron(us-central1)`
* **Function API Endpoint:** [https://api-gml5i27mma-uc.a.run.app](https://api-gml5i27mma-uc.a.run.app)
* **Assets API Endpoint Status:** `HTTP/2 200 OK` (Seeded and returning 17 active portfolio assets)

