import { getDb } from '../db/db.js';
import { uploadDbToStorage } from '../db/storage_sync.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NotificationService } from './notificationService.js';
import { getReportsDir } from '../utils/paths.js';
import { performance } from 'perf_hooks';
import fs from 'fs';
import path from 'path';

const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.replace(/[\r\n\s]/g, '') : null;
const isGeminiAvailable = !!(apiKey && apiKey !== 'your_gemini_api_key_here' && apiKey !== '');

/**
 * Weekly Batch operations: Runs weekly rebalancing analytics and AI registry repair.
 */
export async function runWeeklyBatch(userInput) {
  const startTime = performance.now();
  
  // Support both legacy (string UID) and new (User object) call styles
  let uid, email;
  if (typeof userInput === 'string') {
    uid = userInput;
    email = null;
  } else if (userInput && typeof userInput === 'object') {
    uid = userInput.uid;
    email = userInput.email;
  }

  if (!uid) {
    console.error('[Weekly Batch] Error: No user identification (UID) provided.');
    return { success: false, error: 'User identification missing' };
  }

  const targetDate = new Date().toISOString().substring(0, 10);
  console.log(`[Weekly Batch] >>> STEP 0: STARTING for user ${email || uid} at ${targetDate}`);

  try {
    console.log(`[Weekly Batch] >>> STEP 1: Opening Database...`);
    const db = await getDb(uid, email);
    console.log(`[Weekly Batch] >>> STEP 1: Database opened.`);

    // 1. Recover broken URL registries (Parallelized)
    console.log(`[Weekly Batch] >>> STEP 2: Starting Registry Recovery...`);
    const recoveryStart = performance.now();
    const recoveredList = await recoverBrokenRegistries(db);
    const recoveryEnd = performance.now();
    console.log(`[Weekly Batch] >>> STEP 2: Registry Recovery finished (${recoveredList.length} items).`);

    // 2. Deep Weekly Analysis
    console.log(`[Weekly Batch] >>> STEP 3: Starting Deep Strategy Analysis...`);
    const analysisStart = performance.now();
    const assets = await db.all('SELECT * FROM portfolio_asset WHERE is_active = 1');
    console.log(`[Weekly Batch] >>> STEP 3: Found ${assets.length} active assets to analyze.`);
    
    const weeklyStrategy = await performWeeklyDeepAnalysis(db, assets, targetDate);
    const analysisEnd = performance.now();
    console.log(`[Weekly Batch] >>> STEP 3: Strategy Analysis finished.`);

    const totalTime = (performance.now() - startTime) / 1000;
    const stats = {
      recoveryTime: ((recoveryEnd - recoveryStart) / 1000).toFixed(2),
      analysisTime: ((analysisEnd - analysisStart) / 1000).toFixed(2),
      totalTime: totalTime.toFixed(2),
      assetCount: assets.length,
      recoveredCount: recoveredList.length
    };

    // 3. Generate Report
    console.log(`[Weekly Batch] >>> STEP 4: Generating Markdown...`);
    const report = generateWeeklyMarkdown(targetDate, recoveredList, weeklyStrategy, stats);
    const filePath = saveWeeklyReport(report, targetDate, uid);

    // 4. Deliver notification
    console.log(`[Weekly Batch] >>> STEP 5: Delivering Notification...`);
    await NotificationService.sendPersonalizedReport(
      { uid, email },
      `📊 주간 운영 리포트 (${stats.totalTime}s)`,
      report,
      'weekly'
    );

    // 5. Sync state
    console.log(`[Weekly Batch] >>> STEP 6: Syncing with Storage...`);
    await uploadDbToStorage(uid);

    console.log(`[Weekly Batch] >>> STEP 7: ALL DONE in ${stats.totalTime}s.`);
    return { success: true, reportPath: filePath, stats };
  } catch (err) {
    console.error(`[Weekly Batch] !!! CRITICAL ERROR:`, err.message);
    throw err;
  }
}

/**
 * Uses Gemini AI to find corrected URLs for broken registries.
 */
