require("dotenv").config();
const fetch = require("node-fetch");
const express = require("express");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
app.use(express.json());

const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const ADMIN_SECRET = process.env.ADMIN_SECRET || "Mbuki@2030.";
const MAIN_BOT_URL = process.env.MAIN_BOT_URL || "https://video-app-bot-production.up.railway.app";
const MAIN_BOT_ADMIN = process.env.MAIN_BOT_ADMIN || "Mbuki@2030.";

// ─── Named destinations (Telegram channels → website communities) ──────────
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

const FOXY_ROUTE_KEYS = ["foxy_haul", "foxy_trans", "foxy_haul2"];

function destinationFor(chatId) {
  return DESTINATIONS.find((d) => String(d.chatId) === String(chatId)) || null;
}
function destinationByKey(key) {
  return DESTINATIONS.find((d) => d.key === key) || null;
}

// Per-bot already-processed message ids (persisted in bot_state).
const forwardedSets = {};

// ─── Bot roster ────────────────────────────────────────────────────────────
// ORIGINAL bots (bot1 / bot2) — restored. Do not rename or repurpose them.
// NEW bots are added BELOW so the admin dashboard lists them under the old ones.
//
// bot1  Femboys → Haul          (BOT1_TOKEN / SOURCE1_ID / DEST1_ID)
// bot2  HaulTransparent → Haul2 (BOT2_TOKEN / SOURCE2_ID / DEST2_ID)
// bot3  foxyalexxbot            → Femboys/Trans/Trending (route chips)
// bot4  linkbot (XLinkfetch)    → Wetlooks
// bot5  maitwerkingbot          → Cloudflare R2 (foxxyalexonline), not TG forward

const bots = {
  // ── ORIGINAL (restored) ───────────────────────────────────────────────
  bot1: {
    name: "Femboys → Haul",
    token: process.env.BOT1_TOKEN,
    sourceId: process.env.SOURCE1_ID,
    destId: process.env.DEST1_ID,
    mode: "forward",
    active: true,
    interval: 10,
    lastForwarded: null,
    status: "idle",
    forwardCount: 0,
    lastUpdateId: 0,
    videoPool: [],
    lastError: null,
  },
  bot2: {
    name: "HaulTransparent → Haul2",
    token: process.env.BOT2_TOKEN,
    sourceId: process.env.SOURCE2_ID,
    destId: process.env.DEST2_ID,
    mode: "forward",
    active: true,
    interval: 10,
    lastForwarded: null,
    status: "idle",
    forwardCount: 0,
    lastUpdateId: 0,
    videoPool: [],
    lastError: null,
  },

  // ── NEW: foxyalexxbot ─────────────────────────────────────────────────
  // Destination communities (Femboys / Trans / Trending). Source is a content
  // channel (FOXY_SOURCE_ID). Route chips let admin re-point dest.
  bot3: {
    name: "foxyalexxbot → Foxy (Femboys/Trans/Trending)",
    token: process.env.FOXYALEXX_BOT_TOKEN || process.env.BOT3_TOKEN,
    // Source channels (user-specified): Trending, Trans, Femboys
    sourceId:
      process.env.FOXY_SOURCE_ID ||
      process.env.SOURCE3_ID ||
      "-1003581577500,-1003906532971,-1002932798127",
    // Default dest = Femboys; admin can re-route to Trans / Trending
    destId: process.env.FOXY_DEST_ID || destinationByKey("foxy_haul").chatId,
    routeKeys: FOXY_ROUTE_KEYS,
    mode: "forward",
    active: true,
    interval: 5,
    lastForwarded: null,
    status: "idle",
    forwardCount: 0,
    lastUpdateId: 0,
    videoPool: [],
    lastError: null,
  },

  // ── NEW: linkbot (XLinkfetchbot) → Wetlooks ───────────────────────────
  // Source channel -1003823166195 (wetlooks) as specified; dest defaults to
  // the same wetlooks community channel unless LINK_DEST_ID is set.
  bot4: {
    name: "linkbot → Wetlooks",
    token: process.env.LINKBOT_TOKEN || process.env.XLINKFETCH_BOT_TOKEN || process.env.BOT4_TOKEN,
    sourceId: process.env.LINK_SOURCE_ID || "-1003823166195",
    destId: process.env.LINK_DEST_ID || destinationByKey("mai_wetlooks").chatId,
    routeKeys: ["mai_wetlooks"],
    mode: "forward",
    active: true,
    interval: 5,
    lastForwarded: null,
    status: "idle",
    forwardCount: 0,
    lastUpdateId: 0,
    videoPool: [],
    lastError: null,
  },

  // ── NEW: maitwerkingbot → Cloudflare R2 (S3) ──────────────────────────
  // Downloads videos from Telegram source and uploads to R2 bucket
  // foxxyalexonline. Does NOT copyMessage to a Telegram dest.
  bot5: {
    name: "maitwerkingbot → R2 (foxxyalexonline)",
    token: process.env.MAITWERKING_BOT_TOKEN || process.env.BOT5_TOKEN,
    sourceId: process.env.MAITWERKING_SOURCE_ID || "-1003568502743",
    destId: null,
    mode: "r2",
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

// Ensure a Set exists for every bot key.
Object.keys(bots).forEach((k) => {
  forwardedSets[k] = new Set();
});

const timers = {};

// ─── R2 (S3-compatible) for maitwerkingbot ────────────────────────────────
// Endpoint: https://<account>.r2.cloudflarestorage.com  Bucket: foxxyalexonline
// Credentials MUST come from env in production — defaults only for local boot.
const R2_ACCOUNT_ID =
  process.env.R2_ACCOUNT_ID || "4c974536c3152a9cee7dec2ddf09ecf1";
const R2_BUCKET = process.env.R2_BUCKET || "foxxyalexonline";
const R2_ACCESS_KEY_ID =
  process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY =
  process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "";
const R2_PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || "").replace(/\/+$/, "");

let r2Client = null;
function getR2() {
  if (r2Client) return r2Client;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.warn("⚠️ R2 credentials missing — set R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY");
    return null;
  }
  r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  return r2Client;
}

