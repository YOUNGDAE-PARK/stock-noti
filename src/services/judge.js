import { getDb } from '../db/db.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { evaluateWithTeam } from './teamJudge.js';

// Initialize Gemini API from environment variables
const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.replace(/[\r\n\s]/g, '') : null;
const isGeminiAvailable = apiKey && apiKey !== 'your_gemini_api_key_here' && apiKey !== '';

export async function evaluateEvents(userId = null) {
  const db = await getDb(userId);

  // Get all events needing review with asset and portfolio context
  const rawEvents = await db.all(`
    SELECT e.*, a.investment_thesis, a.risk_keywords, a.name as asset_name, a.market,
           a.holding_weight, a.target_weight, a.max_weight, a.asset_type
    FROM investment_event e
    JOIN portfolio_asset a ON e.ticker = a.ticker
    WHERE e.status = 'needs_review'
  `);

  if (rawEvents.length === 0) {
    console.log('JaaS Evaluator: No events needing review.');
    return;
  }

  // 1. Gather all required context (Market indices, etc.)
  const dates = [...new Set(rawEvents.map(e => e.event_date))];
  const marketContext = {};
  for (const date of dates) {
    const indices = await db.all('SELECT ticker, change_pct FROM market_snapshot_daily WHERE date = ? AND asset_type = "index"', [date]);
    marketContext[date] = indices.reduce((acc, cur) => {
      acc[cur.ticker] = cur.change_pct;
      return acc;
    }, {});
  }

  // 2. Identify "Trivial" events for auto-processing (Noise Reduction - Strategy 4)
  const trivialTypes = [
    '단순 정정', '기타 경영사항(안내)', '결산실적공시예고', '현저한 시황변동에 대한 답변', 
    '기업설명회(IR) 개최', '사외이사의 선임·해임 또는 중도퇴임에 관한 신고'
  ];

  // 2.1 Fetch recent portfolio deltas for AI context (last 3 days)
  const recentDeltas = await db.all(`
    SELECT ticker, asset_name, action_type, delta_qty, timestamp 
    FROM portfolio_delta_log 
    WHERE timestamp >= date('now', '-3 days')
    ORDER BY timestamp DESC
  `);

  const deltaContext = recentDeltas.map(d => 
    `- ${d.timestamp}: ${d.asset_name} ${d.action_type} (수량변화: ${d.delta_qty})`
  ).join('\n');

  const processedEvents = [];
  const aiTargets = [];

  for (const e of rawEvents) {
    // Get asset market data
    const assetMarket = await db.get(
      'SELECT change_pct, volume FROM market_snapshot_daily WHERE ticker = ? AND date = ?',
      [e.ticker, e.event_date]
    );
    e.change_pct = assetMarket ? assetMarket.change_pct : 0;
    e.volume = assetMarket ? assetMarket.volume : 0;

    // Check market index for relative performance
    const indexTicker = e.market === 'KOSPI' ? 'KOSPI' : 'KOSDAQ';
    e.market_change = marketContext[e.event_date]?.[indexTicker] || 0;
    e.excess_return = e.change_pct - e.market_change;

    const isTrivialType = trivialTypes.some(type => e.event_type.includes(type) || e.event_title.includes(type));
    const isNoMarketImpact = Math.abs(e.change_pct) < 0.2; // Very small impact

    if (isTrivialType && isNoMarketImpact) {
      processedEvents.push({
        ...e,
        direction: 'neutral',
        level: 'low',
        signal: '보유',
        reason: `[시스템 자동처리] 시장 영향이 미미한 단순 행정성 공시로 판정됨. (상대수익률: ${e.excess_return.toFixed(2)}%)`
      });
    } else {
      aiTargets.push(e);
    }
  }

  // 3. Batch AI Evaluation (Team Multi-Agent System)
  if (isGeminiAvailable && aiTargets.length > 0) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.2 }
    });

    const chunkSize = 10;
    for (let i = 0; i < aiTargets.length; i += chunkSize) {
      const chunk = aiTargets.slice(i, i + chunkSize);
      const chunkNum = Math.floor(i / chunkSize) + 1;
      console.log(`[Judge] >>> STEP 3-${chunkNum}: 팀 에이전트 분석 시작 (${chunk.length}건)`);

      try {
        const teamResults = await evaluateWithTeam(db, chunk, marketContext, deltaContext, genAI, model);

        if (!teamResults) {
          console.warn(`[Judge] 팀 에이전트 전체 실패. 규칙 엔진 fallback 적용.`);
          for (const e of chunk) await evaluateByRules(db, e);
          continue;
        }

        for (const res of teamResults) {
          const e = chunk[res.id];
          if (!e) continue;
          await updateEvent(db, e.event_id, res.direction, res.level, res.signal, res.reason, {
            technical_signal: res.technical_signal,
            fundamental_signal: res.fundamental_signal,
            macro_signal: res.macro_signal,
            consensus_score: res.consensus_score,
            team_analysis: res.team_analysis
          });
        }

        console.log(`[Judge] >>> STEP 3-${chunkNum}: 팀 에이전트 분석 완료`);
      } catch (err) {
        console.warn(`[Judge] 청크 ${chunkNum} 실패:`, err.message, '→ fallback 적용');
        for (const e of chunk) await evaluateByRules(db, e);
      }
    }
  }

  // 4. Update trivial events
  for (const e of processedEvents) {
    await updateEvent(db, e.event_id, e.direction, e.level, e.signal, e.reason);
  }

  console.log('JaaS Evaluation completed.');
}

async function updateEvent(db, id, direction, level, signal, reason, extraFields = {}) {
  const { technical_signal, fundamental_signal, macro_signal, consensus_score, team_analysis } = extraFields;
  await db.run(
    `UPDATE investment_event
     SET impact_direction = ?, impact_level = ?, decision_signal = ?, ai_reason = ?, status = 'confirmed',
         technical_signal = COALESCE(?, technical_signal),
         fundamental_signal = COALESCE(?, fundamental_signal),
         macro_signal = COALESCE(?, macro_signal),
         consensus_score = COALESCE(?, consensus_score),
         team_analysis = COALESCE(?, team_analysis)
     WHERE event_id = ?`,
    [
      direction, level, signal, reason,
      technical_signal || null,
      fundamental_signal || null,
      macro_signal || null,
      consensus_score ?? null,
      team_analysis ? JSON.stringify(team_analysis) : null,
      id
    ]
  );
}

async function evaluateByRules(db, event) {
  let direction = 'neutral';
  let level = 'low';
  let signal = '보유';
  let reason = '규칙 기반 엔진에 의해 분석됨 (보수적 접근)';

  const type = event.event_type;
  const changePct = event.change_pct;

  if (['실적 호조', '수주 / 공급계약', '자사주 / 배당'].includes(type)) {
    direction = 'positive';
    level = Math.abs(changePct) > 3 ? 'high' : 'medium';
    signal = changePct < 0 ? '비중축소' : '추매검토';
  } else if (['어닝쇼크', '유상증자', 'CB / BW', '리콜'].includes(type)) {
    direction = 'negative';
    level = Math.abs(changePct) > 2 ? 'high' : 'medium';
    signal = changePct < -3.0 ? '매도검토' : '비중축소';
  }
  
  await updateEvent(db, event.event_id, direction, level, signal, reason);
}
