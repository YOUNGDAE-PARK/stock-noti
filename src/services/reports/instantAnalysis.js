import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { getDb } from '../../db/db.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NotificationService } from '../notificationService.js';
import { getReportsDir } from '../../utils/paths.js';
import { syncPortfolioPrices, recalculatePortfolioWeights } from '../api.js';
import { calculateIndicators } from '../indicators.js';
import { performance } from 'perf_hooks';

const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.replace(/[\r\n\s]/g, '') : null;
const isGeminiAvailable = !!(apiKey && apiKey !== 'your_gemini_api_key_here' && apiKey !== '');

const TIMEOUT_MS = 20000;
const CHUNK_SIZE = 5;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[InstantAnalysis] ${label} timeout`)), TIMEOUT_MS)
    )
  ]);
}

function parseJSON(text, label) {
  try {
    return JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
  } catch {
    console.warn(`[InstantAnalysis] JSON parse failed: ${label}`);
    return null;
  }
}

export async function runInstantAnalysis(userInput) {
  const startTime = performance.now();

  let uid, email;
  if (typeof userInput === 'string') {
    uid = userInput;
    email = null;
  } else if (userInput && typeof userInput === 'object') {
    uid = userInput.uid;
    email = userInput.email;
  }
  if (!uid) throw new Error('User UID is required for analysis.');

  const db = await getDb(uid, email);
  console.log(`[Instant Analysis] >>> STEP 0: Starting for user ${email || uid}`);

  // 1. 가격 동기화
  const syncStart = performance.now();
  await syncPortfolioPrices(db);
  await recalculatePortfolioWeights(db);
  const syncEnd = performance.now();
  console.log(`[Instant Analysis] >>> STEP 1: Price sync done (${((syncEnd - syncStart) / 1000).toFixed(1)}s)`);

  const assets = await db.all('SELECT * FROM portfolio_asset WHERE is_active = 1');
  if (assets.length === 0) throw new Error('포트폴리오가 비어있습니다.');

  // 2. 30일 히스토리 수집
  const historyStart = performance.now();
  console.log(`[Instant Analysis] >>> STEP 2: Fetching 30-day history for ${assets.length} assets...`);
  for (const asset of assets) {
    await populateHistoryFromNaver(db, asset);
  }
  const historyEnd = performance.now();
  console.log(`[Instant Analysis] >>> STEP 2: History done (${((historyEnd - historyStart) / 1000).toFixed(1)}s)`);

  // 3. 기술적 지표 계산 (수학자 — AI 없음)
  console.log(`[Instant Analysis] >>> STEP 3: Calculating technical indicators...`);
  const indicatorsCache = {};
  for (const asset of assets) {
    indicatorsCache[asset.ticker] = await calculateIndicators(db, asset.ticker);
  }

  // 4. 팀 에이전트 분석 (청크 단위)
  const aiStart = performance.now();
  console.log(`[Instant Analysis] >>> STEP 4: Team agent analysis (chunk size ${CHUNK_SIZE})...`);
  const results = [];

  if (isGeminiAvailable) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { temperature: 0.2 } });

    for (let i = 0; i < assets.length; i += CHUNK_SIZE) {
      const chunk = assets.slice(i, i + CHUNK_SIZE);
      const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
      console.log(`[Instant Analysis] >>> STEP 4-${chunkNum}: Analyzing chunk (${chunk.length}종목)...`);

      const enrichedChunk = await Promise.all(chunk.map(async (asset) => {
        const events = await db.all(
          'SELECT * FROM investment_event WHERE ticker = ? ORDER BY event_date DESC LIMIT 3',
          [asset.ticker]
        );
        const deltas = await db.all(
          'SELECT * FROM portfolio_delta_log WHERE ticker = ? AND timestamp >= date("now", "-7 days") ORDER BY timestamp DESC',
          [asset.ticker]
        );
        return { ...asset, events, deltas, indicators: indicatorsCache[asset.ticker] };
      }));

      const chunkResults = await analyzeChunkWithTeam(enrichedChunk, model);
      results.push(...chunkResults);
    }
  } else {
    // Gemini 없을 때 기술적 지표 기반 fallback
    for (const asset of assets) {
      const events = await db.all('SELECT * FROM investment_event WHERE ticker = ? ORDER BY event_date DESC LIMIT 3', [asset.ticker]);
      const ind = indicatorsCache[asset.ticker];
      const signal = ind?.overallBias === 'bullish' ? '추매검토' : ind?.overallBias === 'bearish' ? '비중축소' : '보유';
      results.push({
        asset, events,
        signal,
        aiSummary: ind?.insufficientData ? '기술적 지표 데이터 부족' : `기술적 지표 기반: ${ind?.summary}`,
        technicalSummary: ind?.summary || null,
        consensusScore: null,
        agentVotes: null
      });
    }
  }

  const aiEnd = performance.now();
  console.log(`[Instant Analysis] >>> STEP 4: AI done (${((aiEnd - aiStart) / 1000).toFixed(1)}s)`);

  const totalTime = (performance.now() - startTime) / 1000;
  const stats = {
    syncTime: ((syncEnd - syncStart) / 1000).toFixed(2),
    historyTime: ((historyEnd - historyStart) / 1000).toFixed(2),
    aiTime: ((aiEnd - aiStart) / 1000).toFixed(2),
    totalTime: totalTime.toFixed(2),
    assetCount: assets.length
  };

  const report = generateMarkdownReport(results, stats);
  const { filePath, filename } = saveReport(report, uid);

  await NotificationService.sendPersonalizedReport(
    { uid, email },
    `⚡ 즉시분석 리포트 (${stats.totalTime}s)`,
    report,
    'urgent'
  );

  console.log(`[Instant Analysis] >>> DONE in ${stats.totalTime}s`);
  return { filename, filePath, results };
}

async function analyzeChunkWithTeam(chunk, model) {
  const buildChunkText = (c) => c.map((asset, idx) => `
