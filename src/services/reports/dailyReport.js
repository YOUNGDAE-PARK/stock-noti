import fs from 'fs';
import path from 'path';
import { getDb } from '../../db/db.js';
import { NotificationService } from '../notificationService.js';
import { getReportsDir } from '../../utils/paths.js';

/**
 * Generates a comprehensive daily investment report.
 * @param {string} dateStr - Target date (YYYY-MM-DD). Defaults to yesterday.
 * @param {Object} user - User context { uid, email }
 */
export async function generateDailyReport(dateStr, user) {
  const { uid, email } = user || {};
  const db = await getDb(uid);
  
  const targetDate = dateStr || getYesterdayDate();
  console.log(`[Daily Report] Generating for ${targetDate} (User: ${email || uid})...`);

  const events = await fetchEvents(db, targetDate);
  const snapshots = await fetchSnapshots(db, targetDate);

  if (events.length === 0 && snapshots.length === 0) {
    console.log(`[Daily Report] No data for ${targetDate}. Skipping.`);
    return null;
  }

  const report = assembleReport(targetDate, events, snapshots);
  const filePath = saveReportFile(report, targetDate, uid);

  // Deliver notification
  await NotificationService.sendPersonalizedReport(
    { uid, email },
    `📈 일일 투자 리포트 (${targetDate})`,
    report
  );

  return filePath;
}

function getYesterdayDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().substring(0, 10);
}

async function fetchEvents(db, date) {
  return await db.all(`
    SELECT e.*, a.name as asset_name, a.investment_thesis, a.avg_price, a.holding_weight
    FROM investment_event e
    JOIN portfolio_asset a ON e.ticker = a.ticker
    WHERE e.event_date = ?
    ORDER BY e.reliability_score DESC
  `, [date]);
}

async function fetchSnapshots(db, date) {
  return await db.all(`
    SELECT s.*, a.name as asset_name
    FROM market_snapshot_daily s
    JOIN portfolio_asset a ON s.ticker = a.ticker
    WHERE s.date = ?
  `, [date]);
}

function assembleReport(date, events, snapshots) {
  let report = `📈 *Stock-Noti 일일 투자 종합 리포트 (${date})*\n\n`;

  // Action Items
  report += `*1. 포트폴리오 행동 권고 (Action Items)*\n`;
  const highRisk = events.filter(e => e.decision_signal === '매도검토' || e.decision_signal === '비중축소');
  const positive = events.filter(e => e.decision_signal === '추매검토');
  const watch = events.filter(e => e.decision_signal === '관찰');

  if (highRisk.length > 0) {
    report += `⚠️ *주의 요망 (리스크 경보):*\n`;
    highRisk.forEach(e => report += `• *${e.asset_name}*: \`${e.event_type}\` 악재 감지. *${e.decision_signal}* 권장.\n`);
  }
  if (watch.length > 0) {
    report += `🔍 *모니터링 필요 (관찰 요망):*\n`;
    watch.forEach(e => report += `• *${e.asset_name}*: \`${e.event_type}\` 의심 사항 발생. 지속 모니터링.\n`);
  }
  if (positive.length > 0) {
    report += `💡 *진입 기회 감지:*\n`;
    positive.forEach(e => report += `• *${e.asset_name}*: 긍정적 이벤트 포착. *${e.decision_signal}* 가능.\n`);
  }
  if (!highRisk.length && !positive.length && !watch.length) {
    report += `특이 리스크가 식별되지 않았습니다. *보유 유지 (Hold)* 기조 유지.\n`;
  }
  report += `\n`;

  // Market Performance
  report += `*2. 포트폴리오 시장 반응 요약*\n`;
  if (snapshots.length > 0) {
    snapshots.forEach(s => {
      const dir = s.change_pct > 0 ? '▲' : s.change_pct < 0 ? '▼' : ' ';
      report += `• *${s.asset_name}*: ${s.close_price.toLocaleString()}원 (${dir} ${Math.abs(s.change_pct)}%) | ${(s.trading_value / 100000000).toFixed(1)}억\n`;
    });
  } else {
    report += `당일 포트폴리오 시장 데이터가 존재하지 않습니다.\n`;
  }
  report += `\n`;

  // Investment Events
  report += `*3. 오늘의 핵심 투자 이벤트*\n`;
  if (events.length > 0) {
    events.forEach(e => {
      const signalEmoji = e.decision_signal === '추매검토' ? '🔵' : e.decision_signal === '매도검토' || e.decision_signal === '비중축소' ? '🔴' : '⚪';
      const impactEmoji = e.impact_direction === 'positive' ? '🟢' : e.impact_direction === 'negative' ? '🔴' : '⚪';
      
      report += `*${e.asset_name}* | ${e.event_title}\n`;
      report += `${signalEmoji} *신호: ${e.decision_signal}* (영향: ${impactEmoji} / 중요도: ${e.impact_level})\n`;
      if (e.ai_reason) {
        const quotedReason = e.ai_reason.split('\n').map(line => `> ${line}`).join('\n');
        report += `${quotedReason}\n`;
      }
      report += `🔗 [${e.primary_source_type} 이동](${e.primary_source_url})\n\n`;
    });
  } else {
    report += `특이할 만한 주요 공시나 뉴스가 관측되지 않았습니다.\n`;
  }

  return report;
}

function saveReportFile(content, date, uid) {
  const reportDir = getReportsDir(uid);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  
  const filePath = path.join(reportDir, `daily_report_${date}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}