async function uploadToR2(key, buffer, contentType) {
  const client = getR2();
  if (!client) throw new Error("R2 client not configured");
  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || "video/mp4",
    })
  );
  if (R2_PUBLIC_BASE) return `${R2_PUBLIC_BASE}/${key.split("/").map(encodeURIComponent).join("/")}`;
  // Private bucket — return s3-style path for logging.
  return `r2://${R2_BUCKET}/${key}`;
}

// ─── Persistence ──────────────────────────────────────────────────────────
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

async function ensureLongPolling(bot) {
  if (!bot.token || bot._webhookCleared) return;
  const r = await tgApi(bot.token, "deleteWebhook", { drop_pending_updates: false });
  if (r.ok) {
    bot._webhookCleared = true;
    console.log(`🔓 ${bot.name} — webhook cleared (long-polling ready)`);
  } else {
    console.warn(`⚠️ ${bot.name} — deleteWebhook: ${r.description || "failed"}`);
  }
}

// Collect videos. sourceId may be a single id or comma-separated list
// (foxyalexxbot can watch multiple content channels if configured that way).
async function collectVideos(bot, botKey) {
  console.log(`📥 ${bot.name} — collecting videos...`);
  if (!bot.token) {
    bot.lastError = "token missing";
    return;
  }
  if (!bot.sourceId) {
    bot.lastError = "sourceId missing";
    return;
  }

  await ensureLongPolling(bot);

  const sources = String(bot.sourceId)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

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
    if (!sources.includes(String(post.chat.id))) continue;
    if (!post.video && !post.document) continue;
    if (post.document && !(post.document.mime_type || "").startsWith("video/")) continue;

    const fileId = post.video?.file_id || post.document?.file_id;
    const msgId = post.message_id;
    if (!bot.videoPool.find((v) => v.messageId === msgId && String(v.chatId) === String(post.chat.id))) {
      bot.videoPool.push({
        messageId: msgId,
        chatId: String(post.chat.id),
        caption: post.caption || "",
        fileId,
        mimeType: post.video?.mime_type || post.document?.mime_type || "video/mp4",
        fileName: post.document?.file_name || `video_${msgId}.mp4`,
      });
      newVideos++;
    }
  }
  console.log(`✅ ${bot.name} — collected ${newVideos} new. Pool: ${bot.videoPool.length}`);
  bot.lastError = null;
  await saveBotState(botKey);
}

