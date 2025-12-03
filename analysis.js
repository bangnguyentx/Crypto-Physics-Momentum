/**
 * analysis.js
 *
 * Exports: analyzePhysics(symbol, options)
 * - Multi-source (Binance main, Binance API, Bybit, Bitget, OKX) fallback for OHLCV
 * - Physics Momentum algorithm:
 *    - RSI(14)
 *    - Bollinger Bands (20,2)
 *    - v = SMA(3) of price change
 *    - a = v_t - v_{t-1}
 *    - ATR(14)
 * - Entry rules:
 *    LONG: RSI < 30 && Close < LowerBand && Acceleration > 0
 *    SHORT: RSI > 70 && Close > UpperBand && Acceleration < 0
 * - SL = entry +/- 1.5 * ATR ; TP = entry +/- 3.0 * ATR
 * - Returns { symbol, side, entry, tp, sl, rr, meta }
 */

const axios = require('axios');

// Data sources (multi-exchange rotation). Each has a function that returns URL for klines
const DATA_SOURCES = [
  {
    name: 'BinanceFutures',
    kline: (symbol, interval, limit = 500) => `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol.replace('/','')}&interval=${interval}&limit=${limit}`
  },
  {
    name: 'BinanceSpot',
    kline: (symbol, interval, limit = 500) => `https://api.binance.com/api/v3/klines?symbol=${symbol.replace('/','')}&interval=${interval}&limit=${limit}`
  },
  {
    name: 'BybitV5',
    kline: (symbol, interval, limit = 500) => {
      // bybit v5 mapping (approx) - uses category=linear for many symbols
      const map = { '1m':'1', '3m':'3', '5m':'5', '15m':'15', '1h':'60', '4h':'240', '1d':'D' };
      const intv = map[interval] || interval;
      return `https://api.bybit.com/public/linear/kline?symbol=${symbol.replace('/','')}&interval=${intv}&limit=${limit}`;
    }
  },
  {
    name: 'Bitget',
    kline: (symbol, interval, limit = 500) => `https://api.bitget.com/api/spot/v1/market/candles?symbol=${symbol.replace('/','')}&granularity=${interval}&limit=${limit}`
  },
  {
    name: 'OKX',
    kline: (symbol, interval, limit = 500) => `https://www.okx.com/api/v5/market/history-candles?instId=${symbol.replace('/','')}&bar=${interval}&limit=${limit}`
  }
];

// Helper: fetch candles with fallback through sources
async function fetchCandlesFallback(symbol, interval='5m', limit=200) {
  const sources = [...DATA_SOURCES];
  // Shuffle to spread load (simple shuffle)
  for (let i = sources.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sources[i], sources[j]] = [sources[j], sources[i]];
  }

  for (const src of sources) {
    try {
      const url = src.kline(symbol, interval, limit);
      // console.log('Trying source', src.name, url);
      const resp = await axios.get(url, { timeout: 10_000, headers: { 'User-Agent':'Mozilla/5.0' } });
      if (!resp || !resp.data) throw new Error('No data');

      // Normalize different response shapes to candles array of { t, open, high, low, close, vol }
      let raw = resp.data;
      let candles = [];

      if (src.name === 'BybitV5') {
        // Bybit linear public kline returns { retCode, retMsg, result: { list: [...] } } OR array
        if (raw.result && raw.result.list) {
          raw = raw.result.list;
        } else if (Array.isArray(raw)) {
          // Try direct
        }
      }

      // OKX returns array of arrays: [timestamp, open, high, low, close, volume]
      if (src.name === 'OKX') {
        // resp.data should be array of arrays or object { data: [...] }
        if (raw.data) raw = raw.data;
      }

      // Handle common Binance format (array of arrays)
      if (Array.isArray(raw) && Array.isArray(raw[0])) {
        // binance style: [ openTime, open, high, low, close, volume, ...]
        candles = raw.map(c => ({
          t: c[0],
          open: Number(c[1]),
          high: Number(c[2]),
          low: Number(c[3]),
          close: Number(c[4]),
          vol: Number(c[5])
        }));
      } else if (Array.isArray(raw)) {
        // bitget or others may return array of string arrays
        candles = raw.map(c => {
          // support mapping if entries are arrays or objects
          if (Array.isArray(c)) {
            return { t: c[0], open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), vol: Number(c[5]) };
          } else if (c && c.open) {
            return { t: c.t || c.timestamp || c[0], open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), vol: Number(c.vol || c.volume || 0) };
          } else return null;
        }).filter(Boolean);
      } else if (raw && raw.data && Array.isArray(raw.data)) {
        // some APIs return { data: [...] }
        candles = raw.data.map(c => {
          if (Array.isArray(c)) {
            return { t: c[0], open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), vol: Number(c[5]) };
          } else {
            return { t: c.t || c[0], open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), vol: Number(c.vol || c.volume || 0) };
          }
        }).filter(Boolean);
      } else {
        // fallback: try to extract candlesticks from object
        // skip this source if no usable format
        continue;
      }

      if (candles && candles.length >= 30) {
        // ensure chronological order ascending (old -> new). Some responses may be newest first
        if (candles[0].t > candles[candles.length - 1].t) candles = candles.reverse();
        return candles.slice(-limit);
      }
    } catch (err) {
      // Log minimal info; continue to next source
      // console.warn(`Source ${src.name} failed for ${symbol}: ${err.message}`);
      // If rate-limited, small pause (but we are in serverless often)
      continue;
    }
  }

  // If all sources fail -> throw
  throw new Error('All data sources failed');
}

