import fs from 'fs';
import path from 'path';
import { getDb } from '../../db/db.js';
import { collectKindRiskDisclosures } from '../collectors/kind.js';
import { collectNaverNews } from '../collectors/naverNews.js';
import { collectKrxMarketData } from '../collectors/krx.js';
import { consolidateEvents } from '../consolidator.js';
import { evaluateEvents } from '../judge.js';
import { sendSlackMarkdown } from '../slack.js';

export async function runHourlyAnalysis(dateStr, isSimulation = false) {
  const targetDate = dateStr || new Date().toISOString().substring(0, 10);
  console.log(`[Hourly Notifier] Starting hourly analysis loop for ${targetDate} (Simulation: ${isSimulation})...`);

  if (!isSimulation) {
    // 1. Fetch real-time data from sources
    await collectKindRiskDisclosures();
    await collectNaverNews();
    await collectKrxMarketData();

    // 2. Consolidate and judge
    await consolidateEvents();
    await evaluateEvents();
  }

  const db = await getDb();

  // 3. Query for critical events generated on this targetDate
  const criticalEvents = await db.all(`
    SELECT e.*, a.name as asset_name, a.investment_thesis
    FROM investment_event e
    JOIN portfolio_asset a ON e.ticker = a.ticker
    WHERE e.event_date = ? AND e.decision_signal IN ('매도검토', '비중축소', '추매검토', '관찰')
  `, [targetDate]);

  // Check if any stock had price moves exceeding +/- 5% on this targetDate
  const wildPriceMoves = await db.all(`
    SELECT s.*, a.name as asset_name
    FROM market_snapshot_daily s
    JOIN portfolio_asset a ON s.ticker = a.ticker
    WHERE s.date = ? AND abs(s.change_pct) >= 5.0
  `, [targetDate]);

  // ★ Skip condition: No critical events AND no wild price moves
  if (criticalEvents.length === 0 && wildPriceMoves.length === 0) {
    console.log(`[Hourly Notifier] Analysis complete for ${targetDate}. No critical alerts found. Omit notification (Silent).`);
    return null;
  }

  // 4. If we reach here, we have notifications to output!
  console.log(`🚨 ALERT TRIGGERED for ${targetDate}: Found ${criticalEvents.length} critical events and ${wildPriceMoves.length} volatile price moves!`);
  
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const timestamp = `${hh}:${mm}`;

  let alertContent = `# 🚨 실시간 단기 감시 알림 (${targetDate} ${timestamp})\n\n`;
  alertContent += `포트폴리오 감시망 내에서 중요 변동성 또는 리스크 이벤트가 감지되어 알림을 발행합니다.\n\n`;

  if (wildPriceMoves.length > 0) {
    alertContent += `### 📉 실시간 주가 급변 자산\n`;
    for (const move of wildPriceMoves) {
      const direction = move.change_pct > 0 ? '▲' : '▼';
      alertContent += `* **${move.asset_name}** (\`${move.ticker}\`): 현재 주가 **${move.close_price.toLocaleString()}원** (${direction} ${move.change_pct}%) - 임계치(5%) 초과 변동 발생!\n`;
    }
    alertContent += `\n`;
  }

  if (criticalEvents.length > 0) {
    alertContent += `### 🔍 실시간 감지 핵심 투자 이벤트\n`;
    for (const event of criticalEvents) {
      const impactSymbol = event.impact_direction === 'positive' ? '🟢 긍정' : event.impact_direction === 'negative' ? '🔴 부정' : '⚪ 중립';
      alertContent += `#### [${event.asset_name}] ${event.event_title}\n`;
      alertContent += `* **신호:** **\`${event.decision_signal}\`** (이벤트 유형: \`${event.event_type}\` / 영향: ${impactSymbol})\n`;
      alertContent += `* **보유 이유:** *"${event.investment_thesis}"*\n`;
      alertContent += `* **대표 근거 링크:** [${event.primary_source_type} 이동](${event.primary_source_url})\n\n`;
    }
  }

  // Save to reports folder
  const reportDir = './reports';
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const filename = `hourly_noti_${targetDate.replace(/-/g, '')}_${hh}${mm}.md`;
  const filePath = path.join(reportDir, filename);
  fs.writeFileSync(filePath, alertContent, 'utf-8');
  console.log(`[Hourly Notifier] Notification report saved to ${filePath}`);

  // Send hourly warning via Slack
  await sendSlackMarkdown(`🚨 실시간 단기 감시 알림 (${targetDate} ${timestamp})`, alertContent);

  return filePath;
}
