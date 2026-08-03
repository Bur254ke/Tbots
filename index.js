require(\"dotenv\").config();
const fetch = require(\"node-fetch\");
const express = require(\"express\");

const app = express();
app.use(express.json());

const { createClient } = require(\"@supabase/supabase-js\");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const ADMIN_SECRET = process.env.ADMIN_SECRET || \"Mbuki@2030.\";
const MAIN_BOT_URL = process.env.MAIN_BOT_URL || \"https://video-app-bot-production.up.railway.app\";
const MAIN_BOT_ADMIN = process.env.MAIN_BOT_ADMIN || \"Mbuki@2030.\";

// Simple in-memory tracking (Railway persists between requests, not restarts)
const forwarded1 = new Set();
const forwarded2 = new Set();

const bots = {
  bot1: {
    name: \"Femboys → Haul\",
    token: process.env.BOT1_TOKEN,
    sourceId: process.env.SOURCE1_ID,
    destId: process.env.DEST1_ID,
    active: true,
    interval: 10,
    lastForwarded: null,
    status: \"idle\",
    forwardCount: 0,
    lastUpdateId: 0,
    videoPool: [],
  },
  bot2: {
    name: \"HaulTransparent → Haul2\",
    token: process.env.BOT2_TOKEN,
    sourceId: process.env.SOURCE2_ID,
    destId: process.env.DEST2_ID,
    active: true,
    interval: 10,
    lastForwarded: null,
    status: \"idle\",
    forwardCount: 0,
    lastUpdateId: 0,
    videoPool: [],
  },
};

const timers = {};

async function loadBotState() {
  try {
    const { data } = await supabase.from(\"bot_state\").select(\"*\");
    if (data) {
      data.forEach(row => {
        if (bots[row.bot_key]) {
          bots[row.bot_key].lastUpdateId = row.last_update_id || 0;
        }
        if (row.bot_key === \"bot1\" && row.forwarded_ids) {
          row.forwarded_ids.forEach(id => forwarded1.add(String(id)));
        }
        if (row.bot_key === \"bot2\" && row.forwarded_ids) {
          row.forwarded_ids.forEach(id => forwarded2.add(String(id)));
        }
      });
      console.log(\"📋 Loaded bot state from Supabase\");
    }
  } catch (e) { console.error(\"Load state error:\", e.message); }
}

async function saveBotState(botKey) {
  try {
    const forwardedSet = botKey === \"bot1\" ? forwarded1 : forwarded2;
    await supabase.from(\"bot_state\").upsert({
      bot_key: botKey,
      last_update_id: bots[botKey].lastUpdateId,
      forwarded_ids: [...forwardedSet],
    }, { onConflict: \"bot_key\" });
  } catch (e) { console.error(\"Save state error:\", e.message); }
}


// ─── Named forwarding destinations (2026-07-28) ───────────────────────────
// The dashboard used to require a raw Telegram chat id to change where a bot
// forwards. These are the same channels, addressable by name.
//
// A destination is a Telegram CHANNEL. Which community a video lands in is then
// decided by the MAIN bot's communities.js, which maps channel id → community —
// so a name here is only meaningful if that channel is present in that map. The
// two below are the ones currently mapped:
//   -1003870438959 → maitwerking
//   -1003859771687 → maitrending
//
// To offer \"Foxy: haul / trans / haul2\" or \"Mai: wetlooks\" you need a Telegram
// channel per community AND a matching line in the main bot's communities.js.
// Those channels do not exist yet — the two haul channels were rewired to Mai on
// 2026-07-16 — so add the ids to DESTINATIONS and to communities.js together.
// Forwarding to a channel that is not in that map makes the main bot log
// \"Unknown channel\" and silently drop every video.
const DESTINATIONS = [
  // Twerking Mai
  { key: \"mai_maitwerking\", site: \"Mai\", community: \"maitwerking\", label: \"Mai: Mai Twerking\", chatId: \"-1003870438959\" },
  { key: \"mai_maitrending\", site: \"Mai\", community: \"maitrending\", label: \"Mai: Trending\", chatId: \"-1003859771687\" },
  { key: \"mai_wetlooks\", site: \"Mai\", community: \"wetlooks\", label: \"Mai: Wet Looks\", chatId: \"-1003823166195\" },
  // Foxy Alexx
  { key: \"foxy_haul\", site: \"Foxy\", community: \"haul\", label: \"Foxy: Femboys\", chatId: \"-1002932798127\" },
  { key: \"foxy_trans\", site: \"Foxy\", community: \"trans\", label: \"Foxy: Trans\", chatId: \"-1003906532971\" },
  { key: \"foxy_haul2\", site: \"Foxy\", community: \"haul2\", label: \"Foxy: Trending\", chatId: \"-1003581577500\" },
  // Add when the channels exist (and are in communities.js):
  // { key: \"foxy_haul\",  site: \"Foxy\", community: \"haul\",  label: \"Foxy: Femboys\",  chatId: \"-100…\" },
  // { key: \"foxy_trans\", site: \"Foxy\", community: \"trans\", label: \"Foxy: Trans\",    chatId: \"-100…\" },
  // { key: \"foxy_haul2\", site: \"Foxy\", community: \"haul2\", label: \"Foxy: Trending\", chatId: \"-100…\" },
  // { key: \"mai_wetlooks\", site: \"Mai\", community: \"wetlooks\", label: \"Mai: Wet Looks\", chatId: \"-100…\" },
];

function destinationFor(chatId) {
  return DESTINATIONS.find((d) => String(d.chatId) === String(chatId)) || null;
}

// ─── Config persistence ───────────────────────────────────────────────────
// interval / destId / sourceId used to live only in the in-memory `bots` object,
// so every change made from the dashboard was lost the next time Railway
// restarted the service — the bot quietly reverted to its env defaults. Config is
// now stored in `settings` (key/value, already used by the main backend) as
// bot_config_<key> JSON, and re-applied on boot.
const CONFIG_FIELDS = [\"interval\", \"destId\", \"sourceId\"];

async function loadBotConfig() {
  try {
    const keys = Object.keys(bots).map((k) => \"bot_config_\" + k);
    const { data } = await supabase.from(\"settings\").select(\"key, value\").in(\"key\", keys);
    (data || []).forEach((row) => {
      const botKey = row.key.replace(\"bot_config_\", \"\");
      if (!bots[botKey]) return;
      let cfg = {};
      try { cfg = JSON.parse(row.value || \"{}\"); } catch (e) { return; }
      CONFIG_FIELDS.forEach((f) => {
        if (cfg[f] !== undefined && cfg[f] !== null && cfg[f] !== \"\") bots[botKey][f] = cfg[f];
      });
      if (cfg.interval) bots[botKey].interval = parseInt(cfg.interval, 10);
    });
    if (data && data.length) console.log(\"⚙️  Applied saved bot config\");
  } catch (e) { console.error(\"Load config error:\", e.message); }
}

async function saveBotConfig(botKey) {
  try {
    const cfg = {};
    CONFIG_FIELDS.forEach((f) => { cfg[f] = bots[botKey][f]; });
    await supabase.from(\"settings\").upsert(
      { key: \"bot_config_\" + botKey, value: JSON.stringify(cfg), updated_at: new Date().toISOString() },
      { onConflict: \"key\" }
    );
  } catch (e) { console.error(\"Save config error:\", e.message); }
}

function adminAuth(req, res, next) {
  const token = req.headers[\"x-admin-token\"];
  if (token !== ADMIN_SECRET) return res.status(401).json({ error: \"Unauthorized\" });
  next();
}

async function tgApi(token, method, body = {}) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: \"POST\",
      headers: { \"Content-Type\": \"application/json\" },
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
  const data = await tgApi(bot.token, \"getUpdates\", {
    offset: bot.lastUpdateId + 1,
    limit: 100,
    allowed_updates: [\"channel_post\"],
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
      bot.videoPool.push({ messageId: msgId, caption: post.caption || \"\" });
      newVideos++;
    }
  }
  console.log(`✅ ${bot.name} — collected ${newVideos} new videos. Pool: ${bot.videoPool.length}`);
  const botKey = bot === bots.bot1 ? \"bot1\" : \"bot2\";
  await saveBotState(botKey);
}

async function forwardVideo(botKey) {
  const bot = bots[botKey];
  if (!bot.active) return;
  const forwardedSet = botKey === \"bot1\" ? forwarded1 : forwarded2;

  bot.status = \"running\";

  // First collect any new videos
  await collectVideos(bot);

  if (bot.videoPool.length === 0) {
    bot.status = \"idle\";
    console.log(`⚠️ ${bot.name} — video pool empty`);
    return;
  }

  // Pick an unforwarded video. 2026-07-16: forward each source video EXACTLY
  // ONCE — when the pool is fully forwarded, go idle instead of recycling old
  // ones. The rewired channels feed maitwerking/maitrending only with NEW
  // content; the old backlog (already forwarded) is never re-sent.
  const unforwarded = bot.videoPool.filter(v => !forwardedSet.has(String(v.messageId)));
  if (unforwarded.length === 0) {
    bot.status = \"idle\";
    console.log(`✅ ${bot.name} — all ${bot.videoPool.length} pooled videos already forwarded; nothing new to send`);
    return;
  }
  const pick = unforwarded[Math.floor(Math.random() * unforwarded.length)];

  console.log(`📤 ${bot.name} — copying message ${pick.messageId}`);
  const result = await tgApi(bot.token, \"copyMessage\", {
    chat_id: bot.destId,
    from_chat_id: bot.sourceId,
    message_id: pick.messageId,
  });

  if (result.ok) {
    forwardedSet.add(String(pick.messageId));
    await saveBotState(botKey);
    bot.lastForwarded = new Date().toISOString();
    bot.status = \"idle\";
    bot.forwardCount++;
    console.log(`✅ ${bot.name} — forwarded! Total: ${bot.forwardCount}`);
  } else {
    bot.status = \"error\";
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
  bots[botKey].status = \"stopped\";
}

// ═══ ADMIN ROUTES ═══
app.get(\"/admin/bots\", adminAuth, (req, res) => {
  const status = {};
  Object.keys(bots).forEach(key => {
    const bot = bots[key];
    const minutesSinceLastForward = bot.lastForwarded
      ? Math.round((Date.now() - new Date(bot.lastForwarded).getTime()) / 60000)
      : null;
    // Active but silent for 2x its own interval (or never forwarded at all) = likely stuck/broken.
    const stale = bot.active && (
      minutesSinceLastForward === null ? bot.forwardCount === 0 : minutesSinceLastForward > bot.interval * 2
    );
    status[key] = {
      name: bot.name,
      active: bot.active,
      status: bot.status,
      interval: bot.interval,
      sourceId: bot.sourceId,
      destId: bot.destId,
      destination: destinationFor(bot.destId),
      lastForwarded: bot.lastForwarded,
      forwardCount: bot.forwardCount,
      poolSize: bot.videoPool.length,
      minutesSinceLastForward,
      stale,
      poolExhausted: bot.videoPool.length === 0,
    };
  });
  res.json(status);
});

app.post(\"/admin/bots/:key/start\", adminAuth, (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: \"Bot not found\" });
  bots[key].active = true;
  startTimer(key);
  res.json({ success: true, message: `${bots[key].name} started` });
});

app.post(\"/admin/bots/:key/stop\", adminAuth, (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: \"Bot not found\" });
  stopTimer(key);
  res.json({ success: true, message: `${bots[key].name} stopped` });
});

app.post(\"/admin/bots/:key/config\", adminAuth, async (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: \"Bot not found\" });
  const { sourceId, destId, destKey, interval, token } = req.body;

  // destKey is the named form (\"mai_maitrending\"); destId stays supported so an
  // older admin build keeps working.
  if (destKey) {
    const dest = DESTINATIONS.find((d) => d.key === destKey);
    if (!dest) return res.status(400).json({ error: \"Unknown destination: \" + destKey });
    bots[key].destId = dest.chatId;
  } else if (destId) {
    bots[key].destId = destId;
  }

  if (sourceId) bots[key].sourceId = sourceId;

  if (interval !== undefined && interval !== null && interval !== \"\") {
    const n = parseInt(interval, 10);
    // A zero or negative interval would make setInterval fire continuously and
    // flood the destination channel; 1 minute is the floor.
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: \"Interval must be a whole number of minutes, 1 or more\" });
    bots[key].interval = n;
  }

  // The token is NOT persisted — it is a bot credential and belongs in env.
  if (token) bots[key].token = token;

  await saveBotConfig(key);
  // Restart the timer so a new interval takes effect now rather than after the
  // current one elapses.
  if (bots[key].active) startTimer(key);
  res.json({ success: true, config: { interval: bots[key].interval, destId: bots[key].destId, sourceId: bots[key].sourceId } });
});

// Named destinations for the dashboard picker.
app.get(\"/admin/destinations\", adminAuth, (req, res) => {
  res.json({ destinations: DESTINATIONS.map(({ key, site, community, label, chatId }) => ({ key, site, community, label, chatId })) });
});

app.post(\"/admin/bots/:key/forward\", adminAuth, async (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: \"Bot not found\" });
  await forwardVideo(key);
  res.json({ success: true, message: \"Forwarded!\" });
});

app.post(\"/admin/bots/:key/collect\", adminAuth, async (req, res) => {
  const { key } = req.params;
  if (!bots[key]) return res.status(404).json({ error: \"Bot not found\" });
  await collectVideos(bots[key]);
  res.json({ success: true, poolSize: bots[key].videoPool.length });
});

app.get(\"/admin/mainbot/stats\", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/stats`, { headers: { \"x-admin-token\": MAIN_BOT_ADMIN } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post(\"/admin/mainbot/ads/toggle\", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/ads/toggle`, { method: \"POST\", headers: { \"x-admin-token\": MAIN_BOT_ADMIN } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete(\"/admin/mainbot/videos/:id\", adminAuth, async (req, res) => {
  try {
    const r = await fetch(`${MAIN_BOT_URL}/admin/videos/${req.params.id}`, { method: \"DELETE\", headers: { \"x-admin-token\": MAIN_BOT_ADMIN } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get(\"/\", (req, res) => res.json({ status: \"ok\", message: \"Forwarding bots running 🚀\" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Forwarding bots on port ${PORT}`);
  await loadBotState();
  // Saved interval/destination must be applied BEFORE the timers start, or the
  // first cycle after a restart runs on the env defaults instead.
  await loadBotConfig();
  startTimer(\"bot1\");
  startTimer(\"bot2\");
});

