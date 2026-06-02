require("dotenv").config();
const fetch = require("node-fetch");
const express = require("express");

const app = express();
app.use(express.json());

// ═══ BOT CONFIGS (can be changed via API) ═══
const bots = {
  bot1: {
    name: "Femboys → Haul",
    token: process.env.BOT1_TOKEN,
    sourceId: process.env.SOURCE1_ID,
    destId: process.env.DEST1_ID,
    active: true,
    interval: 20,
    lastForwarded: null,
    status: "idle",
  },
  bot2: {
    name: "HaulTransparent → Haul2",
    token: process.env.BOT2_TOKEN,
    sourceId: process.env.SOURCE2_ID,
    destId: process.env.DEST2_ID,
    active: true,
    interval: 20,
    lastForwarded: null,
    status: "idle",
  },
};

const ADMIN_SECRET = process.env.ADMIN_SECRET || "Mbuki@2030.";
const timers = {};
const forwarded1 = new Set();
const forwarded2 = new Set();

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function copyMessage(token, fromChatId, toChatId, messageId) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/copyMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: toChatId, from_chat_id: fromChatId, message_id: messageId }),
    });
    const data = await res.json();
    return data.ok;
  } catch (e) { return false; }
}

async function getLatestMessageId(token, channelId) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: channelId, text: ".", disable_notification: true }),
    });
    const data = await res.json();
    if (data.ok) {
      const msgId = data.result.message_id;
      await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: channelId, message_id: msgId }),
      });
      return msgId;
    }
  } catch (e) {}
  return 100;
}

async function findVideos(token, channelId, startId) {
  const videos = [];
  for (let id = startId; id > Math.max(startId - 200, 1); id--) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/forwardMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: channelId, from_chat_id: channelId, message_id: id, disable_notification: true }),
      });
      const data = await res.json();
      if (data.ok && data.result.video) {
        videos.push({ messageId: id, caption: data.result.caption || "" });
        await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: channelId, message_id: data.result.message_id }),
        });
      }
      if (videos.length >= 50) break;
    } catch (e) { continue; }
  }
  return videos;
}

async function runBot(botKey) {
  const bot = bots[botKey];
  if (!bot.active) return;
  const forwardedSet = botKey === "bot1" ? forwarded1 : forwarded2;

  bot.status = "running";
  console.log(`\n🤖 ${bot.name} — looking for videos...`);

  const latestId = await getLatestMessageId(bot.token, bot.sourceId);
  const videos = await findVideos(bot.token, bot.sourceId, latestId);

  if (videos.length === 0) {
    bot.status = "idle";
    console.log(`⚠️ ${bot.name} — no videos found`);
    return;
  }

  const unforwarded = videos.filter(v => !forwardedSet.has(v.messageId));
  const pool = unforwarded.length > 0 ? unforwarded : videos;
  const pick = pool[Math.floor(Math.random() * pool.length)];

  const ok = await copyMessage(bot.token, bot.sourceId, bot.destId, pick.messageId);
  if (ok) {
    forwardedSet.add(pick.messageId);
    bot.lastForwarded = new Date().toISOString();
    bot.status = "idle";
    console.log(`✅ ${bot.name} — forwarded!`);
  } else {
    bot.status = "error";
  }
}

function startTimer(botKey) {
  if (timers[botKey]) clearInterval(timers[botKey]);
  runBot(botKey);
  timers[botKey] = setInterval(() => runBot(botKey), bots[botKey].interval * 60 * 1000);
  console.log(`⏰ ${bots[botKey].name} — running every ${bots[botKey].interval} mins`);
}

function stopTimer(botKey) {
  if (timers[botKey]) {
    clearInterval(timers[botKey]);
    delete timers[botKey];
  }
  bots[botKey].active = false;
  bots[botKey].status = "stopped";
}

// ═══ ADMIN API ═══

// Get all bots status
app.get("/admin/bots", adminAuth, (req, res) => {
  const status = {};
  Object.keys(bots).forEach(key => {
    status[key] = {
      name: bots[key].name,
      active: bots[key].active,
      status: bots[key].status,
      interval: bots[key].interval,
      sourceId: bots[key].sourceId,
      destId: bots[key].destId,
      lastForwarded: bots[key].lastForwarded,
    };
  });
  res.json(status);
});

// Start a bot
app.post("/admin/bots/:key/start", adminAuth, (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  bots[key].active = true;
  startTimer(key);
  res.json({ success: true, message: `${bots[key].name} started` });
});

// Stop a bot
app.post("/admin/bots/:key/stop", adminAuth, (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  stopTimer(key);
  res.json({ success: true, message: `${bots[key].name} stopped` });
});

// Update bot config (change channels, interval)
app.post("/admin/bots/:key/config", adminAuth, (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  const { sourceId, destId, interval, token } = req.body;
  if (sourceId) bots[key].sourceId = sourceId;
  if (destId) bots[key].destId = destId;
  if (interval) bots[key].interval = parseInt(interval);
  if (token) bots[key].token = token;
  if (bots[key].active) startTimer(key);
  res.json({ success: true, config: bots[key] });
});

// Force forward now
app.post("/admin/bots/:key/forward", adminAuth, async (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  await runBot(key);
  res.json({ success: true, message: "Forwarded!" });
});

app.get("/", (req, res) => res.json({ status: "ok", message: "Forwarding bots running 🚀" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Forwarding bots + Admin API on port ${PORT}`);
  startTimer("bot1");
  startTimer("bot2");
});