ID: ${idx}
- 종목: ${asset.name} (${asset.ticker}) | 비중: ${asset.holding_weight}% / 목표: ${asset.target_weight}% / 최대: ${asset.max_weight}%
- 보유이유: ${asset.investment_thesis || '미입력'}
- 리스크요인: ${asset.risk_keywords || '없음'}
- 평균단가: ${asset.avg_price.toLocaleString()}원
- 기술적지표: ${JSON.stringify(asset.indicators || { insufficientData: true })}
- 최근이벤트: ${asset.events.map(e => `[${e.event_date}] ${e.event_title}(${e.decision_signal})`).join(' | ') || '없음'}
- 최근매매(7일): ${asset.deltas.map(d => `${d.action_type}(${d.delta_qty})`).join(', ') || '없음'}
`).join('\n---\n');

  // Agent A: 기술적 분석가 (수학자 + 주식전문가)
  let agentAResults = null;
  try {
    const promptA = `당신은 기술적 분석 전문가입니다. 수학적으로 계산된 기술적 지표를 해석하여 매매 신호를 도출하십시오.

[지표 해석 기준]
- RSI: overbought(>70)=비중축소, oversold(<30)=추매, bearish_neutral=하방압력
- MACD: golden_cross=강한매수, death_cross=강한매도
- 볼린저밴드: upper_breakout=과매수, lower_breakout=과매도, squeeze=변동성폭발예고
- 거래량: volume_surge=강한방향성, volume_dry=시장무관심

[종목 및 지표]
${buildChunkText(chunk)}

반드시 아래 JSON 배열로만 응답:
[{"id":0,"tech_signal":"RSI+MACD+BB요약","tech_action":"보유","tech_confidence":3,"tech_summary":"기술적 신호 1문장","conflicts":null}]`;

    const r = await withTimeout(model.generateContent(promptA), 'AgentA');
    agentAResults = parseJSON(r.response.text(), 'AgentA');
  } catch (e) {
    console.warn('[InstantAnalysis] Agent A 실패:', e.message);
  }

  // Agent B: 거시경제 + 기업가치 애널리스트
  let agentBResults = null;
  try {
    const promptB = `당신은 거시경제 분석가이자 기업가치 평가 전문가입니다.
각 종목의 투자 thesis와 최근 이벤트/매매 이력을 분석하여 펀더멘털 판단을 내리십시오.

[분석 포인트]
1. 보유이유(thesis)가 현재도 유효한가
2. 최근 이벤트가 thesis를 강화/훼손하는가
3. 비중이 목표/최대를 초과하는지 체크
4. 최근 매매 이력과 이벤트의 일관성

[종목 목록]
${buildChunkText(chunk)}

