import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import dotenv from 'dotenv';

import { downloadDbFromStorage } from './storage_sync.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DATABASE_PATH || './data/stock_noti.db';
const absoluteDbPath = path.resolve(dbPath);

// Ensure directory exists
const dbDir = path.dirname(absoluteDbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let dbInstance = null;
let dbDownloaded = false;

export async function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  if (!dbDownloaded) {
    try {
      await downloadDbFromStorage();
      dbDownloaded = true;
    } catch (err) {
      console.error('[DB Init] Failed to sync download from storage on startup:', err.message);
    }
  }

  dbInstance = await open({
    filename: absoluteDbPath,
    driver: sqlite3.Database
  });

  // Enable foreign key support
  await dbInstance.run('PRAGMA foreign_keys = ON');

  return dbInstance;
}
