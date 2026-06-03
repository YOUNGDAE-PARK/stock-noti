import { getDb } from '../db/db.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

  // 3. Batch AI Evaluation (Professional Multi-layered Judgment)
  if (isGeminiAvailable && aiTargets.length > 0) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ 
        model: 'gemini-2.5-flash',
        generationConfig: { temperature: 0.2 } 
      });

      const chunkSize = 10;
      for (let i = 0; i < aiTargets.length; i += chunkSize) {
        const chunk = aiTargets.slice(i, i + chunkSize);
        
        const prompt = `
당신은 베테랑 펀드매니저이자 투자 전략가입니다. 아래 [투자 이벤트 목록]을 분석하여 전문적인 판단 신호와 심층 근거를 도출하십시오.

[핵심 판단 지침]
1. **Investment Thesis Alignment**: 뉴스가 사용자의 '보유이유'를 강화하는지, 아니면 핵심 논리를 훼손하는지 최우선으로 보십시오.
2. **Relative Performance**: 절대 등락률이 아닌 시장 지수 대비 '초과 수익률(Excess Return)'과 거래량을 기반으로 시장의 진정한 해석을 파악하십시오. (예: 호재에도 지수 대비 약하면 Sell on News 가능성)
3. **Portfolio Constraints**: 현재 비중이 목표 비중을 초과했거나 최대 비중에 근접했다면, 아무리 좋은 뉴스라도 '추매검토' 대신 '보유' 또는 '비중축소'를 권고하십시오.
4. **Valuation & Risk**: 리스크 키워드와 연관된 뉴스인 경우 가중치를 두어 분석하고, 밸류에이션 부담이 느껴지는 구간(급등 후 등)인지 고려하십시오.
5. **Recent Actions Context**: 아래 [최근 포트폴리오 변경 내역]을 참고하여, 사용자의 최근 매수/매도 행보와 일관성 있는 조언을 제공하거나, 최근 행동 이후 발생한 이벤트에 대해 피드백을 주십시오.
6. **Structural Reasoning**: 단순히 찬성 근거만 나열하지 말고, 반대 논리(Cons)와 현재 알 수 없는 불확실성(Uncertainty)을 반드시 포함하십시오.

[최근 포트폴리오 변경 내역 (최근 3일)]
${deltaContext || '최근 변경 내역 없음'}

[투자 이벤트 목록]
${chunk.map((e, idx) => `
ID: ${idx}
- 종목: ${e.asset_name} (${e.ticker}) | 비중: 현재 ${e.holding_weight}% / 목표 ${e.target_weight}% (최대 ${e.max_weight}%)
- 보유이유: ${e.investment_thesis}
- 리스크요인: ${e.risk_keywords}
- 이벤트: [${e.event_type}] ${e.event_title} (출처: ${e.primary_source_type})
- 시장반응: 종목 ${e.change_pct}% | 지수 ${e.market_change}% | 초과수익 ${e.excess_return.toFixed(2)}% | 거래량 ${e.volume.toLocaleString()}
`).join('\n---\n')}

반드시 아래 JSON 배열 형식으로만 응답하십시오:
[
  {
    "id": 0,
    "direction": "positive | negative | neutral",
    "level": "high | medium | low",
    "signal": "매도검토 | 비중축소 | 보유 | 추매검토 | 관찰",
    "thesis_impact": "강화 | 중립 | 훼손",
    "confidence": 1~5,
    "summary": "핵심 판단 요약 (1문장)",
    "pros": ["근거1", "근거2"],
    "cons": ["반대논리/리스크1"],
    "uncertainties": ["미확인 사항"],
    "next_check": "향후 모니터링 포인트"
  }
]
`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const llmResults = JSON.parse(responseText);

        for (const res of llmResults) {
          const e = chunk[res.id];
          if (!e) continue;

          // Format professional reason string
          const fullReason = `
[판단 요약] ${res.summary}
[Thesis 영향] ${res.thesis_impact} (신뢰도: ${res.confidence}/5)

● 긍정 요인: ${res.pros.join(', ')}
● 리스크 요인: ${res.cons.join(', ')}
● 불확실성: ${res.uncertainties.join(', ')}
● 향후 체크: ${res.next_check}
`.trim();

          await updateEvent(db, e.event_id, res.direction, res.level, res.signal, fullReason);
        }
      }
    } catch (err) {
      console.warn('[Gemini Evaluator] Batch analysis failed, falling back to simple rules:', err.message);
      for (const e of aiTargets) await evaluateByRules(db, e);
    }
  }

  // 4. Update trivial events
  for (const e of processedEvents) {
    await updateEvent(db, e.event_id, e.direction, e.level, e.signal, e.reason);
  }

  console.log('JaaS Evaluation completed.');
}

async function updateEvent(db, id, direction, level, signal, reason) {
  await db.run(
    `UPDATE investment_event 
     SET impact_direction = ?, impact_level = ?, decision_signal = ?, ai_reason = ?, status = 'confirmed' 
     WHERE event_id = ?`,
    [direction, level, signal, reason, id]
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
