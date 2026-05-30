import fs from 'fs';
import path from 'path';
import { getDb } from '../db/db.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { sendSlackMarkdown } from './slack.js';

const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.replace(/[\r\n\s]/g, '') : null;
const isGeminiAvailable = apiKey && apiKey !== 'your_gemini_api_key_here' && apiKey !== '';

/**
 * Weekly Batch operations: Runs weekly rebalancing analytics and AI registry repair.
 */
export async function runWeeklyBatch(dateStr) {
  const targetDate = dateStr || new Date().toISOString().substring(0, 10);
  console.log(`[Weekly Batch] Initiating weekly operations for ${targetDate}...`);

  const db = await getDb();

  // 1. Recover broken URL registries using Gemini AI
  const recoveredList = await recoverBrokenRegistries(db);

  // 2. Generate Weekly Rebalance Report
  const reportPath = await generateWeeklyRebalanceReport(db, targetDate, recoveredList);

  return { success: true, reportPath, recoveredCount: recoveredList.length };
}

/**
 * Scans needs_review registries and invokes Gemini AI to repair/find the official URL.
 */
async function recoverBrokenRegistries(db) {
  console.log('[Weekly Batch] Checking for broken URL registries (fail_count >= 3)...');
  
  const brokenRegistries = await db.all(`
    SELECT r.*, a.name as asset_name 
    FROM source_registry r
    JOIN portfolio_asset a ON r.ticker = a.ticker
    WHERE r.status = 'needs_review' OR r.fail_count >= 3
  `);

  if (brokenRegistries.length === 0) {
    console.log('[Weekly Batch] All URL registries are healthy.');
    return [];
  }

  console.log(`[Weekly Batch] Found ${brokenRegistries.length} broken registries. Triggering AI recovery...`);

  let genAI = null;
  let model = null;
  if (isGeminiAvailable) {
    try {
      genAI = new GoogleGenerativeAI(apiKey);
      model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    } catch (err) {
      console.warn('Failed to init Gemini for registry recovery:', err.message);
    }
  }

  const recoveredList = [];

  for (const reg of brokenRegistries) {
    let recoveredUrl = null;
    let reason = 'AI 복구 엔진 비활성화';

    if (model) {
      try {
        const prompt = `
당신은 대한민국 상장사들의 공식 웹사이트와 공시 정보를 전문적으로 찾는 어시스턴트입니다.
현재 아래 상장사의 공식 IR(Investor Relations) 보도자료 게시판 또는 공식 뉴스룸 URL이 만료되었거나 정상 작동하지 않습니다.

[상장사 정보]
- 종목명: ${reg.asset_name}
- 티커 (6자리): ${reg.ticker}
- 기존 등록되었던 URL: ${reg.rss_url || reg.source_url}
- 소스 타입: ${reg.source_type} (IR 또는 NEWSROOM)

이 상장사의 공식 홈페이지 내에 존재하는 실제 보도자료(IR 뉴스룸) 게시판 또는 공보용 RSS 피드 URL을 최신 정보로 검색/추론하여 1개만 반환해 주십시오. 
반드시 실제 접속 가능한 유효한 HTTPS 웹페이지 URL이어야 합니다. 

응답은 다른 설명 텍스트나 코드 블록(\`\`\`) 없이 반드시 아래 JSON 형식으로만 출력하십시오:
{
  "recovered_url": "https://실제_정상_접속되는_공식_IR_또는_뉴스룸_게시판_주소",
  "reason": "URL을 매핑한 구체적인 근거 설명"
}
`;
        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const json = JSON.parse(text);

        if (json.recovered_url && json.recovered_url.startsWith('http')) {
          recoveredUrl = json.recovered_url;
          reason = json.reason;
        }
      } catch (err) {
        console.error(`[Weekly Batch] AI URL recovery failed for ${reg.asset_name}:`, err.message);
        reason = `AI 분석 오류: ${err.message}`;
      }
    } else {
      // Offline fallback: Match static healthy URLs for standard assets
      if (reg.ticker === '009150') recoveredUrl = 'https://www.samsungsem.com/kr/newsroom/news/list.do';
      else if (reg.ticker === '064400') recoveredUrl = 'https://www.lgcns.com/pr/news';
      else if (reg.ticker === '475960') recoveredUrl = 'https://www.tomocube.com/news';
      else if (reg.ticker === '064760') recoveredUrl = 'https://www.tck.co.kr/news';
      reason = '오프라인 폴백 주소 매핑 성공';
    }

    if (recoveredUrl) {
      // Update database
      const cleanDomain = new URL(recoveredUrl).origin;
      await db.run(
        `UPDATE source_registry 
         SET source_url = ?, rss_url = NULL, domain = ?, fail_count = 0, status = 'active', verified_at = CURRENT_TIMESTAMP
         WHERE source_id = ?`,
        [recoveredUrl, cleanDomain, reg.source_id]
      );

      console.log(`[Weekly Batch] Successfully repaired ${reg.asset_name} URL: ${recoveredUrl}`);
      recoveredList.push({
        asset: reg.asset_name,
        ticker: reg.ticker,
        oldUrl: reg.rss_url || reg.source_url,
        newUrl: recoveredUrl,
        reason
      });
    } else {
      console.warn(`[Weekly Batch] Failed to repair URL for ${reg.asset_name}. Manual inspection required.`);
    }
  }

  return recoveredList;
}

