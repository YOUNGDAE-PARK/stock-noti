import fs from 'fs';
import path from 'path';
import { getDb } from '../../db/db.js';
import { sendSlackMarkdown } from '../slack.js';

export async function generateDailyReport(dateStr) {
  const db = await getDb();
  
  // If dateStr is not provided, use yesterday's date
  let targetDate = dateStr;
  if (!targetDate) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    targetDate = yesterday.toISOString().substring(0, 10);
  }

  console.log(`Generating Daily Report for date: ${targetDate}...`);

  // 1. Fetch investment events on this date
  const events = await db.all(`
    SELECT e.*, a.name as asset_name, a.investment_thesis, a.avg_price, a.holding_weight
    FROM investment_event e
    JOIN portfolio_asset a ON e.ticker = a.ticker
    WHERE e.event_date = ?
    ORDER BY e.reliability_score DESC
  `, [targetDate]);

  // 2. Fetch market snapshots on this date
  const snapshots = await db.all(`
    SELECT s.*, a.name as asset_name
    FROM market_snapshot_daily s
    JOIN portfolio_asset a ON s.ticker = a.ticker
    WHERE s.date = ?
  `, [targetDate]);

  if (events.length === 0 && snapshots.length === 0) {
    console.log(`No data available to generate a report for ${targetDate}.`);
    return null;
  }

  // 3. Assemble Report Content
  let report = `# 📈 Stock-Noti 일일 투자 종합 리포트 (${targetDate})\n\n`;
  report += `본 리포트는 DART, IR 뉴스룸, KIND, 네이버 뉴스 및 KRX 데이터를 취합·병합하여 생성된 일일 종합 리포트입니다.\n\n`;

  // Section 1: Actionable Advice (Action Items)
  report += `## 1. 포트폴리오 행동 권고 (Action Items)\n`;
  const highRiskEvents = events.filter(e => e.decision_signal === '매도검토' || e.decision_signal === '비중축소');
  const positiveEvents = events.filter(e => e.decision_signal === '추매검토');
  const watchEvents = events.filter(e => e.decision_signal === '관찰');

  if (highRiskEvents.length > 0) {
    report += `> ⚠️ **주의 요망 (리스크 경보):**\n`;
    for (const re of highRiskEvents) {
      report += `> * **${re.asset_name}**의 \`${re.event_type}\` 관련 부정적 소식이 관측되었습니다. 투자 판단(${re.decision_signal})에 따라 보유 비중 축소 및 투자 아이디어 재검토를 권장합니다.\n`;
    }
    report += `\n`;
  }

  if (watchEvents.length > 0) {
    report += `> 🔍 **모니터링 필요 (관찰 요망):**\n`;
    for (const we of watchEvents) {
      report += `> * **${we.asset_name}**의 \`${we.event_type}\` 관련 의심/불확실 사항이 관측되었습니다. 추가 공시 및 뉴스 추이를 지속 모니터링할 것을 권장합니다.\n`;
    }
    report += `\n`;
  }

  if (positiveEvents.length > 0) {
    report += `> 💡 **진입 기회 감지:**\n`;
    for (const pe of positiveEvents) {
      report += `> * **${pe.asset_name}**의 긍정적 이벤트가 포착되었습니다. 주가 상승 피로도가 높지 않은 경우, 추가 매수를 검토해 보실 수 있습니다.\n`;
    }
    report += `\n`;
  }

  if (highRiskEvents.length === 0 && positiveEvents.length === 0 && watchEvents.length === 0) {
    report += `현재 모든 포트폴리오 보유 자산에 대하여 특이 리스크가 식별되지 않았습니다. **보유 유지 (Hold)** 기조를 유지합니다.\n`;
  }
  report += `\n---\n\n`;

  // Section 2: Market Performance
  report += `## 2. 포트폴리오 시장 반응 요약\n`;
  if (snapshots.length > 0) {
    report += `| 자산명 | 종목코드 | 종가 | 등락률 | 거래량 | 추정 거래대금 |\n`;
    report += `| :--- | :---: | :---: | :---: | :---: | :---: |\n`;
    for (const snap of snapshots) {
      const direction = snap.change_pct > 0 ? '▲' : snap.change_pct < 0 ? '▼' : ' ';
      const changeText = `${direction} ${Math.abs(snap.change_pct)}%`;
      report += `| **${snap.asset_name}** | \`${snap.ticker}\` | ${snap.close_price.toLocaleString()}원 | ${changeText} | ${snap.volume.toLocaleString()}주 | ${(snap.trading_value / 100000000).toFixed(1)}억 원 |\n`;
    }
  } else {
    report += `당일 포트폴리오 시장 데이터가 존재하지 않습니다.\n`;
  }
  report += `\n---\n\n`;

  // Section 3: Key Investment Events
  report += `## 3. 오늘의 핵심 투자 이벤트\n`;
  if (events.length > 0) {
    for (const event of events) {
      const impactSymbol = event.impact_direction === 'positive' ? '🟢 긍정' : event.impact_direction === 'negative' ? '🔴 부정' : '⚪ 중립';
      
      report += `### [${event.asset_name}] ${event.event_title}\n`;
      report += `* **이벤트 유형:** \`${event.event_type}\` (${impactSymbol} / 중요도: \`${event.impact_level}\`)\n`;
      report += `* **JaaS 판단 신호:** **\`${event.decision_signal}\`** (신뢰도: ${event.reliability_score}/5)\n`;
      if (event.ai_reason) {
        report += `* **JaaS 판단 상세 근거:** ${event.ai_reason}\n`;
      }
      report += `* **대표 근거 출처:** [${event.primary_source_type} 링크](${event.primary_source_url}) (병합된 기사 수: ${event.source_count}개)\n`;
      report += `* **보유 이유:** *"${event.investment_thesis}"*\n\n`;
      
      // Fetch sub sources linked to this event
      const subSources = await db.all(`
        SELECT r.title, r.url, r.source_name
        FROM event_source_link l
        JOIN raw_source_item r ON l.raw_id = r.raw_id
        WHERE l.event_id = ? AND l.is_primary = 0
      `, [event.event_id]);

      if (subSources.length > 0) {
        report += `* **병합된 참고 자료:**\n`;
        for (const sub of subSources) {
          report += `  - [${sub.source_name}] [${sub.title}](${sub.url})\n`;
        }
      }
      report += `\n`;
    }
  } else {
    report += `특이할 만한 주요 공시나 뉴스가 관측되지 않았습니다. 포트폴리오가 평온한 하루를 보냈습니다.\n`;
  }
  report += `\n`;

  // 4. Save to file
  const reportDir = process.env.REPORTS_DIR || './reports';
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const filename = `daily_report_${targetDate}.md`;
  const filePath = path.join(reportDir, filename);
  fs.writeFileSync(filePath, report, 'utf-8');
  console.log(`Daily Report saved to ${filePath}`);

  // Send daily report via Slack
  await sendSlackMarkdown(`📈 Stock-Noti 일일 투자 종합 리포트 (${targetDate})`, report);

  return filePath;
}
