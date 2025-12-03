/**
 * index.js
 * Main Telegram bot + scheduler for Physics Momentum signals
 *
 * - /start để đăng ký nhận tín hiệu (lưu users.json)
 * - Quét các coin mỗi 5 phút, dùng analysis.js -> analyzePhysics()
 * - Multi-exchange rotation được xử lý trong analysis.js
 * - Không có logic admin / key / đặt lệnh
 * - Tránh gửi trùng (same symbol + side) trong vòng 1 giờ (signals_sent.json)
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const analysis = require('./analysis');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8322194930:AAEbemqNTWGAKoLwl23bwziKatEb6jx5ZIM';

// FILES
const USERS_FILE = path.join(__dirname, 'users.json');
const SIGNALS_FILE = path.join(__dirname, 'signals_sent.json');

// Ensure files exist
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
if (!fs.existsSync(SIGNALS_FILE)) fs.writeFileSync(SIGNALS_FILE, JSON.stringify([]));

// util: read/write users
function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE));
  } catch (e) {
    return [];
  }
}
function writeUsers(arr) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(arr, null, 2));
  } catch (e) { /* swallow */ }
}

// signals persistence
function readSignals() {
  try {
    return JSON.parse(fs.readFileSync(SIGNALS_FILE));
  } catch (e) {
    return [];
  }
}
function writeSignals(arr) {
  try {
    fs.writeFileSync(SIGNALS_FILE, JSON.stringify(arr, null, 2));
  } catch (e) { /* swallow */ }
}

// Add user if not exists
function addUser(chatId, userInfo) {
  try {
    const users = readUsers();
    const found = users.find(u => u.chatId === chatId);
    if (!found) {
      users.push({ chatId, userInfo, addedAt: new Date().toISOString() });
      writeUsers(users);
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// Remove user (e.g., if banned) - invoked when Telegram returns 403
function removeUser(chatId) {
  try {
    let users = readUsers();
    users = users.filter(u => u.chatId !== chatId);
    writeUsers(users);
  } catch (e) { /* swallow */ }
}

// dedupe: check if same symbol+side sent within last 3600 seconds
function isDuplicateRecent(symbol, side, windowSeconds = 3600) {
  try {
    const signals = readSignals();
    const now = Date.now();
    // Clean old entries (older than windowSeconds to keep file small)
    const cleaned = signals.filter(s => (now - s.ts) < (24 * 3600 * 1000)); // keep 1 day for safety
    writeSignals(cleaned);

    const found = signals.find(s => s.symbol === symbol && s.side === side && (now - s.ts) <= (windowSeconds * 1000));
    return !!found;
  } catch (e) {
    return false;
  }
}
function recordSignal(symbol, side) {
  try {
    const signals = readSignals();
    signals.push({ symbol, side, ts: Date.now() });
    writeSignals(signals);
  } catch (e) { /* swallow */ }
}

// Format message exactly per your template (Vietnamese)
function formatPhysicsMessage(signal) {
  // signal: { symbol, side, entry, tp, sl, rr, meta }
  const tzNow = moment().tz("Asia/Ho_Chi_Minh");
  const weekdayMap = {
    0: 'THỨ HAI', 1: 'THỨ BA', 2: 'THỨ TƯ', 3: 'THỨ NĂM',
    4: 'THỨ SÁU', 5: 'THỨ BẢY', 6: 'CHỦ NHẬT'
  };
  const weekday = weekdayMap[tzNow.isoWeekday() - 1] || tzNow.format('dddd');
  const coin = (signal.symbol || '').replace('/USDT','').replace('USDT','');
  const side = (signal.side || 'LONG').toUpperCase();
  const entry = formatPrice(signal.entry);
  const tp = formatPrice(signal.tp);
  const sl = formatPrice(signal.sl);
  const rr = (signal.rr !== null && signal.rr !== undefined) ? Number(signal.rr).toFixed(2) : '-';

  const txt = `🤖 Tín hiệu ${weekday}
#${coin} – [${side}] 📌

🔴 Entry: ${entry}
🆗 Take Profit: ${tp}
🙅‍♂️ Stop-Loss: ${sl}
🪙 Tỉ lệ RR: ${rr}

🧠 By Bot [Physics Momentum]

⚠️ Nhất định phải tuân thủ quản lý rủi ro – Đi tối đa 2-3% risk, Bot chỉ để tham khảo, win 3 lệnh nên ngưng`;
  return txt;
}
function formatPrice(p) {
  try {
    if (p === null || p === undefined) return '-';
    const num = Number(p);
    if (!isFinite(num)) return String(p);
    if (num >= 1) return num.toFixed(4);
    return num.toFixed(8);
  } catch {
    return String(p);
  }
}

// Broadcaster with retry and handling 403 to remove user
async function broadcastMessage(bot, text) {
  const users = readUsers();
  let success = 0, fail = 0;
  for (const u of users) {
    const chatId = u.chatId;
    let attempts = 0;
    let ok = false;
    while (attempts < 3 && !ok) {
      try {
        await bot.sendMessage(chatId, text);
        ok = true;
        success++;
      } catch (err) {
        attempts++;
        // If user blocked bot or chat migrated, remove user to avoid repeated errors
        try {
          if (err && err.response && (err.response.statusCode === 403 || err.response.statusCode === 400)) {
            removeUser(chatId);
            console.log(`Removed user ${chatId} due to Telegram error ${err.response.statusCode}`);
            ok = true; // stop retrying
            fail++;
          } else {
            // wait backoff
            await new Promise(r => setTimeout(r, 500 * attempts));
          }
        } catch (inner) {
          // swallow
          ok = true;
          fail++;
        }
      }
    }
    if (!ok) fail++;
    // polite short delay
    await new Promise(r => setTimeout(r, 120));
  }
  console.log(`Broadcast results: success=${success}, fail=${fail}`);
  return { success, fail };
}

// LIST OF 15 COINS (xịn)
const SYMBOLS = [
  'BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT','ADA/USDT',
  'XRP/USDT','AVAX/USDT','LTC/USDT','LINK/USDT','DOGE/USDT',
  'MATIC/USDT','DOT/USDT','ATOM/USDT','TRX/USDT','ALGO/USDT'
];

// CONFIG
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 5 * 60 * 1000); // 5 minutes
const PER_SYMBOL_DELAY_MS = Number(process.env.PER_SYMBOL_DELAY_MS || 2000); // 2 seconds

// Telegram bot init (polling)
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true, request: { timeout: 10 } });

