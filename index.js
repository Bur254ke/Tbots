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

// ─── Named destinations ────────────────────────────────────────────────────
// Destination is a Telegram CHANNEL. The MAIN video-app-bot maps chat id →
// community in communities.js, so these ids must stay in sync:
//   -1002932798127 → haul   (Femboys)
//   -1003906532971 → trans  (Trans)
//   -1003581577500 → haul2  (Trending)
//   -1003823166195 → wetlooks
const DESTINATIONS = [
  // Foxy Alexx
  { key: "foxy_haul", site: "Foxy", community: "haul", label: "Femboys", chatId: "-1002932798127" },
  { key: "foxy_trans", site: "Foxy", community: "trans", label: "Trans", chatId: "-1003906532971" },
  { key: "foxy_haul2", site: "Foxy", community: "haul2", label: "Trending", chatId: "-1003581577500" },
  // Twerking Mai
  { key: "mai_maitwerking", site: "Mai", community: "maitwerking", label: "Mai: Mai Twerking", chatId: "-1003870438959" },
  { key: "mai_maitrending", site: "Mai", community: "maitrending", label: "Mai: Trending", chatId: "-1003859771687" },
  { key: "mai_wetlooks", site: "Mai", community: "wetlooks", label: "Wetlooks", chatId: "-1003823166195" },
];

// Quick-route chips shown under Forward for the Foxy bot (admin UI).
const FOXY_ROUTE_KEYS = ["foxy_haul", "foxy_trans", "foxy_haul2"];

function destinationFor(chatId) {
  return DESTINATIONS.find((d) => String(d.chatId) === String(chatId)) || null;
}

function destinationByKey(key) {
  return DESTINATIONS.find((d) => d.key === key) || null;
}

// Per-bot set of already-forwarded source message ids (persisted in bot_state).
const forwardedSets = {
  bot1: new Set(),
  bot2: new Set(),
};

// bot1 = foxyalexxbot → Foxy Alexx (Femboys / Trans / Trending), every 5 min
// bot2 = XLinkfetchbot → Mai Wetlooks, every 5 min
// Tokens/source/dest come from env (Railway Tbots service). Optional aliases
// FOXYALEXX_BOT_TOKEN / XLINKFETCH_BOT_TOKEN accepted for clarity.
const bots = {
  bot1: {
    name: "foxyalexxbot → Foxy Alexx",
    token: process.env.BOT1_TOKEN || process.env.FOXYALEXX_BOT_TOKEN,
    sourceId: process.env.SOURCE1_ID,
    destId: process.env.DEST1_ID || destinationByKey("foxy_haul").chatId,
    // Restrict the admin quick-picker to Foxy communities.
    routeKeys: FOXY_ROUTE_KEYS,
    active: true,
    interval: 5,
    lastForwarded: null,
    status: "idle",
    forwardCount: 0,
    lastUpdateId: 0,
    videoPool: [],
    lastError: null,
  },
  bot2: {
    name: "XLinkfetchbot → Wetlooks",
    token: process.env.BOT2_TOKEN || process.env.XLINKFETCH_BOT_TOKEN,
    sourceId: process.env.SOURCE2_ID,
    destId: process.env.DEST2_ID || destinationByKey("mai_wetlooks").chatId,
    // Wetlooks is fixed; still allow full list if they open Edit.
    routeKeys: ["mai_wetlooks"],
    active: true,
    interval: 5,
    lastForwarded: null,
    status: "idle",
    forwardCount: 0,
    lastUpdateId: 0,
    videoPool: [],
    lastError: null,
  },
};

const timers = {};

async function loadBotState() {
  try {
    const { data } = await supabase.from("bot_state").select("*");
    if (data) {
      data.forEach((row) => {
        if (bots[row.bot_key]) {
          bots[row.bot_key].lastUpdateId = row.last_update_id || 0;
        }
        if (forwardedSets[row.bot_key] && Array.isArray(row.forwarded_ids)) {
          row.forwarded_ids.forEach((id) => forwardedSets[row.bot_key].add(String(id)));
        }
      });
      console.log("📋 Loaded bot state from Supabase");
    }
  } catch (e) {
    console.error("Load state error:", e.message);
  }
}

async function saveBotState(botKey) {
  try {
    const set = forwardedSets[botKey] || new Set();
    await supabase.from("bot_state").upsert(
      {
        bot_key: botKey,
        last_update_id: bots[botKey].lastUpdateId,
        forwarded_ids: [...set],
      },
      { onConflict: "bot_key" }
    );
  } catch (e) {
    console.error("Save state error:", e.message);
  }
}