async function recoverBrokenRegistries(db) {
  const brokenRegistries = await db.all('SELECT * FROM source_registry WHERE status = "active" AND fail_count >= 3');
  if (brokenRegistries.length === 0 || !isGeminiAvailable) return [];

  console.log(`[Weekly Batch] AI Recovery: found ${brokenRegistries.length} targets.`);
  
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ 
    model: 'gemini-2.5-flash',
    generationConfig: { maxOutputTokens: 512 }
  });

  const recoveryPromises = brokenRegistries.map(async (reg) => {
    try {
      const prompt = `
[기업] ${reg.ticker} (URL 접근 실패)
[기존URL] ${reg.source_url}
[유형] ${reg.source_type} (IR 또는 NEWSROOM)

위 기업의 최신 공식 홈페이지 내 해당 섹션 주소를 찾아 JSON으로 응답하십시오. 유효한 URL이어야 합니다.
{"new_url": "https://...", "reason": "변경 사유 요약"}
`;
      
      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AI Timeout')), 15000))
      ]);

      const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
      const json = JSON.parse(text);

      if (json.new_url) {
        await db.run(
          'UPDATE source_registry SET source_url = ?, fail_count = 0, verified_by = "ai", verified_at = CURRENT_TIMESTAMP WHERE source_id = ?',
          [json.new_url, reg.source_id]
        );
        return { ticker: reg.ticker, type: reg.source_type, oldUrl: reg.source_url, newUrl: json.new_url, reason: json.reason };
      }
    } catch (err) {
      console.warn(`[Recovery Failed] ${reg.ticker}: ${err.message}`);
    }
    return null;
  });

  const results = await Promise.all(recoveryPromises);
  return results.filter(r => r !== null);
}

async function trackSignalAccuracy(db, date) {
  const pastEvents = await db.all(`
    SELECT
      e.event_id, e.ticker, e.event_date, e.decision_signal,
      e.consensus_score,
      a.name as asset_name,
      s1.close_price as price_at_event,
      s2.close_price as price_5days_later
    FROM investment_event e
    JOIN portfolio_asset a ON e.ticker = a.ticker
    LEFT JOIN market_snapshot_daily s1
      ON s1.ticker = e.ticker AND s1.date = e.event_date
    LEFT JOIN market_snapshot_daily s2
      ON s2.ticker = e.ticker AND s2.date = (
        SELECT MIN(date) FROM market_snapshot_daily
        WHERE ticker = e.ticker AND date > date(e.event_date, '+3 days')
      )
    WHERE e.event_date BETWEEN date(?, '-12 days') AND date(?, '-7 days')
    AND e.decision_signal IN ('추매검토', '매도검토', '비중축소')
    AND e.status = 'confirmed'
    AND s1.close_price IS NOT NULL
    AND s2.close_price IS NOT NULL
  `, [date, date]);

  if (pastEvents.length === 0) return null;

  const results = pastEvents.map(e => {
    const priceChangePct = (e.price_5days_later - e.price_at_event) / e.price_at_event * 100;
    const hit = e.decision_signal === '추매검토' ? priceChangePct > 0 : priceChangePct < 0;
    return { ...e, priceChangePct: parseFloat(priceChangePct.toFixed(2)), hit };
  });

  const hitCount = results.filter(r => r.hit).length;
  const accuracyRate = parseFloat((hitCount / results.length * 100).toFixed(1));

  const highConf = results.filter(r => r.consensus_score >= 70);
  const highConfAccuracy = highConf.length > 0
    ? parseFloat((highConf.filter(r => r.hit).length / highConf.length * 100).toFixed(1))
    : null;

  return { results, accuracyRate, hitCount, total: results.length, highConfAccuracy };
}

