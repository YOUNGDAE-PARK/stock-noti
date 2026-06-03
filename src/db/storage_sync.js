import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getAbsoluteDbPath } from '../utils/paths.js';

dotenv.config();

const bucketName = 'stock-f2ee7.firebasestorage.app';

let storageBucket = null;
let hasValidCredentials = false;

// Initialize Firebase Admin
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const projectId = process.env.FIREBASE_PROJECT_ID || 'stock-f2ee7';

if (serviceAccountJson) {
  try {
    let serviceAccount;
    const trimmedJson = serviceAccountJson.trim();
    if (trimmedJson.startsWith('{')) {
      serviceAccount = JSON.parse(trimmedJson);
    } else {
      const filePath = path.resolve(trimmedJson);
      if (fs.existsSync(filePath)) {
        serviceAccount = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } else {
        throw new Error(`Service account file not found at ${filePath}`);
      }
    }

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: bucketName,
        projectId: projectId
      });
    }
    hasValidCredentials = true;
    console.log('[Storage Sync] Firebase Admin initialized with Service Account.');
  } catch (err) {
    console.error('[Storage Sync] Service Account init failed:', err.message);
  }
}

// Fallback for Cloud Environment (Cloud Run/Functions) or ADC
if (!admin.apps.length && (process.env.K_SERVICE || process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  try {
    admin.initializeApp({
      storageBucket: bucketName,
      projectId: projectId
    });
    hasValidCredentials = true;
    console.log('[Storage Sync] Firebase Admin initialized via ADC/Cloud Environment.');
  } catch (err) {
    console.warn('[Storage Sync] ADC initialization failed.');
  }
}

// Final fallback for local middleware (Auth verification will fail, but server starts)
if (!admin.apps.length) {
  admin.initializeApp({ projectId: projectId });
  console.log('[Storage Sync] Firebase Admin initialized in LOCAL mode (No credentials).');
}

// Only enable Storage if we have confirmed credentials
if (hasValidCredentials) {
  try {
    storageBucket = admin.storage().bucket();
  } catch (err) {
    console.warn('[Storage Sync] Storage bucket access failed.');
  }
}

export { admin, storageBucket };

/**
 * Downloads the SQLite database from Firebase Storage to local path.
 */
export async function downloadDbFromStorage(userId = null) {
  if (!storageBucket) {
    console.log('[Storage Sync] Skipping download: running in offline local-only mode.');
    return false;
  }

  const absoluteDbPath = getAbsoluteDbPath(userId);
  const remotePath = userId ? `users/${userId}/stock_noti.db` : 'stock_noti.db';

  try {
    const remoteFile = storageBucket.file(remotePath);
    const [exists] = await remoteFile.exists();

    if (!exists) {
      console.log(`[Storage Sync] Remote ${remotePath} does not exist yet. Using local database.`);
      return false;
    }

    // Ensure the local database directory exists
    const dbDir = path.dirname(absoluteDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    console.log(`[Storage Sync] Downloading database from gs://${bucketName}/${remotePath} to ${absoluteDbPath}...`);
    await remoteFile.download({ destination: absoluteDbPath });
    console.log('[Storage Sync] Database download completed.');
    return true;
  } catch (err) {
    console.error('[Storage Sync] Failed to download database from storage:', err.message);
    return false;
  }
}

/**
 * Uploads the local SQLite database to Firebase Storage.
 */
export async function uploadDbToStorage(userId = null) {
  if (!storageBucket) {
    console.log('[Storage Sync] Skipping upload: running in offline local-only mode.');
    return false;
  }

  const absoluteDbPath = getAbsoluteDbPath(userId);
  const remotePath = userId ? `users/${userId}/stock_noti.db` : 'stock_noti.db';

  if (!fs.existsSync(absoluteDbPath)) {
    console.warn(`[Storage Sync] Local database file ${absoluteDbPath} does not exist. Skipping upload.`);
    return false;
  }

  try {
    console.log(`[Storage Sync] Uploading database from ${absoluteDbPath} to gs://${bucketName}/${remotePath}...`);
    await storageBucket.upload(absoluteDbPath, {
      destination: remotePath,
      metadata: {
        cacheControl: 'no-cache',
        contentType: 'application/x-sqlite3'
      }
    });
    console.log('[Storage Sync] Database upload completed.');
    return true;
  } catch (err) {
    console.error('[Storage Sync] Failed to upload database to storage:', err.message);
    return false;
  }
}

