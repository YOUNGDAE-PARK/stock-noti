import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getAbsoluteDbPath } from '../utils/paths.js';

dotenv.config();

const bucketName = 'stock-f2ee7.firebasestorage.app';

let storageBucket = null;

// Initialize Firebase Admin
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (serviceAccountJson) {
  try {
    const serviceAccount = JSON.parse(serviceAccountJson.trim());
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: bucketName
      });
    }
    storageBucket = admin.storage().bucket();
    console.log('[Storage Sync] Firebase Admin successfully initialized using service account.');
  } catch (err) {
    console.error('[Storage Sync] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', err.message);
  }
} else {
  try {
    // Attempt default initialization (Application Default Credentials in GCP)
    if (!admin.apps.length) {
      admin.initializeApp({
        storageBucket: bucketName
      });
    }
    storageBucket = admin.storage().bucket();
    console.log('[Storage Sync] Firebase Admin successfully initialized using Application Default Credentials (ADC).');
  } catch (err) {
    console.log('[Storage Sync] Firebase credentials not found. Operating in local-only offline mode.');
  }
}

/**
 * Downloads the SQLite database from Firebase Storage to local path.
 */
export async function downloadDbFromStorage() {
  if (!storageBucket) {
    console.log('[Storage Sync] Skipping download: running in offline local-only mode.');
    return false;
  }

  const absoluteDbPath = getAbsoluteDbPath();

  try {
    const remoteFile = storageBucket.file('stock_noti.db');
    const [exists] = await remoteFile.exists();

    if (!exists) {
      console.log('[Storage Sync] Remote stock_noti.db does not exist yet. Using local database.');
      return false;
    }

    // Ensure the local database directory exists
    const dbDir = path.dirname(absoluteDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    console.log(`[Storage Sync] Downloading database from gs://${bucketName}/stock_noti.db to ${absoluteDbPath}...`);
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
export async function uploadDbToStorage() {
  if (!storageBucket) {
    console.log('[Storage Sync] Skipping upload: running in offline local-only mode.');
    return false;
  }

  const absoluteDbPath = getAbsoluteDbPath();

  if (!fs.existsSync(absoluteDbPath)) {
    console.warn(`[Storage Sync] Local database file ${absoluteDbPath} does not exist. Skipping upload.`);
    return false;
  }

  try {
    console.log(`[Storage Sync] Uploading database from ${absoluteDbPath} to gs://${bucketName}/stock_noti.db...`);
    await storageBucket.upload(absoluteDbPath, {
      destination: 'stock_noti.db',
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