/* ---------- Indicator implementations (plain JS) ---------- */

// Simple rolling utility
function rolling(arr, window, idx) {
  const start = Math.max(0, idx - window + 1);
  return arr.slice(start, idx + 1);
}

// RSI (Wilder) compute array version, returns array of RSI values same length as prices (NaN early)
function computeRSI(prices, period = 14) {
  const rsis = Array(prices.length).fill(null);
  if (prices.length < period + 1) return rsis;

  const deltas = [];
  for (let i = 1; i < prices.length; i++) deltas.push(prices[i] - prices[i - 1]);

  // initial average gain/loss
  let gains = 0, losses = 0;
  for (let i = 0; i < period; i++) {
    const d = deltas[i];
    if (d >= 0) gains += d;
    else losses += Math.abs(d);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  // first RSI at index period (0-based prices)
  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsis[period] = 100 - (100 / (1 + rs));

  // Wilder smoothing
  for (let i = period + 1; i < prices.length; i++) {
    const d = deltas[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? Math.abs(d) : 0;
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsis[i] = 100 - (100 / (1 + rs));
  }
  return rsis;
}

// SMA
function sma(arr, period) {
  const res = [];
  for (let i = 0; i < arr.length; i++) {
    const win = arr.slice(Math.max(0, i - period + 1), i + 1);
    const s = win.reduce((a,b)=>a+(Number(b)||0), 0) / win.length;
    res.push(s);
  }
  return res;
}

// Std dev rolling
function rollingStd(arr, period) {
  const res = [];
  for (let i = 0; i < arr.length; i++) {
    const win = arr.slice(Math.max(0, i - period + 1), i + 1).map(Number);
    const mean = win.reduce((a,b)=>a+b,0)/win.length;
    const variance = win.reduce((a,b)=>a + Math.pow(b - mean, 2), 0) / win.length;
    res.push(Math.sqrt(variance));
  }
  return res;
}

// ATR (Wilder) - uses high, low, close arrays
function computeATR(highs, lows, closes, period = 14) {
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i-1]),
      Math.abs(lows[i] - closes[i-1])
    );
    trs.push(tr);
  }
  if (trs.length < period) {
    // simple average
    const avg = trs.reduce((a,b)=>a+b,0) / (trs.length||1);
    return Array(closes.length).fill(avg);
  }
  // first ATR = average of first 'period' TRs
  const atrs = Array(closes.length).fill(null);
  let initial = trs.slice(0, period).reduce((a,b)=>a+b,0) / period;
  atrs[period] = initial;
  let prev = initial;
  for (let i = period; i < trs.length; i++) {
    const cur = ((prev * (period - 1)) + trs[i]) / period;
    atrs[i+1] = cur; // shift because trs index starts at 0 for close index 1
    prev = cur;
  }
  // Fill any leading nulls with first valid
  for (let i = 0; i < atrs.length; i++) {
    if (atrs[i] === null) atrs[i] = atrs.find(x => x !== null) || 0;
  }
  return atrs;
}

/* ---------- Physics Momentum core ---------- */