// ─── Config persistence ───────────────────────────────────────────────────
// interval / destId / sourceId used to live only in memory, so every change
// made from the dashboard was lost on Railway restart. Stored in `settings`
// as bot_config_<key> JSON and re-applied on boot.
const CONFIG_FIELDS = ["interval", "destId", "sourceId"];

async function loadBotConfig() {
  try {
    const keys = Object.keys(bots).map((k) => "bot_config_" + k);
    const { data } = await supabase.from("settings").select("key, value").in("key", keys);
    (data || []).forEach((row) => {
      const botKey = row.key.replace("bot_config_", "");
      if (!bots[botKey]) return;
      let cfg = {};
      try {
        cfg = JSON.parse(row.value || "{}");
      } catch (e) {
        return;
      }
      CONFIG_FIELDS.forEach((f) => {
        if (cfg[f] !== undefined && cfg[f] !== null && cfg[f] !== "") bots[botKey][f] = cfg[f];
      });
      if (cfg.interval) bots[botKey].interval = parseInt(cfg.interval, 10);
    });
    if (data && data.length) console.log("⚙️  Applied saved bot config");
  } catch (e) {
    console.error("Load config error:", e.message);
  }
}

async function saveBotConfig(botKey) {
  try {
    const cfg = {};
    CONFIG_FIELDS.forEach((f) => {
      cfg[f] = bots[botKey][f];
    });
    await supabase.from("settings").upsert(
      {
        key: "bot_config_" + botKey,
        value: JSON.stringify(cfg),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );
  } catch (e) {
    console.error("Save config error:", e.message);
  }
}

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function tgApi(token, method, body = {}) {
  if (!token) return { ok: false, description: "Bot token missing" };
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
    return { ok: false, description: e.message };
  }
}

// getUpdates and webhooks are mutually exclusive. Clear any webhook so the
// forwarding bots can poll channel posts from their source channels.
async function ensureLongPolling(bot) {
  if (!bot.token) return;
  if (bot._webhookCleared) return;
  const r = await tgApi(bot.token, "deleteWebhook", { drop_pending_updates: false });
  if (r.ok) {
    bot._webhookCleared = true;
    console.log(`🔓 ${bot.name} — webhook cleared (long-polling ready)`);
  } else {
    console.warn(`⚠️ ${bot.name} — deleteWebhook: ${r.description || "failed"}`);
  }
}

// Collect videos from source channel updates.
async function collectVideos(bot, botKey) {
  console.log(`📥 ${bot.name} — collecting videos from updates...`);
  if (!bot.token) {
    bot.lastError = "token missing";
    console.error(`❌ ${bot.name} — no token configured`);
    return;
  }
  if (!bot.sourceId) {
    bot.lastError = "sourceId missing";
    console.error(`❌ ${bot.name} — no SOURCE id configured`);
    return;
  }

  await ensureLongPolling(bot);

  const data = await tgApi(bot.token, "getUpdates", {
    offset: bot.lastUpdateId + 1,
    limit: 100,
    timeout: 0,
    allowed_updates: ["channel_post", "message"],
  });

  if (!data.ok) {
    bot.lastError = data.description || "getUpdates failed";
    console.log(`📭 ${bot.name} — getUpdates failed: ${bot.lastError}`);
    return;
  }
  if (!data.result?.length) {
    console.log(`📭 ${bot.name} — no new updates (pool: ${bot.videoPool.length})`);
    return;
  }

  let newVideos = 0;
  for (const update of data.result) {
    bot.lastUpdateId = Math.max(bot.lastUpdateId, update.update_id);
    const post = update.channel_post || update.message;
    if (!post) continue;
    if (String(post.chat.id) !== String(bot.sourceId)) continue;
    if (!post.video && !post.document) continue;
    // Prefer real videos; allow video documents (mp4) as a fallback.
    if (post.document && !(post.document.mime_type || "").startsWith("video/")) continue;
    const msgId = post.message_id;
    if (!bot.videoPool.find((v) => v.messageId === msgId)) {
      bot.videoPool.push({ messageId: msgId, caption: post.caption || "" });
      newVideos++;
    }
  }
  console.log(`✅ ${bot.name} — collected ${newVideos} new. Pool: ${bot.videoPool.length}`);
  bot.lastError = null;
  await saveBotState(botKey);
}

