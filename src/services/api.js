import express from 'express';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { exec } from 'child_process';
import { getDb } from '../db/db.js';
import { buildCorpDirectory } from '../db/corp_directory.js';
import { sendSlackMessage } from './slack.js';
import { runWeeklyBatch } from './weeklyBatch.js';
import { uploadDbToStorage } from '../db/storage_sync.js';
import { getReportsDir } from '../utils/paths.js';
import { runInstantAnalysis } from './reports/instantAnalysis.js';

export const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

export async function syncPortfolioPrices(db) {
  const assets = await db.all('SELECT ticker, name FROM portfolio_asset WHERE is_active = 1');
  console.log(`[Price Sync] Initiating real-time price synchronization for ${assets.length} assets...`);
  
  for (const asset of assets) {
    try {
      const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${asset.ticker}&timeframe=day&count=1&requestType=0`;
      const response = await axios.get(url, { responseType: 'text', timeout: 5000 });
      const xml = response.data;
      
      const itemRegex = /<item data="([^"]+)"/g;
      const match = itemRegex.exec(xml);
      if (match) {
        const parts = match[1].split('|');
        const closePrice = parseFloat(parts[4]);
        
        if (closePrice > 0) {
          await db.run(
            'UPDATE portfolio_asset SET avg_price = ? WHERE ticker = ?',
            [closePrice, asset.ticker]
          );
          console.log(`- Synced ${asset.name} (${asset.ticker}) -> Price: ${closePrice.toLocaleString()} won.`);
        }
      }
    } catch (err) {
      console.error(`- Failed to sync price for ${asset.name} (${asset.ticker}):`, err.message);
    }
  }
}

export async function recalculatePortfolioWeights(db) {
  const assets = await db.all('SELECT ticker, avg_price, holding_qty FROM portfolio_asset WHERE is_active = 1');
  
  let totalValue = 0;
  const assetValues = {};

  for (const asset of assets) {
    const value = (asset.avg_price || 0.0) * (asset.holding_qty || 0.0);
    assetValues[asset.ticker] = value;
    totalValue += value;
  }

  for (const asset of assets) {
    let weight = 0.0;
    if (totalValue > 0) {
      weight = parseFloat(((assetValues[asset.ticker] / totalValue) * 100).toFixed(2));
    }
    await db.run(
      'UPDATE portfolio_asset SET holding_weight = ? WHERE ticker = ?',
      [weight, asset.ticker]
    );
  }
  console.log(`[Weight Calculator] Portfolio weights recalculated. Total value: ${totalValue.toLocaleString()} won.`);
}

// Root Static files (will be served from src/public)
const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, 'src/public')));

// 1. Get portfolio assets list
app.get('/api/assets', async (req, res) => {
  try {
    const db = await getDb();
    const assets = await db.all('SELECT * FROM portfolio_asset ORDER BY name ASC');
    res.json(assets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Add an asset to portfolio
app.post('/api/assets', async (req, res) => {
  const {
    ticker,
    name,
    asset_type,
    holding_weight,
    avg_price,
    holding_qty,
    investment_thesis,
    risk_keywords,
    watch_level
  } = req.body;

  if (!ticker || !name || !asset_type) {
    return res.status(400).json({ error: 'Ticker, name, and asset_type are required.' });
  }

  try {
    const db = await getDb();
    
    // Check if DART code exists in the directory
    const dirItem = await db.get('SELECT corp_code FROM corp_code_directory WHERE ticker = ?', [ticker]);
    const corpCode = dirItem ? dirItem.corp_code : null;

    await db.run(
      `INSERT INTO portfolio_asset (
        asset_type, ticker, name, market, holding_weight, avg_price, 
        holding_qty, investment_thesis, risk_keywords, watch_level, is_active, corp_code
      ) VALUES (?, ?, ?, ?, 0.0, ?, ?, ?, ?, ?, ?, ?)`,
      [
        asset_type,
        ticker,
        name,
        asset_type === 'etf' ? 'ETF' : 'KOSPI', // default market
        avg_price || 0.0,
        holding_qty || 0.0,
        investment_thesis || '',
        risk_keywords || '',
        watch_level || 'normal',
        1, // is_active
        corpCode
      ]
    );

    // Seed empty placeholder daily market snap to prevent join query failures immediately
    const today = new Date().toISOString().substring(0, 10);
    await db.run(
      `INSERT OR IGNORE INTO market_snapshot_daily (
        date, ticker, close_price, change_pct, volume, asset_type
      ) VALUES (?, ?, ?, 0.0, 0, ?)`,
      [today, ticker, avg_price || 0.0, asset_type]
    );

    // Recalculate weights for the entire portfolio
    await recalculatePortfolioWeights(db);

    // Sync database file to Firebase Storage
    await uploadDbToStorage();

    res.status(201).json({ success: true, message: `Seeded and added asset: ${name}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Edit portfolio asset details
app.put('/api/assets/:ticker', async (req, res) => {
  const { ticker } = req.params;
  const {
    avg_price,
    holding_qty,
    investment_thesis,
    risk_keywords,
    watch_level,
    is_active
  } = req.body;

  try {
    const db = await getDb();
    
    await db.run(
      `UPDATE portfolio_asset 
       SET avg_price = ?, holding_qty = ?, investment_thesis = ?, 
           risk_keywords = ?, watch_level = ?, is_active = ? 
       WHERE ticker = ?`,
      [
        avg_price,
        holding_qty,
        investment_thesis,
        risk_keywords,
        watch_level,
        is_active,
        ticker
      ]
    );

    // Recalculate weights for the entire portfolio
    await recalculatePortfolioWeights(db);

    // Sync database file to Firebase Storage
    await uploadDbToStorage();

    res.json({ success: true, message: `Updated asset ${ticker}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Delete portfolio asset
app.delete('/api/assets/:ticker', async (req, res) => {
  const { ticker } = req.params;
  try {
    const db = await getDb();
    
    // Delete links and dependencies cascade or set null
    await db.run('DELETE FROM portfolio_asset WHERE ticker = ?', [ticker]);
    
    // Recalculate weights for the entire portfolio
    await recalculatePortfolioWeights(db);

    // Sync database file to Firebase Storage
    await uploadDbToStorage();

    res.json({ success: true, message: `Deleted asset ${ticker}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Autocomplete Stock search
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim() === '') {
    return res.json([]);
  }

  const queryStr = q.trim();
  try {
    const db = await getDb();
    
    // Query corporate directory
    const results = await db.all(
      `SELECT ticker, corp_name, corp_code 
       FROM corp_code_directory 
       WHERE corp_name LIKE ? OR ticker LIKE ? 
       LIMIT 15`,
      [`%${queryStr}%`, `%${queryStr}%`]
    );

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Get report lists
app.get('/api/reports', async (req, res) => {
  const reportDir = getReportsDir();
  try {
    if (!fs.existsSync(reportDir)) {
      return res.json([]);
    }

    const files = fs.readdirSync(reportDir);
    const reportFiles = files
      .filter(f => f.endsWith('.md') && (f.startsWith('daily_report_') || f.startsWith('hourly_noti_') || f.startsWith('simulation_report') || f.startsWith('instant_report_')))
      .map(filename => {
        const filePath = path.join(reportDir, filename);
        const stats = fs.statSync(filePath);
        
        let type = 'daily';
        if (filename.startsWith('hourly_noti_')) type = 'hourly';
        if (filename.startsWith('simulation_report')) type = 'backtest';
        if (filename.startsWith('instant_report_')) type = 'instant';

        // Extract clean date
        let date = stats.mtime.toISOString().substring(0, 10);
        if (type === 'daily') {
          const match = filename.match(/daily_report_(.*)\.md/);
          if (match) date = match[1];
        } else if (type === 'hourly') {
          const match = filename.match(/hourly_noti_(.*)_(.*)\.md/);
          if (match) {
            const rawDate = match[1]; // yyyymmdd
            const time = match[2]; // hhmm
            date = `${rawDate.substring(0, 4)}-${rawDate.substring(4, 6)}-${rawDate.substring(6, 8)} ${time.substring(0, 2)}:${time.substring(2, 4)}`;
          }
        } else if (type === 'instant') {
          const match = filename.match(/instant_report_(.*)_(.*)\.md/);
          if (match) {
            const rawDate = match[1]; // yyyymmdd
            const time = match[2]; // hhmmss
            date = `${rawDate.substring(0, 4)}-${rawDate.substring(4, 6)}-${rawDate.substring(6, 8)} ${time.substring(0, 2)}:${time.substring(2, 4)}:${time.substring(4, 6)}`;
          }
        }

        return {
          filename,
          type,
          date,
          sizeBytes: stats.size,
          mtime: stats.mtime
        };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime)); // Newest first

    res.json(reportFiles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Get single report details (Markdown raw)
app.get('/api/reports/:filename', (req, res) => {
  const { filename } = req.params;
  const reportDir = getReportsDir();
  const resolvedReportDir = path.resolve(reportDir);
  const filePath = path.resolve(path.join(reportDir, filename));

  // Security check to prevent Directory Traversal
  if (!filePath.startsWith(resolvedReportDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Report not found' });
  }

  try {
    const mdContent = fs.readFileSync(filePath, 'utf-8');
    res.json({ filename, content: mdContent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Get Live Backtest results & statistics
app.get('/api/backtest', async (req, res) => {
  const horizonDatesMapping = {
    '2026-03-12': { t5: '2026-03-19', t20: '2026-04-09' },
    '2026-04-14': { t5: '2026-04-21', t20: '2026-05-13' },
    '2026-04-24': { t5: '2026-05-04', t20: '2026-05-22' },
    '2026-04-28': { t5: '2026-05-07', t20: '2026-05-28' },
    '2026-04-30': { t5: '2026-05-08', t20: '2026-05-29' },
    '2026-05-04': { t5: '2026-05-12', t20: '2026-06-01' },
    '2026-05-15': { t5: '2026-05-22', t20: '2026-06-12' },
    '2026-05-20': { t5: '2026-05-27', t20: '2026-06-17' },
    '2026-05-21': { t5: '2026-05-28', t20: '2026-06-18' },
    '2026-05-28': { t5: '2026-06-04', t20: '2026-06-25' }
  };

  try {
    const db = await getDb();

    // Query confirmed events
    const events = await db.all(`
      SELECT e.event_id, e.ticker, a.name as asset_name, e.event_type, 
             e.event_title, e.event_date, e.decision_signal, e.ai_reason
      FROM investment_event e
      JOIN portfolio_asset a ON e.ticker = a.ticker
      ORDER BY e.event_date DESC
    `);

    let hitsCount = 0;
    const backtestResults = [];

    for (const event of events) {
      const mapping = horizonDatesMapping[event.event_date];
      
      // Default mapping for custom events (uses simulation mock dates or T0 default placeholder)
      const t0CloseRes = await db.get(
        'SELECT close_price FROM market_snapshot_daily WHERE ticker = ? AND date = ?',
        [event.ticker, event.event_date]
      );
      
      const t5Date = mapping ? mapping.t5 : event.event_date;
      const t20Date = mapping ? mapping.t20 : event.event_date;

      const t5CloseRes = await db.get(
        'SELECT close_price FROM market_snapshot_daily WHERE ticker = ? AND date = ?',
        [event.ticker, t5Date]
      );
      const t20CloseRes = await db.get(
        'SELECT close_price FROM market_snapshot_daily WHERE ticker = ? AND date = ?',
        [event.ticker, t20Date]
      );

      const t0Close = t0CloseRes ? t0CloseRes.close_price : 0;
      const t5Close = t5CloseRes ? t5CloseRes.close_price : t0Close;
      const t20Close = t20CloseRes ? t20CloseRes.close_price : t0Close;

      const t5Return = t0Close > 0 ? ((t5Close - t0Close) / t0Close) * 100 : 0;
      const t20Return = t0Close > 0 ? ((t20Close - t0Close) / t0Close) * 100 : 0;

      let hit = false;
      const signal = event.decision_signal;

      if (signal === '추매검토') {
        if (t5Return > 0 || t20Return > 0) hit = true;
      } 
      else if (signal === '매도검토' || signal === '비중축소') {
        if (t5Return < 0 || t20Return < 0) hit = true;
      } 
      else {
        if (t20Return >= -5.0) hit = true;
      }

      if (hit) hitsCount++;

      backtestResults.push({
        eventId: event.event_id,
        asset: event.asset_name,
        date: event.event_date,
        title: event.event_title,
        signal: signal,
        reason: event.ai_reason || '분석 결과 내용 없음',
        T0_Price: t0Close,
        t5Return: t5Return,
        t20Return: t20Return,
        result: hit ? 'HIT' : 'MISS'
      });
    }

    const accuracy = events.length > 0 ? (hitsCount / events.length) * 100 : 0;

    res.json({
      totalEvents: events.length,
      hitsCount,
      accuracy: parseFloat(accuracy.toFixed(2)),
      results: backtestResults
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Trigger simulation manually
app.post('/api/backtest/run', (req, res) => {
  console.log('[API] Triggering Backtest Simulation manually...');
  exec('node src/test/run_simulation.js', async (error, stdout, stderr) => {
    if (error) {
      console.error('[API] Failed to run simulation:', error.message);
      return res.status(500).json({ success: false, error: error.message });
    }
    console.log('[API] Simulation successfully finished.');
    
    // Sync database file to Firebase Storage
    await uploadDbToStorage();

    res.json({ success: true, message: 'Simulation finished and database refreshed.' });
  });
});

// 10. Send a Slack test alert
app.post('/api/slack/test', async (req, res) => {
  console.log('[API] Triggering Slack connection test...');
  try {
    const success = await sendSlackMessage('🔔 [Stock-Noti] Slack 연동 및 알림 테스트 수신 성공! 시스템이 슬랙 채널에 정상 연동되었습니다.');
    if (success) {
      res.json({ success: true, message: 'Slack test message sent successfully.' });
    } else {
      res.status(500).json({ success: false, error: 'Webhook post failed. Check SLACK_WEBHOOK_URL configuration.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 11. Trigger Weekly Batch manually
app.post('/api/weekly/run', async (req, res) => {
  console.log('[API] Triggering Weekly Batch analysis manually...');
  try {
    const result = await runWeeklyBatch();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. Sync portfolio asset prices manually
app.post('/api/assets/sync-prices', async (req, res) => {
  console.log('[API] Request received to sync portfolio prices manually...');
  try {
    const db = await getDb();
    await syncPortfolioPrices(db);
    await recalculatePortfolioWeights(db);
    
    // Sync database file to Firebase Storage
    await uploadDbToStorage();

    res.json({ success: true, message: 'Real-time prices and weights successfully synchronized.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 13. Trigger Instant Analysis manually
app.post('/api/analysis/run', async (req, res) => {
  console.log('[API] Triggering Instant Portfolio Analysis manually...');
  try {
    const result = await runInstantAnalysis();
    // Sync database file to Firebase Storage
    await uploadDbToStorage();
    res.json({ success: true, filename: result.filename, results: result.results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serving the SPA router fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'src/public/index.html'));
});

export async function startServer() {
  // Build Search directory on bootup
  await buildCorpDirectory();

  // Recalculate weights and sync prices on start
  try {
    const db = await getDb();
    await syncPortfolioPrices(db);
    await recalculatePortfolioWeights(db);
  } catch (err) {
    console.warn('[API Server] Failed to sync prices & weights on startup:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`🚀 Stock-Noti REST Web Server listening on port ${PORT}`);
    console.log(`🔗 Web UI URL: http://localhost:${PORT}`);
    console.log(`=================================================`);
  });
}