반드시 아래 JSON 배열로만 응답:
[{"id":0,"thesis_alignment":"강화","fundamental_action":"추매검토","fundamental_confidence":4,"pros":["근거1"],"cons":["리스크1"],"next_check":"모니터링포인트"}]`;

    const r = await withTimeout(model.generateContent(promptB), 'AgentB');
    agentBResults = parseJSON(r.response.text(), 'AgentB');
  } catch (e) {
    console.warn('[InstantAnalysis] Agent B 실패:', e.message);
  }

  // Agent C: 리스크 관리자 + 검증자
  let agentCResults = null;
  try {
    const promptC = `당신은 포트폴리오 리스크 관리자입니다.
각 종목의 비중 제약, 집중도, 변동성 리스크를 검증하십시오.

[검증 기준]
1. 현재비중 >= 목표비중이면 추매 시 패널티
2. 단일 종목 비중 > 20%는 집중 위험
3. 단일종목레버리지 ETF는 변동성 소멸 리스크 추가
4. 이벤트 없이 급등/급락한 경우 원인 불명 위험

[종목 목록]
${buildChunkText(chunk)}

반드시 아래 JSON 배열로만 응답:
[{"id":0,"weight_ok":true,"concentration_risk":false,"risk_action":"보유","risk_warning":null,"risk_confidence":4}]`;

    const r = await withTimeout(model.generateContent(promptC), 'AgentC');
    agentCResults = parseJSON(r.response.text(), 'AgentC');
  } catch (e) {
    console.warn('[InstantAnalysis] Agent C 실패:', e.message);
  }

  // Synthesis: AI 전문가 오케스트레이터
  let synthesisResults = null;
  try {
    const promptS = `당신은 자산운용 CIO입니다.
기술적 분석가(A), 기업가치 애널리스트(B), 리스크 관리자(C) 의견을 종합하여 최종 투자 판단을 내리십시오.

[consensus_score 산정 (0~100)]
기준 50점:
- 3개 에이전트 방향 일치: +25 / 2개: +10
- thesis_alignment '강화': +10 / '훼손': -10
- tech_confidence >= 4: +5
- concentration_risk true: -15
- weight_ok false: -10

[Agent A 결과] ${JSON.stringify(agentAResults || '없음')}
[Agent B 결과] ${JSON.stringify(agentBResults || '없음')}
[Agent C 결과] ${JSON.stringify(agentCResults || '없음')}

[종목 참조]
${chunk.map((a, i) => `ID ${i}: ${a.name}(${a.ticker}) 비중${a.holding_weight}%`).join('\n')}

