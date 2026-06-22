require("dotenv").config();
const fetch = require("node-fetch");
const express = require("express");

const app = express();
app.use(express.json());

const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const ADMIN_SECRET = process.env.ADMIN_SECRET || "Mbuki@2030.";
const MAIN_BOT_URL = process.env.MAIN_BOT_URL || "https://video-app-bot-production.up.railway.app";
const MAIN_BOT_ADMIN = process.env.MAIN_BOT_ADMIN || "Mbuki@2030.";

// Simple in-memory tracking (Railway persists between requests, not restarts)
const forwarded1 = new Set();
const forwarded2 = new Set();

const bots = {
  bot1: {
    name: "Femboys → Haul",
    token: process.env.BOT1_TOKEN,
    sourceId: process.env.SOURCE1_ID,
    destId: process.env.DEST1_ID,
    active: true,
    interval: 10,
    lastForwarded: null,
    status: "idle",
    forwardCount: 0,
    lastUpdateId: 0,
    videoPool: [],
  },
  bot2: {
    name: "HaulTransparent → Haul2",
    token: process.env.BOT2_TOKEN,
    sourceId: process.env.SOURCE2_ID,
    destId: process.env.DEST2_ID,
    active: true,
    interval: 10,
    lastForwarded: null,
    status: "idle",
    forwardCount: 0,
    lastUpdateId: 0,
    videoPool: [],
  },
};

const timers = {};

async function loadBotState() {
  try {
    const { data } = await supabase.from("bot_state").select("*");
    if (data) {
      data.forEach(row => {
        if (bots[row.bot_key]) {
          bots[row.bot_key].lastUpdateId = row.last_update_id || 0;
        }
        if (row.bot_key === "bot1" && row.forwarded_ids) {
          row.forwarded_ids.forEach(id => forwarded1.add(String(id)));
        }
        if (row.bot_key === "bot2" && row.forwarded_ids) {
          row.forwarded_ids.forEach(id => forwarded2.add(String(id)));
        }
      });
      console.log("📋 Loaded bot state from Supabase");
    }
  } catch (e) { console.error("Load state error:", e.message); }
}

async function saveBotState(botKey) {
  try {
    const forwardedSet = botKey === "bot1" ? forwarded1 : forwarded2;
    await supabase.from("bot_state").upsert({
      bot_key: botKey,
      last_update_id: bots[botKey].lastUpdateId,
      forwarded_ids: [...forwardedSet],
    }, { onConflict: "bot_key" });
  } catch (e) { console.error("Save state error:", e.message); }
}

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function tgApi(token, method, body = {}) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) console.log(`❌ ${method} failed: ${data.description}`);
    return data;
  } catch (e) {
    console.log(`❌ ${method} error: ${e.message}`);
    return { ok: false };
  }
}

// Collect videos from channel updates
async function collectVideos(bot) {
  console.log(`📥 ${bot.name} — collecting videos from updates...`);
  const data = await tgApi(bot.token, "getUpdates", {
    offset: bot.lastUpdateId + 1,
    limit: 100,
    allowed_updates: ["channel_post"],
  });

  if (!data.ok || !data.result?.length) {
    console.log(`📭 ${bot.name} — no new updates`);
    return;
  }

  let newVideos = 0;
  for (const update of data.result) {
    bot.lastUpdateId = Math.max(bot.lastUpdateId, update.update_id);
    const post = update.channel_post;
    if (!post) continue;
    if (String(post.chat.id) !== String(bot.sourceId)) continue;
    if (!post.video) continue;
    const msgId = post.message_id;
    if (!bot.videoPool.find(v => v.messageId === msgId)) {
      bot.videoPool.push({ messageId: msgId, caption: post.caption || "" });
      newVideos++;
    }
  }
  console.log(`✅ ${bot.name} — collected ${newVideos} new videos. Pool: ${bot.videoPool.length}`);
  const botKey = bot === bots.bot1 ? "bot1" : "bot2";
  await saveBotState(botKey);
}

async function forwardVideo(botKey) {
  const bot = bots[botKey];
  if (!bot.active) return;
  const forwardedSet = botKey === "bot1" ? forwarded1 : forwarded2;

  bot.status = "running";

  // First collect any new videos
  await collectVideos(bot);

  if (bot.videoPool.length === 0) {
    bot.status = "idle";
    console.log(`⚠️ ${bot.name} — video pool empty`);
    return;
  }

  // Pick unforwarded video
  const unforwarded = bot.videoPool.filter(v => !forwardedSet.has(String(v.messageId)));
  const pool = unforwarded.length > 0 ? unforwarded : bot.videoPool;
  const pick = pool[Math.floor(Math.random() * pool.length)];

  console.log(`📤 ${bot.name} — copying message ${pick.messageId}`);
  const result = await tgApi(bot.token, "copyMessage", {
    chat_id: bot.destId,
    from_chat_id: bot.sourceId,
    message_id: pick.messageId,
  });

  if (result.ok) {
    forwardedSet.add(String(pick.messageId));
    await saveBotState(botKey);
    bot.lastForwarded = new Date().toISOString();
    bot.status = "idle";
    bot.forwardCount++;
    console.log(`✅ ${bot.name} — forwarded! Total: ${bot.forwardCount}`);
  } else {
    bot.status = "error";
    console.log(`❌ ${bot.name} — copy failed: ${result.description}`);
  }
}

function startTimer(botKey) {
  if (timers[botKey]) clearInterval(timers[botKey]);
  forwardVideo(botKey);
  timers[botKey] = setInterval(() => forwardVideo(botKey), bots[botKey].interval * 60 * 1000);
  console.log(`⏰ ${bots[botKey].name} — every ${bots[botKey].interval} mins`);
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
      poolSize: bots[key].videoPool.length,
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
  res.json({ success: true });
});

app.post("/admin/bots/:key/forward", adminAuth, async (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  await forwardVideo(key);
  res.json({ success: true, message: "Forwarded!" });
});

app.post("/admin/bots/:key/collect", adminAuth, async (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  await collectVideos(bots[key]);
  res.json({ success: true, poolSize: bots[key].videoPool.length });
});

app.get("/admin/mainbot/stats", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/stats`, { headers: { "x-admin-token": MAIN_BOT_ADMIN } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/mainbot/ads/toggle", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/ads/toggle`, { method: "POST", headers: { "x-admin-token": MAIN_BOT_ADMIN } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/admin/mainbot/videos/:id", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/videos/${req.params.id}`, { method: "DELETE", headers: { "x-admin-token": MAIN_BOT_ADMIN } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (req, res) => res.json({ status: "ok", message: "Forwarding bots running 🚀" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Forwarding bots on port ${PORT}`);
  await loadBotState();
  startTimer("bot1");
  startTimer("bot2");
});
