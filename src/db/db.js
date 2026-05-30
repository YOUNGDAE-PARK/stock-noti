import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import dotenv from 'dotenv';

import { downloadDbFromStorage } from './storage_sync.js';
import { getAbsoluteDbPath } from '../utils/paths.js';

dotenv.config();

let dbInstance = null;
let dbDownloaded = false;

export async function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  const absoluteDbPath = getAbsoluteDbPath();
  
  // Ensure directory exists at runtime
  const dbDir = path.dirname(absoluteDbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
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

