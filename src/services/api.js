import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';

import { authenticateUser } from './middleware/auth.js';
import { AssetController } from './api/AssetController.js';
import { ReportController } from './api/ReportController.js';
import { SettingsController } from './api/SettingsController.js';
import { AnalysisController } from './api/AnalysisController.js';
import { buildCorpDirectory } from '../db/corp_directory.js';

// Try to import injected config if available (for production)
let injectedConfig = {};
try {
  const mod = await import('./fb_config.js');
  injectedConfig = mod.default || {};
} catch (e) {
  // Config not injected, will fallback to process.env
}

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// 1. Config & System
app.get('/api/config', (req, res) => {
  res.json({
    apiKey: injectedConfig.apiKey || process.env.FB_CLIENT_API_KEY || process.env.FIREBASE_API_KEY,
    authDomain: injectedConfig.authDomain || process.env.FB_CLIENT_AUTH_DOMAIN || process.env.FIREBASE_AUTH_DOMAIN,
    projectId: injectedConfig.projectId || process.env.FB_CLIENT_PROJECT_ID || process.env.FIREBASE_PROJECT_ID,
    storageBucket: injectedConfig.storageBucket || process.env.FB_CLIENT_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: injectedConfig.messagingSenderId || process.env.FB_CLIENT_MESSAGING_SENDER_ID || process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: injectedConfig.appId || process.env.FB_CLIENT_APP_ID || process.env.FIREBASE_APP_ID
  });
});

app.get('/api/schedule', authenticateUser, (req, res) => {
  res.json([
    { name: '일일 리포트', time: '매일 08:00', icon: 'fa-sun' },
    { name: '실시간 감시', time: '평일 09:00 - 16:00 (매시)', icon: 'fa-clock' },
    { name: '장마감 데이터', time: '평일 18:00', icon: 'fa-moon' },
    { name: '주간 운영 배치', time: '매주 일요일 21:00', icon: 'fa-calendar-days' }
  ]);
});

// 2. Assets
app.get('/api/assets', authenticateUser, AssetController.getAssets);
app.get('/api/search', authenticateUser, AssetController.searchCorp);
app.post('/api/assets', authenticateUser, AssetController.addAsset);
app.put('/api/assets/:ticker', authenticateUser, AssetController.updateAsset);
app.delete('/api/assets/:ticker', authenticateUser, AssetController.deleteAsset);
app.post('/api/assets/sync-prices', authenticateUser, AssetController.syncPrices);

// 3. Reports
app.get('/api/reports', authenticateUser, ReportController.listReports);
app.get('/api/reports/:filename', authenticateUser, ReportController.getReport);

// 4. Settings
app.get('/api/settings', authenticateUser, SettingsController.getSettings);
app.post('/api/settings', authenticateUser, SettingsController.updateSettings);
app.post('/api/slack/test', authenticateUser, SettingsController.testSlack);

// 5. Analysis & Backtest
app.get('/api/backtest', authenticateUser, AnalysisController.getBacktestStats);
app.get('/api/history', authenticateUser, AnalysisController.getPortfolioHistory);
app.delete('/api/history/:log_id', authenticateUser, AnalysisController.deleteHistoryItem);
app.post('/api/backtest/run', authenticateUser, AnalysisController.runBacktest);
app.post('/api/weekly/run', authenticateUser, AnalysisController.runWeekly);
app.post('/api/analysis/run', authenticateUser, AnalysisController.runInstant);

// Serving the SPA router fallback
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'API endpoint not found' });
  } else {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});

/**
 * Global helper for price synchronization.
 */
export async function syncPortfolioPrices(db) {
  const assets = await db.all('SELECT ticker, name FROM portfolio_asset WHERE is_active = 1');
  console.log(`[Price Sync] Fetching prices for ${assets.length} assets...`);
  
  for (const asset of assets) {
    try {
      const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${asset.ticker}&timeframe=day&count=1&requestType=0`;
      const response = await axios.get(url);
      const xml = response.data;
      const match = /<item data="([^"]+)"\s*\/>/.exec(xml);
      if (match) {
        const closePrice = parseFloat(match[1].split('|')[4]);
        await db.run('UPDATE portfolio_asset SET avg_price = ? WHERE ticker = ?', [closePrice, asset.ticker]);
      }
    } catch (err) {
      console.error(`[Price Sync] Failed for ${asset.name}:`, err.message);
    }
  }
}

export async function recalculatePortfolioWeights(db) {
  const assets = await db.all('SELECT ticker, name, avg_price, holding_qty FROM portfolio_asset WHERE is_active = 1');
  let totalValue = 0;
  assets.forEach(a => {
    totalValue += (a.avg_price * a.holding_qty);
  });

  console.log(`[Weight Calc] Total Portfolio Value: ${totalValue}`);

  if (totalValue === 0) {
    // If total value is 0, reset all weights to 0 to avoid nulls
    await db.run('UPDATE portfolio_asset SET holding_weight = 0.0 WHERE is_active = 1');
    return;
  }

  for (const a of assets) {
    const assetValue = a.avg_price * a.holding_qty;
    const weight = (assetValue / totalValue) * 100;
    const roundedWeight = parseFloat(weight.toFixed(2));
    
    await db.run('UPDATE portfolio_asset SET holding_weight = ? WHERE ticker = ?', [roundedWeight, a.ticker]);
    console.log(`  -> ${a.name} (${a.ticker}): ${roundedWeight}%`);
  }
}

export async function startServer() {
  await buildCorpDirectory();
  app.listen(PORT, () => {
    console.log(`🚀 Stock-Noti Server active on port ${PORT}`);
  });
}
