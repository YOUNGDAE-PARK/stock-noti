import axios from 'axios';

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

const assets = [
  { name: '삼성전기', ticker: '009150' },
  { name: 'LG CNS', ticker: '064400' },
  { name: 'TIGER 미국우주테크', ticker: '485620' },
  { name: '토모큐브', ticker: '475960' },
  { name: '티씨케이', ticker: '064760' },
  { name: '현대모비스', ticker: '012330' }
];

async function fetchHistoricalClose(ticker, targetDates) {
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${ticker}&timeframe=day&count=200&requestType=0`;
  try {
    const response = await axios.get(url);
    const xmlContent = response.data;
    const itemRegex = /<item data="([^"]+)"/g;
    const candles = [];
    let match;

    while ((match = itemRegex.exec(xmlContent)) !== null) {
      candles.push(match[1]);
    }

    const priceMap = {};
    candles.forEach(candleStr => {
      const parts = candleStr.split('|');
      const dateStr = parts[0];
      const dateFormatted = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
      const closePrice = parseFloat(parts[4]);
      priceMap[dateFormatted] = closePrice;
    });

    // Find closest available date if the exact date is missing (e.g. holidays)
    const findClose = (dateStr) => {
      if (priceMap[dateStr]) return { date: dateStr, close: priceMap[dateStr] };
      // Search up to 5 days forward
      let current = new Date(dateStr);
      for (let i = 1; i <= 5; i++) {
        current.setDate(current.getDate() + 1);
        const curStr = current.toISOString().substring(0, 10);
        if (priceMap[curStr]) return { date: curStr, close: priceMap[curStr] };
      }
      // If not found, search backwards
      current = new Date(dateStr);
      for (let i = 1; i <= 5; i++) {
        current.setDate(current.getDate() - 1);
        const curStr = current.toISOString().substring(0, 10);
        if (priceMap[curStr]) return { date: curStr, close: priceMap[curStr] };
      }
      return null;
    };

    const results = {};
    for (const d of targetDates) {
      const found = findClose(d);
      results[d] = found ? found.close : null;
    }
    return results;
  } catch (err) {
    console.error(`Failed to fetch for ${ticker}:`, err.message);
    return null;
  }
}

async function start() {
  // Collect all dates to look up
  const allDates = new Set();
  Object.keys(horizonDatesMapping).forEach(t0 => {
    allDates.add(t0);
    allDates.add(horizonDatesMapping[t0].t5);
    allDates.add(horizonDatesMapping[t0].t20);
  });

  const targetDatesArray = Array.from(allDates).sort();

  const allRealPrices = {};
  for (const asset of assets) {
    const prices = await fetchHistoricalClose(asset.ticker, targetDatesArray);
    allRealPrices[asset.ticker] = prices;
    console.log(`Fetched ${asset.name}`);
  }

  // Format as code for copy pasting into mockMarketData in run_simulation.js
  console.log('\n--- REAL MARKET DATA FOR RUN_SIMULATION.JS ---');
  
  const formattedData = [];
  
  // Format for mapping
  // We need to emit the T0, T5, T20 entries for each event
  const eventsDetails = [
    { ticker: '485620', name: 'TIGER 미국우주테크', dates: ['2026-04-14', '2026-04-21', '2026-05-13'], type: 'etf' },
    { ticker: '064400', name: 'LG CNS', dates: ['2026-04-28', '2026-05-07', '2026-05-28'], type: 'stock' },
    { ticker: '009150', name: '삼성전기', dates: ['2026-04-30', '2026-05-08', '2026-05-29'], type: 'stock' },
    { ticker: '064400', name: 'LG CNS', dates: ['2026-05-15', '2026-05-22', '2026-06-12'], type: 'stock' },
    { ticker: '009150', name: '삼성전기', dates: ['2026-05-20', '2026-05-27', '2026-06-17'], type: 'stock' },
    { ticker: '485620', name: 'TIGER 미국우주테크', dates: ['2026-05-21', '2026-05-28', '2026-06-18'], type: 'etf' },
    { ticker: '485620', name: 'TIGER 미국우주테크', dates: ['2026-05-28', '2026-06-04', '2026-06-25'], type: 'etf' },
    { ticker: '475960', name: '토모큐브', dates: ['2026-03-12', '2026-03-19', '2026-04-09'], type: 'stock' },
    { ticker: '064760', name: '티씨케이', dates: ['2026-04-28', '2026-05-07', '2026-05-28'], type: 'stock' },
    { ticker: '064760', name: '티씨케이', dates: ['2026-05-04', '2026-05-12', '2026-06-01'], type: 'stock' },
    { ticker: '012330', name: '현대모비스', dates: ['2026-04-24', '2026-05-04', '2026-05-22'], type: 'stock' },
    { ticker: '012330', name: '현대모비스', dates: ['2026-05-28', '2026-06-04', '2026-06-25'], type: 'stock' }
  ];

  // We should create a unique set of daily prices for run_simulation.js
  const uniqueDailyPrices = [];
  const added = new Set();

  for (const ed of eventsDetails) {
    for (const d of ed.dates) {
      const key = `${ed.ticker}|${d}`;
      if (added.has(key)) continue;
      added.add(key);

      const closePrice = allRealPrices[ed.ticker][d];
      if (closePrice === undefined || closePrice === null) {
        console.warn(`Warning: Missing price for ${ed.name} (${ed.ticker}) on ${d}`);
        continue;
      }
      
      uniqueDailyPrices.push({
        date: d,
        ticker: ed.ticker,
        close_price: closePrice,
        asset_type: ed.type
      });
    }
  }

  console.log(JSON.stringify(uniqueDailyPrices, null, 2));
}

start();
