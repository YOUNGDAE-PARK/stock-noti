/**
 * 멀티에이전트 팀 판단 오케스트레이터
 * Agent A (기술적 분석가 = 수학자 + 주식전문가)
 * Agent B (거시경제 애널리스트 = 경제전문가 + 주가애널리스트)
 * Agent C (리스크 관리자 = 검증자)
 * Synthesis (AI 전문가 오케스트레이터)
 */

import { calculateIndicators } from './indicators.js';

const TIMEOUT_MS = 20000;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[TeamJudge] ${label} timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
    )
  ]);
}

function parseJSON(text, label) {
  try {
    return JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
  } catch (err) {
    console.warn(`[TeamJudge] JSON parse failed for ${label}:`, err.message);
    return null;
  }
}

async function runAgentA(chunk, indicatorsCache, model) {
  const prompt = `당신은 기술적 분석 전문가입니다. 수학적으로 계산된 기술적 지표를 해석하여 매매 신호를 도출하십시오.

[기술적 지표 해석 기준]
- RSI: overbought(>70)=비중축소 경계, oversold(<30)=추매 후보, bearish_neutral=하방 압력
- MACD: golden_cross=강한 매수, death_cross=강한 매도, bullish/bearish_momentum=방향성
- 볼린저밴드: upper_breakout=과매수, lower_breakout=과매도, squeeze=변동성 폭발 예고
- 거래량: volume_surge=강한 방향성, volume_dry=시장 무관심
- 이벤트 방향과 기술적 신호 괴리 시 반드시 indicator_conflicts에 명시하십시오

[이벤트 및 기술적 지표]
${chunk.map((e, idx) => `
ID: ${idx}
- 종목: ${e.asset_name} (${e.ticker})
- 이벤트: [${e.event_type}] ${e.event_title}
- 시장반응: 종목 ${e.change_pct}% | 거래량 ${(e.volume || 0).toLocaleString()}
- 기술적 지표: ${JSON.stringify(indicatorsCache[e.ticker] || { insufficientData: true })}
`).join('\n---\n')}

반드시 아래 JSON 배열 형식으로만 응답하십시오:
[
  {
    "id": 0,
    "technical_signal": "RSI 45(bearish_neutral)/MACD golden_cross/BB normal/거래량 1.8x",
    "tech_direction": "positive",
    "tech_level": "medium",
    "tech_signal_action": "추매검토",
    "tech_confidence": 3,
    "tech_summary": "기술적 신호 종합 1문장",
    "indicator_conflicts": null
  }
]`;

  const result = await withTimeout(model.generateContent(prompt), 'AgentA');
  return parseJSON(result.response.text(), 'AgentA');
}

async function runAgentB(chunk, marketContext, deltaContext, model) {
  const prompt = `당신은 거시경제 분석가이자 기업가치 평가 전문가입니다.
이벤트의 투자 thesis 정렬과 거시경제 맥락을 분석하십시오.

[핵심 분석 지침]
1. Investment Thesis Alignment: 이벤트가 보유이유를 강화하는지 훼손하는지 최우선 판단
2. 초과 수익률(excess_return) 해석: 지수 대비 약하면 'Sell on News' 가능성
3. 섹터 파급효과: 동일 섹터 종목에 미치는 영향 추정
4. Valuation Context: 급등 후 이벤트인지, 저평가 구간 이벤트인지 판단

[당일 시장 지수]
${JSON.stringify(marketContext)}

[최근 포트폴리오 변경 내역 (3일)]
${deltaContext || '최근 변경 없음'}

[이벤트 목록]
${chunk.map((e, idx) => `
ID: ${idx}
- 종목: ${e.asset_name} (${e.ticker}) | 시장: ${e.market}
- 보유이유: ${e.investment_thesis}
- 리스크요인: ${e.risk_keywords}
- 이벤트: [${e.event_type}] ${e.event_title} (출처: ${e.primary_source_type})
- 초과수익: ${(e.excess_return || 0).toFixed(2)}% (종목 ${e.change_pct}% vs 지수 ${e.market_change}%)
`).join('\n---\n')}

반드시 아래 JSON 배열 형식으로만 응답하십시오:
[
  {
    "id": 0,
    "thesis_alignment": "강화",
    "macro_context": "거시경제 맥락 요약",
    "fundamental_signal": "기업가치 관점 평가",
    "macro_direction": "positive",
    "macro_level": "medium",
    "macro_signal_action": "추매검토",
    "macro_confidence": 4,
    "sector_impact": null,
    "pros": ["긍정 근거1"],
    "cons": ["리스크1"],
    "uncertainties": ["불확실성1"],
    "next_check": "향후 모니터링 포인트"
  }
]`;

  const result = await withTimeout(model.generateContent(prompt), 'AgentB');
  return parseJSON(result.response.text(), 'AgentB');
}

