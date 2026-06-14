require("dotenv").config();
const fetch = require("node-fetch");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const app = express();
app.use(express.json());

const ADMIN_SECRET = process.env.ADMIN_SECRET || "Mbuki@2030.";
const MAIN_BOT_URL = process.env.MAIN_BOT_URL || "https://video-app-bot-production.up.railway.app";
const MAIN_BOT_ADMIN = process.env.MAIN_BOT_ADMIN || "Mbuki@2030.";

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
    forwardCount: 0,
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
    forwardCount: 0,
  },
};

const timers = {};
const forwarded1 = new Set();
const forwarded2 = new Set();

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function loadForwardedIds() {
  try {
    const { data } = await supabase.from("forwarded_ids").select("message_id, bot_key");
    if (data) {
      data.forEach(row => {
        if (row.bot_key === "bot1") forwarded1.add(row.message_id);
        if (row.bot_key === "bot2") forwarded2.add(row.message_id);
      });
      console.log(`📋 Loaded ${data.length} previously forwarded IDs`);
    }
  } catch (e) { console.error("Load error:", e.message); }
}

async function saveForwardedId(botKey, messageId) {
  try {
    await supabase.from("forwarded_ids").upsert(
      { message_id: String(messageId), bot_key: botKey },
      { onConflict: "message_id,bot_key" }
    );
  } catch (e) {}
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
  const unforwarded = videos.filter(v => !forwardedSet.has(String(v.messageId)));
  const pool = unforwarded.length > 0 ? unforwarded : videos;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const ok = await copyMessage(bot.token, bot.sourceId, bot.destId, pick.messageId);
  if (ok) {
    forwardedSet.add(String(pick.messageId));
    saveForwardedId(botKey, pick.messageId);
    bot.lastForwarded = new Date().toISOString();
    bot.status = "idle";
    bot.forwardCount++;
    console.log(`✅ ${bot.name} — forwarded! Total: ${bot.forwardCount}`);
  } else {
    bot.status = "error";
  }
}

function startTimer(botKey) {
  if (timers[botKey]) clearInterval(timers[botKey]);
  runBot(botKey);
  timers[botKey] = setInterval(() => runBot(botKey), bots[botKey].interval * 60 * 1000);
}

function stopTimer(botKey) {
  if (timers[botKey]) { clearInterval(timers[botKey]); delete timers[botKey]; }
  bots[botKey].active = false;
  bots[botKey].status = "stopped";
}

// ═══ ADMIN ROUTES ═══
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
      forwardCount: bots[key].forwardCount,
    };
  });
  res.json(status);
});

app.post("/admin/bots/:key/start", adminAuth, (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  bots[key].active = true;
  startTimer(key);
  res.json({ success: true, message: `${bots[key].name} started` });
});

app.post("/admin/bots/:key/stop", adminAuth, (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  stopTimer(key);
  res.json({ success: true, message: `${bots[key].name} stopped` });
});

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

app.post("/admin/bots/:key/forward", adminAuth, async (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  await runBot(key);
  res.json({ success: true, message: "Forwarded!" });
});

app.get("/admin/mainbot/stats", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/stats`, { headers: { "x-admin-token": MAIN_BOT_ADMIN } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/mainbot/announcement", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/announcement`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": MAIN_BOT_ADMIN },
      body: JSON.stringify(req.body),
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/mainbot/ads/toggle", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/ads/toggle`, {
      method: "POST",
      headers: { "x-admin-token": MAIN_BOT_ADMIN },
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/admin/mainbot/videos/:id", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/videos/${req.params.id}`, {
      method: "DELETE",
      headers: { "x-admin-token": MAIN_BOT_ADMIN },
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/mainbot/settings", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/settings`, { headers: { "x-admin-token": MAIN_BOT_ADMIN } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (req, res) => res.json({ status: "ok", message: "All bots running 🚀" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 All bots + Admin API on port ${PORT}`);
  await loadForwardedIds();
  startTimer("bot1");
  startTimer("bot2");
});
