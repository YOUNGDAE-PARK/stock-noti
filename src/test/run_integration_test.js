import { getDb } from '../db/db.js';
import { collectDartDisclosures } from '../services/collectors/dart.js';
import { collectNaverNews } from '../services/collectors/naverNews.js';
import { collectKrxMarketData } from '../services/collectors/krx.js';
import { collectKindRiskDisclosures } from '../services/collectors/kind.js';
import { collectIrNewsroomData } from '../services/collectors/ir.js';
import { consolidateEvents } from '../services/consolidator.js';
import { evaluateEvents } from '../services/judge.js';
import { generateDailyReport } from '../services/reports/dailyReport.js';

async function runIntegrationTest() {
  console.log('=== STARTING LIVE INTEGRATION TEST ===');
  const db = await getDb();

  // 1. Setup active IR registry for Samsung Electronics if not present
  console.log('Checking source registry seed...');
  const existingRegistry = await db.get('SELECT * FROM source_registry WHERE ticker = "005930" AND source_type = "IR"');
  if (!existingRegistry) {
    console.log('Inserting seed source registry for Samsung Electronics IR page...');
    await db.run(`
      INSERT INTO source_registry (
        ticker, source_type, source_url, domain, verified_by, verified_at, status
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
      [
        '005930',
        'IR',
        'https://www.samsung.com/sec/ir/',
        'https://www.samsung.com',
        'manual',
        'active'
      ]
    );
  }

  // 2. Fetch the current date for today's market query
  const todayStr = new Date().toISOString().substring(0, 10);
  console.log(`Running collectors for date: ${todayStr}`);

  // 3. Execute Collectors (Live calls)
  console.log('\n--- Step 1: Running Live Collectors ---');
  
  console.log('\n[1/5] Querying Naver Finance Chart for KRX prices...');
  await collectKrxMarketData(todayStr);

  console.log('\n[2/5] Fetching KIND Today RSS warnings...');
  await collectKindRiskDisclosures();

  console.log('\n[3/5] Querying Naver News Search (requires API keys)...');
  await collectNaverNews();

  console.log('\n[4/5] Crawling Corporate IR pages...');
  await collectIrNewsroomData();

  console.log('\n[5/5] Querying DART API (requires API keys)...');
  await collectDartDisclosures(todayStr, todayStr);

  // 4. Run Consolidator & Evaluation
  console.log('\n--- Step 2: Running Event Consolidation ---');
  await consolidateEvents();

  console.log('\n--- Step 3: Running JaaS Judgment ---');
  await evaluateEvents();

  // 5. Generate Daily Report
  console.log('\n--- Step 4: Generating Live Daily Report ---');
  const reportPath = await generateDailyReport(todayStr);

  if (reportPath) {
    console.log(`\n🎉 Live Integration Test Complete! Report file created at: ${reportPath}`);
  } else {
    console.log('\n⚠️ Live Integration Test Complete, but no report file was created (possibly no data collected).');
  }

  process.exit(0);
}

runIntegrationTest().catch(err => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