async function runAgentC(chunk, model) {
  const prompt = `당신은 포트폴리오 리스크 관리자입니다.
포트폴리오 제약조건과 이벤트 신뢰도를 검증하십시오.

[검증 기준]
1. 비중 제약: 현재비중 >= 목표비중이면 '추매검토' 신호에 패널티 필요
2. 신뢰도: reliability_score 1~2(NEWS만)는 신뢰도 낮음 경고
3. 리스크 키워드 직접 히트 시 가중 경고
4. 출처 신뢰도: DART(5) > IR(4) > KIND(3) > NEWS(2)

[이벤트 목록]
${chunk.map((e, idx) => `
ID: ${idx}
- 종목: ${e.asset_name} (${e.ticker})
- 비중: 현재 ${e.holding_weight}% / 목표 ${e.target_weight}% / 최대 ${e.max_weight}%
- 신뢰도: ${e.reliability_score}/5 (출처: ${e.primary_source_type})
- 리스크요인: ${e.risk_keywords}
- 이벤트: [${e.event_type}] ${e.event_title}
`).join('\n---\n')}

반드시 아래 JSON 배열 형식으로만 응답하십시오:
[
  {
    "id": 0,
    "weight_constraint_ok": true,
    "weight_warning": null,
    "reliability_check": "신뢰도 평가 요약",
    "risk_keyword_hit": false,
    "risk_assessment": "리스크 수준 평가",
    "risk_signal_action": "보유",
    "risk_confidence": 3
  }
]`;

  const result = await withTimeout(model.generateContent(prompt), 'AgentC');
  return parseJSON(result.response.text(), 'AgentC');
}

async function runSynthesis(agentAResults, agentBResults, agentCResults, chunk, model) {
  const prompt = `당신은 투자팀 AI 전문가 오케스트레이터입니다.
기술적 분석가(A), 거시경제 애널리스트(B), 리스크 관리자(C)의 분석을 종합하여
최종 투자 신호와 합의 점수를 도출하십시오.

[consensus_score 산정 원칙]
기준 50점에서 시작:
- 3개 에이전트 방향 일치: +25 / 2개 일치: +10 / 3분화: 0
- thesis_alignment '강화': +10 / '훼손': -10
- tech_confidence >= 4: +5
- risk_keyword_hit == true: -10
- weight_constraint_ok == false: -15
- 최종 신호 '매도검토' 또는 '추매검토' 강도 높으면 ±5 추가
범위: 0~100 클램핑

[Agent A - 기술적 분석 결과]
${JSON.stringify(agentAResults || '데이터 없음')}

[Agent B - 거시경제/애널리스트 결과]
${JSON.stringify(agentBResults || '데이터 없음')}

[Agent C - 리스크 관리자 결과]
${JSON.stringify(agentCResults || '데이터 없음')}

[원본 이벤트 참조]
${chunk.map((e, idx) => `ID ${idx}: ${e.asset_name}(${e.ticker}) | [${e.event_type}] ${e.event_title}`).join('\n')}

반드시 아래 JSON 배열 형식으로만 응답하십시오:
[
  {
    "id": 0,
    "consensus_score": 72,
    "final_direction": "positive",
    "final_level": "medium",
    "final_signal": "추매검토",
    "synthesis_reason": "3개 에이전트 종합 판단 근거 (2~3문장)",
    "dissent": null,
    "agent_votes": {"A": "추매검토", "B": "추매검토", "C": "보유"}
  }
]`;

  const result = await withTimeout(model.generateContent(prompt), 'Synthesis');
  return parseJSON(result.response.text(), 'Synthesis');
}

