import cron from 'node-cron';
import dotenv from 'dotenv';
import { getDb } from './db/db.js';
import { collectDartDisclosures } from './services/collectors/dart.js';
import { collectNaverNews } from './services/collectors/naverNews.js';
import { collectKrxMarketData } from './services/collectors/krx.js';
import { collectKindRiskDisclosures } from './services/collectors/kind.js';
import { collectIrNewsroomData } from './services/collectors/ir.js';
import { consolidateEvents } from './services/consolidator.js';
import { evaluateEvents } from './services/judge.js';
import { generateDailyReport } from './services/reports/dailyReport.js';
import { runHourlyAnalysis } from './services/reports/hourlyNoti.js';
import { startServer } from './services/api.js';
import { runWeeklyBatch } from './services/weeklyBatch.js';
import { admin, uploadDbToStorage } from './db/storage_sync.js';

dotenv.config();

// Helper to get all active users from Firebase Auth
async function getAllUsers() {
  try {
    const listUsersResult = await admin.auth().listUsers();
    return listUsersResult.users.map(user => ({ uid: user.uid, email: user.email }));
  } catch (err) {
    console.error('[App] Failed to list users from Firebase:', err.message);
    return [];
  }
}

// End of Day (EOD) Bulk Data Collection
export async function runEndOfDayCollection(userId = null) {
  console.log('\n======================================');
  console.log(`[EOD Collection] Starting market-close bulk download for user ${userId || 'global'} at ${new Date().toLocaleTimeString()}...`);
  console.log('======================================');

  const todayStr = new Date().toISOString().substring(0, 10);

  try {
    // 1. Collect from all sources
    console.log('[EOD] Collecting DART disclosures...');
    await collectDartDisclosures(todayStr, todayStr, userId);

    console.log('[EOD] Collecting KIND risk disclosures...');
    await collectKindRiskDisclosures(userId);

    console.log('[EOD] Collecting Naver News...');
    await collectNaverNews(userId);

    console.log('[EOD] Collecting KRX market pricing...');
    await collectKrxMarketData(todayStr, userId);

    console.log('[EOD] Collecting IR & Corporate Newsrooms...');
    await collectIrNewsroomData(userId);

    // 2. Consolidate (Phase 7)
    console.log('[EOD] Running Event Consolidator...');
    await consolidateEvents(userId);

    // 3. JaaS Judge Evaluation (Phase 8)
    console.log('[EOD] Running Judge as a Service analysis...');
    await evaluateEvents(userId);

    // Sync database file to Firebase Storage
    await uploadDbToStorage(userId);

    console.log(`[EOD Collection] Completed successfully for user ${userId || 'global'}.`);
  } catch (error) {
    console.error(`[EOD Collection] Failed for user ${userId || 'global'}:`, error.message);
  }
}

async function startApp() {
  console.log('Starting Stock-Noti Application...');
  
  // Start REST Web Server
  await startServer();

  // --- Cron Schedules Setup ---

  // 1. Daily Report Batch: Every day at 08:00 AM
  cron.schedule('0 8 * * *', async () => {
    console.log('[Scheduler] Triggering 8:00 AM Daily Report for all users...');
    const users = await getAllUsers();
    for (const user of users) {
      try {
        await generateDailyReport(null, user);
      } catch (err) {
        console.error(`Failed to generate daily report for user ${user.email}:`, err.message);
      }
    }
  });
  console.log('- Registered Cron: 8:00 AM Daily Comprehensive Report (Daily, Multi-user)');

  // 2. Hourly Real-time Monitor: Every hour from 09:00 to 16:00, Monday to Friday (trading hours)
  cron.schedule('0 9-16 * * 1-5', async () => {
    console.log('[Scheduler] Triggering hourly real-time analysis for all users...');
    const users = await getAllUsers();
    for (const user of users) {
      try {
        await runHourlyAnalysis(null, false, user);
      } catch (err) {
        console.error(`Failed to run hourly monitor for user ${user.email}:`, err.message);
      }
    }
  });
  console.log('- Registered Cron: Hourly short-term warning analysis (Mon-Fri, 09:00 - 16:00, Multi-user)');

  // 3. Post-market Bulk Ingestion Batch: Every Monday to Friday at 18:00 (6:00 PM) KST
  cron.schedule('0 18 * * 1-5', async () => {
    console.log('[Scheduler] Triggering EOD post-market bulk ingestion for all users...');
    const users = await getAllUsers();
    for (const user of users) {
      await runEndOfDayCollection(user.uid);
    }
  });
  console.log('- Registered Cron: 18:00 EOD Bulk Ingestion and Consolidation (Mon-Fri, Multi-user)');

  // 4. Weekly Operations Batch: Every Sunday at 21:00 PM KST
  cron.schedule('0 21 * * 0', async () => {
    console.log('[Scheduler] Triggering Weekly operations batch for all users...');
    const users = await getAllUsers();
    for (const user of users) {
      try {
        await runWeeklyBatch(user);
      } catch (err) {
        console.error(`Failed to run weekly batch for user ${user.email}:`, err.message);
      }
    }
  });
  console.log('- Registered Cron: 21:00 PM Weekly Operations Batch (Sunday, Multi-user)');

  console.log('\nStock-Noti Daemon is active and running in background.');
}

// Only boot the local app server & cron daemon if run directly (e.g. node src/app.js)
const isMain = process.argv[1] && (
  process.argv[1].endsWith('app.js') || 
  process.argv[1].endsWith('app')
);

if (isMain) {
  startApp().catch(err => {
    console.error('Application boot failed:', err.message);
  });
}