/**
 * Compiles a weekly summary of event trends and performance changes, outputting a rebalancing markdown report.
 */
async function generateWeeklyRebalanceReport(db, targetDate, recoveredList) {
  console.log('[Weekly Batch] Generating Weekly Portfolio Rebalance Report...');

  // 1. Fetch all assets
  const assets = await db.all('SELECT * FROM portfolio_asset WHERE is_active = 1');

  // 2. Fetch events from the past 7 days
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const oneWeekAgoStr = oneWeekAgo.toISOString().substring(0, 10);

  const weeklyEvents = await db.all(`
    SELECT e.*, a.name as asset_name 
    FROM investment_event e
    JOIN portfolio_asset a ON e.ticker = a.ticker
    WHERE e.event_date >= ?
    ORDER BY e.event_date DESC
  `, [oneWeekAgoStr]);

  // Aggregate signals per ticker
  const tickerStats = {};
  for (const asset of assets) {
    tickerStats[asset.ticker] = {
      ticker: asset.ticker,
      name: asset.name,
      buyCount: 0,
      sellCount: 0,
      reduceCount: 0,
      holdCount: 0,
      watchCount: 0,
      events: []
    };
  }

  for (const event of weeklyEvents) {
    if (!tickerStats[event.ticker]) continue;
    
    tickerStats[event.ticker].events.push(event);
    if (event.decision_signal === '추매검토') tickerStats[event.ticker].buyCount++;
    else if (event.decision_signal === '매도검토') tickerStats[event.ticker].sellCount++;
    else if (event.decision_signal === '비중축소') tickerStats[event.ticker].reduceCount++;
    else if (event.decision_signal === '보유') tickerStats[event.ticker].holdCount++;
    else if (event.decision_signal === '관찰') tickerStats[event.ticker].watchCount++;
  }

  // 3. Generate Weekly Sector & Macro Insights via Gemini AI
  let sectorInsight = '섹터별 분석을 위해 AI 분석기를 가동합니다.';
  let model = null;
  if (isGeminiAvailable) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    } catch (err) {
      console.warn('Failed to init Gemini for weekly sector insight:', err.message);
    }
  }

  if (model) {
    try {
      const eventsSummary = weeklyEvents.map(e => `[${e.asset_name}] ${e.event_title} (${e.event_date}) - JaaS판단: ${e.decision_signal}`).join('\n');
      const assetsPerformance = assets.map(a => `[${a.name}] 투자아이디어: ${a.investment_thesis}, 리스크: ${a.risk_keywords}, 현재비중: ${a.holding_weight}%`).join('\n');

      const prompt = `
당신은 글로벌 테크 분야의 거시 매크로 및 섹터 로테이션을 분석하는 전문 포트폴리오 매니저이자 투자 전략가입니다.
최근 1주일간 우리 포트폴리오 자산들에 발생한 이벤트 로그와 포트폴리오 기초 자산 프로필을 제공합니다.

이 정보를 종합적으로 분석하여, 포트폴리오가 노출되어 있는 핵심 섹터들(예: 우주항공/뉴스페이스, AI/클라우드 DX 인프라, 나노 계측 및 반도체 부품 등)의 **중장기 관점에서의 거시 흐름, 모멘텀 요인 및 잠재적 리스크 요인을 일목요연하고 간결하게 진단하는 주간 섹터 인사이트 리포트**를 작성해 주십시오.

[포트폴리오 자산 구성]
${assetsPerformance}

[최근 1주일 주요 이벤트 로그]
${eventsSummary}

[작성 지침]
1. 불필요한 수식어나 길고 장황한 서술식 문장은 전면 배제하고, 핵심 정보 위주로 직관적으로 작성하십시오.
2. 각 섹터별로 제목을 달고, 아래의 3가지 핵심 요소를 글머리 기호로 요약하십시오.
   - 🚀 **성장 모멘텀 / 거시 트렌드:** [핵심 내용을 1~2문장으로 요약]
   - ⚠️ **잠재적 리스크 요인:** [핵심 리스크를 1~2문장으로 요약]
   - 💡 **중장기 대응 전략:** [핵심 전략을 1~2문장으로 요약]
3. 전체 분량이 너무 장황해지지 않도록 간결함을 최우선으로 하여 일목요연하게 정리해 주십시오.

다른 군더더기 설명이나 인사말 없이 마크다운 본문 텍스트만 바로 출력하십시오:
`;
      const result = await model.generateContent(prompt);
      sectorInsight = result.response.text().trim();
    } catch (err) {
      console.error('[Weekly Batch] Sector insight generation failed:', err.message);
      sectorInsight = '⚠️ AI 모델 오류로 섹터 분석 보고서를 동적 생성하지 못했습니다.';
    }
  } else {
    // Offline Fallback
    sectorInsight = `* **우주항공 / 뉴스페이스 섹터 (Space Tech & Satellite):**
  - 🚀 **성장 모멘텀:** 민간 뉴스페이스 산업의 대형화 본격화 및 스페이스X 6월 로드쇼 모멘텀.
  - ⚠️ **잠재적 리스크:** 미국 고금리 지속에 따른 밸류에이션 부담.
  - 💡 **중장기 전략:** 단기 소음 배제 후 글로벌 위성 통신망 확장 방향성에 장기 투자.
* **AI / 클라우드 DX 인프라 섹터 (AI Infrastructure & DX):**
  - 🚀 **성장 모멘텀:** 빅테크의 AI 데이터센터용 부품 대형 수주 및 유니콘 지분 가치 현실화.
  - ⚠️ **잠재적 리스크:** 인프라 감가상각 및 설비투자(CAPEX) 비용 효율성 검증 요구.
  - 💡 **중장기 전략:** 단순 기대감 극복 후 실제 실적 숫자로 가치가 증명되는 선도주 집중.
* **나노 반도체 및 신소재 부품 섹터 (Advanced Materials & Semis):**
  - 🚀 **성장 모멘텀:** 고도화 공정 부품(SiC 링 등) 지배력 유지 및 적극적인 주주환원(자사주 소각 등).
  - ⚠️ **잠재적 리스크:** 바이오/반도체 계측 예산 일시 삭감 및 경쟁사 진입에 따른 단가 압박.
  - 💡 **중장기 전략:** 특허 만료 등 기술 경쟁 구도 추적하며 핵심 부품 벤더 지위 점검.`;
  }

  // 4. Compile Markdown
  let report = `# 📊 주간 포트폴리오 리밸런싱 및 섹터 인사이트 제안서 (${targetDate})\n\n`;
  report += `본 보고서는 최근 1주일간 포스폴리오 내 종목별로 축적된 핵심 투자 이벤트 추이 및 JaaS(판단 보조 서비스) 분석 시그널을 종합해 도출된 포트폴리오 리밸런싱 권고안입니다.\n\n`;

  report += `## 1. 중장기 매크로 및 섹터별 흐름 점검 (Sector & ETF Analysis)\n`;
  report += `${sectorInsight}\n\n`;
  report += `---\n\n`;

  // Section 2: AI Rebalancing Action Plan
  report += `## 2. 포트폴리오 비중 조정 권고 (Rebalancing Actions)\n`;
  
  let buyCandidates = [];
  let sellCandidates = [];
  let holdCandidates = [];

  for (const ticker in tickerStats) {
    const stat = tickerStats[ticker];
    const asset = assets.find(a => a.ticker === ticker);
    
    if (stat.sellCount > 0 || stat.reduceCount >= 2) {
      sellCandidates.push(stat);
    } else if (stat.buyCount > 0 && stat.sellCount === 0 && stat.reduceCount === 0) {
      buyCandidates.push(stat);
    } else {
      holdCandidates.push(stat);
    }
  }

  if (sellCandidates.length > 0) {
    report += `### 🔴 비중 축소 / 차익 실현 제안 (Sell/Reduce Candidates)\n`;
    for (const c of sellCandidates) {
      const asset = assets.find(a => a.ticker === c.ticker);
      report += `* **${c.name}** (\`${c.ticker}\` / 현재 비중: ${asset.holding_weight}%)\n`;
      report += `  - **이유:** 최근 1주일간 부정적 이벤트 감지 (매도검토: ${c.sellCount}회, 비중축소: ${c.reduceCount}회). 펀더멘털의 단기 훼손 또는 재료 소멸 우려가 있으므로 비중 축소 후 현금 확보를 권장합니다.\n`;
    }
    report += `\n`;
  }

  if (buyCandidates.length > 0) {
    report += `### 🟢 비중 확대 / 추가 매수 제안 (Buy/Accumulate Candidates)\n`;
    for (const c of buyCandidates) {
      const asset = assets.find(a => a.ticker === c.ticker);
      report += `* **${c.name}** (\`${c.ticker}\` / 현재 비중: ${asset.holding_weight}%)\n`;
      report += `  - **이유:** 최근 1주일간 양질의 모멘텀 발생 (추매검토: ${c.buyCount}회). 중장기 투자 매력도가 상승하였으므로 분할 추매를 통해 비중 확대를 권고합니다.\n`;
    }
    report += `\n`;
  }

  if (sellCandidates.length === 0 && buyCandidates.length === 0) {
    report += `> 💡 **의견:** 최근 1주일간 포트폴리오 비중을 대폭 조정할 만한 임계 이벤트를 동반한 자산이 없었습니다. 현 비중 체계(\`Hold\`)를 유지하는 것을 권장합니다.\n\n`;
  }

  // Section 3: Asset Weekly Log
  report += `## 3. 종목별 주간 이벤트 누적 추이\n`;
  report += `| 종목명 | 티커 | 주간 이벤트 수 | 추매 | 비중축소/매도 | 보유/관찰 | 최종 권고 기조 |\n`;
  report += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: |\n`;
  
  for (const ticker in tickerStats) {
    const s = tickerStats[ticker];
    let action = '보유 유지';
    if (s.sellCount > 0) action = '🔴 매도/비중축소';
    else if (s.reduceCount > 0) action = '⚠️ 비중축소';
    else if (s.buyCount > 0) action = '🟢 비중확대';

    report += `| **${s.name}** | \`${s.ticker}\` | ${s.events.length}개 | ${s.buyCount}회 | ${s.sellCount + s.reduceCount}회 | ${s.holdCount + s.watchCount}회 | **${action}** |\n`;
  }
  report += `\n---\n\n`;

  // Section 4: AI URL Registry Repair Summary
  report += `## 4. 주간 수집 레지스트리 점검 & AI 자동 복구 내역\n`;
  if (recoveredList.length > 0) {
    report += `주간 스캔 중 접속 오류(3회 실패 이상)가 발생한 공식 뉴스룸 웹사이트 레지스트리 복구를 진행했습니다:\n\n`;
    report += `| 종목명 | 소스 구분 | 이전 주소 | AI 복구된 새 주소 | 복구 근거 요약 |\n`;
    report += `| :--- | :---: | :--- | :--- | :--- |\n`;
    for (const r of recoveredList) {
      report += `| **${r.asset}** | IR 뉴스 | \`${r.oldUrl}\` | [이동](${r.newUrl}) | ${r.reason} |\n`;
    }
  } else {
    report += `* **점검 결과:** 감시 중인 모든 기업의 IR/뉴스룸 공식 레지스트리가 정상 작동하고 있어, AI 복구 우회 동작을 수행하지 않았습니다 (안정 상태).\n`;
  }
  report += `\n`;

  // 4. Save file
  const reportDir = './reports';
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const filename = `weekly_report_${targetDate}.md`;
  const filePath = path.join(reportDir, filename);
  fs.writeFileSync(filePath, report, 'utf-8');
  console.log(`[Weekly Batch] Weekly report successfully saved to ${filePath}`);

  // Send report to Slack
  await sendSlackMarkdown(`📊 주간 포트폴리오 리밸런싱 조정 제안서 (${targetDate})`, report);

  return filePath;
}
