import axios from 'axios';
import { getDb } from '../../db/db.js';

export async function collectKrxMarketData(dateStr, userId = null) {
  const db = await getDb(userId);
  
  // Get active assets
  const assets = await db.all(
    'SELECT ticker, name, asset_type FROM portfolio_asset WHERE is_active = 1'
  );

  if (assets.length === 0) {
    console.log('No active assets found for KRX market data collection.');
    return [];
  }

  // Format dateStr: YYYY-MM-DD
  const targetDate = dateStr || new Date().toISOString().substring(0, 10);
  console.log(`KRX Collector: Fetching market data for ${targetDate}...`);
  const collectedSnapshots = [];

  // Always collect Market Indices
  const indices = [
    { ticker: 'KOSPI', name: 'KOSPI 지수', asset_type: 'index' },
    { ticker: 'KOSDAQ', name: 'KOSDAQ 지수', asset_type: 'index' }
  ];

  const allTargets = [...indices, ...assets];

  for (const target of allTargets) {
    try {
      // Query Naver Finance chart API for the latest 2 days (to compute change percentage)
      const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${target.ticker}&timeframe=day&count=2&requestType=0`;
      
      const response = await axios.get(url, { responseType: 'text' });
      const xmlContent = response.data;

      // Extract item data using Regex
      const itemRegex = /<item data="([^"]+)"/g;
      const candles = [];
      let match;

      while ((match = itemRegex.exec(xmlContent)) !== null) {
        candles.push(match[1]);
      }

      if (candles.length === 0) {
        console.warn(`- No market data returned from Naver Finance for ${target.name} (${target.ticker})`);
        continue;
      }

      // If we have 2 candles, we can compute change percent
      const latestCandleStr = candles[candles.length - 1];
      const prevCandleStr = candles.length > 1 ? candles[candles.length - 2] : null;

      // Split candles (Date|Open|High|Low|Close|Volume)
      const latestParts = latestCandleStr.split('|');
      const latestDateStr = latestParts[0]; // YYYYMMDD
      const latestDateFormatted = `${latestDateStr.substring(0, 4)}-${latestDateStr.substring(4, 6)}-${latestDateStr.substring(6, 8)}`;
      
      const closePrice = parseFloat(latestParts[4]);
      const volume = parseInt(latestParts[5], 10);
      const tradingValue = closePrice * volume; 

      let changePct = 0;
      if (prevCandleStr) {
        const prevParts = prevCandleStr.split('|');
        const prevClose = parseFloat(prevParts[4]);
        changePct = ((closePrice - prevClose) / prevClose) * 100;
        changePct = Math.round(changePct * 100) / 100; // round to 2 decimals
      }

      const snapshot = {
        date: latestDateFormatted,
        ticker: target.ticker,
        close_price: closePrice,
        change_pct: changePct,
        volume: volume,
        trading_value: tradingValue,
        market_cap: 0, 
        asset_type: target.asset_type
      };

      await db.run(
        `INSERT OR REPLACE INTO market_snapshot_daily (
          date, ticker, close_price, change_pct, volume, trading_value, market_cap, asset_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshot.date,
          snapshot.ticker,
          snapshot.close_price,
          snapshot.change_pct,
          snapshot.volume,
          snapshot.trading_value,
          snapshot.market_cap,
          snapshot.asset_type
        ]
      );

      console.log(`- Loaded market data for ${target.name} (${target.ticker}): Close=${closePrice}, Change=${changePct}%, Vol=${volume}`);
      collectedSnapshots.push(snapshot);
    } catch (err) {
      console.error(`- Failed to collect market data for ${target.name} (${target.ticker}):`, err.message);
    }
  }

  return collectedSnapshots;
}