async function forwardVideo(botKey) {
  const bot = bots[botKey];
  if (!bot) return;
  if (!bot.active) return;
  const forwardedSet = forwardedSets[botKey] || (forwardedSets[botKey] = new Set());

  bot.status = "running";

  await collectVideos(bot, botKey);

  if (bot.videoPool.length === 0) {
    bot.status = "idle";
    bot.lastError = bot.lastError || "video pool empty — is the bot admin in the SOURCE channel?";
    console.log(`⚠️ ${bot.name} — video pool empty`);
    return;
  }

  // Forward each source video EXACTLY ONCE. When the pool is fully sent, idle
  // instead of recycling old content.
  const unforwarded = bot.videoPool.filter((v) => !forwardedSet.has(String(v.messageId)));
  if (unforwarded.length === 0) {
    bot.status = "idle";
    bot.lastError = null;
    console.log(`✅ ${bot.name} — all ${bot.videoPool.length} pooled videos already forwarded`);
    return;
  }
  const pick = unforwarded[Math.floor(Math.random() * unforwarded.length)];

  if (!bot.destId) {
    bot.status = "error";
    bot.lastError = "destId missing";
    console.error(`❌ ${bot.name} — no destination configured`);
    return;
  }

  console.log(`📤 ${bot.name} — copy ${pick.messageId} → ${bot.destId}`);
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
    bot.lastError = null;
    console.log(`✅ ${bot.name} — forwarded! Total: ${bot.forwardCount}`);
  } else {
    bot.status = "error";
    bot.lastError = result.description || "copyMessage failed";
    console.log(`❌ ${bot.name} — copy failed: ${bot.lastError}`);
  }
}

function startTimer(botKey) {
  if (!bots[botKey]) return;
  if (timers[botKey]) clearInterval(timers[botKey]);
  bots[botKey].active = true;
  // Fire once immediately, then on the interval.
  forwardVideo(botKey);
  const ms = Math.max(1, Number(bots[botKey].interval) || 5) * 60 * 1000;
  timers[botKey] = setInterval(() => forwardVideo(botKey), ms);
  console.log(`⏰ ${bots[botKey].name} — every ${bots[botKey].interval} mins`);
}

function stopTimer(botKey) {
  if (timers[botKey]) {
    clearInterval(timers[botKey]);
    delete timers[botKey];
  }
  if (bots[botKey]) {
    bots[botKey].active = false;
    bots[botKey].status = "stopped";
  }
}

// ═══ ADMIN ROUTES ═══
app.get("/admin/bots", adminAuth, (req, res) => {
  const status = {};
  Object.keys(bots).forEach((key) => {
    const bot = bots[key];
    const minutesSinceLastForward = bot.lastForwarded
      ? Math.round((Date.now() - new Date(bot.lastForwarded).getTime()) / 60000)
      : null;
    const stale =
      bot.active &&
      (minutesSinceLastForward === null
        ? bot.forwardCount === 0
        : minutesSinceLastForward > bot.interval * 2);
    const dest = destinationFor(bot.destId);
    status[key] = {
      name: bot.name,
      active: bot.active,
      status: bot.status,
      interval: bot.interval,
      sourceId: bot.sourceId,
      destId: bot.destId,
      destination: dest,
      routeKeys: bot.routeKeys || [],
      // Convenience for the Foxy community picker.
      routes: (bot.routeKeys || [])
        .map((k) => destinationByKey(k))
        .filter(Boolean)
        .map(({ key: k, label, community, chatId }) => ({ key: k, label, community, chatId })),
      lastForwarded: bot.lastForwarded,
      forwardCount: bot.forwardCount,
      poolSize: bot.videoPool.length,
      minutesSinceLastForward,
      stale,
      poolExhausted: bot.videoPool.length === 0,
      lastError: bot.lastError,
      hasToken: Boolean(bot.token),
    };
  });
  res.json(status);
});

app.post("/admin/bots/:key/start", adminAuth, (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  startTimer(key);
  res.json({ success: true, message: `${bots[key].name} started` });
});

app.post("/admin/bots/:key/stop", adminAuth, (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  stopTimer(key);
  res.json({ success: true, message: `${bots[key].name} stopped` });
});

app.post("/admin/bots/:key/config", adminAuth, async (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  const { sourceId, destId, destKey, interval, token } = req.body;

  // destKey is the named form ("foxy_haul"); destId stays for raw chat ids.
  if (destKey) {
    const dest = destinationByKey(destKey);
    if (!dest) return res.status(400).json({ error: "Unknown destination: " + destKey });
    bots[key].destId = dest.chatId;
  } else if (destId) {
    bots[key].destId = destId;
  }

  if (sourceId) bots[key].sourceId = sourceId;

  if (interval !== undefined && interval !== null && interval !== "") {
    const n = parseInt(interval, 10);
    if (!Number.isFinite(n) || n < 1) {
      return res.status(400).json({ error: "Interval must be a whole number of minutes, 1 or more" });
    }
    bots[key].interval = n;
  }

  // Token is NOT persisted — belongs in env.
  if (token) bots[key].token = token;

  await saveBotConfig(key);
  if (bots[key].active) startTimer(key);
  res.json({
    success: true,
    config: {
      interval: bots[key].interval,
      destId: bots[key].destId,
      sourceId: bots[key].sourceId,
      destination: destinationFor(bots[key].destId),
    },
  });
});

