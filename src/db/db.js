import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import dotenv from 'dotenv';

import { downloadDbFromStorage } from './storage_sync.js';
import { getAbsoluteDbPath } from '../utils/paths.js';
import { initializeSchema, seedDefaultAssets } from './schema.js';

dotenv.config();

let dbInstances = {};
let dbDownloaded = {};

export async function getDb(userId = null, userEmail = null) {
  const cacheKey = userId || 'global';
  if (dbInstances[cacheKey]) {
    return dbInstances[cacheKey];
  }

  const absoluteDbPath = getAbsoluteDbPath(userId);
  console.log(`[DB Instance] >>> ATTEMPTING TO OPEN: ${absoluteDbPath} (User: ${userEmail || userId || 'global'})`);

  // Ensure directory exists at runtime
  const dbDir = path.dirname(absoluteDbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // --- SPECIAL MIGRATION FOR PRE-DEFINED USER ---
  // If user is ydjava@gmail.com and personal DB doesn't exist OR is empty, migrate from global DB
  const isTargetUser = userId && userEmail === 'ydjava@gmail.com';
  let needsMigration = false;

  if (isTargetUser) {
    let currentAssetCount = 0;
    if (fs.existsSync(absoluteDbPath)) {
      try {
        const tempDb = await open({ filename: absoluteDbPath, driver: sqlite3.Database });
        const countRes = await tempDb.get('SELECT COUNT(*) as count FROM portfolio_asset');
        await tempDb.close();
        currentAssetCount = countRes ? countRes.count : 0;
      } catch (err) {
        currentAssetCount = 0;
      }
    } else {
      needsMigration = true;
    }

    // If it has 0 assets (even if file exists), it definitely needs migration
    if (currentAssetCount === 0) {
      needsMigration = true;
    }
  }

  if (needsMigration) {
    console.log(`[Migration] User ${userEmail} needs data migration. Source: legacy global DB.`);
    const globalDbPath = getAbsoluteDbPath(); // Path to global stock_noti.db
    if (fs.existsSync(globalDbPath)) {
      try {
        console.log(`[Migration] Copying ${globalDbPath} to ${absoluteDbPath}...`);
        fs.copyFileSync(globalDbPath, absoluteDbPath);
        console.log(`[Migration] Copy successful.`);
        dbDownloaded[cacheKey] = true; // Skip storage download since we just migrated fresh data
      } catch (copyErr) {
        console.error(`[Migration] Copy FAILED:`, copyErr.message);
      }
    } else {
      console.warn(`[Migration] Legacy global DB not found at ${globalDbPath}. Skipping migration.`);
    }
  }

  if (!dbDownloaded[cacheKey]) {
    try {
      console.log(`[DB Init] >>> STARTING Storage Download for ${cacheKey}...`);
      await downloadDbFromStorage(userId);
      dbDownloaded[cacheKey] = true;
      console.log(`[DB Init] >>> Storage Download FINISHED.`);
    } catch (err) {
      console.error(`[DB Init] Failed to sync download for user ${userId || 'global'} on startup:`, err.message);
    }
  }

  console.log(`[DB Instance] >>> CALLING SQLite Open: ${absoluteDbPath}`);
  const db = await open({
    filename: absoluteDbPath,
    driver: sqlite3.Database
  });

  console.log(`[DB Instance] >>> SQLite Open SUCCESS.`);

  // Enable foreign key support
  await db.run('PRAGMA foreign_keys = ON');

  // Dynamic schema initialization & seeding
  try {
    await db.get('SELECT 1 FROM portfolio_asset LIMIT 1');
  } catch (err) {
    if (err.message.includes('no such table')) {
      console.log(`[DB Init] "portfolio_asset" table not found for user ${userId || 'global'}. Auto-initializing schema and defaults...`);
      await initializeSchema(db);
      await seedDefaultAssets(db);

      // --- INITIALIZE SLACK WEBHOOK FOR TARGET USER ---
      if (userEmail === 'ydjava@gmail.com') {
        if (process.env.SLACK_WEBHOOK_URL) {
          console.log(`[DB Init] Seeding personal Slack Webhook for ${userEmail}`);
          await db.run(
            'INSERT OR REPLACE INTO user_config (config_key, config_value) VALUES (?, ?)',
            ['slack_webhook_url', process.env.SLACK_WEBHOOK_URL]
          );
        }
        if (process.env.SLACK_WEBHOOK_WEEKLY_URL) {
          await db.run(
            'INSERT OR REPLACE INTO user_config (config_key, config_value) VALUES (?, ?)',
            ['slack_webhook_weekly_url', process.env.SLACK_WEBHOOK_WEEKLY_URL]
          );
        }
        if (process.env.SLACK_WEBHOOK_URGENT_URL) {
          await db.run(
            'INSERT OR REPLACE INTO user_config (config_key, config_value) VALUES (?, ?)',
            ['slack_webhook_urgent_url', process.env.SLACK_WEBHOOK_URGENT_URL]
          );
        }
      }
    } else {
      throw err;
    }
  }

  // --- SCHEMA MIGRATION FOR UPDATED COLUMNS ---
  try {
    const columns = await db.all('PRAGMA table_info(portfolio_asset)');
    const columnNames = columns.map(c => c.name);
    if (!columnNames.includes('target_weight')) {
      console.log('[DB Migration] Adding target_weight to portfolio_asset...');
      await db.run('ALTER TABLE portfolio_asset ADD COLUMN target_weight REAL DEFAULT 0.0');
    }
    if (!columnNames.includes('max_weight')) {
      console.log('[DB Migration] Adding max_weight to portfolio_asset...');
      await db.run('ALTER TABLE portfolio_asset ADD COLUMN max_weight REAL DEFAULT 100.0');
    }
  } catch (migrationErr) {
    console.warn('[DB Migration] Column update failed:', migrationErr.message);
  }

  // --- MIGRATION: investment_event 팀 에이전트 분석 컬럼 추가 ---
  try {
    const ieColumns = await db.all('PRAGMA table_info(investment_event)');
    const ieColumnNames = ieColumns.map(c => c.name);
    const newIECols = [
      { name: 'technical_signal',   def: 'TEXT' },
      { name: 'fundamental_signal', def: 'TEXT' },
      { name: 'macro_signal',       def: 'TEXT' },
      { name: 'consensus_score',    def: 'INTEGER DEFAULT NULL' },
      { name: 'team_analysis',      def: 'TEXT' },
    ];
    for (const col of newIECols) {
      if (!ieColumnNames.includes(col.name)) {
        console.log(`[DB Migration] Adding ${col.name} to investment_event...`);
        await db.run(`ALTER TABLE investment_event ADD COLUMN ${col.name} ${col.def}`);
      }
    }
  } catch (migrationErr) {
    console.warn('[DB Migration] investment_event column update failed:', migrationErr.message);
  }

  // --- MIGRATION: CREATE portfolio_delta_log IF MISSING ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio_delta_log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      asset_name TEXT,
      action_type TEXT NOT NULL CHECK(action_type IN ('ADD', 'UPDATE', 'DELETE')),
      old_qty REAL,
      new_qty REAL,
      delta_qty REAL,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(ticker) REFERENCES portfolio_asset(ticker) ON DELETE CASCADE
    )
  `);

  // Ensure user_config exists (in case schema was initialized before this table was added)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_config (
      config_key TEXT PRIMARY KEY,
      config_value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Extra check for ydjava@gmail.com to ensure webhooks are always there if missing
  if (userEmail === 'ydjava@gmail.com') {
    const configs = [
      { key: 'slack_webhook_url', env: process.env.SLACK_WEBHOOK_URL },
      { key: 'slack_webhook_weekly_url', env: process.env.SLACK_WEBHOOK_WEEKLY_URL },
      { key: 'slack_webhook_urgent_url', env: process.env.SLACK_WEBHOOK_URGENT_URL }
    ];

    for (const conf of configs) {
      if (conf.env) {
        const existing = await db.get('SELECT config_value FROM user_config WHERE config_key = ?', [conf.key]);
        if (!existing || !existing.config_value) {
          await db.run('INSERT OR REPLACE INTO user_config (config_key, config_value) VALUES (?, ?)', 
            [conf.key, conf.env]);
        }
      }
    }
  }

  dbInstances[cacheKey] = db;
  return db;
}
