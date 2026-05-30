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
import { uploadDbToStorage } from './db/storage_sync.js';

dotenv.config();

// End of Day (EOD) Bulk Data Collection
export async function runEndOfDayCollection() {
  console.log('\n======================================');
  console.log(`[EOD Collection] Starting market-close bulk download at ${new Date().toLocaleTimeString()}...`);
  console.log('======================================');

  const todayStr = new Date().toISOString().substring(0, 10);

  try {
    // 1. Collect from all sources
    console.log('[EOD] Collecting DART disclosures...');
    await collectDartDisclosures(todayStr, todayStr);

    console.log('[EOD] Collecting KIND risk disclosures...');
    await collectKindRiskDisclosures();

    console.log('[EOD] Collecting Naver News...');
    await collectNaverNews();

    console.log('[EOD] Collecting KRX market pricing...');
    await collectKrxMarketData(todayStr);

    console.log('[EOD] Collecting IR & Corporate Newsrooms...');
    await collectIrNewsroomData();

    // 2. Consolidate (Phase 7)
    console.log('[EOD] Running Event Consolidator...');
    await consolidateEvents();

    // 3. JaaS Judge Evaluation (Phase 8)
    console.log('[EOD] Running Judge as a Service analysis...');
    await evaluateEvents();

    // Sync database file to Firebase Storage
    await uploadDbToStorage();

    console.log('[EOD Collection] Completed successfully. Ready for morning report.');
  } catch (error) {
    console.error('[EOD Collection] Failed:', error.message);
  }
}

async function startApp() {
  console.log('Starting Stock-Noti Application...');
  
  // Verify database connection on bootup
  try {
    const db = await getDb();
    const assets = await db.get('SELECT count(*) as count FROM portfolio_asset');
    console.log(`Database connected. Found ${assets.count} assets in portfolio.`);
  } catch (err) {
    console.error('Failed to connect to database on startup. Ensure src/db/init.js has run.', err.message);
    process.exit(1);
  }

  // Start REST Web Server & Seed UI Dictionary
  await startServer();

  // --- Cron Schedules Setup ---

  // 1. Daily Report Batch: Every day at 08:00 AM
  // We schedule for 08:00 KST. If timezone is local, this triggers at 8 AM.
  cron.schedule('0 8 * * *', async () => {
    console.log('[Scheduler] Triggering 8:00 AM Daily Report...');
    try {
      await generateDailyReport();
    } catch (err) {
      console.error('Failed to generate daily report via cron:', err.message);
    }
  });
  console.log('- Registered Cron: 8:00 AM Daily Comprehensive Report (Daily)');

  // 2. Hourly Real-time Monitor: Every hour from 09:00 to 16:00, Monday to Friday (trading hours)
  cron.schedule('0 9-16 * * 1-5', async () => {
    console.log('[Scheduler] Triggering hourly real-time analysis...');
    try {
      await runHourlyAnalysis();
    } catch (err) {
      console.error('Failed to run hourly monitor via cron:', err.message);
    }
  });
  console.log('- Registered Cron: Hourly short-term warning analysis (Mon-Fri, 09:00 - 16:00)');

  // 3. Post-market Bulk Ingestion Batch: Every Monday to Friday at 18:00 (6:00 PM) KST
  cron.schedule('0 18 * * 1-5', async () => {
    console.log('[Scheduler] Triggering EOD post-market bulk ingestion...');
    await runEndOfOfDayCollection();
  });
  console.log('- Registered Cron: 18:00 EOD Bulk Ingestion and Consolidation (Mon-Fri)');

  // 4. Weekly Operations Batch: Every Sunday at 09:00 AM KST
  cron.schedule('0 9 * * 0', async () => {
    console.log('[Scheduler] Triggering Weekly operations batch (Weekly Rebalancing & AI repair)...');
    try {
      await runWeeklyBatch();
    } catch (err) {
      console.error('Failed to run weekly batch via cron:', err.message);
    }
  });
  console.log('- Registered Cron: 9:00 AM Weekly Operations Batch (Sunday)');

  console.log('\nStock-Noti Daemon is active and running in background.');
}

startApp().catch(err => {
  console.error('Application boot failed:', err.message);
});