async function analyzePhysics(symbol, opts = { timeframe: '5m', limit: 200 }) {
  try {
    // Normalize symbol for exchanges (we use symbol like 'BTC/USDT')
    const cleanSymbol = symbol.includes('/') ? symbol : symbol.replace('USDT','/USDT');

    const interval = opts.timeframe || '5m';
    const limit = opts.limit || 200;

    // Fetch candles using multi-source fallback
    const candles = await fetchCandlesFallback(cleanSymbol, interval, limit);
    if (!candles || candles.length < 40) {
      return null;
    }

    // Build arrays
    const highs = candles.map(c => Number(c.high));
    const lows = candles.map(c => Number(c.low));
    const closes = candles.map(c => Number(c.close));
    const opens = candles.map(c => Number(c.open));
    const vols = candles.map(c => Number(c.vol || 0));

    // RSI(14)
    const rsiArr = computeRSI(closes, 14);

    // Bollinger Bands 20,2: middle = sma20 of closes; std20 -> upper = mid + 2*std
    const sma20 = sma(closes, 20);
    const std20 = rollingStd(closes, 20);
    const upperBB = sma20.map((m, idx) => m + 2 * (std20[idx] || 0));
    const lowerBB = sma20.map((m, idx) => m - 2 * (std20[idx] || 0));

    // Velocity: price change then sma(3)
    const priceChanges = [];
    for (let i = 0; i < closes.length; i++) {
      const prev = (i === 0) ? closes[0] : closes[i-1];
      priceChanges.push(closes[i] - prev);
    }
    const vArr = sma(priceChanges, 3);
    // acceleration a = v_t - v_{t-1}
    const aArr = [];
    for (let i = 0; i < vArr.length; i++) {
      if (i === 0) aArr.push(0);
      else aArr.push(vArr[i] - vArr[i-1]);
    }

    // ATR(14)
    const atrArr = computeATR(highs, lows, closes, 14);

    // last index
    const idx = closes.length - 1;
    const lastClose = closes[idx];
    const lastRsi = rsiArr[idx];
    const lastLowerBB = lowerBB[idx];
    const lastUpperBB = upperBB[idx];
    const lastA = aArr[idx];
    const lastAtr = atrArr[idx];

    // Validate indicators exist
    if (lastRsi === null || lastLowerBB === null || lastUpperBB === null || lastAtr === null) {
      return null;
    }

    // Entry rules
    let side = null;
    if (lastRsi < 30 && lastClose < lastLowerBB && lastA > 0) side = 'LONG';
    if (lastRsi > 70 && lastClose > lastUpperBB && lastA < 0) side = 'SHORT';
    if (!side) return null;

    const entry = lastClose;
    let sl, tp;
    if (side === 'LONG') {
      sl = entry - 1.5 * lastAtr;
      tp = entry + 3.0 * lastAtr;
    } else {
      sl = entry + 1.5 * lastAtr;
      tp = entry - 3.0 * lastAtr;
    }
    const rr = (Math.abs(tp - entry) / Math.abs(entry - sl)) || null;

    // Compute a simple confidence score:
    // base 70 if condition satisfied, add margin if RSI far from boundary, and acceleration magnitude, and ATR relative smallness
    let confidence = 70;
    try {
      // RSI distance
      if (side === 'LONG') confidence += Math.min(15, (30 - lastRsi)); // if RSI = 10 -> +20, cap later
      else confidence += Math.min(15, (lastRsi - 70));
      // acceleration magnitude normalized by close
      const accScore = Math.min(10, Math.abs(lastA) / (entry || 1) * 1000);
      confidence += accScore;
      // ATR relative (smaller ATR relative to price -> cleaner)
      const atrRel = lastAtr / (entry || 1);
      if (atrRel < 0.005) confidence += 5;
      confidence = Math.max(30, Math.min(95, Math.round(confidence)));
    } catch (e) {
      confidence = 70;
    }

    return {
      symbol: cleanSymbol,
      side,
      entry: Number(entry),
      tp: Number(tp),
      sl: Number(sl),
      rr: rr ? Number(rr.toFixed(2)) : null,
      confidence,
      meta: {
        rsi: Number((lastRsi||0).toFixed(2)),
        lowerBB: Number((lastLowerBB||0).toFixed(8)),
        upperBB: Number((lastUpperBB||0).toFixed(8)),
        acceleration: Number((lastA||0).toFixed(8)),
        atr: Number((lastAtr||0).toFixed(8)),
        close: Number(lastClose)
      }
    };

  } catch (err) {
    // Always return null on failures (scanner will continue)
    // console.error('analyzePhysics error:', err && err.message);
    return null;
  }
}

module.exports = { analyzePhysics };
