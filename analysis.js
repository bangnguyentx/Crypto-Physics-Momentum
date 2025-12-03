// analysis.js
// Physics Momentum (RSI(14), BB(20,2), v (SMA3 of price change), a (acceleration), ATR(14))
// Multi-source fallback: Binance / Binance API / Bybit public
const axios = require('axios');

const DATA_SOURCES = [
  {
    name: 'Binance Futures (fapi)',
    klines: (symbol, interval, limit = 200) => `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    priority: 1
  },
  {
    name: 'Binance Spot (api)',
    klines: (symbol, interval, limit = 200) => `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    priority: 2
  },
  {
    name: 'Bybit',
    klines: (symbol, interval, limit = 200) => {
      // simple mapping for common intervals
      const mapping = { '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
      const iv = mapping[interval] || interval;
      return `https://api.bybit.com/v2/public/kline/list?symbol=${symbol}&interval=${iv}&limit=${limit}`;
    },
    priority: 3
  }
];

const INTERVAL = '5m';
const LIMIT = 120; // fetch 120 candles to be safe

async function fetchCandlesMulti(symbol, interval = INTERVAL, limit = LIMIT) {
  const sources = [...DATA_SOURCES].sort((a,b)=>a.priority - b.priority);
  for (const s of sources) {
    try {
      const url = s.klines(symbol, interval, limit);
      const resp = await axios.get(url, { timeout: 10_000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (resp.status === 200 && resp.data) {
        let rows = resp.data;
        // unify format -> array of [ts, open, high, low, close, vol]
        let candles = [];
        if (s.name.includes('Bybit')) {
          // bybit v2 format: {ret_code, result: [...]} or direct list
          const data = resp.data.result || resp.data;
          if (!data || !Array.isArray(data)) throw new Error('Invalid Bybit response');
          // bybit returns newest first? test: ensure chronological order oldest->newest
          // map each element depending on format
          for (const c of data) {
            // some endpoints return [openTime, open, high, low, close, volume]
            if (Array.isArray(c)) {
              candles.push([c[0], parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3]), parseFloat(c[4]), parseFloat(c[5])]);
            } else if (c.t && c.o) {
              candles.push([Number(c.t), parseFloat(c.o), parseFloat(c.h), parseFloat(c.l), parseFloat(c.c), parseFloat(c.v)]);
            } else {
              // fallback
            }
          }
        } else {
          // Binance format: array of arrays
          for (const c of rows) {
            // c = [openTime, open, high, low, close, volume, ...]
            if (Array.isArray(c) && c.length >= 6) {
              candles.push([c[0], parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3]), parseFloat(c[4]), parseFloat(c[5])]);
            }
          }
        }
        if (candles.length >= 30) {
          // ensure oldest -> newest
          if (candles[0][0] > candles[candles.length - 1][0]) candles = candles.reverse();
          return candles;
        } else {
          // try next source
        }
      }
    } catch (e) {
      // console.warn(`[fetchCandlesMulti] source ${s.name} failed: ${e.message}`);
      continue;
    }
  }
  // if all fail
  return null;
}

// indicator helpers
function sma(arr, len) {
  const res = [];
  for (let i = 0; i < arr.length; i++) {
    if (i + 1 < len) res.push(null);
    else {
      const slice = arr.slice(i - len + 1, i + 1);
      const s = slice.reduce((a,b)=>a+b,0)/len;
      res.push(s);
    }
  }
  return res;
}
function stddev(arr, len) {
  const res = [];
  for (let i = 0; i < arr.length; i++) {
    if (i + 1 < len) res.push(null);
    else {
      const slice = arr.slice(i - len + 1, i + 1);
      const mean = slice.reduce((a,b)=>a+b,0)/len;
      const variance = slice.reduce((a,b)=>a + Math.pow(b-mean,2),0)/len;
      res.push(Math.sqrt(variance));
    }
  }
  return res;
}
// RSI simple implementation (classic Wilder? We'll use standard average gain/loss method)
function rsiFromArray(closes, period = 14) {
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i-1]);
  const rsi = new Array(closes.length).fill(null);
  if (changes.length < period) return rsi;
  // first avg gain/loss is simple average over first period
  let gains = 0, losses = 0;
  for (let i = 0; i < period; i++) {
    const v = changes[i];
    if (v > 0) gains += v;
    else losses += Math.abs(v);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  // RSI for index period -> maps to closes index (period)
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period+1; i < closes.length; i++) {
    const c = changes[i-1];
    const gain = c > 0 ? c : 0;
    const loss = c < 0 ? Math.abs(c) : 0;
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

function atrFromCandles(highs, lows, closes, period = 14) {
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
    return Array(closes.length).fill(null);
  }
  const atr = new Array(closes.length).fill(null);
  // initial ATR: average of first 'period' TRs -> maps to index period
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let prevAtr = sum / period;
  atr[period] = prevAtr;
  for (let i = period+1; i < closes.length; i++) {
    const tr = trs[i-1];
    const cur = ((prevAtr * (period - 1)) + tr) / period;
    atr[i] = cur;
    prevAtr = cur;
  }
  return atr;
}