// One-tap route change for the Foxy community chips under Forward.
app.post("/admin/bots/:key/route", adminAuth, async (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  const destKey = String(req.body?.destKey || "");
  const allowed = bots[key].routeKeys || [];
  if (allowed.length && !allowed.includes(destKey)) {
    return res.status(400).json({ error: "That route is not allowed for this bot" });
  }
  const dest = destinationByKey(destKey);
  if (!dest) return res.status(400).json({ error: "Unknown destination: " + destKey });
  bots[key].destId = dest.chatId;
  await saveBotConfig(key);
  res.json({
    success: true,
    destId: dest.chatId,
    destination: dest,
    message: `Rerouted to ${dest.label}`,
  });
});

app.get("/admin/destinations", adminAuth, (req, res) => {
  res.json({
    destinations: DESTINATIONS.map(({ key, site, community, label, chatId }) => ({
      key,
      site,
      community,
      label,
      chatId,
    })),
  });
});

app.post("/admin/bots/:key/forward", adminAuth, async (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  // Manual forward works even if the timer is stopped.
  const wasActive = bots[key].active;
  bots[key].active = true;
  await forwardVideo(key);
  bots[key].active = wasActive;
  res.json({
    success: bots[key].status !== "error",
    message: bots[key].lastError
      ? `Forward attempt: ${bots[key].lastError}`
      : "Forwarded!",
    lastError: bots[key].lastError,
    poolSize: bots[key].videoPool.length,
    forwardCount: bots[key].forwardCount,
  });
});

app.post("/admin/bots/:key/collect", adminAuth, async (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  await collectVideos(bots[key], key);
  res.json({
    success: true,
    poolSize: bots[key].videoPool.length,
    lastError: bots[key].lastError,
  });
});

app.get("/admin/mainbot/stats", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/stats`, {
      headers: { "x-admin-token": MAIN_BOT_ADMIN },
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/admin/mainbot/ads/toggle", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/ads/toggle`, {
      method: "POST",
      headers: { "x-admin-token": MAIN_BOT_ADMIN },
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/admin/mainbot/videos/:id", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/mainbot/videos/${req.params.id}`.replace(
      "/admin/mainbot/videos/",
      "/admin/videos/"
    ), {
      method: "DELETE",
      headers: { "x-admin-token": MAIN_BOT_ADMIN },
    });
    // Fix: hit the real main-bot path
  } catch (e) {
    /* fall through */
  }
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/videos/${req.params.id}`, {
      method: "DELETE",
      headers: { "x-admin-token": MAIN_BOT_ADMIN },
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (req, res) =>
  res.json({
    status: "ok",
    message: "Forwarding bots running 🚀",
    bots: Object.keys(bots).map((k) => ({
      key: k,
      name: bots[k].name,
      interval: bots[k].interval,
      active: bots[k].active,
    })),
  })
);

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Forwarding bots on port ${PORT}`);
  await loadBotState();
  // Saved interval/destination must be applied BEFORE the timers start, or the
  // first cycle after a restart runs on the env defaults instead.
  await loadBotConfig();

  // Default intervals to 5 if nothing was saved / env didn't set them.
  Object.keys(bots).forEach((k) => {
    if (!bots[k].interval || bots[k].interval < 1) bots[k].interval = 5;
  });

  // Heal stale saved destinations from the old Mai-only wiring so a restart
  // lands foxyalexxbot on a Foxy community and XLinkfetchbot on Wetlooks.
  const bot1Dest = destinationFor(bots.bot1.destId);
  if (!bot1Dest || bot1Dest.site !== "Foxy") {
    bots.bot1.destId = destinationByKey("foxy_haul").chatId;
    console.log("🔧 bot1 dest healed → Femboys (haul)");
    await saveBotConfig("bot1");
  }
  const bot2Dest = destinationFor(bots.bot2.destId);
  if (!bot2Dest || bot2Dest.community !== "wetlooks") {
    bots.bot2.destId = destinationByKey("mai_wetlooks").chatId;
    console.log("🔧 bot2 dest healed → Wetlooks");
    await saveBotConfig("bot2");
  }

  for (const key of Object.keys(bots)) {
    if (!bots[key].token) {
      console.warn(`⚠️ ${bots[key].name} — token missing (set BOT1_TOKEN / BOT2_TOKEN)`);
      bots[key].active = false;
      bots[key].status = "error";
      bots[key].lastError = "token missing";
      continue;
    }
    startTimer(key);
  }
});
