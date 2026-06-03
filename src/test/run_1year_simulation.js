import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { getDb } from '../db/db.js';

// Load active portfolio assets
async function getActiveAssets() {
  const db = await getDb();
  return await db.all('SELECT ticker, name, asset_type FROM portfolio_asset WHERE is_active = 1');
}

// Fetch historical daily sise from Naver (last 300 candles to cover 1 year)
async function fetchAssetHistory(ticker) {
  try {
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${ticker}&timeframe=day&count=300&requestType=0`;
    const response = await axios.get(url, { responseType: 'text', timeout: 5000 });
    const xmlContent = response.data;
    
    const itemRegex = /<item data="([^"]+)"/g;
    const candles = [];
    let match;
    while ((match = itemRegex.exec(xmlContent)) !== null) {
      candles.push(match[1]);
    }
    
    return candles.map((c) => {
      const parts = c.split('|');
      const d = parts[0];
      return {
        date: `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`,
        close: parseFloat(parts[4]),
        volume: parseInt(parts[5], 10)
      };
    });
  } catch (err) {
    console.error(`Failed to fetch history for ticker ${ticker}:`, err.message);
    return [];
  }
}

async function run1YearSimulation() {
  console.log('Starting 1-Year Portfolio Simulation with 500M Won seed...');
  
  const assets = await getActiveAssets();
  const assetHistories = {};
  const dateSet = new Set();
  
  // 1. Fetch Naver price feeds for the last 1 year
  for (const asset of assets) {
    const history = await fetchAssetHistory(asset.ticker);
    if (history.length > 0) {
      assetHistories[asset.ticker] = history;
      history.forEach(c => {
        // Range: 2025-05-30 to 2026-05-29 (1 Year)
        if (c.date >= '2025-05-30' && c.date <= '2026-05-29') {
          dateSet.add(c.date);
        }
      });
    }
  }
  
  const sortedDates = Array.from(dateSet).sort();
  console.log(`Simulating over ${sortedDates.length} trading days.`);
  
  // Initial Capital Configurations
  const STARTING_CAPITAL = 500000000; // 500,000,000 Won (5억)
  const ALLOCATION_PER_STOCK = 15000000; // 15,000,000 Won (1천 5백만원) per stock (51% stock, 49% cash)
  
  // State for Strategy A (Buy & Hold)
  let holdCash = STARTING_CAPITAL;
  const holdPortfolio = {};
  
  // State for Strategy B (Active JaaS Management)
  let activeCash = STARTING_CAPITAL;
  const activePortfolio = {};
  
  const initialDate = sortedDates[0];
  
  // Setup initial portfolios on day 1 (2025-05-30)
  for (const asset of assets) {
    const history = assetHistories[asset.ticker] || [];
    const day1Candle = history.find(c => c.date === initialDate);
    if (!day1Candle) continue;
    
    const day1Price = day1Candle.close;
    const qty = Math.floor(ALLOCATION_PER_STOCK / day1Price);
    
    // Hold portfolio setup
    holdPortfolio[asset.ticker] = { qty, initialPrice: day1Price };
    holdCash -= qty * day1Price;
    
    // Active portfolio setup
    activePortfolio[asset.ticker] = { qty, lastPrice: day1Price };
    activeCash -= qty * day1Price;
  }
  
  // 2. Daily trading loop
  for (let t = 0; t < sortedDates.length; t++) {
    const currentDate = sortedDates[t];
    
    for (const asset of assets) {
      const history = assetHistories[asset.ticker] || [];
      const currentIdx = history.findIndex(c => c.date === currentDate);
      if (currentIdx === -1) continue;
      
      const currentCandle = history[currentIdx];
      const currentPrice = currentCandle.close;
      
      // Calculate MAs
      const candlesForMA = history.slice(0, currentIdx + 1);
      const avg5 = candlesForMA.slice(-5).reduce((sum, c) => sum + c.close, 0) / Math.min(5, candlesForMA.length);
      const avg20 = candlesForMA.slice(-20).reduce((sum, c) => sum + c.close, 0) / Math.min(20, candlesForMA.length);
      
      const portfolioState = activePortfolio[asset.ticker];
      if (!portfolioState) continue;
      
      portfolioState.lastPrice = currentPrice;
      
      // Determine Signal
      let signal = '보유';
      if (currentPrice < avg5 && currentPrice < avg20) {
        signal = '매도검토';
      } else if (currentPrice < avg20) {
        signal = '비중축소';
      } else if (currentPrice > avg5 && currentPrice > avg20) {
        const disparity20 = avg20 > 0 ? (currentPrice / avg20) : 1.0;
        if (disparity20 >= 1.15) {
          signal = '보유'; // Overheated Limit
        } else {
          signal = '추매검토';
        }
      }
      
      // Execute trading
      if (signal === '매도검토' && portfolioState.qty > 0) {
        const sellQty = portfolioState.qty;
        const proceeds = sellQty * currentPrice * 0.998; // Deduct 0.2% fee/tax
        activeCash += proceeds;
        portfolioState.qty = 0;
      } 
      else if (signal === '비중축소' && portfolioState.qty > 0) {
        const sellQty = Math.floor(portfolioState.qty * 0.5);
        if (sellQty > 0) {
          const proceeds = sellQty * currentPrice * 0.998;
          activeCash += proceeds;
          portfolioState.qty -= sellQty;
        }
      } 
      else if (signal === '추매검토' && activeCash > 2500000) {
        const currentAssetValue = portfolioState.qty * currentPrice;
        let activeStocksVal = 0;
        for (const ast of assets) {
          const astState = activePortfolio[ast.ticker];
          if (astState) {
            activeStocksVal += astState.qty * (astState.lastPrice || 0);
          }
        }
        const totalVal = activeCash + activeStocksVal;
        const weight = totalVal > 0 ? (currentAssetValue / totalVal) : 0;
        
        // Weight Cap: Limit any single stock to max 20% of total portfolio value
        if (weight < 0.20) {
          const buyBudget = Math.min(activeCash * 0.1, 2500000); // 10% of cash, max 2,500,000 Won
          const buyQty = Math.floor(buyBudget / (currentPrice * 1.00015)); // include 0.015% buying fee
          if (buyQty > 0) {
            activeCash -= buyQty * currentPrice * 1.00015;
            portfolioState.qty += buyQty;
          }
        }
      }
    }
  }
  
  // 3. Final Portfolio Valuation
  const finalDate = sortedDates[sortedDates.length - 1];
  let holdStocksValue = 0;
  let activeStocksValue = 0;
  
  for (const asset of assets) {
    const history = assetHistories[asset.ticker] || [];
    const finalCandle = history.find(c => c.date === finalDate);
    const finalPrice = finalCandle ? finalCandle.close : (activePortfolio[asset.ticker]?.lastPrice || 0);
    
    if (holdPortfolio[asset.ticker]) {
      holdStocksValue += holdPortfolio[asset.ticker].qty * finalPrice;
    }
    if (activePortfolio[asset.ticker]) {
      activeStocksValue += activePortfolio[asset.ticker].qty * finalPrice;
    }
  }
  
  const holdTotalValue = holdCash + holdStocksValue;
  const activeTotalValue = activeCash + activeStocksValue;
  
  const holdReturn = ((holdTotalValue - STARTING_CAPITAL) / STARTING_CAPITAL) * 100;
  const activeReturn = ((activeTotalValue - STARTING_CAPITAL) / STARTING_CAPITAL) * 100;
  
  console.log('=== 1-YEAR SIMULATION COMPLETED ===');
  console.log(`Initial Capital: ${STARTING_CAPITAL.toLocaleString()} Won`);
  console.log(`Strategy A (Buy & Hold) Final: ${holdTotalValue.toLocaleString()} Won (${holdReturn.toFixed(2)}%)`);
  console.log(`Strategy B (Active JaaS) Final: ${activeTotalValue.toLocaleString()} Won (${activeReturn.toFixed(2)}%)`);
  
  // Generate Report
  const resultJson = {
    startingCapital: STARTING_CAPITAL,
    holdFinalValue: holdTotalValue,
    holdReturn,
    activeFinalValue: activeTotalValue,
    activeReturn,
    alpha: activeReturn - holdReturn
  };
  
  await fs.writeFile('/home/eins777/workspace/stock-noti/reports/simulation_1year.json', JSON.stringify(resultJson, null, 2), 'utf-8');
}

run1YearSimulation().catch(console.error);