function computeVelocityAcceleration(closes) {
  // price change array
  const pc = [null];
  for (let i = 1; i < closes.length; i++) pc.push(closes[i] - closes[i-1]);
  // v = SMA(3) of price change
  const v = [];
  for (let i = 0; i < pc.length; i++) {
    if (i < 2) v.push(null);
    else {
      const sum = (pc[i] || 0) + (pc[i-1] || 0) + (pc[i-2] || 0);
      v.push(sum / 3);
    }
  }
  // a = v_t - v_{t-1}
  const a = [null];
  for (let i = 1; i < v.length; i++) {
    if (v[i] === null || v[i-1] === null) a.push(null);
    else a.push(v[i] - v[i-1]);
  }
  return { v, a };
}

// Main analyze function for Physics Momentum
async function analyzePhysics(symbol) {
  try {
    const candles = await fetchCandlesMulti(symbol, '5m', LIMIT);
    if (!candles || candles.length < 40) return null; // not enough data

    // normalize arrays
    const timestamps = candles.map(c => c[0]);
    const opens = candles.map(c => Number(c[1]));
    const highs = candles.map(c => Number(c[2]));
    const lows = candles.map(c => Number(c[3]));
    const closes = candles.map(c => Number(c[4]));
    const vols = candles.map(c => Number(c[5]));

    // compute indicators
    const rsiArr = rsiFromArray(closes, 14);
    const ma20Arr = sma(closes, 20);
    const sd20Arr = stddev(closes, 20);
    const bbUpper = ma20Arr.map((m,i)=> m === null ? null : m + 2 * sd20Arr[i]);
    const bbLower = ma20Arr.map((m,i)=> m === null ? null : m - 2 * sd20Arr[i]);

    const atrArr = atrFromCandles(highs, lows, closes, 14);
    const { v: vArr, a: aArr } = computeVelocityAcceleration(closes);

    // take last valid index
    const idx = closes.length - 1;
    const lastRsi = rsiArr[idx];
    const lastClose = closes[idx];
    const lastLower = bbLower[idx];
    const lastUpper = bbUpper[idx];
    const lastA = aArr[idx];
    const lastAtr = atrArr[idx];

    if ([lastRsi, lastLower, lastUpper, lastA, lastAtr].some(x => x === null || x === undefined || Number.isNaN(x))) {
      return null;
    }

    // Entry rules:
    // LONG: RSI < 30 AND Close < LowerBand AND Acceleration > 0.
    // SHORT: RSI > 70 AND Close > UpperBand AND Acceleration < 0.
    let side = null;
    if (lastRsi < 30 && lastClose < lastLower && lastA > 0) side = 'LONG';
    else if (lastRsi > 70 && lastClose > lastUpper && lastA < 0) side = 'SHORT';
    else side = null;

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

    // Return nicely
    return {
      symbol,
      side,
      entry: Number(entry),
      tp: Number(tp),
      sl: Number(sl),
      rr: Number(rr)
    };
  } catch (e) {
    // swallow error to keep scanner stable
    // console.error('[analyzePhysics] error', e.message);
    return null;
  }
}

module.exports = { analyzePhysics };
