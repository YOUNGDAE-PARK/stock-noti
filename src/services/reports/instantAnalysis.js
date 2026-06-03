import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { getDb } from '../../db/db.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NotificationService } from '../notificationService.js';
import { getReportsDir } from '../../utils/paths.js';
import { syncPortfolioPrices, recalculatePortfolioWeights } from '../api.js';

const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.replace(/[\r\n\s]/g, '') : null;
const isGeminiAvailable = !!(apiKey && apiKey !== 'your_gemini_api_key_here' && apiKey !== '');

import { performance } from 'perf_hooks';

/**
 * Executes an immediate, deep analysis of the current portfolio using Gemini AI.
 */
export async function runInstantAnalysis(userInput) {
  const startTime = performance.now();
  
  // Robust identification parsing
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

  console.log(`[Instant Analysis] Initiating deep dive for user ${email || uid}...`);

  // 1. Refresh real-time data
  const syncStart = performance.now();
  await syncPortfolioPrices(db);
  await recalculatePortfolioWeights(db);
  const syncEnd = performance.now();

  const assets = await db.all('SELECT * FROM portfolio_asset WHERE is_active = 1');
  if (assets.length === 0) throw new Error('포트폴리오가 비어있습니다.');

  // 2. Refresh market history (Last 30 days)
  console.log(`[Instant Analysis] Fetching historical data for ${assets.length} assets...`);
  const historyStart = performance.now();
  for (const asset of assets) {
    await populateHistoryFromNaver(db, asset);
  }
  const historyEnd = performance.now();

  // 3. AI-driven Analysis (Parallelized for performance)
  console.log(`[Instant Analysis] Running deep AI reasoning...`);
  const aiStart = performance.now();
  const results = await performDeepAnalysis(db, assets);
  const aiEnd = performance.now();
  
  const totalTime = (performance.now() - startTime) / 1000;
  const stats = {
    syncTime: ((syncEnd - syncStart) / 1000).toFixed(2),
    historyTime: ((historyEnd - historyStart) / 1000).toFixed(2),
    aiTime: ((aiEnd - aiStart) / 1000).toFixed(2),
    totalTime: totalTime.toFixed(2),
    assetCount: assets.length
  };

  // 4. Report & Notification
  const report = generateMarkdownReport(results, stats);
  const { filePath, filename } = saveReport(report, uid);

  await NotificationService.sendPersonalizedReport(
    { uid, email },
    `⚡ 즉시분석 리포트 (${stats.totalTime}s)`,
    report,
    'urgent'
  );

  console.log(`[Instant Analysis] Completed in ${stats.totalTime}s (Sync: ${stats.syncTime}s, History: ${stats.historyTime}s, AI: ${stats.aiTime}s)`);
  return { filename, filePath, results };
}

async function populateHistoryFromNaver(db, asset) {
  try {
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${asset.ticker}&timeframe=day&count=30&requestType=0`;
    const response = await axios.get(url);
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
        const prevClose = parseFloat(candles[i-1].split('|')[4]);
        changePct = prevClose !== 0 ? ((close - prevClose) / prevClose) * 100 : 0;
      }

      await db.run(
        `INSERT OR REPLACE INTO market_snapshot_daily (date, ticker, close_price, change_pct, volume, asset_type) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [date, asset.ticker, close, changePct, vol, asset.asset_type]
      );
    }
  } catch (err) {
    console.error(`[Instant Analysis] Failed history sync for ${asset.ticker}:`, err.message);
  }
}

async function performDeepAnalysis(db, assets) {
  let model = null;
  if (isGeminiAvailable) {
    const genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash'
    });
  }

  const analysisPromises = assets.map(async (asset) => {
    // 1. Fetch recent data
    const events = await db.all('SELECT * FROM investment_event WHERE ticker = ? ORDER BY event_date DESC LIMIT 3', [asset.ticker]);
    const candles = await db.all('SELECT * FROM market_snapshot_daily WHERE ticker = ? ORDER BY date DESC LIMIT 10', [asset.ticker]);
    
    // Fetch recent deltas for this asset
    const deltas = await db.all('SELECT * FROM portfolio_delta_log WHERE ticker = ? AND timestamp >= date("now", "-7 days") ORDER BY timestamp DESC', [asset.ticker]);
    const deltaStr = deltas.map(d => `${d.timestamp}: ${d.action_type}(${d.delta_qty})`).join(', ');

    let aiSummary = "AI 분석을 수행할 수 없습니다.";
    let signal = "보유";

    if (model) {
      try {
        // Summarize trend to save tokens
        const latestPrice = candles.length > 0 ? candles[0].close_price : 0;
        const trend = candles.map(c => `${c.change_pct}%`).join('->');

        const prompt = `
당신은 주식 분석 전문가입니다. 아래 정보를 바탕으로 종목을 진단하십시오.

[종목] ${asset.name} (${asset.ticker}) | 비중: ${asset.holding_weight}%
[아이디어] ${asset.investment_thesis}
[최근 변경이력] ${deltaStr || '없음'}
[최근이벤트]
${events.map(e => `- ${e.event_date}: ${e.event_title} (${e.decision_signal})`).join('\n')}
[최근주가추이(10일)] ${trend} (현재가: ${latestPrice.toLocaleString()}원)

[요구사항]
1. 사용자의 최근 매매 행보와 이벤트를 연결하여 분석하십시오.
2. 아이디어 대비 리스크/기회 요인을 짚어주십시오.
3. 최종 제안(매도검토|비중축소|보유|추매검토)과 이유를 JSON으로 응답하십시오.

응답형식:
{"summary": "3문장 요약", "signal": "매도검토|비중축소|보유|추매검토", "reason": "1문장 요약"}
`;
        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const json = JSON.parse(text);
        aiSummary = json.summary;
        signal = json.signal;
      } catch (err) {
        console.warn(`[Instant Analysis] AI analysis failed for ${asset.name}:`, err.message);
      }
    }

    return { asset, events, aiSummary, signal };
  });

  return await Promise.all(analysisPromises);
}

function generateMarkdownReport(results, stats) {
  const now = new Date();
  let report = `⚡ *실시간 포트폴리오 즉시 분석 리포트*\n`;
  report += `*발성 시각: ${now.toLocaleString()}*\n\n`;
  
  results.forEach(res => {
    const signalEmoji = res.signal === '추매검토' ? '🔵' : res.signal === '매도검토' || res.signal === '비중축소' ? '🔴' : '⚪';
    report += `*${res.asset.name}* (${res.asset.ticker})\n`;
    report += `💰 현재가: ${res.asset.avg_price.toLocaleString()}원 | 비중: ${res.asset.holding_weight}%\n`;
    report += `${signalEmoji} *최종 권고: ${res.signal}*\n`;
    report += `> AI 분석: ${res.aiSummary}\n`;
    
    if (res.events.length > 0) {
      report += `🗓 *최근 주요 이벤트*\n`;
      res.events.forEach(e => {
        report += `• [${e.event_date}] ${e.event_title} (*${e.decision_signal}*)\n`;
      });
    }
    report += `\n`;
  });

  report += `*[시스템 실행 통계]*\n`;
  report += `• 분석 대상: ${stats.assetCount}개 종목\n`;
  report += `• 총 소요 시간: *${stats.totalTime}초*\n`;

  return report;
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
