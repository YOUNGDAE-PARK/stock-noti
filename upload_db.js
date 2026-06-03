import admin from 'firebase-admin';
import fs from 'fs';

const projectId = 'stock-f2ee7';
const bucketName = 'stock-f2ee7.firebasestorage.app';

admin.initializeApp({
  storageBucket: bucketName,
  projectId: projectId
});

const bucket = admin.storage().bucket();
const userId = 'Ohzuuk3w3oTQ2iTLuxkjr9feyzp1';
const localPath = `./data/user_${userId}.db`;
const remotePath = `users/${userId}/stock_noti.db`;

async function upload() {
  if (!fs.existsSync(localPath)) {
    console.error(`Local file not found: ${localPath}`);
    return;
  }
  
  try {
    console.log(`Uploading ${localPath} to ${remotePath}...`);
    await bucket.upload(localPath, {
      destination: remotePath,
      metadata: {
        cacheControl: 'no-cache',
        contentType: 'application/x-sqlite3'
      }
    });
    console.log('Upload successful.');
  } catch (err) {
    console.error('Upload failed:', err.message);
  }
}

upload();
