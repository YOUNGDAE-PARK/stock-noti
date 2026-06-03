import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import dotenv from 'dotenv';

// Load environment variables immediately
dotenv.config();

import { app } from './src/services/api.js';
import { runEndOfDayCollection } from './src/app.js';
import { generateDailyReport } from './src/services/reports/dailyReport.js';
import { runHourlyAnalysis } from './src/services/reports/hourlyNoti.js';
import { runWeeklyBatch } from './src/services/weeklyBatch.js';
import { admin } from './src/db/storage_sync.js';

// Helper to get all active user IDs from Firebase Auth
async function getAllUserIds() {
  try {
    const listUsersResult = await admin.auth().listUsers();
    return listUsersResult.users.map(user => user.uid);
  } catch (err) {
    console.error('[Scheduler] Failed to list users:', err.message);
    return [];
  }
}

// 1. HTTP API Web Server Function
export const api = onRequest({
  cors: true,
  timeoutSeconds: 60,
  memory: '256MiB',
  invoker: 'public'
}, app);

// 2. Daily Report Batch: 08:00 AM KST
export const dailyReportCron = onSchedule({
  schedule: '0 8 * * *',
  timeZone: 'Asia/Seoul',
  timeoutSeconds: 300,
  memory: '512MiB'
}, async (event) => {
  console.log('[Scheduler] Triggering 8:00 AM Daily Report for all users...');
  const userIds = await getAllUserIds();
  for (const uid of userIds) {
    try {
      await generateDailyReport(null, uid);
    } catch (err) {
      console.error(`Daily Report failed for user ${uid}:`, err.message);
    }
  }
});

// 3. Hourly Real-time Monitor: Every hour from 09:00 to 16:00, Mon-Fri KST
export const hourlyMonitorCron = onSchedule({
  schedule: '0 9-16 * * 1-5',
  timeZone: 'Asia/Seoul',
  timeoutSeconds: 300,
  memory: '512MiB'
}, async (event) => {
  console.log('[Scheduler] Triggering hourly real-time analysis for all users...');
  const userIds = await getAllUserIds();
  for (const uid of userIds) {
    try {
      await runHourlyAnalysis(null, false, uid);
    } catch (err) {
      console.error(`Hourly Analysis failed for user ${uid}:`, err.message);
    }
  }
});

// 4. Post-market Bulk Ingestion Batch: Mon-Fri at 18:00 (6:00 PM) KST
export const eodCollectionCron = onSchedule({
  schedule: '0 18 * * 1-5',
  timeZone: 'Asia/Seoul',
  timeoutSeconds: 540,
  memory: '512MiB'
}, async (event) => {
  console.log('[Scheduler] Triggering EOD post-market bulk ingestion for all users...');
  const userIds = await getAllUserIds();
  for (const uid of userIds) {
    try {
      await runEndOfDayCollection(uid);
    } catch (err) {
      console.error(`EOD Ingestion failed for user ${uid}:`, err.message);
    }
  }
});

// 5. Weekly Operations Batch: Sunday at 21:00 PM KST
export const weeklyBatchCron = onSchedule({
  schedule: '0 21 * * 0',
  timeZone: 'Asia/Seoul',
  timeoutSeconds: 300,
  memory: '512MiB'
}, async (event) => {
  console.log('[Scheduler] Triggering Weekly operations batch for all users...');
  const userIds = await getAllUserIds();
  for (const uid of userIds) {
    try {
      await runWeeklyBatch(uid);
    } catch (err) {
      console.error(`Weekly operations failed for user ${uid}:`, err.message);
    }
  }
});
