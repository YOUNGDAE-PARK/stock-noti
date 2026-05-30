import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { app } from './src/services/api.js';
import { runEndOfDayCollection } from './src/app.js';
import { generateDailyReport } from './src/services/reports/dailyReport.js';
import { runHourlyAnalysis } from './src/services/reports/hourlyNoti.js';
import { runWeeklyBatch } from './src/services/weeklyBatch.js';

// 1. HTTP API Web Server Function
export const api = onRequest({
  cors: true,
  timeoutSeconds: 60,
  memory: '256MiB'
}, app);

// 2. Daily Report Batch: 08:00 AM KST
export const dailyReportCron = onSchedule({
  schedule: '0 8 * * *',
  timeZone: 'Asia/Seoul',
  timeoutSeconds: 300,
  memory: '512MiB'
}, async (event) => {
  console.log('[Scheduler] Triggering 8:00 AM Daily Report...');
  try {
    await generateDailyReport();
    console.log('[Scheduler] Daily Report completed successfully.');
  } catch (err) {
    console.error('[Scheduler] Daily Report failed:', err.message);
  }
});

// 3. Hourly Real-time Monitor: Every hour from 09:00 to 16:00, Mon-Fri KST
export const hourlyMonitorCron = onSchedule({
  schedule: '0 9-16 * * 1-5',
  timeZone: 'Asia/Seoul',
  timeoutSeconds: 300,
  memory: '512MiB'
}, async (event) => {
  console.log('[Scheduler] Triggering hourly real-time analysis...');
  try {
    await runHourlyAnalysis();
    console.log('[Scheduler] Hourly Analysis completed.');
  } catch (err) {
    console.error('[Scheduler] Hourly Analysis failed:', err.message);
  }
});

// 4. Post-market Bulk Ingestion Batch: Mon-Fri at 18:00 (6:00 PM) KST
export const eodCollectionCron = onSchedule({
  schedule: '0 18 * * 1-5',
  timeZone: 'Asia/Seoul',
  timeoutSeconds: 540,
  memory: '512MiB'
}, async (event) => {
  console.log('[Scheduler] Triggering EOD post-market bulk ingestion...');
  try {
    await runEndOfDayCollection();
    console.log('[Scheduler] EOD Ingestion and Evaluation completed.');
  } catch (err) {
    console.error('[Scheduler] EOD Ingestion failed:', err.message);
  }
});

// 5. Weekly Operations Batch: Sunday at 09:00 AM KST
export const weeklyBatchCron = onSchedule({
  schedule: '0 9 * * 0',
  timeZone: 'Asia/Seoul',
  timeoutSeconds: 300,
  memory: '512MiB'
}, async (event) => {
  console.log('[Scheduler] Triggering Weekly operations batch...');
  try {
    await runWeeklyBatch();
    console.log('[Scheduler] Weekly operations batch completed.');
  } catch (err) {
    console.error('[Scheduler] Weekly operations failed:', err.message);
  }
});