async function downloadTelegramFile(botToken, fileId) {
  const info = await tgApi(botToken, "getFile", { file_id: fileId });
  if (!info.ok || !info.result?.file_path) throw new Error(info.description || "getFile failed");
  const url = `https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const ab = await r.arrayBuffer();
  return { buffer: Buffer.from(ab), path: info.result.file_path };
}

async function processBot(botKey) {
  const bot = bots[botKey];
  if (!bot || !bot.active) return;
  const forwardedSet = forwardedSets[botKey] || (forwardedSets[botKey] = new Set());

  bot.status = "running";
  await collectVideos(bot, botKey);

  if (bot.videoPool.length === 0) {
    bot.status = "idle";
    bot.lastError = bot.lastError || "video pool empty — is the bot admin in the SOURCE channel?";
    return;
  }

  const unforwarded = bot.videoPool.filter(
    (v) => !forwardedSet.has(`${v.chatId || bot.sourceId}:${v.messageId}`)
  );
  if (unforwarded.length === 0) {
    bot.status = "idle";
    bot.lastError = null;
    console.log(`✅ ${bot.name} — pool fully processed (${bot.videoPool.length})`);
    return;
  }
  const pick = unforwarded[Math.floor(Math.random() * unforwarded.length)];
  const pickKey = `${pick.chatId || bot.sourceId}:${pick.messageId}`;

  // ── R2 upload path (maitwerkingbot) ───────────────────────────────────
  if (bot.mode === "r2") {
    try {
      if (!pick.fileId) throw new Error("no file_id on pool item");
      console.log(`☁️  ${bot.name} — downloading ${pick.messageId} for R2`);
      const { buffer, path: tgPath } = await downloadTelegramFile(bot.token, pick.fileId);
      const ext = (tgPath.split(".").pop() || "mp4").replace(/[^a-z0-9]/gi, "") || "mp4";
      const key = `maitwerkingbot/${new Date().toISOString().slice(0, 10)}/${pick.messageId}.${ext}`;
      const publicUrl = await uploadToR2(key, buffer, pick.mimeType || "video/mp4");
      forwardedSet.add(pickKey);
      await saveBotState(botKey);
      bot.lastForwarded = new Date().toISOString();
      bot.status = "idle";
      bot.forwardCount++;
      bot.lastError = null;
      bot.lastUploadUrl = publicUrl;
      console.log(`✅ ${bot.name} — uploaded ${key} → ${publicUrl}`);
    } catch (e) {
      bot.status = "error";
      bot.lastError = e.message || "R2 upload failed";
      console.log(`❌ ${bot.name} — R2: ${bot.lastError}`);
    }
    return;
  }

  // ── Telegram forward path ─────────────────────────────────────────────
  if (!bot.destId) {
    bot.status = "error";
    bot.lastError = "destId missing";
    return;
  }

  console.log(`📤 ${bot.name} — copy ${pick.messageId} → ${bot.destId}`);
  const result = await tgApi(bot.token, "copyMessage", {
    chat_id: bot.destId,
    from_chat_id: pick.chatId || bot.sourceId,
    message_id: pick.messageId,
  });

  if (result.ok) {
    forwardedSet.add(pickKey);
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
  processBot(botKey);
  const ms = Math.max(1, Number(bots[botKey].interval) || 5) * 60 * 1000;
  timers[botKey] = setInterval(() => processBot(botKey), ms);
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
  // Stable order: bot1…bot5 so originals stay on top in the dashboard.
  Object.keys(bots)
    .sort()
    .forEach((key) => {
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
        mode: bot.mode || "forward",
        active: bot.active,
        status: bot.status,
        interval: bot.interval,
        sourceId: bot.sourceId,
        destId: bot.destId,
        destination: dest,
        routeKeys: bot.routeKeys || [],
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
        lastUploadUrl: bot.lastUploadUrl || null,
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

  if (destKey) {
    const dest = destinationByKey(destKey);
    if (!dest) return res.status(400).json({ error: "Unknown destination: " + destKey });
    bots[key].destId = dest.chatId;
  } else if (destId !== undefined) {
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
      mode: bots[key].mode,
    },
  });
});

app.post("/admin/bots/:key/route", adminAuth, async (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: "Bot not found" });
  if (bots[key].mode === "r2") {
    return res.status(400).json({ error: "R2 upload bots have no Telegram destination to route" });
  }
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
  const wasActive = bots[key].active;
  bots[key].active = true;
  await processBot(key);
  bots[key].active = wasActive;
  res.json({
    success: bots[key].status !== "error",
    message: bots[key].lastError
      ? `Attempt: ${bots[key].lastError}`
      : bots[key].mode === "r2"
        ? `Uploaded! ${bots[key].lastUploadUrl || ""}`
        : "Forwarded!",
    lastError: bots[key].lastError,
    lastUploadUrl: bots[key].lastUploadUrl || null,
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

app.get("/", (req, res) =>
  res.json({
    status: "ok",
    message: "Forwarding bots running 🚀",
    bots: Object.keys(bots)
      .sort()
      .map((k) => ({
        key: k,
        name: bots[k].name,
        mode: bots[k].mode,
        interval: bots[k].interval,
        active: bots[k].active,
      })),
  })
);

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Forwarding bots on port ${PORT}`);
  await loadBotState();
  await loadBotConfig();

  Object.keys(bots).forEach((k) => {
    if (!bots[k].interval || bots[k].interval < 1) bots[k].interval = bots[k].mode === "forward" && (k === "bot1" || k === "bot2") ? 10 : 5;
  });

  for (const key of Object.keys(bots).sort()) {
    if (!bots[key].token) {
      console.warn(`⚠️ ${bots[key].name} — token missing`);
      bots[key].active = false;
      bots[key].status = "error";
      bots[key].lastError = "token missing";
      continue;
    }
    if (bots[key].mode === "r2" && !getR2()) {
      console.warn(`⚠️ ${bots[key].name} — R2 not configured (set R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)`);
      bots[key].lastError = "R2 credentials missing";
    }
    startTimer(key);
  }
});
