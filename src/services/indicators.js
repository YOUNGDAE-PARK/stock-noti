/**
 * 수학자 역할: 기술적 지표 순수 계산 모듈 (AI 없음)
 * RSI(14), MACD(12,26,9), 볼린저밴드(20,2σ), 거래량비율
 */

function calcEMA(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcEMAArray(values, period) {
  const k = 2 / (period + 1);
  const emas = [values[0]];
  for (let i = 1; i < values.length; i++) {
    emas.push(values[i] * k + emas[i - 1] * (1 - k));
  }
  return emas;
}

function calcRSI(closes) {
  if (closes.length < 15) return null;

  const diffs = [];
  for (let i = 1; i < closes.length; i++) diffs.push(closes[i] - closes[i - 1]);

  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < 14; i++) {
    if (diffs[i] > 0) avgGain += diffs[i];
    else avgLoss += Math.abs(diffs[i]);
  }
  avgGain /= 14;
  avgLoss /= 14;

  for (let i = 14; i < diffs.length; i++) {
    const gain = diffs[i] > 0 ? diffs[i] : 0;
    const loss = diffs[i] < 0 ? Math.abs(diffs[i]) : 0;
    avgGain = (avgGain * 13 + gain) / 14;
    avgLoss = (avgLoss * 13 + loss) / 14;
  }

  const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  const value = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
  const rounded = parseFloat(value.toFixed(2));

  let signal;
  if (rounded >= 70) signal = 'overbought';
  else if (rounded <= 30) signal = 'oversold';
  else if (rounded >= 50) signal = 'bullish_neutral';
  else signal = 'bearish_neutral';

  return { value: rounded, signal };
}

function calcMACD(closes) {
  if (closes.length < 35) return null;

  const ema12Array = calcEMAArray(closes, 12);
  const ema26Array = calcEMAArray(closes, 26);

  // MACD line starts from index 25 (need 26 values for EMA26)
  const macdLine = ema12Array.slice(25).map((v, i) => v - ema26Array[i + 25]);
  if (macdLine.length < 9) return null;

  const signalArray = calcEMAArray(macdLine, 9);
  const curr = macdLine.length - 1;
  const prev = curr - 1;

  const macdCurr = macdLine[curr];
  const signalCurr = signalArray[curr];
  const histCurr = macdCurr - signalCurr;
  const histPrev = macdLine[prev] - signalArray[prev];

  let signal;
  if (macdLine[prev] < signalArray[prev] && macdCurr > signalCurr) signal = 'golden_cross';
  else if (macdLine[prev] > signalArray[prev] && macdCurr < signalCurr) signal = 'death_cross';
  else if (histCurr > 0 && histCurr > histPrev) signal = 'bullish_momentum';
  else if (histCurr < 0 && histCurr < histPrev) signal = 'bearish_momentum';
  else signal = 'neutral';

  return {
    macdLine: parseFloat(macdCurr.toFixed(4)),
    signalLine: parseFloat(signalCurr.toFixed(4)),
    histogram: parseFloat(histCurr.toFixed(4)),
    signal
  };
}

function calcBollingerBands(closes) {
  if (closes.length < 20) return null;

  const slice = closes.slice(-20);
  const mean = slice.reduce((a, b) => a + b, 0) / 20;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / 20;
  const stdDev = Math.sqrt(variance);

  const upper = mean + 2 * stdDev;
  const lower = mean - 2 * stdDev;
  const current = closes[closes.length - 1];
  const bandwidth = stdDev === 0 ? 0 : (upper - lower) / mean;
  const percentB = (upper - lower) === 0 ? 0.5 : (current - lower) / (upper - lower);

  let signal;
  if (percentB > 1.0) signal = 'upper_breakout';
  else if (percentB < 0.0) signal = 'lower_breakout';
  else if (percentB > 0.8) signal = 'near_upper';
  else if (percentB < 0.2) signal = 'near_lower';
  else if (bandwidth < 0.05) signal = 'squeeze';
  else signal = 'normal';

  return {
    upper: parseFloat(upper.toFixed(2)),
    middle: parseFloat(mean.toFixed(2)),
    lower: parseFloat(lower.toFixed(2)),
    percentB: parseFloat(percentB.toFixed(3)),
    bandwidth: parseFloat(bandwidth.toFixed(4)),
    signal
  };
}

function calcVolumeRatio(volumes) {
  if (volumes.length < 2) return null;

  const current = volumes[volumes.length - 1];
  const avg20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length - 1);
  if (avg20 === 0) return null;

  const ratio = parseFloat((current / avg20).toFixed(2));

  let signal;
  if (ratio >= 3.0) signal = 'volume_surge';
  else if (ratio >= 2.0) signal = 'high_volume';
  else if (ratio >= 0.5) signal = 'normal';
  else signal = 'volume_dry';

  return { ratio, signal };
}

function deriveOverallBias(rsi, macd, bb, vol) {
  const bullish = [];
  const bearish = [];

  if (rsi) {
    if (['oversold'].includes(rsi.signal)) bullish.push('RSI');
    if (['overbought'].includes(rsi.signal)) bearish.push('RSI');
  }
  if (macd) {
    if (['golden_cross', 'bullish_momentum'].includes(macd.signal)) bullish.push('MACD');
    if (['death_cross', 'bearish_momentum'].includes(macd.signal)) bearish.push('MACD');
  }
  if (bb) {
    if (['lower_breakout', 'near_lower'].includes(bb.signal)) bullish.push('BB');
    if (['upper_breakout', 'near_upper'].includes(bb.signal)) bearish.push('BB');
  }

  if (bullish.length > bearish.length) return 'bullish';
  if (bearish.length > bullish.length) return 'bearish';
  return 'neutral';
}

export async function calculateIndicators(db, ticker) {
  const history = await db.all(`
    SELECT date, close_price, volume
    FROM market_snapshot_daily
    WHERE ticker = ? AND asset_type != 'index'
    ORDER BY date DESC LIMIT 35
  `, [ticker]);

  const rows = history.reverse();
  const dataPoints = rows.length;

  if (dataPoints < 14) {
    return { ticker, insufficientData: true, dataPoints };
  }

  const closes = rows.map(r => r.close_price);
  const volumes = rows.map(r => r.volume || 0);

  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);
  const bollingerBands = calcBollingerBands(closes);
  const volumeRatio = calcVolumeRatio(volumes);
  const overallBias = deriveOverallBias(rsi, macd, bollingerBands, volumeRatio);

  const parts = [];
  if (rsi) parts.push(`RSI ${rsi.value}(${rsi.signal})`);
  if (macd) parts.push(`MACD ${macd.signal}`);
  if (bollingerBands) parts.push(`BB ${bollingerBands.signal}(${bollingerBands.percentB})`);
  if (volumeRatio) parts.push(`거래량비율 ${volumeRatio.ratio}x(${volumeRatio.signal})`);
  const summary = parts.join(' / ') || '지표 계산 불가';

  return {
    ticker,
    dataPoints,
    insufficientData: false,
    rsi,
    macd,
    bollingerBands,
    volumeRatio,
    overallBias,
    summary
  };
}
