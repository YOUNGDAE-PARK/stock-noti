import { runWeeklyBatch } from '../weeklyBatch.js';
import { runInstantAnalysis } from '../reports/instantAnalysis.js';
import { getDb } from '../../db/db.js';
import { exec } from 'child_process';
import { uploadDbToStorage } from '../../db/storage_sync.js';

export class AnalysisController {
  static async runWeekly(req, res) {
    try {
      const result = await runWeeklyBatch(req.user);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  static async runInstant(req, res) {
    try {
      const result = await runInstantAnalysis(req.user);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  static async runBacktest(req, res) {
    console.log(`[API] Triggering Backtest Simulation manually for ${req.user.email}...`);
    exec('node src/test/run_simulation.js', async (error, stdout, stderr) => {
      if (error) {
        console.error('[API] Failed to run simulation:', error.message);
        return res.status(500).json({ success: false, error: error.message });
      }
      console.log('[API] Simulation successfully finished.');
      await uploadDbToStorage(req.user.uid);
      res.json({ success: true, message: 'Simulation finished and database refreshed.' });
    });
  }

  static async getBacktestStats(req, res) {
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
      const db = await getDb(req.user.uid, req.user.email);
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
        const t0CloseRes = await db.get('SELECT close_price FROM market_snapshot_daily WHERE ticker = ? AND date = ?', [event.ticker, event.event_date]);
        
        const t5Date = mapping ? mapping.t5 : event.event_date;
        const t20Date = mapping ? mapping.t20 : event.event_date;

        const t5CloseRes = await db.get('SELECT close_price FROM market_snapshot_daily WHERE ticker = ? AND date = ?', [event.ticker, t5Date]);
        const t20CloseRes = await db.get('SELECT close_price FROM market_snapshot_daily WHERE ticker = ? AND date = ?', [event.ticker, t20Date]);

        const t0Close = t0CloseRes ? t0CloseRes.close_price : 0;
        const t5Close = t5CloseRes ? t5CloseRes.close_price : t0Close;
        const t20Close = t20CloseRes ? t20CloseRes.close_price : t0Close;

        const t5Return = t0Close > 0 ? ((t5Close - t0Close) / t0Close) * 100 : 0;
        const t20Return = t0Close > 0 ? ((t20Close - t0Close) / t0Close) * 100 : 0;

        let hit = false;
        const signal = event.decision_signal;
        if (signal === '추매검토') {
          if (t5Return > 0 || t20Return > 0) hit = true;
        } else if (signal === '매도검토' || signal === '비중축소') {
          if (t5Return < 0 || t20Return < 0) hit = true;
        } else {
          if (t20Return >= -5.0) hit = true;
        }

        if (hit) hitsCount++;
        backtestResults.push({
          eventId: event.event_id,
          asset: event.asset_name,
          date: event.event_date,
          title: event.event_title,
          signal,
          T0_Price: t0Close,
          t5Return,
          t20Return,
          result: hit ? 'HIT' : 'MISS'
        });
      }

      res.json({
        totalEvents: events.length,
        hitsCount,
        accuracy: events.length > 0 ? parseFloat(((hitsCount / events.length) * 100).toFixed(2)) : 0,
        results: backtestResults
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getPortfolioHistory(req, res) {
    try {
      const db = await getDb(req.user.uid, req.user.email);
      const history = await db.all(`
        SELECT * FROM portfolio_delta_log 
        ORDER BY timestamp DESC 
        LIMIT 200
      `);
      res.json(history);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  static async deleteHistoryItem(req, res) {
    const { log_id } = req.params;
    try {
      const db = await getDb(req.user.uid, req.user.email);
      await db.run('DELETE FROM portfolio_delta_log WHERE log_id = ?', [log_id]);
      await uploadDbToStorage(req.user.uid);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
}
