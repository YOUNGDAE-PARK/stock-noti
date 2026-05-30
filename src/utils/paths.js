import path from 'path';

/**
 * Returns the absolute path to the SQLite database.
 * If running on Google Cloud Run/Firebase Functions, it forces the path to be in /tmp.
 */
export function getAbsoluteDbPath() {
  let dbPath = process.env.DATABASE_PATH || './data/stock_noti.db';
  
  if ((process.env.K_SERVICE || process.env.FIREBASE_CONFIG) && !process.env.FUNCTIONS_EMULATOR) {
    dbPath = '/tmp/stock_noti.db';
  }
  
  return path.resolve(dbPath);
}

/**
 * Returns the reports directory path.
 * If running on Google Cloud Run/Firebase Functions, it forces the path to be in /tmp.
 */
export function getReportsDir() {
  let reportDir = process.env.REPORTS_DIR || './reports';
  
  if ((process.env.K_SERVICE || process.env.FIREBASE_CONFIG) && !process.env.FUNCTIONS_EMULATOR) {
    reportDir = '/tmp/reports';
  }
  
  return reportDir;
}