async function performWeeklyDeepAnalysis(db, assets, date) {
  const weeklyResults = [];
  let totalEventsAnalyzed = 0;

  // 1. Gather statistical data for all assets (SQL)
  for (const asset of assets) {
    const stats = await db.get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN decision_signal = '추매검토' THEN 1 ELSE 0 END) as buy,
        SUM(CASE WHEN decision_signal IN ('매도검토', '비중축소') THEN 1 ELSE 0 END) as sell,
        SUM(CASE WHEN decision_signal IN ('보유', '관찰') THEN 1 ELSE 0 END) as hold
      FROM investment_event
      WHERE ticker = ? AND event_date >= date(?, '-7 days')
    `, [asset.ticker, date]);

    totalEventsAnalyzed += (stats.total || 0);

    let strategy = "유지";
    if (stats.sell > stats.buy) strategy = "비중축소";
    else if (stats.buy > stats.sell) strategy = "비중확대";

    // Fetch weekly deltas for this asset
    const weeklyDeltas = await db.all(`
      SELECT action_type, SUM(delta_qty) as total_delta 
      FROM portfolio_delta_log 
      WHERE ticker = ? AND timestamp >= date(?, '-7 days')
      GROUP BY action_type
    `, [asset.ticker, date]);
    const deltaSummary = weeklyDeltas.map(d => `${d.action_type}: ${d.total_delta}`).join(', ');

    weeklyResults.push({
      asset,
      total: stats.total || 0,
      buy: stats.buy || 0,
      sell: stats.sell || 0,
      hold: stats.hold || 0,
      strategy,
      deltaSummary
    });
  }

  // 2. Perform AI Global Synthesis (Gemini)
  let globalInsight = "전체 포트폴리오에 대한 AI 통합 인사이트를 생성할 수 없습니다.";
  if (isGeminiAvailable && weeklyResults.length > 0) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ 
        model: 'gemini-2.5-flash'
      });

      const statsSummary = weeklyResults
        .filter(r => r.total > 0 || r.deltaSummary)
        .map(r => `${r.asset.name}: ${r.total}건(추매 ${r.buy}, 축소 ${r.sell}, 관망 ${r.hold}) | 이번주 나의 행동: ${r.deltaSummary || '없음'}`)
        .join('\n');

      const prompt = `
당신은 자산운용 CIO입니다. 아래 [주간 데이터]는 우리 포트폴리오의 지난 7일간 발생한 주요 이벤트와 사용자의 실제 매매 내역 요약입니다.
이 데이터를 심층 분석하여 다음 주를 위한 [통합 운용 전략]을 전문적이고 구체적으로 작성하십시오.

[분석 가이드]
1. 이번 주 시장 시그널과 사용자의 실제 매매 행보를 대조하여 분석하십시오.
2. 사용자가 최근 비중을 늘리거나 줄인 종목에 대해, 발생한 이벤트와 연계하여 적절한 피드백을 주십시오.
3. 데이터상 변동성이 크거나 주의 깊게 모니터링해야 할 종목군/리스크를 구체적으로 언급하십시오.
4. 다음 주 운용 기조를 '적극적', '중립적', '보수적' 중 하나로 확정하고 그 전략적 이유를 설명하십시오.

[주간 데이터]
${statsSummary || '특이 이벤트 없음'}

작성을 시작하십시오:
`;
      const result = await model.generateContent(prompt);
      globalInsight = result.response.text().trim();
    } catch (err) {
      console.warn(`[Weekly AI Synthesis Failed]`, err.message);
    }
  }

  const accuracyData = await trackSignalAccuracy(db, date);
  return { weeklyResults, globalInsight, totalEventsAnalyzed, accuracyData };
}

function generateWeeklyMarkdown(date, recovered, analysis, stats) {
  const { weeklyResults, globalInsight, totalEventsAnalyzed, accuracyData } = analysis;
  
  let report = `📊 *주간 포트폴리오 운영 및 리밸런싱 제안서*\n`;
  report += `*분석 기간: 지난 7일 ~ ${date}*\n\n`;

  // 1. AI Strategic Synthesis
  report += `💡 *AI 통합 운용 전략 (CIO Insight)*\n`;
  report += `${globalInsight}\n\n`;

  // 2. AI System Health
  if (recovered.length > 0) {
    report += `🛠 *AI 시스템 자동 복구 내역*\n`;
    recovered.forEach(r => {
      report += `• *${r.ticker}* [${r.type}]: [새 주소 확인](${r.newUrl}) | ${r.reason}\n`;
    });
    report += `\n`;
  }

  // 3. Portfolio Trend Section
  report += `📈 *종목별 주간 이벤트 및 성과 추이*\n`;
  weeklyResults.forEach(s => {
    const stance = s.strategy === '비중확대' ? '🔵 *비중확대*' : s.strategy === '비중축소' ? '🔴 *비중축소*' : '⚪ 유지';
    report += `• *${s.asset.name}*: 이벤트 ${s.total}건 (추매 ${s.buy}, 축소 ${s.sell}, 관망 ${s.hold}) ➔ ${stance}\n`;
  });

  // 신호 정확도 추적 (검증자 역할)
  if (accuracyData && accuracyData.total > 0) {
    report += `\n📊 *신호 정확도 추적 (지난주 검증)*\n`;
    report += `• 전체 신호 적중률: *${accuracyData.accuracyRate}%* (${accuracyData.hitCount}/${accuracyData.total}건)\n`;
    if (accuracyData.highConfAccuracy !== null) {
      report += `• 고신뢰도 신호(팀합의 ≥70) 적중률: *${accuracyData.highConfAccuracy}%*\n`;
    }
    const top5 = accuracyData.results.slice(0, 5);
    top5.forEach(r => {
      const icon = r.hit ? '✅' : '❌';
      const scoreStr = r.consensus_score ? ` | 합의점수: ${r.consensus_score}` : '';
      report += `  ${icon} ${r.asset_name}(${r.ticker}) | ${r.decision_signal} → 5일후 *${r.priceChangePct > 0 ? '+' : ''}${r.priceChangePct}%*${scoreStr}\n`;
    });
  }

  report += `\n*[시스템 실행 및 데이터 검증 통계]*\n`;
  report += `• 분석 대상: ${stats.assetCount}개 종목\n`;
  report += `• 검증된 주간 데이터: 총 ${totalEventsAnalyzed}건\n`;
  report += `• 총 소요 시간: *${stats.totalTime}초*\n`;

  return report;
}

function saveWeeklyReport(report, date, uid) {
  const reportDir = getReportsDir(uid);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

  const filePath = path.join(reportDir, `weekly_report_${date}.md`);
  fs.writeFileSync(filePath, report, 'utf-8');
  return filePath;
}
