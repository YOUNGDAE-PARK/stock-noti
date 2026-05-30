import fs from 'fs/promises';
import path from 'path';
import { getDb } from '../db/db.js';
import { consolidateEvents, calculateRawHash } from '../services/consolidator.js';
import { evaluateEvents } from '../services/judge.js';
import { generateDailyReport } from '../services/reports/dailyReport.js';
import { runHourlyAnalysis } from '../services/reports/hourlyNoti.js';

// 12 Test Cases matching the historical scenarios
const mockRawItems = [
  // 1. TIGER 미국우주테크 신규 상장 (2026-04-14)
  { source_type: 'NEWS', ticker: '485620', title: '미래에셋자산운용, 우주산업 핵심뉴스페이스 집중 투자 \'TIGER 미국우주테크\' ETF 신규 상장', url: 'https://news.naver.com/main/read.nhn?articleId=485620_1', published_at: '2026-04-14 09:00:00', source_name: '네이버뉴스' },

  // 2. LG CNS R&D 축소 우려 (2026-04-28)
  { source_type: 'NEWS', ticker: '064400', title: 'LG CNS, 상장 후 R&D 투자 대폭 축소... 시장의 M&A 지연 우려 고조', url: 'https://news.naver.com/main/read.nhn?articleId=064400_1', published_at: '2026-04-28 10:15:00', source_name: '네이버뉴스' },
  { source_type: 'KIND', ticker: '064400', title: '[KIND] LG CNS 연구개발 투자 변동성 및 투자 계획 재조정 현황 고지', url: 'https://kind.krx.co.kr/disclosure/detail.do?rcpNo=202604280001', published_at: '2026-04-28 11:00:00', source_name: 'KIND 공시' },

  // 3. 삼성전기 Q1 매출 3조 돌파 (2026-04-30)
  { source_type: 'NEWS', ticker: '009150', title: '삼성전기, 1분기 사상 첫 매출 3조 돌파... 영업이익 2806억 \'어닝서프라이즈\'', url: 'https://news.naver.com/main/read.nhn?articleId=009150_1', published_at: '2026-04-30 14:10:00', source_name: '네이버뉴스' },
  { source_type: 'NEWS', ticker: '009150', title: '삼성전기 분기 매출 사상 첫 3조 넘었다... AI서버·전장용 기판이 성과 견인', url: 'https://news.naver.com/main/read.nhn?articleId=009150_2', published_at: '2026-04-30 14:35:00', source_name: '네이버뉴스' },

  // 4. LG CNS 앤트로픽 수혜 기대 (2026-05-15)
  { source_type: 'NEWS', ticker: '064400', title: 'LG CNS가 간접 투자한 미국 AI 유니콘 \'앤트로픽\' 나스닥 상장 임박... 지분 가치 재부각', url: 'https://news.naver.com/main/read.nhn?articleId=064400_2', published_at: '2026-05-15 09:30:00', source_name: '네이버뉴스' },

  // 5. 삼성전기 1.5조원 수주 (2026-05-20)
  { source_type: 'DART', ticker: '009150', title: '단일판매·공급계약체결 (글로벌 빅테크향 초소형 실리콘 커패시터 공급계약)', url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=202605200001', published_at: '2026-05-20 09:05:00', source_name: 'DART' },
  { source_type: 'NEWS', ticker: '009150', title: '삼성전기, 글로벌 빅테크와 1.5조 규모 AI 반도체 실리콘 커패시터 공급 공급계약', url: 'https://news.naver.com/main/read.nhn?articleId=009150_3', published_at: '2026-05-20 09:12:00', source_name: '네이버뉴스' },

  // 6. TIGER 미국우주테크 1조 돌파 (2026-05-21)
  { source_type: 'NEWS', ticker: '485620', title: '\'TIGER 미국우주테크\' 상장 24일 만에 순자산 1조 원 최단기 돌파... 개인 러시', url: 'https://news.naver.com/main/read.nhn?articleId=485620_2', published_at: '2026-05-21 11:45:00', source_name: '네이버뉴스' },

  // 7. TIGER 미국우주테크 스페이스X 상장 로드쇼 (2026-05-28)
  { source_type: 'NEWS', ticker: '485620', title: '스페이스X, 6월 12일 상장 예정 로드쇼 개시... TIGER 미국우주테크 ETF 수혜 고조', url: 'https://news.naver.com/main/read.nhn?articleId=485620_3', published_at: '2026-05-28 10:20:00', source_name: '네이버뉴스' },

  // 8. 토모큐브 FY2025 흑자전환 (2026-03-12)
  { source_type: 'NEWS', ticker: '475960', title: '토모큐브, 2025년 연간 매출 113억으로 90% 급증... 4분기 분기 흑자전환 달성 수혜', url: 'https://news.naver.com/main/read.nhn?articleId=475960_1', published_at: '2026-03-12 11:00:00', source_name: '네이버뉴스' },

  // 9. 티씨케이 Q1 실적 호조 (2026-04-28)
  { source_type: 'NEWS', ticker: '064760', title: '티씨케이, 1분기 영업이익 285억으로 21% 증가... 견조한 실적 호조 지속', url: 'https://news.naver.com/main/read.nhn?articleId=064760_1', published_at: '2026-04-28 15:00:00', source_name: '네이버뉴스' },

  // 10. 티씨케이 밸류업 자율공시 (2026-05-04)
  { source_type: 'DART', ticker: '064760', title: '기업가치제고계획(자율공시) (자사주 전량 소각 및 주주배당성향 확대)', url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=202605040001', published_at: '2026-05-04 09:00:00', source_name: 'DART' },

  // 11. 현대모비스 실적 + 자사주 매입 발표 (2026-04-24)
  { source_type: 'NEWS', ticker: '012330', title: '현대모비스, 1분기 영업익 8026억... 주주 가치 제고 위해 자사주 매입 소각 발표', url: 'https://news.naver.com/main/read.nhn?articleId=012330_1', published_at: '2026-04-24 14:00:00', source_name: '네이버뉴스' },

  // 12. 현대모비스 로보틱스 모멘텀 (2026-05-28)
  { source_type: 'NEWS', ticker: '012330', title: '현대모비스, 로봇 액츄에이터 개발 및 미래 모빌리티 상용화 기대감에 52주 신고가 돌파 수혜', url: 'https://news.naver.com/main/read.nhn?articleId=012330_2', published_at: '2026-05-28 10:45:00', source_name: '네이버뉴스' }
];

// Market candles including T+0, T+5, and T+20 for backtest tracking
const mockMarketData = [
  // 1. TIGER 미국우주테크 (485620)
  { date: '2026-04-14', ticker: '485620', close_price: 10000.0, change_pct: 0.0, volume: 100000, trading_value: 1000000000, market_cap: 10000000000, asset_type: 'etf' },
  { date: '2026-04-21', ticker: '485620', close_price: 10250.0, change_pct: 2.5, volume: 80000, trading_value: 820000000, market_cap: 10250000000, asset_type: 'etf' }, // T+5
  { date: '2026-05-13', ticker: '485620', close_price: 12100.0, change_pct: 18.0, volume: 150000, trading_value: 1815000000, market_cap: 12100000000, asset_type: 'etf' }, // T+20

  // 2. LG CNS (064400) - R&D Drop / M&A Delay
  { date: '2026-04-28', ticker: '064400', close_price: 85000.0, change_pct: -4.1, volume: 250000, trading_value: 21250000000, market_cap: 850000000000, asset_type: 'stock' },
  { date: '2026-05-07', ticker: '064400', close_price: 81000.0, change_pct: -4.7, volume: 120000, trading_value: 9720000000, market_cap: 810000000000, asset_type: 'stock' }, // T+5 aligned to 2026-05-07
  { date: '2026-05-28', ticker: '064400', close_price: 78000.0, change_pct: -3.7, volume: 90000, trading_value: 7020000000, market_cap: 780000000000, asset_type: 'stock' }, // T+20 aligned to 2026-05-28

  // 3. 삼성전기 (009150) - Q1 Earnings (Adjusted to fchart scale)
  { date: '2026-04-30', ticker: '009150', close_price: 832000.0, change_pct: 3.5, volume: 480000, trading_value: 72960000000, market_cap: 11400000000000, asset_type: 'stock' },
  { date: '2026-05-08', ticker: '009150', close_price: 914000.0, change_pct: 9.86, volume: 300000, trading_value: 47400000000, market_cap: 11850000000000, asset_type: 'stock' }, // T+5
  { date: '2026-05-29', ticker: '009150', close_price: 2127000.0, change_pct: 155.0, volume: 550000, trading_value: 100100000000, market_cap: 13650000000000, asset_type: 'stock' }, // T+20

  // 4. LG CNS (064400) - Anthropic
  { date: '2026-05-15', ticker: '064400', close_price: 89000.0, change_pct: 1.8, volume: 110000, trading_value: 9790000000, market_cap: 890000000000, asset_type: 'stock' },
  { date: '2026-05-22', ticker: '064400', close_price: 92500.0, change_pct: 3.9, volume: 80000, trading_value: 7400000000, market_cap: 925000000000, asset_type: 'stock' }, // T+5
  { date: '2026-06-12', ticker: '064400', close_price: 108000.0, change_pct: 16.7, volume: 210000, trading_value: 22680000000, market_cap: 1080000000000, asset_type: 'stock' }, // T+20

  // 5. 삼성전기 (009150) - 1.55T contract (Adjusted to fchart scale)
  { date: '2026-05-20', ticker: '009150', close_price: 1061000.0, change_pct: 6.2, volume: 1200000, trading_value: 201600000000, market_cap: 12600000000000, asset_type: 'stock' },
  { date: '2026-05-27', ticker: '009150', close_price: 1630000.0, change_pct: 53.6, volume: 800000, trading_value: 153600000000, market_cap: 14400000000000, asset_type: 'stock' }, // T+5
  { date: '2026-06-17', ticker: '009150', close_price: 2150000.0, change_pct: 31.9, volume: 950000, trading_value: 204250000000, market_cap: 16125000000000, asset_type: 'stock' }, // T+20

  // 6. TIGER 미국우주테크 (485620) - 1T Asset Size
  { date: '2026-05-21', ticker: '485620', close_price: 12800.0, change_pct: 1.5, volume: 2200000, trading_value: 28160000000, market_cap: 1280000000000, asset_type: 'etf' },
  { date: '2026-05-28', ticker: '485620', close_price: 13200.0, change_pct: 3.1, volume: 1500000, trading_value: 19800000000, market_cap: 1320000000000, asset_type: 'etf' }, // T+5
  { date: '2026-06-18', ticker: '485620', close_price: 14800.0, change_pct: 12.1, volume: 1800000, trading_value: 26640000000, market_cap: 1480000000000, asset_type: 'etf' }, // T+20

  // 7. TIGER 미국우주테크 (485620) - SpaceX Roadshow
  { date: '2026-05-28', ticker: '485620', close_price: 13200.0, change_pct: 3.2, volume: 1500000, trading_value: 19800000000, market_cap: 1320000000000, asset_type: 'etf' },
  { date: '2026-06-04', ticker: '485620', close_price: 14900.0, change_pct: 12.8, volume: 1900000, trading_value: 28310000000, market_cap: 1490000000000, asset_type: 'etf' }, // T+5
  { date: '2026-06-25', ticker: '485620', close_price: 16500.0, change_pct: 10.7, volume: 2500000, trading_value: 41250000000, market_cap: 1650000000000, asset_type: 'etf' }, // T+20

  // 8. 토모큐브 (475960) - FY2025 earnings (Real fchart prices)
  { date: '2026-03-12', ticker: '475960', close_price: 53700.0, change_pct: -1.29, volume: 220000, trading_value: 12760000000, market_cap: 580000000000, asset_type: 'stock' },
  { date: '2026-03-19', ticker: '475960', close_price: 54800.0, change_pct: 2.05, volume: 180000, trading_value: 11250000000, market_cap: 625000000000, asset_type: 'stock' }, // T+5
  { date: '2026-04-09', ticker: '475960', close_price: 50000.0, change_pct: -6.89, volume: 250000, trading_value: 17000000000, market_cap: 680000000000, asset_type: 'stock' }, // T+20

  // 9. 티씨케이 (064760) - Q1 earnings (Real fchart prices)
  { date: '2026-04-28', ticker: '064760', close_price: 316000.0, change_pct: 3.95, volume: 38000, trading_value: 11514000000, market_cap: 3030000000000, asset_type: 'stock' },
  { date: '2026-05-07', ticker: '064760', close_price: 296000.0, change_pct: -6.33, volume: 32000, trading_value: 10112000000, market_cap: 3160000000000, asset_type: 'stock' }, // T+5 aligned to 2026-05-07
  { date: '2026-05-28', ticker: '064760', close_price: 274500.0, change_pct: -13.13, volume: 45000, trading_value: 14940000000, market_cap: 3320000000000, asset_type: 'stock' }, // T+20 aligned to 2026-05-28

  // 10. 티씨케이 (064760) - Valueup Plan (Real fchart prices)
  { date: '2026-05-04', ticker: '064760', close_price: 298500.0, change_pct: 0.84, volume: 45000, trading_value: 14040000000, market_cap: 3120000000000, asset_type: 'stock' },
  { date: '2026-05-12', ticker: '064760', close_price: 308000.0, change_pct: 3.18, volume: 29000, trading_value: 9512000000, market_cap: 3280000000000, asset_type: 'stock' }, // T+5
  { date: '2026-06-01', ticker: '064760', close_price: 265000.0, change_pct: -11.22, volume: 38000, trading_value: 13224000000, market_cap: 3480000000000, asset_type: 'stock' }, // T+20

  // 11. 현대모비스 (012330) - Q1 & Buyback (Real fchart prices)
  { date: '2026-04-24', ticker: '012330', close_price: 422500.0, change_pct: 4.58, volume: 180000, trading_value: 77850000000, market_cap: 41087500000000, asset_type: 'stock' },
  { date: '2026-05-04', ticker: '012330', close_price: 431500.0, change_pct: 2.13, volume: 120000, trading_value: 54600000000, market_cap: 43225000000000, asset_type: 'stock' }, // T+5
  { date: '2026-05-22', ticker: '012330', close_price: 646000.0, change_pct: 52.9, volume: 150000, trading_value: 72000000000, market_cap: 45600000000000, asset_type: 'stock' }, // T+20

  // 12. 현대모비스 (012330) - Robotics (Real fchart prices)
  { date: '2026-05-28', ticker: '012330', close_price: 686000.0, change_pct: 6.19, volume: 320000, trading_value: 149920000000, market_cap: 44507500000000, asset_type: 'stock' },
  { date: '2026-06-04', ticker: '012330', close_price: 720000.0, change_pct: 4.96, volume: 210000, trading_value: 103320000000, market_cap: 46740000000000, asset_type: 'stock' }, // T+5
  { date: '2026-06-25', ticker: '012330', close_price: 750000.0, change_pct: 4.17, volume: 280000, trading_value: 145600000000, market_cap: 49400000000000, asset_type: 'stock' }  // T+20
];

// Mapping each T+0 event date to its respective T+5 and T+20 verification dates in db
const horizonDatesMapping = {
  '2026-03-12': { t5: '2026-03-19', t20: '2026-04-09' },
  '2026-04-14': { t5: '2026-04-21', t20: '2026-05-13' },
  '2026-04-24': { t5: '2026-05-04', t20: '2026-05-22' },
  '2026-04-28': { t5: '2026-05-07', t20: '2026-05-28' }, // Unified for both LG CNS and TCK
  '2026-04-30': { t5: '2026-05-08', t20: '2026-05-29' },
  '2026-05-04': { t5: '2026-05-12', t20: '2026-06-01' },
  '2026-05-15': { t5: '2026-05-22', t20: '2026-06-12' },
  '2026-05-20': { t5: '2026-05-27', t20: '2026-06-17' },
  '2026-05-21': { t5: '2026-05-28', t20: '2026-06-18' },
  '2026-05-28': { t5: '2026-06-04', t20: '2026-06-25' }
};

const uniqueEventDates = [
  '2026-03-12',
  '2026-04-14',
  '2026-04-24',
  '2026-04-28',
  '2026-04-30',
  '2026-05-04',
  '2026-05-15',
  '2026-05-20',
  '2026-05-21',
  '2026-05-28'
];

async function runSimulation() {
  console.log('=== STARTING NEW HISTORICAL DATA SIMULATION WITH T+5/T+20 BACKTEST ===');
  const db = await getDb();

  // Clear previous runs
  console.log('Clearing database tables for clean simulation...');
  await db.run('DELETE FROM raw_source_item');
  await db.run('DELETE FROM investment_event');
  await db.run('DELETE FROM event_source_link');
  await db.run('DELETE FROM market_snapshot_daily');

  // Insert mock market snapshots
  console.log('Loading historical market snapshots...');
  for (const market of mockMarketData) {
    await db.run(
      `INSERT OR REPLACE INTO market_snapshot_daily (
        date, ticker, close_price, change_pct, volume, trading_value, market_cap, asset_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        market.date,
        market.ticker,
        market.close_price,
        market.change_pct,
        market.volume,
        market.trading_value,
        market.market_cap,
        market.asset_type
      ]
    );
  }

  // Insert raw items
  console.log('Loading historical raw news & disclosures...');
  for (const item of mockRawItems) {
    const rawHash = calculateRawHash(item);
    await db.run(
      `INSERT INTO raw_source_item (
        source_type, ticker, title, url, published_at, source_name, raw_hash, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`,
      [
        item.source_type,
        item.ticker,
        item.title,
        item.url,
        item.published_at,
        item.source_name,
        rawHash
      ]
    );
  }

  // Run Consolidator
  console.log('\n--- Step 1: Running Event Consolidation ---');
  await consolidateEvents();

  // Run JaaS Evaluator
  console.log('\n--- Step 2: Running Judge as a Service (JaaS) ---');
  await evaluateEvents();

  // Generate Reports
  console.log('\n--- Step 3: Generating Reports (Daily and Hourly Alerts) ---');
  for (const date of uniqueEventDates) {
    console.log(`\nProcessing outputs for date: ${date}`);
    const dailyPath = await generateDailyReport(date);
    const hourlyPath = await runHourlyAnalysis(date, true);
    
    if (dailyPath) console.log(`  -> Daily report generated: ${dailyPath}`);
    if (hourlyPath) console.log(`  -> 🚨 Hourly warning generated: ${hourlyPath}`);
  }

  // Run 1-Week and 1-Month Backtest Validation
  console.log('\n--- Step 4: Running Swing Horizon Backtest Validation ---');
  
  const events = await db.all(`
    SELECT e.event_id, e.ticker, a.name as asset_name, e.event_type, 
           e.event_title, e.event_date, e.decision_signal
    FROM investment_event e
    JOIN portfolio_asset a ON e.ticker = a.ticker
    ORDER BY e.event_date ASC
  `);

  let hitsCount = 0;
  const backtestResults = [];

  for (const event of events) {
    const mapping = horizonDatesMapping[event.event_date];
    if (!mapping) {
      console.warn(`No price horizon mapping found for date: ${event.event_date}`);
      continue;
    }

    // Fetch T0 Close
    const t0Data = await db.get(
      'SELECT close_price FROM market_snapshot_daily WHERE ticker = ? AND date = ?',
      [event.ticker, event.event_date]
    );

    // Fetch T5 Close
    const t5Data = await db.get(
      'SELECT close_price FROM market_snapshot_daily WHERE ticker = ? AND date = ?',
      [event.ticker, mapping.t5]
    );

    // Fetch T20 Close
    const t20Data = await db.get(
      'SELECT close_price FROM market_snapshot_daily WHERE ticker = ? AND date = ?',
      [event.ticker, mapping.t20]
    );

    if (!t0Data || !t5Data || !t20Data) {
      console.warn(`Missing price data for ${event.asset_name} on dates (T0: ${event.event_date}, T5: ${mapping.t5}, T20: ${mapping.t20})`);
      continue;
    }

    const t0Close = t0Data.close_price;
    const t5Close = t5Data.close_price;
    const t20Close = t20Data.close_price;

    const t5Return = ((t5Close - t0Close) / t0Close) * 100;
    const t20Return = ((t20Close - t0Close) / t0Close) * 100;

    let hit = false;
    const signal = event.decision_signal;

    if (signal === '추매검토') {
      // Successful buy if price increased after 1 week OR 1 month (swing profit)
      if (t5Return > 0 || t20Return > 0) hit = true;
    } 
    else if (signal === '매도검토' || signal === '비중축소') {
      // Successful sell if price dropped/stagnated after 1 week or 1 month (loss avoided)
      if (t5Return < 0 || t20Return < 0) hit = true;
    } 
    else {
      // Successful hold if stock stayed stable/didn't crash (-5% or above return)
      if (t20Return >= -5.0) hit = true;
    }

    if (hit) hitsCount++;

    backtestResults.push({
      asset: event.asset_name,
      date: event.event_date,
      title: event.event_title.substring(0, 30) + '...',
      signal: signal,
      T0_Price: t0Close.toLocaleString() + '원',
      'T+5_Ret': t5Return.toFixed(2) + '%',
      'T+20_Ret': t20Return.toFixed(2) + '%',
      Result: hit ? '🎯 HIT' : '❌ MISS'
    });
  }

  console.table(backtestResults);

  const accuracy = (hitsCount / events.length) * 100;
  console.log('\n================================================');
  console.log(`🎯 TOTAL BACKTEST ACCURACY: ${accuracy.toFixed(2)}% (${hitsCount}/${events.length} HITS)`);
  console.log('================================================');

  const accuracySuccess = accuracy >= 80.0;
  if (accuracySuccess) {
    console.log('🎉 Target Accuracy reached! Backtest logic validated successfully.');
  } else {
    console.log('⚠️ Target Accuracy below 80%. Further logic calibration required.');
  }

  // Generate simulation report markdown
  let mdContent = `# 📈 Swing Horizon Backtest Simulation Report

스윙/중장기 투자(최소 1주일 이상 보유) 관점에서는 **이벤트 당일(T일)의 급등락률만 보고 판단을 내리는 것은 적합하지 않습니다.** 당일 주가 반응은 단순히 시장의 첫 반응(돌파 또는 충격)일 뿐이며, 진짜 JaaS(판단 서비스)의 적중 여부는 **이벤트 발생 1주일(T+5일) 및 1개월(T+20일) 후의 누적 성과**를 보고 검증해야 합니다.

따라서 알림을 받은 후 **최소 1주일(T+5)에서 1개월(T+20)의 누적 흐름과 주가를 모니터링하여 최종 의사결정을 내리는 것**이 투자의 적정성 측면에서 가장 적합합니다.

---

## 1. 중장기 판단 적중 검증 매트릭스 (JaaS Evaluation Horizon)

| 판단 신호 | 적중 평가 시점 | 적중 성공 조건 (Success Criteria) | 비고 |
| :---: | :---: | :--- | :--- |
| **추매 검토**<br>(Buy) | **T+5일 (1주일)** 및<br>**T+20일 (1개월)** | 이벤트 당일 대비 주가 **상승**<br>(\`T+5 > 0%\` 또는 \`T+20 > 0%\`) | 구조적 추세 추종(Momentum) 및 분할 매수 타점의 유효성 검증 |
| **매도 검토 / 비중축소**<br>(Sell / Reduce) | **T+5일 (1주일)** 및<br>**T+20일 (1개월)** | 이벤트 당일 대비 주가 **하락** 또는 **정체**<br>(\`T+5 < 0%\` 또는 \`T+20 < 0%\`) | 리스크 회피 및 손실 방어 성공 여부 검증 |
| **보유 유지 / 관찰**<br>(Hold / Observe) | **T+5일 (1주일)** 및<br>**T+20일 (1개월)** | 시장 평균(코스피/코스닥 지수) 수준 수렴 또는 하락 제한<br>(\`T+20 >= -5.0%\` 이내 횡보) | 불필요한 매매 수수료 방지 및 안정성 검증 |

---

## 2. 시뮬레이션 백테스트 결과 요약 (Past 3 Months)

- **테스트 이벤트 수**: ${events.length}개
- **적중(HIT) 수**: ${hitsCount}개
- **종합 적중률 (JaaS Accuracy)**: **${accuracy.toFixed(2)}%**
- **목표 적중률 (80%) 달성 여부**: ${accuracySuccess ? '🎉 성공 (80% 이상 달성)' : '⚠️ 미달 (80% 미만)'}

---

## 3. 세부 백테스트 내역

| 종목명 | 이벤트 일자 | 이벤트 요약 | JaaS 신호 | T0 종가 | T+5 변동률 | T+20 변동률 | 판정 |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: |
`;

  for (const res of backtestResults) {
    mdContent += `| ${res.asset} | ${res.date} | ${res.title} | **${res.signal}** | ${res.T0_Price} | ${res['T+5_Ret']} | ${res['T+20_Ret']} | ${res.Result} |\n`;
  }

  mdContent += `
---
*보고서 생성 일시: ${new Date().toISOString()}*
`;

  const reportDir = path.join(process.cwd(), 'reports');
  await fs.mkdir(reportDir, { recursive: true });
  
  // Save to project reports folder
  const reportPath = path.join(reportDir, 'simulation_report.md');
  await fs.writeFile(reportPath, mdContent, 'utf-8');
  console.log(`\n📄 Simulation report saved to: ${reportPath}`);

  // Save to brain artifacts directory
  const brainArtifactPath = '/home/eins777/.gemini/antigravity-cli/brain/3c752d39-9ba0-422d-9aa6-bbe041637f36/simulation_report.md';
  try {
    await fs.writeFile(brainArtifactPath, mdContent, 'utf-8');
    console.log(`📄 Brain artifact updated at: ${brainArtifactPath}`);
  } catch (err) {
    console.warn(`⚠️ Failed to write to brain artifact path: ${err.message}`);
  }

  process.exit(0);
}

runSimulation().catch((err) => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
