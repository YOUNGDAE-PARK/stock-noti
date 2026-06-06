import fs from 'fs';
import path from 'path';
import { getDb } from '../../db/db.js';
import { collectKindRiskDisclosures } from '../collectors/kind.js';
import { collectNaverNews } from '../collectors/naverNews.js';
import { collectKrxMarketData } from '../collectors/krx.js';
import { consolidateEvents } from '../consolidator.js';
import { evaluateEvents } from '../judge.js';
import { NotificationService } from '../notificationService.js';
import { getReportsDir } from '../../utils/paths.js';

/**
 * Hourly analysis task: collects new data, consolidates, judges, and alerts if needed.
 */
export async function runHourlyAnalysis(dateStr, isSimulation = false, userInput) {
  // Support both Object {uid, email} and string UID (from Cron)
  let uid, email;
  if (typeof userInput === 'string') {
    uid = userInput;
    email = null;
  } else if (userInput && typeof userInput === 'object') {
    uid = userInput.uid;
    email = userInput.email;
  }

  const targetDate = dateStr || new Date().toISOString().substring(0, 10);
  console.log(`[Hourly Notifier] Starting for user ${email || uid} at ${targetDate}...`);

  const db = await getDb(uid);

  if (!isSimulation) {
    // 1. Data Collection
    await collectKindRiskDisclosures(uid);
    await collectNaverNews(uid);
    await collectKrxMarketData(targetDate, uid);

    // 2. Processing (LLM Judge updates status to 'confirmed')
    await consolidateEvents(uid);
    await evaluateEvents(uid);
  }

  // 3. Identification of actionable events that were JUST confirmed
  // We check for 'confirmed' status and high impact signals
  const newEvents = await db.all(`
    SELECT e.*, a.name as asset_name 
    FROM investment_event e
    JOIN portfolio_asset a ON e.ticker = a.ticker
    WHERE e.event_date = ? AND e.status = 'confirmed'
    AND e.decision_signal IN ('매도검토', '비중축소', '추매검토')
    ORDER BY e.event_id DESC
  `, [targetDate]);

  if (newEvents.length === 0) {
    console.log('[Hourly Notifier] No new critical events detected.');
    return null;
  }

  // 4. Alerting
  const alertContent = assembleAlert(targetDate, newEvents);
  const filePath = saveAlertFile(alertContent, targetDate, uid);

  await NotificationService.sendPersonalizedReport(
    { uid, email },
    `🚨 실시간 감시 알림 (${targetDate})`,
    alertContent,
    'urgent'
  );

  return filePath;
}

function assembleAlert(date, events) {
  const now = new Date();
  const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  
  let content = `🔔 *실시간 단기 감시 알림 (${timestamp})*\n`;
  content += `장중 포트폴리오 자산에서 핵심 이벤트가 포착되었습니다.\n\n`;

  events.forEach(e => {
    const signalEmoji = e.decision_signal === '추매검토' ? '🔵' : e.decision_signal === '매도검토' || e.decision_signal === '비중축소' ? '🔴' : '⚪';
    const impactEmoji = e.impact_direction === 'positive' ? '🟢' : e.impact_direction === 'negative' ? '🔴' : '⚪';

    content += `*${e.asset_name}* | ${e.event_title}\n`;
    content += `${signalEmoji} *신호: ${e.decision_signal}* (영향: ${impactEmoji} / 중요도: ${e.impact_level})\n`;
    if (e.ai_reason) {
      const quotedReason = e.ai_reason.split('\n').map(line => `> ${line}`).join('\n');
      content += `${quotedReason}\n`;
    } else {
      content += `> 분석 중...\n`;
    }
    content += `🔗 [${e.primary_source_type} 이동](${e.primary_source_url})\n\n`;
  });

  return content;
}

function saveAlertFile(content, date, uid) {
  const reportDir = getReportsDir(uid);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

  const now = new Date();
  const hhmm = `${now.getHours()}${now.getMinutes().toString().padStart(2, '0')}`;
  const filename = `hourly_noti_${date.replace(/-/g, '')}_${hhmm}.md`;
  const filePath = path.join(reportDir, filename);
  
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}