bot.on('polling_error', (err) => {
  console.error('[Polling Error]', err && err.code, err && err.message);
});

// /start command: simply add user to users.json
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const user = msg.from || {};
    addUser(chatId, { username: user.username, first_name: user.first_name });
    await bot.sendMessage(chatId,
      "👋 Bạn đã được đăng ký nhận tín hiệu Nemesis (Physics Momentum).\n" +
      "Bot sẽ quét tự động 24/7 (chu kỳ mặc định 5 phút). Gõ /start bất kỳ lúc nào để chắc chắn đăng ký."
    );
    console.log(`User ${chatId} registered via /start`);
  } catch (e) {
    console.error("Error in /start handler", e && e.message);
  }
});

// health & keepalive server (Express)
const app = express();
app.get('/', (req, res) => res.send('Nemesis Physics Momentum Bot - running'));
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Keepalive server listening on port ${PORT}`));

// SCANNER: run Physics Momentum across SYMBOLS on interval
let isScanning = false;
async function scanAllSymbols() {
  if (isScanning) {
    console.log('Scanner already running, skipping this tick');
    return;
  }
  isScanning = true;
  console.log(`[${new Date().toISOString()}] Starting physics scan pass for ${SYMBOLS.length} symbols`);
  try {
    for (const symbol of SYMBOLS) {
      try {
        // analyze symbol (multi-exchange fallback inside)
        const sig = await analysis.analyzePhysics(symbol, { timeframe: '5m', limit: 120 });
        if (sig && (sig.side === 'LONG' || sig.side === 'SHORT')) {
          // dedupe
          if (isDuplicateRecent(symbol, sig.side, 3600)) {
            console.log(`Skip duplicate signal ${symbol} ${sig.side} within 1 hour`);
          } else {
            // record and broadcast
            recordSignal(symbol, sig.side);
            const message = formatPhysicsMessage(sig);
            console.log(`Signal -> ${symbol} ${sig.side} | broadcasting to users`);
            await broadcastMessage(bot, message);
          }
        } else {
          console.log(`No physics signal for ${symbol}`);
        }
      } catch (err) {
        console.error(`Error scanning ${symbol}:`, err && err.message);
      }
      // polite delay between symbols
      await new Promise(r => setTimeout(r, PER_SYMBOL_DELAY_MS));
    }
  } catch (e) {
    console.error('Fatal scanner error', e && e.message);
  } finally {
    isScanning = false;
    console.log(`[${new Date().toISOString()}] Scan pass finished`);
  }
}

// Start immediate scan after short delay, then schedule
setTimeout(() => {
  scanAllSymbols();
  setInterval(scanAllSymbols, SCAN_INTERVAL_MS);
}, 5000);

// Graceful shutdown hooks
process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  try { bot.stopPolling(); } catch (_) {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  try { bot.stopPolling(); } catch (_) {}
  process.exit(0);
});

console.log('Nemesis Physics Momentum Bot started. /start để đăng ký nhận tín hiệu.');