반드시 아래 JSON 배열로만 응답:
[{"id":0,"consensus_score":72,"final_signal":"보유","summary":"3문장 종합 분석","agent_votes":{"A":"추매검토","B":"보유","C":"보유"},"dissent":null}]`;

    const r = await withTimeout(model.generateContent(promptS), 'Synthesis');
    synthesisResults = parseJSON(r.response.text(), 'Synthesis');
  } catch (e) {
    console.warn('[InstantAnalysis] Synthesis 실패:', e.message);
  }

  // 결과 조립
  return chunk.map((asset, idx) => {
    const a = agentAResults?.find(x => x.id === idx);
    const b = agentBResults?.find(x => x.id === idx);
    const c = agentCResults?.find(x => x.id === idx);
    const s = synthesisResults?.find(x => x.id === idx);

    const signal = s?.final_signal || b?.fundamental_action || a?.tech_action || '보유';
    const consensusScore = s?.consensus_score ?? null;

    const summaryLines = [];
    if (s?.summary) summaryLines.push(s.summary);
    if (b?.pros?.length)  summaryLines.push(`✅ ${b.pros.join(', ')}`);
    if (b?.cons?.length)  summaryLines.push(`⚠️ ${b.cons.join(', ')}`);
    if (a?.conflicts)     summaryLines.push(`⚡ 괴리: ${a.conflicts}`);
    if (c?.risk_warning)  summaryLines.push(`🚨 ${c.risk_warning}`);
    if (b?.next_check)    summaryLines.push(`📌 체크: ${b.next_check}`);

    return {
      asset,
      events: asset.events,
      signal,
      aiSummary: summaryLines.join('\n') || '분석 불가',
      technicalSummary: a?.tech_signal || asset.indicators?.summary || null,
      consensusScore,
      agentVotes: s?.agent_votes || null
    };
  });
}

async function populateHistoryFromNaver(db, asset) {
  try {
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${asset.ticker}&timeframe=day&count=35&requestType=0`;
    const response = await axios.get(url, { timeout: 8000 });
    const xml = response.data;
    const itemRegex = /<item data="([^"]+)"\s*\/>/g;
    let match;
    const candles = [];
    while ((match = itemRegex.exec(xml)) !== null) candles.push(match[1]);
    if (candles.length === 0) return;

    for (let i = 0; i < candles.length; i++) {
      const p = candles[i].split('|');
      const date = `${p[0].substring(0, 4)}-${p[0].substring(4, 6)}-${p[0].substring(6, 8)}`;
      const close = parseFloat(p[4]);
      const vol = parseInt(p[5], 10);
      let changePct = 0;
      if (i > 0) {
        const prevClose = parseFloat(candles[i - 1].split('|')[4]);
        changePct = prevClose !== 0 ? ((close - prevClose) / prevClose) * 100 : 0;
      }
      await db.run(
        `INSERT OR REPLACE INTO market_snapshot_daily (date, ticker, close_price, change_pct, volume, asset_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [date, asset.ticker, close, changePct, vol, asset.asset_type]
      );
    }
  } catch (err) {
    console.warn(`[Instant Analysis] History sync failed for ${asset.ticker}:`, err.message);
  }
}

function generateMarkdownReport(results, stats) {
  const now = new Date();
  let report = `⚡ *실시간 포트폴리오 즉시 분석 리포트 (팀 에이전트)*\n`;
  report += `*분석 시각: ${now.toLocaleString()}*\n\n`;

  // 신호별 분류
  const urgent = results.filter(r => ['매도검토', '비중축소'].includes(r.signal));
  const buy    = results.filter(r => r.signal === '추매검토');
  const hold   = results.filter(r => !['매도검토', '비중축소', '추매검토'].includes(r.signal));

  if (urgent.length > 0) {
    report += `🔴 *주의 필요 종목*\n`;
    urgent.forEach(r => report += renderAsset(r));
    report += '\n';
  }
  if (buy.length > 0) {
    report += `🔵 *추매 검토 종목*\n`;
    buy.forEach(r => report += renderAsset(r));
    report += '\n';
  }
  if (hold.length > 0) {
    report += `⚪ *보유/관찰 종목*\n`;
    hold.forEach(r => report += renderAsset(r));
  }

  report += `\n*[시스템 실행 통계]*\n`;
  report += `• 분석 대상: ${stats.assetCount}개 종목\n`;
  report += `• 가격동기화: ${stats.syncTime}s | 히스토리: ${stats.historyTime}s | AI분석: ${stats.aiTime}s\n`;
  report += `• 총 소요 시간: *${stats.totalTime}초*\n`;

  return report;
}

function renderAsset(res) {
  const { asset, events, signal, aiSummary, technicalSummary, consensusScore, agentVotes } = res;
  const signalEmoji = signal === '추매검토' ? '🔵' : ['매도검토', '비중축소'].includes(signal) ? '🔴' : '⚪';

  let out = `\n*${asset.name}* (${asset.ticker})\n`;
  out += `💰 현재가: ${asset.avg_price.toLocaleString()}원 | 비중: ${asset.holding_weight}%\n`;
  out += `${signalEmoji} *최종 권고: ${signal}*`;
  if (consensusScore !== null) out += ` | 📊 팀합의: ${consensusScore}/100`;
  if (agentVotes) out += ` | 투표: A=${agentVotes.A || '-'} B=${agentVotes.B || '-'} C=${agentVotes.C || '-'}`;
  out += '\n';
  if (technicalSummary) out += `> 📈 기술적: ${technicalSummary}\n`;
  if (aiSummary) {
    aiSummary.split('\n').forEach(line => { out += `> ${line}\n`; });
  }
  if (events.length > 0) {
    out += `🗓 *최근 주요 이벤트*\n`;
    events.forEach(e => { out += `• [${e.event_date}] ${e.event_title} (*${e.decision_signal}*)\n`; });
  }
  return out;
}

function saveReport(report, uid) {
  const reportDir = getReportsDir(uid);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

  const now = new Date();
  const dateStr = now.toISOString().substring(0, 10).replace(/-/g, '');
  const timeStr = now.toTimeString().substring(0, 5).replace(/:/g, '');
  const filename = `instant_report_${dateStr}_${timeStr}00.md`;
  const filePath = path.join(reportDir, filename);
  fs.writeFileSync(filePath, report, 'utf-8');
  return { filePath, filename };
}