function assembleTeamReason(synth, agentA, agentB, agentC) {
  const lines = [];
  lines.push(`[팀 합의] ${synth.synthesis_reason}`);
  lines.push(`[합의 점수] ${synth.consensus_score}/100 | 투표: A=${synth.agent_votes?.A || '-'} B=${synth.agent_votes?.B || '-'} C=${synth.agent_votes?.C || '-'}`);
  if (synth.dissent) lines.push(`[소수의견] ${synth.dissent}`);
  lines.push('');
  lines.push(`● 기술적 신호: ${agentA?.technical_signal || '분석 불가'}${agentA?.indicator_conflicts ? ` ⚡ 괴리: ${agentA.indicator_conflicts}` : ''}`);

  if (agentB) {
    lines.push(`● 거시경제: ${agentB.macro_context || '-'} | Thesis: ${agentB.thesis_alignment || '-'}`);
    if (agentB.pros?.length)         lines.push(`● 긍정 요인: ${agentB.pros.join(', ')}`);
    if (agentB.cons?.length)         lines.push(`● 리스크 요인: ${agentB.cons.join(', ')}`);
    if (agentB.uncertainties?.length) lines.push(`● 불확실성: ${agentB.uncertainties.join(', ')}`);
    if (agentB.next_check)           lines.push(`● 향후 체크: ${agentB.next_check}`);
  }

  if (agentC) {
    const riskLine = `● 리스크: ${agentC.risk_assessment || '-'}`;
    const weightWarn = agentC.weight_warning ? ` ⚠️ ${agentC.weight_warning}` : '';
    lines.push(riskLine + weightWarn);
  }

  return lines.join('\n');
}

export async function evaluateWithTeam(db, chunk, marketContext, deltaContext, genAI, model) {
  console.log(`[TeamJudge] >>> 팀 에이전트 분석 시작: ${chunk.length}개 이벤트`);

  // 1. 기술적 지표 수집 (ticker별 memoize)
  const indicatorsCache = {};
  for (const e of chunk) {
    if (!indicatorsCache[e.ticker]) {
      indicatorsCache[e.ticker] = await calculateIndicators(db, e.ticker);
    }
  }
  console.log(`[TeamJudge] >>> STEP 1: 기술적 지표 계산 완료 (${Object.keys(indicatorsCache).length}개 종목)`);

  // 2. 3개 에이전트 병렬 실행
  const [settledA, settledB, settledC] = await Promise.allSettled([
    runAgentA(chunk, indicatorsCache, model),
    runAgentB(chunk, marketContext, deltaContext, model),
    runAgentC(chunk, model)
  ]);

  const agentAResults = settledA.status === 'fulfilled' ? settledA.value : null;
  const agentBResults = settledB.status === 'fulfilled' ? settledB.value : null;
  const agentCResults = settledC.status === 'fulfilled' ? settledC.value : null;

  if (settledA.status === 'rejected') console.warn('[TeamJudge] Agent A 실패:', settledA.reason?.message);
  if (settledB.status === 'rejected') console.warn('[TeamJudge] Agent B 실패:', settledB.reason?.message);
  if (settledC.status === 'rejected') console.warn('[TeamJudge] Agent C 실패:', settledC.reason?.message);

  if (!agentAResults && !agentBResults && !agentCResults) {
    console.warn('[TeamJudge] 모든 에이전트 실패. fallback 필요.');
    return null;
  }

  console.log(`[TeamJudge] >>> STEP 2: 에이전트 병렬 분석 완료 (A:${agentAResults ? 'OK' : 'FAIL'} B:${agentBResults ? 'OK' : 'FAIL'} C:${agentCResults ? 'OK' : 'FAIL'})`);

  // 3. Synthesis 에이전트
  let synthesisResults;
  try {
    synthesisResults = await runSynthesis(agentAResults, agentBResults, agentCResults, chunk, model);
  } catch (err) {
    console.warn('[TeamJudge] Synthesis 실패:', err.message);
    return null;
  }

  if (!synthesisResults) {
    console.warn('[TeamJudge] Synthesis 결과 파싱 실패. fallback 필요.');
    return null;
  }

  console.log(`[TeamJudge] >>> STEP 3: Synthesis 완료`);

  // 4. 결과 조립
  const results = [];
  for (const synth of synthesisResults) {
    const e = chunk[synth.id];
    if (!e) continue;

    const agentA = agentAResults?.[synth.id] || null;
    const agentB = agentBResults?.[synth.id] || null;
    const agentC = agentCResults?.[synth.id] || null;

    const indicators = indicatorsCache[e.ticker];
    const technicalSignal = agentA?.technical_signal || (indicators?.summary ? `[자동] ${indicators.summary}` : '지표 부족');
    const fundamentalSignal = agentB?.fundamental_signal || null;
    const macroSignal = agentB?.macro_context || null;

    results.push({
      id: synth.id,
      direction: synth.final_direction,
      level: synth.final_level,
      signal: synth.final_signal,
      reason: assembleTeamReason(synth, agentA, agentB, agentC),
      technical_signal: technicalSignal,
      fundamental_signal: fundamentalSignal,
      macro_signal: macroSignal,
      consensus_score: synth.consensus_score,
      team_analysis: {
        agentA: agentA,
        agentB: agentB,
        agentC: agentC,
        synthesis: synth,
        indicators: indicators
      }
    });
  }

  return results;
}
