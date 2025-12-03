// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const moment = require('moment-timezone');
const analysis = require('./analysis');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8567789264:AAE5JOYXdFHXnPm1H160nhCLcZ3lWrb1moY';
const WEBHOOK_URL = process.env.WEBHOOK_URL || null; // set this to https://your-app.onrender.com when using webhook
const PORT = parseInt(process.env.PORT || '3000', 10);

const USERS_FILE = path.join(__dirname, 'users.json');
const RECENT_SIGNALS_FILE = path.join(__dirname, 'recent_signals.json');

// Ensure users file exists
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
if (!fs.existsSync(RECENT_SIGNALS_FILE)) fs.writeFileSync(RECENT_SIGNALS_FILE, JSON.stringify([]));

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}
function saveUsers(arr) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {}
}

function loadRecentSignals() {
  try {
    return JSON.parse(fs.readFileSync(RECENT_SIGNALS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}
function saveRecentSignals(arr) {
  try {
    fs.writeFileSync(RECENT_SIGNALS_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {}
}

// 15 coin "xịn" như yêu cầu
const SYMBOLS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','LINKUSDT',
  'DOGEUSDT','XRPUSDT','LTCUSDT','ADAUSDT','AVAXUSDT',
  'MATICUSDT','ATOMUSDT','TRXUSDT','XMRUSDT','BCHUSDT'
];

const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 phút
const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 giờ, không gửi lặp trùng

// Setup Express
const app = express();
app.use(bodyParser.json());

// Telegram bot instance (we will init below based on webhook/polling)
let bot;
const useWebhook = !!WEBHOOK_URL;

function addUser(chatId, userInfo) {
  const users = loadUsers();
  if (!users.find(u => u.chatId === chatId)) {
    users.push({ chatId, userInfo, joinedAt: new Date().toISOString() });
    saveUsers(users);
    console.log(`[Users] Added ${chatId}`);
  } else {
    console.log(`[Users] Already subscribed: ${chatId}`);
  }
}
function removeUser(chatId) {
  let users = loadUsers();
  users = users.filter(u => u.chatId !== chatId);
  saveUsers(users);
  console.log(`[Users] Removed ${chatId}`);
}

// Format message as required (Vietnamese)
function formatSignalMessage(signal) {
  try {
    const tz = 'Asia/Ho_Chi_Minh';
    const now = moment().tz(tz);
    const weekdayMap = {
      1: 'THỨ HAI', 2: 'THỨ BA', 3: 'THỨ TƯ', 4: 'THỨ NĂM',
      5: 'THỨ SÁU', 6: 'THỨ BẢY', 0: 'CHỦ NHẬT'
    };
    const day = weekdayMap[now.day()] || 'HÔM NAY';
    const coin = signal.symbol.replace('USDT','');
    const side = signal.side;
    const entry = typeof signal.entry === 'number' ? signal.entry : parseFloat(signal.entry);
    const tp = typeof signal.tp === 'number' ? signal.tp : parseFloat(signal.tp);
    const sl = typeof signal.sl === 'number' ? signal.sl : parseFloat(signal.sl);
    const rr = signal.rr !== undefined && signal.rr !== null ? Number(signal.rr).toFixed(2) : '-';

    // nice formatting: if price >=1 show 4 decimals, else show 8 decimals
    const fmt = (p) => {
      if (p === null || p === undefined || isNaN(p)) return '-';
      if (p >= 1) return p.toFixed(4);
      return p.toFixed(8);
    };

    const header = `🤖 Tín hiệu ${day}\n#${coin} – [${side}] 📌\n\n`;
    const body = `🔴 Entry: ${fmt(entry)}\n🆗 Take Profit: ${fmt(tp)}\n🙅‍♂️ Stop-Loss: ${fmt(sl)}\n🪙 Tỉ lệ RR: ${rr}\n\n`;
    const byline = `🧠 By Bot [Physics Momentum]\n\n⚠️ Nhất định phải tuân thủ quản lý rủi ro – Đi tối đa 2-3% risk, Bot chỉ để tham khảo, win 3 lệnh nên ngưng`;
    return header + body + byline;
  } catch (e) {
    return '🤖 Tín hiệu — lỗi định dạng';
  }
}

// prevent duplicate similar signals within last hour: same symbol + same side
function isDuplicateSignal(symbol, side) {
  const recent = loadRecentSignals();
  const now = Date.now();
  // purge older than DEDUP_WINDOW_MS
  const filtered = recent.filter(r => now - r.ts <= DEDUP_WINDOW_MS);
  saveRecentSignals(filtered);
  const found = filtered.find(r => r.symbol === symbol && r.side === side);
  return !!found;
}
function registerSentSignal(symbol, side) {
  const recent = loadRecentSignals();
  recent.push({ symbol, side, ts: Date.now() });
  // keep only recent window to avoid growing file
  const keep = recent.filter(r => Date.now() - r.ts <= DEDUP_WINDOW_MS);
  saveRecentSignals(keep);
}

// Broadcast helper with small retry
async function broadcastMessage(text) {
  const users = loadUsers();
  let success = 0, fail = 0;
  for (const u of users) {
    try {
      await bot.sendMessage(u.chatId, text);
      success++;
      // small delay to be polite
      await new Promise(r => setTimeout(r, 150));
    } catch (err) {
      fail++;
      console.error(`[Broadcast] Failed to ${u.chatId}:`, err.message || err.toString());
      if (err.response && err.response.statusCode === 403) {
        // bot blocked -> remove
        removeUser(u.chatId);
      }
    }
  }
  console.log(`[Broadcast] Sent: ${success}, Failed: ${fail}`);
  return { success, fail };
}

// Create bot (webhook or polling fallback)
async function initBot() {
  if (useWebhook) {
    // create bot without polling
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
    // setup webhook endpoint url
    const webhookPath = `/bot${TELEGRAM_TOKEN}`;
    const webhookUrl = WEBHOOK_URL.replace(/\/$/, '') + webhookPath;
    try {
      await bot.setWebHook(webhookUrl);
      console.log(`[Webhook] Set webhook to ${webhookUrl}`);
    } catch (e) {
      console.error('[Webhook] Failed to set webhook:', e.message || e.toString());
    }

    // express will handle POST at webhookPath -> processed below
    app.post(webhookPath, async (req, res) => {
      try {
        await bot.processUpdate(req.body);
        res.sendStatus(200);
      } catch (err) {
        console.error('[Webhook] processUpdate error:', err && err.message);
        res.sendStatus(200); // respond 200 to avoid retries
      }
    });
  } else {
    // fallback: polling (increase timeout)
    bot = new TelegramBot(TELEGRAM_TOKEN, {
      polling: {
        interval: 1000,
        autoStart: true,
        params: { timeout: 30 } // increase timeout
      },
      request: { timeout: 60 * 1000 } // request-level timeout
    });
    bot.on('polling_error', (err) => {
      console.error('[Polling Error]', err && err.code, err && err.message);
    });
  }

  // Handlers
  bot.onText(/\/start/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      addUser(chatId, msg.from);
      const reply = `👋 Chào ${msg.from.first_name || 'Trader'}!\nBot đã lưu bạn để nhận tín hiệu tự động.\n\n⚠️ Bot chỉ gửi tín hiệu tham khảo — tuân thủ quản lý rủi ro.`;
      await bot.sendMessage(chatId, reply);
    } catch (e) {
      console.error('/start handler error', e && e.message);
    }
  });

  bot.on('message', async (msg) => {
    // handle simple commands like /help or /stop
    try {
      const text = (msg.text || '').trim();
      const chatId = msg.chat.id;
      if (text === '/help') {
        await bot.sendMessage(chatId, 'Gõ /start để đăng ký nhận tín hiệu. Gõ /stop để huỷ đăng ký.');
      } else if (text === '/stop') {
        removeUser(chatId);
        await bot.sendMessage(chatId, 'Bạn đã huỷ đăng ký nhận tín hiệu.');
      }
    } catch (e) {
      console.error('message handler error', e && e.message);
    }
  });

  console.log('[Bot] Initialized');
}

// Scanner : quét mọi symbol mỗi 5 phút
async function scannerPass() {
  console.log(`[Scanner] Start pass - ${new Date().toISOString()}`);
  for (const symbol of SYMBOLS) {
    try {
      // analyzeSignature returns object or null
      const sig = await analysis.analyzePhysics(symbol);
      if (sig && sig.side) {
        // dedupe: same symbol+side within 1h
        if (isDuplicateSignal(symbol, sig.side)) {
          console.log(`[Scanner] Duplicate within 1h, skip ${symbol} ${sig.side}`);
        } else {
          // register and broadcast
          registerSentSignal(symbol, sig.side);
          const text = formatSignalMessage({
            symbol: symbol,
            side: sig.side,
            entry: sig.entry,
            tp: sig.tp,
            sl: sig.sl,
            rr: sig.rr
          });
          console.log(`[Scanner] Signal -> ${symbol} ${sig.side} RR:${sig.rr}`);
          await broadcastMessage(text);
        }
      } else {
        // no signal
        //console.log(`[Scanner] No signal ${symbol}`);
      }
    } catch (err) {
      console.error(`[Scanner] Error on ${symbol}:`, err && (err.message || err.toString()));
    }
    // polite delay per symbol to avoid hammering (2s)
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`[Scanner] Pass finished at ${new Date().toISOString()}`);
}

// Start everything
(async () => {
  // init bot
  await initBot();

  // Express endpoints
  app.get('/', (req, res) => res.send('Nemesis Physics Momentum Bot is running'));
  app.get('/health', (req, res) => {
    const users = loadUsers();
    res.json({ status: 'ok', users: users.length, time: new Date().toISOString() });
  });

  // Listen for incoming webhook requests (if using webhook, webhookPath already registered)
  app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT} (WEBHOOK_URL=${!!WEBHOOK_URL})`);
  });

  // Kick-off scanner: run immediately, then every SCAN_INTERVAL_MS
  try {
    // initial small delay to allow bot init
    setTimeout(() => scannerPass(), 5000);
    setInterval(() => {
      scannerPass().catch(e => console.error('scannerPass error', e && e.message));
    }, SCAN_INTERVAL_MS);
    console.log(`[Scheduler] Scanner scheduled every ${SCAN_INTERVAL_MS / 1000} seconds`);
  } catch (e) {
    console.error('Failed scheduling scanner:', e && e.message);
  }
})();
