import axios from 'axios';
import { getDb } from '../../db/db.js';
import { uploadDbToStorage } from '../../db/storage_sync.js';
import { syncPortfolioPrices, recalculatePortfolioWeights } from '../api.js';

export class AssetController {
  static async getAssets(req, res) {
    try {
      const db = await getDb(req.user.uid, req.user.email);
      const assets = await db.all('SELECT * FROM portfolio_asset WHERE is_active = 1');
      res.json(assets);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  static async searchCorp(req, res) {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);

    try {
      // 1. Local Search First
      const db = await getDb();
      const localResults = await db.all(
        'SELECT * FROM corp_code_directory WHERE corp_name LIKE ? OR ticker LIKE ? LIMIT 5',
        [`%${q}%`, `%${q}%`]
      );

      // 2. Real-time Search (Naver Finance) to catch new listings or ETFs
      const naverSearchUrl = `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`;
      let realTimeResults = [];

      try {
        const naverRes = await axios.get(naverSearchUrl, { timeout: 5000 });
        const data = naverRes.data;

        if (data && Array.isArray(data.items)) {
          // Naver item format: { "code": "005930", "name": "삼성전자", ... }
          realTimeResults = data.items.map(item => ({
            ticker: item.code,
            corp_name: item.name,
            corp_code: null
          }));
        }
      } catch (naverErr) {
        console.warn('[Search] Naver real-time API failed or returned unexpected format:', naverErr.message);
        // Continue with local results only
      }

      // 3. Merge & Deduplicate
      const mergedMap = new Map();
      localResults.forEach(r => mergedMap.set(r.ticker, r));
      realTimeResults.forEach(r => {
        if (!mergedMap.has(r.ticker)) {
          mergedMap.set(r.ticker, r);
        }
      });

      res.json(Array.from(mergedMap.values()).slice(0, 10));
    } catch (err) {
      console.error('[Search] Real-time search failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  }

  static async addAsset(req, res) {
    const { ticker, name, asset_type, holding_weight, target_weight, max_weight, avg_price, holding_qty, watch_level, investment_thesis, corp_code } = req.body;

    if (!ticker || !name || ticker.trim() === '' || name.trim() === '') {
      return res.status(400).json({ success: false, error: 'Ticker and Name are required.' });
    }

    try {
      const db = await getDb(req.user.uid, req.user.email);

      const existing = await db.get('SELECT ticker FROM portfolio_asset WHERE ticker = ?', [ticker]);
      if (existing) {
        return res.status(409).json({ success: false, error: `이미 포트폴리오에 등록된 종목입니다 (${ticker}). 편집 버튼으로 수정해 주세요.` });
      }

      await db.run(
        `INSERT INTO portfolio_asset (ticker, name, asset_type, market, holding_weight, target_weight, max_weight, avg_price, holding_qty, watch_level, investment_thesis, corp_code)
         VALUES (?, ?, ?, 'KOSPI', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ticker, name, asset_type || 'stock', holding_weight || 0, target_weight || 0, max_weight || 100, avg_price || 0, holding_qty || 0, watch_level || 'normal', investment_thesis || '', corp_code]
      );

      await db.run(
        'INSERT INTO portfolio_delta_log (ticker, asset_name, action_type, old_qty, new_qty, delta_qty) VALUES (?, ?, "ADD", 0, ?, ?)',
        [ticker, name, holding_qty, holding_qty]
      );

      await syncPortfolioPrices(db);
      await recalculatePortfolioWeights(db);

      await uploadDbToStorage(req.user.uid);
      res.json({ success: true });
    } catch (err) {
      console.error('[AssetController] addAsset error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async updateAsset(req, res) {
    const { ticker } = req.params;
    const { holding_weight, target_weight, max_weight, avg_price, holding_qty, watch_level, investment_thesis } = req.body;
    try {
      const db = await getDb(req.user.uid, req.user.email);
      
      // Fetch old state for delta calculation
      const oldAsset = await db.get('SELECT holding_qty, name FROM portfolio_asset WHERE ticker = ?', [ticker]);
      const oldQty = oldAsset ? oldAsset.holding_qty : 0;

      await db.run(
        `UPDATE portfolio_asset SET holding_weight = ?, target_weight = ?, max_weight = ?, avg_price = ?, holding_qty = ?, watch_level = ?, investment_thesis = ? WHERE ticker = ?`,
        [holding_weight, target_weight, max_weight, avg_price, holding_qty, watch_level, investment_thesis, ticker]
      );

      // Log Delta if quantity changed
      if (oldQty !== holding_qty) {
        await db.run(
          'INSERT INTO portfolio_delta_log (ticker, asset_name, action_type, old_qty, new_qty, delta_qty) VALUES (?, ?, "UPDATE", ?, ?, ?)',
          [ticker, oldAsset ? oldAsset.name : '', oldQty, holding_qty, holding_qty - oldQty]
        );
      }

      // Ensure weights are updated
      await recalculatePortfolioWeights(db);

      await uploadDbToStorage(req.user.uid);
      res.json({ success: true });
    } catch (err) {
      console.error('[AssetController] updateAsset error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async deleteAsset(req, res) {
    const { ticker } = req.params;
    try {
      const db = await getDb(req.user.uid, req.user.email);

      const oldAsset = await db.get('SELECT asset_id, holding_qty, name FROM portfolio_asset WHERE ticker = ?', [ticker]);
      if (!oldAsset) {
        return res.status(404).json({ success: false, error: '포트폴리오에서 해당 종목을 찾을 수 없습니다.' });
      }

      await db.run('BEGIN');
      try {
        await db.run('DELETE FROM portfolio_asset WHERE ticker = ?', [ticker]);
        await db.run(
          'INSERT INTO portfolio_delta_log (ticker, asset_name, action_type, old_qty, new_qty, delta_qty) VALUES (?, ?, "DELETE", ?, 0, ?)',
          [ticker, oldAsset.name, oldAsset.holding_qty, -oldAsset.holding_qty]
        );
        await db.run('COMMIT');
      } catch (txErr) {
        await db.run('ROLLBACK');
        throw txErr;
      }

      await recalculatePortfolioWeights(db);
      await uploadDbToStorage(req.user.uid);
      res.json({ success: true });
    } catch (err) {
      console.error('[AssetController] deleteAsset error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async syncPrices(req, res) {
    try {
      const db = await getDb(req.user.uid, req.user.email);
      await syncPortfolioPrices(db);
      await recalculatePortfolioWeights(db);
      await uploadDbToStorage(req.user.uid);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
}
