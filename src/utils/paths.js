import path from 'path';

/**
 * Returns the absolute path to the SQLite database.
 * If running on Google Cloud Run/Firebase Functions, it forces the path to be in /tmp.
 */
export function getAbsoluteDbPath(userId = null) {
  let filename = userId ? `user_${userId}.db` : 'stock_noti.db';
  let dbPath = process.env.DATABASE_PATH;
  
  if (dbPath) {
    // If DATABASE_PATH is defined, we use its directory for user-specific files
    const dbDir = path.dirname(dbPath);
    if (userId) {
      dbPath = path.join(dbDir, filename);
    }
  } else {
    dbPath = `./data/${filename}`;
  }
  
  if ((process.env.K_SERVICE || process.env.FIREBASE_CONFIG) && !process.env.FUNCTIONS_EMULATOR) {
    dbPath = `/tmp/${filename}`;
  }
  
  return path.resolve(dbPath);
}

/**
 * Returns the reports directory path.
 * If running on Google Cloud Run/Firebase Functions, it forces the path to be in /tmp.
 */
export function getReportsDir(userId = null) {
  let reportDir = process.env.REPORTS_DIR || './reports';
  
  if ((process.env.K_SERVICE || process.env.FIREBASE_CONFIG) && !process.env.FUNCTIONS_EMULATOR) {
    reportDir = '/tmp/reports';
  }

  if (userId) {
    return path.join(reportDir, 'users', userId);
  }
  
  return reportDir;
}
