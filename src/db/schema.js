import { initialAssets } from './seed_data.js';

/**
 * Initializes the SQLite database schema tables.
 * Used for both dynamic runtime initialization and setup scripts.
 */
export async function initializeSchema(db) {
  // 1. portfolio_asset table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio_asset (
      asset_id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_type TEXT NOT NULL CHECK(asset_type IN ('stock', 'etf')),
      ticker TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      market TEXT NOT NULL,
      holding_weight REAL DEFAULT 0.0,
      target_weight REAL DEFAULT 0.0,
      max_weight REAL DEFAULT 100.0,
      avg_price REAL DEFAULT 0.0,
      holding_qty REAL DEFAULT 0.0,
      investment_thesis TEXT,
      risk_keywords TEXT,
      watch_level TEXT DEFAULT 'normal' CHECK(watch_level IN ('high', 'normal', 'low')),
      is_active INTEGER DEFAULT 1 CHECK(is_active IN (0, 1)),
      corp_code TEXT -- OpenDART mapping code
    )
  `);

  // 2. source_registry table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS source_registry (
      source_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('IR', 'NEWSROOM', 'RSS', 'KIND', 'ETF_PAGE')),
      source_url TEXT,
      rss_url TEXT,
      domain TEXT,
      verified_by TEXT CHECK(verified_by IN ('manual', 'ai')),
      verified_at TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'needs_review', 'inactive')),
      fail_count INTEGER DEFAULT 0,
      FOREIGN KEY(ticker) REFERENCES portfolio_asset(ticker) ON DELETE CASCADE
    )
  `);

  // 3. raw_source_item table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS raw_source_item (
      raw_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL CHECK(source_type IN ('DART', 'IR', 'NEWS', 'KRX', 'KIND')),
      ticker TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      published_at TEXT,
      collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
      source_name TEXT,
      raw_hash TEXT UNIQUE,
      status TEXT DEFAULT 'new' CHECK(status IN ('new', 'merged', 'ignored')),
      FOREIGN KEY(ticker) REFERENCES portfolio_asset(ticker) ON DELETE CASCADE
    )
  `);

  // 4. investment_event table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS investment_event (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER,
      ticker TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_title TEXT NOT NULL,
      event_date TEXT NOT NULL,
      primary_source_type TEXT CHECK(primary_source_type IN ('DART', 'IR', 'KIND', 'NEWS')),
      primary_source_url TEXT,
      source_count INTEGER DEFAULT 1,
      reliability_score INTEGER CHECK(reliability_score BETWEEN 1 AND 5),
      impact_direction TEXT CHECK(impact_direction IN ('positive', 'negative', 'neutral')),
      impact_level TEXT CHECK(impact_level IN ('high', 'medium', 'low')),
      decision_signal TEXT CHECK(decision_signal IN ('매도검토', '비중축소', '보유', '추매검토', '관찰')),
      status TEXT DEFAULT 'needs_review' CHECK(status IN ('confirmed', 'needs_review', 'ignored')),
      ai_reason TEXT,
      FOREIGN KEY(asset_id) REFERENCES portfolio_asset(asset_id) ON DELETE SET NULL
    )
  `);

  // 5. event_source_link table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS event_source_link (
      event_id INTEGER NOT NULL,
      raw_id INTEGER NOT NULL,
      is_primary INTEGER DEFAULT 0 CHECK(is_primary IN (0, 1)),
      source_rank INTEGER,
      PRIMARY KEY (event_id, raw_id),
      FOREIGN KEY (event_id) REFERENCES investment_event(event_id) ON DELETE CASCADE,
      FOREIGN KEY (raw_id) REFERENCES raw_source_item(raw_id) ON DELETE CASCADE
    )
  `);

  // 6. market_snapshot_daily table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS market_snapshot_daily (
      date TEXT NOT NULL,
      ticker TEXT NOT NULL,
      close_price REAL NOT NULL,
      change_pct REAL,
      volume INTEGER,
      trading_value REAL,
      market_cap REAL,
      asset_type TEXT NOT NULL CHECK(asset_type IN ('stock', 'etf', 'index')),
      PRIMARY KEY (date, ticker)
    )
  `);

  // 7. corp_code_directory table for autocomplete search
  await db.exec(`
    CREATE TABLE IF NOT EXISTS corp_code_directory (
      ticker TEXT PRIMARY KEY,
      corp_name TEXT NOT NULL,
      corp_code TEXT NOT NULL
    )
  `);

  // 8. user_config table for personal settings
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_config (
      config_key TEXT PRIMARY KEY,
      config_value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 9. portfolio_delta_log table for tracking user actions
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
}

/**
 * Seeds default assets into the portfolio_asset table if empty.
 */
export async function seedDefaultAssets(db) {
  // Disabled default seeding to ensure user isolation is obvious.
  // Users now start with an empty portfolio.
  console.log('[DB Init] Portfolio is empty. Ready for user input.');
}
