import { getDb } from '../db/db.js';
import { generateDailyReport } from '../services/reports/dailyReport.js';
import { runWeeklyBatch } from '../services/weeklyBatch.js';

async function simulate() {
  const db = await getDb();
  const warStartDate = '2026-02-28';
  const reportDate = '2026-03-01'; // 2026 is not a leap year, so Feb 29 doesn't exist. Using March 1st.

  console.log('--- Simulating Geopolitical Event: US-Iran War (Feb 28, 2026) ---');

  // 1. Insert Market Snapshots (Broad market drop)
  const assets = await db.all('SELECT ticker, name, asset_type FROM portfolio_asset WHERE is_active = 1');
  
  for (const asset of assets) {
    const dropPct = asset.asset_type === 'etf' ? -3.5 - Math.random() * 2 : -5.0 - Math.random() * 5;
    const prevPriceRes = await db.get('SELECT close_price FROM market_snapshot_daily WHERE ticker = ? ORDER BY date DESC LIMIT 1', [asset.ticker]);
    const prevPrice = prevPriceRes ? prevPriceRes.close_price : (asset.avg_price || 10000);
    const newPrice = Math.round(prevPrice * (1 + dropPct / 100));

    // Valid asset_type in market_snapshot_daily: 'stock', 'etf', 'index'
    await db.run(`
      INSERT OR REPLACE INTO market_snapshot_daily (date, ticker, close_price, change_pct, volume, trading_value, asset_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [warStartDate, asset.ticker, newPrice, parseFloat(dropPct.toFixed(2)), 1000000, newPrice * 1000000, asset.asset_type]);
  }
  console.log(`- Inserted market crash data for ${assets.length} assets on ${warStartDate}`);

  // 2. Insert Investment Events
  // Valid primary_source_type: 'DART', 'IR', 'KIND', 'NEWS'
  // Valid impact_level: 'high', 'medium', 'low'
  const geopoliticalEvent = {
    ticker: '069500', // KODEX 200 as proxy for broad market
    event_type: 'MACRO',
    event_title: '중동 지정학적 위기 고조: 미국-이란 전면전 개시',
    event_date: warStartDate,
    impact_direction: 'negative',
    impact_level: 'high',
    decision_signal: '비중축소',
    reliability_score: 5,
    ai_reason: '2026년 2월 28일부로 중동 지역 내 전면전이 개시됨에 따라 유가 급등 및 글로벌 공급망 마비 우려가 극대화되었습니다. 국내 증시 또한 지정학적 리스크 노출로 인해 단기 패닉 셀링이 관측되며, 안전 자산 선호 현상으로 자산 가치 하락 압력이 매우 높습니다.',
    primary_source_type: 'NEWS',
    primary_source_url: 'https://edition.cnn.com/world',
    source_count: 15
  };

  const res = await db.run(`
    INSERT INTO investment_event (
      ticker, event_type, event_title, event_date, impact_direction, impact_level,
      decision_signal, reliability_score, ai_reason, primary_source_type, primary_source_url, source_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    geopoliticalEvent.ticker, geopoliticalEvent.event_type, geopoliticalEvent.event_title, geopoliticalEvent.event_date,
    geopoliticalEvent.impact_direction, geopoliticalEvent.impact_level, geopoliticalEvent.decision_signal,
    geopoliticalEvent.reliability_score, geopoliticalEvent.ai_reason, geopoliticalEvent.primary_source_type,
    geopoliticalEvent.primary_source_url, geopoliticalEvent.source_count
  ]);
  
  const eventId = res.lastID;

  // Add sub-sources for depth
  await db.run(`
    INSERT INTO raw_source_item (ticker, source_type, title, url, collected_at, source_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `, ['069500', 'NEWS', 'Middle East Crisis: Oil Prices Surge as Conflict Escalates', 'https://reuters.com/world/me', warStartDate, 'Reuters']);

  const rawId = (await db.get('SELECT last_insert_rowid() as id')).id;
  await db.run(`INSERT INTO event_source_link (event_id, raw_id, is_primary) VALUES (?, ?, 0)`, [eventId, rawId]);

  console.log('- Inserted Critical Macro Event into investment_event table.');

  // 3. Generate Daily Report for the war start date
  console.log(`\n--- Generating Daily Report for ${warStartDate} ---`);
  await generateDailyReport(warStartDate);

  // 4. Generate Weekly Report for the following Sunday (assuming Mar 1st is the weekly batch day)
  console.log(`\n--- Generating Weekly Rebalance Report for ${reportDate} ---`);
  await runWeeklyBatch(reportDate);

  console.log('\nSimulation complete. Check the reports directory for the generated files.');
}

simulate().catch(err => console.error(err));
