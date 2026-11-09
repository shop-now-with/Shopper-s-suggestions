/*
 * Shopper's Suggestions — Cloudflare Worker
 *
 * Keeps the website API, GitHub media storage, D1 database and Telegram bot
 * in one Worker.
 */

const CATEGORIES = [
  "Tech", "Home", "Fashion", "Beauty", "Gaming", "Sports", "Travel", "Kitchen",
  "Office", "Automotive", "Electronics", "Kids", "Pets", "Fitness", "Books",
  "Accessories", "Photography", "Creator", "Other"
];

// Owner chat from /getid in the supplied Telegram screenshot.
// Telegram Bot API messages use chat IDs rather than phone numbers.
const DEFAULT_FEEDBACK_CHAT_ID = "8822043643";
const SITE_URL = "https://shopperssuggestions.online";

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  affiliate_url TEXT NOT NULL,
  category TEXT NOT NULL,
  image1_url TEXT NOT NULL DEFAULT '',
  image2_url TEXT NOT NULL DEFAULT '',
  image3_url TEXT NOT NULL DEFAULT '',
  image4_url TEXT NOT NULL DEFAULT '',
  image5_url TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 1,
  featured INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_chats (
  chat_id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'private',
  title TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '',
  unlocked INTEGER NOT NULL DEFAULT 0,
  step TEXT NOT NULL DEFAULT 'idle',
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);
 

CREATE TABLE IF NOT EXISTS telegram_promoter_links (
  telegram_user_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  key_prefix TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_ads_verified_chats (
  chat_id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ads_verified_user ON telegram_ads_verified_chats(telegram_user_id, active);

CREATE TABLE IF NOT EXISTS telegram_ads_accounts (telegram_user_id TEXT PRIMARY KEY, plan TEXT NOT NULL DEFAULT 'free', paid_until TEXT, next_run_at TEXT, groups_in_batch INTEGER NOT NULL DEFAULT 0, batch_number INTEGER NOT NULL DEFAULT 1, next_group_batch_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS telegram_ads_product_cycles (telegram_user_id TEXT NOT NULL, product_id TEXT NOT NULL, sent_count INTEGER NOT NULL DEFAULT 0, cooldown_until TEXT, last_sent_at TEXT, PRIMARY KEY (telegram_user_id, product_id));
CREATE TABLE IF NOT EXISTS telegram_ads_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_user_id TEXT NOT NULL, chat_id TEXT NOT NULL, utr TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT, reviewed_by TEXT, paid_until TEXT);
CREATE TABLE IF NOT EXISTS telegram_ads_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS telegram_admin_ad_schedule (id INTEGER PRIMARY KEY CHECK (id=1), frequency TEXT NOT NULL, next_run_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS telegram_ai_daily_usage (usage_date TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS telegram_ai_user_daily_usage (usage_date TEXT NOT NULL, telegram_user_id TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (usage_date, telegram_user_id));
`;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...extraHeaders
    }
  });
}

function withCors(response, request, extraHeaders = {}) {
  const origin = request.headers.get("Origin") || "*";
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("Vary", "Origin");
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

function api(data, request, status = 200) {
  return withCors(json(data, status), request);
}

function redirect(url, status = 302) {
  return new Response(null, { status, headers: { Location: url } });
}

function cleanText(value, max = 100000) {
  return String(value ?? "").trim().slice(0, max);
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isTruthy(value) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true" || String(value).toLowerCase() === "on";
}

function isValidCategory(category) {
  return CATEGORIES.includes(category);
}

function nowSql() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function cookieValue(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const parts = cookie.split(";");
  for (const part of parts) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function newToken() {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

async function hashText(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function promoterKeyCryptoKey(env) {
  const secret = cleanText(env.TELEGRAM_API_KEY_ENCRYPTION_SECRET, 500);
  if (!secret) throw new Error("Bot security is not configured yet. Please contact Shopper's Suggestions support.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

async function encryptPromoterApiKey(env, apiKey) {
  const key = await promoterKeyCryptoKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(apiKey));
  return bytesToBase64(new Uint8Array([...iv, ...new Uint8Array(encrypted)]));
}

async function decryptPromoterApiKey(env, encryptedValue) {
  const key = await promoterKeyCryptoKey(env);
  const packed = base64ToBytes(encryptedValue);
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

async function getPromoterTelegramLink(env, telegramUserId) {
  return env.DB.prepare("SELECT * FROM telegram_promoter_links WHERE telegram_user_id=? LIMIT 1")
    .bind(String(telegramUserId)).first();
}

async function verifyTelegramAdminAccount(env, chatId, telegramUserId) {
  const link = await getPromoterTelegramLink(env, telegramUserId);
  if (!link || String(link.chat_id) !== String(chatId)) return false;
  const apiKey = await decryptPromoterApiKey(env, link.encrypted_api_key);
  const response = await fetch("https://shopperssuggestions.online/api/integrations/products", {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
      "Cache-Control": "no-cache"
    }
  });
  const data = await response.json().catch(() => ({}));
  return response.ok && data.ok === true && data.is_admin === true;
}

async function verifyPromoterApiKey(apiKey) {
  const response = await fetch("https://shopperssuggestions.online/api/integrations/products", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: "{}"
  });
  const data = await response.json().catch(() => ({}));
  return response.status === 400 && /title is required/i.test(String(data.error || ""));
}

async function connectPromoterTelegram(env, chatId, telegramUserId, apiKey) {
  const encrypted = await encryptPromoterApiKey(env, apiKey);
  await env.DB.prepare(`
    INSERT INTO telegram_promoter_links (telegram_user_id, chat_id, encrypted_api_key, key_prefix, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      chat_id=excluded.chat_id,
      encrypted_api_key=excluded.encrypted_api_key,
      key_prefix=excluded.key_prefix,
      updated_at=CURRENT_TIMESTAMP
  `).bind(String(telegramUserId), String(chatId), encrypted, apiKey.slice(0, 16)).run();
}

async function createPromoterProductFromTelegramSession(env, chatId, telegramUserId) {
  const link = await getPromoterTelegramLink(env, telegramUserId);
  if (!link || String(link.chat_id) !== String(chatId)) {
    throw new Error("Connect your promoter account first using /connect.");
  }

  const apiKey = await decryptPromoterApiKey(env, link.encrypted_api_key);
  const endpoint = "https://shopperssuggestions.online/api/integrations/products";
  const session = await getTelegramSession(env, chatId, telegramUserId);
  session.user_id = String(telegramUserId);
  const d = session.data || {};
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Accept": "application/json",
    "Cache-Control": "no-cache"
  };

  let product = null;

  // If Telegram retried a publish after a delivery or reply issue, reuse the
  // already-created website listing instead of creating a duplicate.
  if (d.created_product_id) {
    const check = await fetch(endpoint, { headers });
    const checkData = await check.json().catch(() => ({}));
    if (!check.ok || !checkData.ok) {
      throw new Error(checkData.error || "Could not verify the existing listing. Please use /myproducts before trying again.");
    }
    product = (checkData.products || []).find(p =>
      String(p.id) === String(d.created_product_id)
    ) || null;
    if (!product) delete d.created_product_id;
  }

  if (!product) {
    const body = {
      title: cleanText(d.title, 300),
      description: cleanText(d.description, 10000),
      affiliate_url: cleanText(d.affiliate_url, 2000),
      category: cleanText(d.category, 100)
    };
    (Array.isArray(d.images) ? d.images : []).slice(0, 5).forEach((url, i) => {
      body[`image${i + 1}_url`] = url;
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const responseText = await response.text();
    let result = {};
    try { result = responseText ? JSON.parse(responseText) : {}; } catch {}
    product = result.product || null;

    if (!response.ok || !result.ok || !product) {
      const detail = String(result.error || responseText || "The product endpoint returned no product record.")
        .replace(/<[^>]*>/g, " ").slice(0, 700);
      throw new Error(`Website publish failed (HTTP ${response.status}): ${detail}`);
    }

    // Save the new product ID before attempting Telegram delivery.
    d.created_product_id = product.id;
    session.step = "confirm";
    session.data = d;
    try { await saveTelegramSession(env, session); }
    catch (error) {
      console.error("Could not save product publish checkpoint", {
        product_id: String(product.id),
        error: String(error?.message || error)
      });
    }
  }

  let telegramResult;
  try {
    telegramResult = await postProductToTelegramGroups(product, env, telegramUserId);
  } catch (error) {
    // The listing is already published. A Telegram outage must not turn that
    // successful website publish into a misleading publish failure.
    console.error("Product published but Telegram delivery could not start", {
      product_id: String(product.id),
      telegram_user_id: String(telegramUserId),
      error: String(error?.message || error)
    });
    telegramResult = {
      sent: 0,
      total: 0,
      groups: [],
      failures: [{ chat_id: "", error: String(error?.message || error) }]
    };
  }

  try { await resetTelegramProductDraft(env, chatId); }
  catch (error) { console.error("Could not reset product draft after publish", error); }
  return { product, telegramResult };
}

async function getTelegramConnectedProfile(env, chatId, telegramUserId) {
  const link = await getPromoterTelegramLink(env, telegramUserId);
  if (!link || String(link.chat_id) !== String(chatId)) throw new Error("Connect your Shopper's Suggestions account first using /connect.");
  const apiKey = await decryptPromoterApiKey(env, link.encrypted_api_key);
  const keyHash = await hashText(apiKey);
  const profile = await env.DB.prepare("SELECT u.id,u.username,u.display_name,u.avatar_url,u.bio,p.id AS promoter_id,p.display_name AS promoter_name,p.username AS promoter_username,p.status AS promoter_status,(SELECT COUNT(*) FROM products pr WHERE pr.uploader_id=u.id AND pr.published=1 AND (pr.expires_at IS NULL OR pr.expires_at>CURRENT_TIMESTAMP)) AS active_products,(SELECT COUNT(*) FROM product_clicks pc JOIN products pr ON pr.id=pc.product_id WHERE pr.uploader_id=u.id) AS clicks,(SELECT COUNT(*) FROM user_favorites uf WHERE uf.promoter_id=p.id) AS followers FROM user_api_keys k JOIN users u ON u.id=k.user_id LEFT JOIN promoters p ON p.user_id=u.id WHERE k.key_hash=? AND k.revoked_at IS NULL AND u.is_banned=0 LIMIT 1").bind(keyHash).first();
  if (!profile) throw new Error("Your connected profile could not be found. Please reconnect using /connect.");
  const setting = await env.DB.prepare("SELECT profile_public FROM user_settings WHERE user_id=?").bind(profile.id).first();
  if (Number(setting?.profile_public ?? 1) !== 1) throw new Error("Your website profile is private. Make it public in profile settings to show it here.");
  return profile;
}

async function sendTelegramConnectedProfile(env, chatId, telegramUserId) {
  const p = await getTelegramConnectedProfile(env, chatId, telegramUserId);
  const display = p.display_name || p.promoter_name || p.username || p.promoter_username || "Shopper's Suggestions user";
  const profileUrl = SITE_URL + "/profile.html?user=" + encodeURIComponent(p.id);
  const body = "👤 <b>" + escapeTelegramHtml(display) + "</b>\n" +
    (p.username ? "🔖 @" + escapeTelegramHtml(p.username) + "\n" : "") +
    "🏷️ <b>Promoter:</b> " + (p.promoter_status === "approved" ? "✅ Approved" : escapeTelegramHtml(p.promoter_status || "Not active")) + "\n" +
    "🛍️ <b>Live products:</b> " + Number(p.active_products || 0) + "\n" +
    "👥 <b>Followers:</b> " + Number(p.followers || 0) + "\n" +
    "👆 <b>Product clicks:</b> " + Number(p.clicks || 0) + "\n\n" +
    "📝 " + escapeTelegramHtml(p.bio || "No bio added yet.") + "\n\n" +
    "🌐 <a href=\"" + profileUrl + "\">Open full profile</a>";
  const markup = { inline_keyboard: [[{ text: "🌐 View profile", url: profileUrl }]] };
  if (p.avatar_url) await telegramApi(env, "sendPhoto", { chat_id: chatId, photo: p.avatar_url, caption: body, parse_mode: "HTML", reply_markup: markup });
  else await telegramApi(env, "sendMessage", { chat_id: chatId, text: body, parse_mode: "HTML", reply_markup: markup, disable_web_page_preview: true });
  const ownProducts = await getTelegramPromoterProducts(env, chatId, telegramUserId);
  const liveProducts = ownProducts.filter(product => Number(product.published) === 1).slice(0, 5);
  if (liveProducts.length) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "🛍️ <b>Your live products</b>", parse_mode: "HTML" });
    for (const product of liveProducts) await sendProductToChat(env, chatId, product);
  } else {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "🛍️ You don't have any live products yet. Use /addproduct to publish one." });
  }
}
async function getTelegramPromoterProducts(env, chatId, telegramUserId) {
  const link = await getPromoterTelegramLink(env, telegramUserId);
  if (!link || String(link.chat_id) !== String(chatId)) throw new Error("Connect your promoter account first using /connect.");
  const apiKey = await decryptPromoterApiKey(env, link.encrypted_api_key);
  const response = await fetch("https://shopperssuggestions.online/api/integrations/products", {
    headers: { "Authorization": `Bearer ${apiKey}` }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "Could not load your products.");
  return result.products || [];
}

async function updateTelegramPromoterProduct(env, chatId, telegramUserId, productId, changes) {
  const link = await getPromoterTelegramLink(env, telegramUserId);
  if (!link || String(link.chat_id) !== String(chatId)) throw new Error("Connect your promoter account first using /connect.");
  const apiKey = await decryptPromoterApiKey(env, link.encrypted_api_key);
  const response = await fetch(`https://shopperssuggestions.online/api/integrations/products/${encodeURIComponent(productId)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(changes)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "Could not update this product.");
  return result.product;
}

async function deleteTelegramPromoterProduct(env, chatId, telegramUserId, productId) {
  const link = await getPromoterTelegramLink(env, telegramUserId);
  if (!link || String(link.chat_id) !== String(chatId)) throw new Error("Connect your promoter account first using /connect.");
  const apiKey = await decryptPromoterApiKey(env, link.encrypted_api_key);
  const response = await fetch(`https://shopperssuggestions.online/api/integrations/products/${encodeURIComponent(productId)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${apiKey}` }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok || Number(result.deleted) !== Number(productId)) {
    throw new Error(result.error || ("The website did not confirm deletion (HTTP " + response.status + ")."));
  }
  return result;
}

async function parseBody(request) {
  const type = request.headers.get("Content-Type") || "";
  if (type.includes("multipart/form-data")) {
    return await request.formData();
  }
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const params = new URLSearchParams(text);
    return Object.fromEntries(params.entries());
  }
}

async function ensureSchema(env) {
  for (const statement of BASE_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }

  // Safe migration for older databases created before featured existed.
  const cols = await env.DB.prepare("PRAGMA table_info(products)").all();
  const names = new Set((cols.results || []).map((r) => r.name));
  if (!names.has("featured")) {
    await env.DB.prepare("ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0").run();
  }
  const adsCols = await env.DB.prepare("PRAGMA table_info(telegram_ads_verified_chats)").all();
  const adsNames = new Set((adsCols.results || []).map((r) => r.name));
  if (!adsNames.has("batch_number")) await env.DB.prepare("ALTER TABLE telegram_ads_verified_chats ADD COLUMN batch_number INTEGER NOT NULL DEFAULT 1").run();
  await env.DB.prepare("INSERT OR IGNORE INTO telegram_ads_accounts (telegram_user_id,plan,next_run_at,groups_in_batch,batch_number,next_group_batch_at,created_at,updated_at) SELECT telegram_user_id,'free',CASE WHEN COUNT(*)>=3 THEN ? ELSE NULL END,COUNT(*)%3,CAST((COUNT(*)-1)/3 AS INTEGER)+1,CASE WHEN COUNT(*)>=3 AND COUNT(*)%3=0 THEN ? ELSE NULL END,?,? FROM telegram_ads_verified_chats WHERE active=1 GROUP BY telegram_user_id").bind(nowSql(), adsSqlAfterDays(20), nowSql(), nowSql()).run();
}

async function getProduct(env, id) {
  return await env.DB.prepare("SELECT * FROM products WHERE id = ? LIMIT 1").bind(id).first();
}

function productPublic(product) {
  if (!product) return null;
  return {
    id: product.id,
    title: product.title,
    description: product.description,
    affiliate_url: product.affiliate_url,
    category: product.category,
    image1_url: product.image1_url || "",
    image2_url: product.image2_url || "",
    image3_url: product.image3_url || "",
    image4_url: product.image4_url || "",
    image5_url: product.image5_url || "",
    video_url: product.video_url || "",
    published: Number(product.published) === 1,
    featured: Number(product.featured) === 1,
    created_at: product.created_at,
    updated_at: product.updated_at
  };
}

function productImages(product) {
  return [1, 2, 3, 4, 5]
    .map((n) => product[`image${n}_url`])
    .filter(Boolean);
}

function productShareUrl(id) {
  return `${SITE_URL}/?product=${encodeURIComponent(id)}`;
}

function telegramGroupIds(env) {
  return cleanText(env.TELEGRAM_GROUP_IDS)
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function escapeTelegramHtml(value) {
  return cleanText(value, 4000)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function productButton(product) {
  return { inline_keyboard: [[{ text: "🛒 GET PRODUCT", url: productShareUrl(product?.id) }]] };
}

function telegramCaption(product) {
  const link = productShareUrl(product.id);
  const featured = Number(product.featured) === 1
    ? "\n⭐ <b>Worth discovering</b>"
    : "";

  return (
    `🛍️ <b>${escapeTelegramHtml(product.title)}</b>\n\n` +
    `${escapeTelegramHtml(product.description || "No description available.")}\n\n` +
    `📂 <b>Category:</b> ${escapeTelegramHtml(product.category)}` +
    featured +
    `\n\n🔗 <a href="${link}">View product</a>`
  );
}

async function telegramApi(env, method, payload) {
  const token = cleanText(env.TELEGRAM_BOT_TOKEN);
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function telegramSendWithRetry(env, method, payload, retries = 2) {
  let attempt = 0;

  while (true) {
    try {
      return await telegramApi(env, method, payload);
    } catch (error) {
      const text = String(error.message || error);
      const match = text.match(/retry_after[^0-9]*(\d+)/i);

      if (!match || attempt >= retries) throw error;

      const seconds = Math.min(10, Math.max(1, Number(match[1])));
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      attempt += 1;
    }
  }
}

async function sendProductMediaToTelegram(env, chatId, product) {
  const images = productImages(product);
  const caption = telegramCaption(product);
  const markup = productButton(product);
  let deliveredImage = false;

  // Broken or non-direct image URLs must not block delivery of the product itself.
  for (const image of images) {
    try {
      const payload = { chat_id: chatId, photo: image };
      if (!deliveredImage) {
        payload.caption = caption;
        payload.parse_mode = "HTML";
        payload.reply_markup = markup;
      }
      await telegramSendWithRetry(env, "sendPhoto", payload);
      deliveredImage = true;
    } catch (error) {
      console.error("Product image delivery failed; trying remaining images", {
        chat_id: String(chatId),
        product_id: String(product?.id || ""),
        error: String(error?.message || error)
      });
    }
  }

  if (!deliveredImage) {
    await telegramSendWithRetry(env, "sendMessage", {
      chat_id: chatId,
      text: "✨ <b>CHECK IT OUT!</b> ✨\n\n" + caption,
      parse_mode: "HTML",
      disable_web_page_preview: false,
      reply_markup: markup
    });
  }
}

async function postProductToTelegramGroups(product, env, telegramUserId = "") {
  const targets = telegramGroupIds(env);

  // Deliver a promoter's new listing to their verified groups too.
  if (telegramUserId) {
    const verified = await env.DB.prepare(
      "SELECT chat_id FROM telegram_ads_verified_chats WHERE telegram_user_id=? AND active=1 ORDER BY verified_at"
    ).bind(String(telegramUserId)).all();
    for (const row of verified.results || []) {
      if (row.chat_id) targets.push(String(row.chat_id));
    }
  }

  const uniqueTargets = [...new Set(targets.filter(Boolean))];
  if (!uniqueTargets.length) {
    return {
      sent: 0,
      total: 0,
      groups: [],
      failures: [],
      message: "No Telegram destination is configured or verified yet."
    };
  }

  const sent = [];
  const failures = [];
  for (const chatId of uniqueTargets) {
    try {
      await sendProductMediaToTelegram(env, chatId, product);
      sent.push(chatId);
    } catch (error) {
      failures.push({ chat_id: chatId, error: String(error?.message || error) });
    }
  }
  return { sent: sent.length, total: uniqueTargets.length, groups: sent, failures };
}

async function recordTelegramChat(env, chat) {
  if (!chat?.id) return;
  const chatId = String(chat.id);
  const type = cleanText(chat.type || "private", 30);
  const title = cleanText(chat.title || "", 300);
  const username = cleanText(chat.username || "", 300);
  const userId = cleanText(chat.type === "private" ? chat.id : (chat.user_id || ""), 100);
  const firstName = cleanText(chat.first_name || "", 200);
  const lastName = cleanText(chat.last_name || "", 200);
  await env.DB.prepare(`
    INSERT INTO telegram_chats (chat_id, type, title, username, user_id, first_name, last_name, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      type = excluded.type,
      title = excluded.title,
      username = excluded.username,
      user_id = excluded.user_id,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      active = 1,
      updated_at = excluded.updated_at
  `).bind(chatId, type, title, username, userId, firstName, lastName, nowSql()).run();
}

async function recordTelegramUpdateChat(env, update) {
  const message = update?.message || update?.channel_post || update?.edited_channel_post || update?.edited_message;
  if (!message?.chat) return;
  const chat = { ...message.chat };
  if (message.from?.id) chat.user_id = message.from.id;
  if (message.from?.first_name) chat.first_name = message.from.first_name;
  if (message.from?.last_name) chat.last_name = message.from.last_name;
  await recordTelegramChat(env, chat);
}

function telegramCommand(text) {
  const first = cleanText(text).split(/\s+/, 1)[0].toLowerCase();
  return first.replace(/^\//, "").split("@")[0];
}

function telegramCommandArgs(text) {
  const raw = cleanText(text);
  const firstSpace = raw.indexOf(" ");
  return firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
}

function productSearchTerms(query) {
  return cleanText(query, 200).replace(/[%_]/g, " ").trim();
}

async function sendProductToChat(env, chatId, product, prefix = "") {
  if (!product || Number(product.published) !== 1) return false;

  if (prefix) {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: cleanText(prefix, 1000)
    });
  }

  await sendProductMediaToTelegram(env, chatId, product);
  return true;
}

async function searchProducts(env, query, limit = 8) {
  const q = productSearchTerms(query);
  if (!q) return [];
  const like = `%${q}%`;
  const result = await env.DB.prepare(`
    SELECT * FROM products
    WHERE published = 1 AND (title LIKE ? OR description LIKE ? OR category LIKE ?)
    ORDER BY CASE WHEN lower(title) = lower(?) THEN 0 WHEN title LIKE ? THEN 1 ELSE 2 END, created_at DESC, id DESC
    LIMIT ?
  `).bind(like, like, like, q, `${q}%`, limit).all();
  return result.results || [];
}

async function sendSearchResults(env, chatId, query) {
  const products = await searchProducts(env, query, 8);
  if (!products.length) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: `🔎 No products found for “${cleanText(query, 120)}”.\n\nTry another product name, keyword, or /categories.` });
    return;
  }
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: `🔎 Found ${products.length} product${products.length === 1 ? "" : "s"} for “${cleanText(query, 120)}”.` });
  for (const product of products) await sendProductToChat(env, chatId, product);
}

async function sendCategoryResults(env, chatId, category) {
  const cat = CATEGORIES.find(x => x.toLowerCase() === cleanText(category).toLowerCase());
  if (!cat) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "❌ Unknown category. Use /categories to see the available categories." });
    return;
  }
  const result = await env.DB.prepare("SELECT * FROM products WHERE published = 1 AND category = ? ORDER BY created_at DESC, id DESC LIMIT 100").bind(cat).all();
  const products = result.results || [];
  if (!products.length) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: `📂 No published products are currently available in ${cat}.` });
    return;
  }
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: `📂 <b>${escapeTelegramHtml(cat)}</b>\n\nSending ${products.length} product${products.length === 1 ? "" : "s"}…`, parse_mode: "HTML" });
  for (const product of products) await sendProductToChat(env, chatId, product);
}

async function sendLatest(env, chatId) {
  const result = await env.DB.prepare("SELECT * FROM products WHERE published = 1 ORDER BY created_at DESC, id DESC LIMIT 5").all();
  const products = result.results || [];
  if (!products.length) return telegramApi(env, "sendMessage", { chat_id: chatId, text: "There are no published products yet." });
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: "🆕 <b>Latest products</b>", parse_mode: "HTML" });
  for (const product of products) await sendProductToChat(env, chatId, product);
}

async function sendFeatured(env, chatId) {
  const result = await env.DB.prepare("SELECT * FROM products WHERE published = 1 AND featured = 1 ORDER BY created_at DESC, id DESC LIMIT 10").all();
  const products = result.results || [];
  if (!products.length) return telegramApi(env, "sendMessage", { chat_id: chatId, text: "⭐ No special picks right now." });
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: "⭐ <b>Worth discovering</b>", parse_mode: "HTML" });
  for (const product of products) await sendProductToChat(env, chatId, product);
}

function adminCode(env) {
  return cleanText(env.TELEGRAM_ADMIN_CODE || env.ADMIN_PASSWORD, 100);
}

function ownerAdminUserId(env) {
  return cleanText(env.TELEGRAM_ADMIN_USER_ID || DEFAULT_FEEDBACK_CHAT_ID, 100);
}

function isOwnerAdmin(env, chat, userId) {
  return (
    String(chat?.type || "") === "private" &&
    String(userId || "") === ownerAdminUserId(env)
  );
}

function publicBotCommands() {
  return [
    { command: "help", description: "See available commands" },
    { command: "explain", description: "Learn affiliate marketing step by step" },
    { command: "start", description: "Open the bot" },
    { command: "connect", description: "Connect your promoter account" },
    { command: "profile", description: "View your connected profile" },
    { command: "products", description: "Browse live products" },
    { command: "latest", description: "See newest products" },
    { command: "search", description: "Search products" },
    { command: "categories", description: "Browse product categories" },
    { command: "featured", description: "See featured products" },
    { command: "addproduct", description: "Upload a product" },
    { command: "myproducts", description: "View your products" },
    { command: "editproduct", description: "Edit your product" },
    { command: "deleteproduct", description: "Delete your product" },
    { command: "disconnect", description: "Disconnect your account" },
    { command: "adsrun", description: "Set up product promotions" },
    { command: "adsverify", description: "Verify this group for ads" },
    { command: "myid", description: "Show your Telegram ID" },
    { command: "cancel", description: "Cancel the current action" }
  ];
}
function adminBotCommands() {
  return [...publicBotCommands(),
    { command: "admin", description: "Unlock admin tools" },
    { command: "lock", description: "Lock admin tools" },
    { command: "broadcast", description: "Message all registered chats" },
    { command: "globalgroupmsg", description: "Message all groups and channels" },
    { command: "globalusermsg", description: "Message all private users" },
    { command: "sendto", description: "Send a message to a chat ID" },
    { command: "channel", description: "Send a message to a group or channel" },
    { command: "chats", description: "List registered chats" },
    { command: "refreshchat", description: "Register or refresh a chat" },
    { command: "stats", description: "Show bot statistics" },
    { command: "paymentdts", description: "Review paid-plan payments" },
    { command: "setadsqr", description: "Set the paid-plan QR image" },
    { command: "showadsqr", description: "Show the current payment QR" },
    { command: "removeadsqr", description: "Remove the payment QR" },
    { command: "adminad", description: "Send or schedule the group promotion" }
  ];
}
async function setTelegramCommandMenu(env, commands, scope) {
  try {
    const payload = { commands };
    if (scope) payload.scope = scope;
    await telegramApi(env, "setMyCommands", payload);
  } catch (error) {
    console.error("Could not update Telegram command menu", String(error?.message || error));
  }
}
async function sendHelp(env, chatId) {
  const text =
    `🛍️ <b>Shopper's Suggestions</b>\n\n` +
    `Connect your promoter account to manage your products directly from Telegram.\n\n` +
    `/help — See every available command\n` +
    `/explain — Learn affiliate marketing step by step\n` +
    `/start — Open the bot\n` +
    `/connect — Connect your account\n` +
    `/profile — View your full profile 👤\n` +
    `/products — Browse live products 🛍️\n` +
    `/latest — See newest products 🆕\n` +
    `/search — Search products 🔎\n` +
    `/categories — Browse categories 📂\n` +
    `/featured — Special product picks ⭐\n` +
    `/addproduct — Upload a product\n` +
    `/myproducts — View your products\n` +
    `/editproduct — Edit one of your products\n` +
    `/deleteproduct — Delete one of your products\n` +
    `/disconnect — Disconnect your account\n` +
    `/adsrun — Set up product promotions 📢\n` +
    `/adsverify — Verify this group for ads\n` +
    `/myid — Show your Telegram user ID 🆔\n` +
    `/cancel — Cancel the current action`;
  return telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}


const EXPLAIN_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const EXPLAIN_GLOBAL_DAILY_LIMIT = 25;
const EXPLAIN_USER_DAILY_LIMIT = 5;
const EXPLAIN_SYSTEM_PROMPT = "You are the friendly, practical affiliate-marketing tutor inside the Shopper's Suggestions Telegram bot. You are speaking in Telegram messages to a beginner.\n\nIDENTITY\nShopper's Suggestions is operated by MEGFO, an advertising brand that creates websites and applications. If asked who owns or operates the service, say MEGFO. Never claim MEGFO created the underlying AI model. Do not name, mention, or pretend to represent any AI model provider or technology company.\n\nTEACHING METHOD — VERY IMPORTANT\nThis is a guided, interactive course, not a one-message guide.\n- Teach exactly ONE small lesson step per reply. Never dump the whole course, a long checklist, or all setup instructions at once.\n- Explain the current step in simple English, with enough detail to be genuinely useful. The learner may ask as many follow-up questions as needed.\n- After explaining one step, stop and ask one short question such as “Want me to explain any part, or are you ready for the next step?”\n- Do not move to the next lesson step until the learner clearly says “next”, “continue”, “I'm ready”, or an equivalent.\n- If the learner asks a question, answer that question fully and stay on the same lesson step. Do not advance the course in the same reply unless they explicitly ask to continue.\n- If they say they do not understand, explain the same idea in a simpler way and give a fresh example.\n- If they ask to skip, respect that and continue with the step they request.\n- Keep track of where the learner is in the course using the conversation history. Do not restart or repeat completed steps unless asked.\n- Start with the basics: what affiliate marketing means, using a simple everyday example. Do not begin with account registration or a wall of instructions.\n- Introduce Telegram group setup around the middle of the course, not in the opening message.\n- Never pressure the learner to buy a plan, invite people, or continue.\n\nTELEGRAM MESSAGE STYLE\nMake every reply feel welcoming, lively, and polished:\n- Use a few relevant emojis, short paragraphs, friendly section labels, and clean spacing.\n- Use Unicode separators occasionally, for example “━━━━━━━━━━━━”.\n- Do NOT use Markdown bold markers (**), asterisks for styling, HTML tags, or complicated formatting.\n- Do not overuse emojis. Avoid huge blocks of text.\n- Use clear, natural, encouraging language without sounding childish or making unrealistic promises.\n- Normally keep each reply around 80–160 words; go longer only when the learner asks for detail.\n- Never send more than one lesson step in a single reply.\n\nCOURSE TOPICS — TEACH ONLY WHEN THE LEARNER REACHES THEM\n1. Affiliate marketing: what it is, how a tracked link works, and a simple example.\n2. EarnKaro: what the platform does, how retailer offers and Profit Links work, and how commissions are tracked.\n3. Eligibility and safety: EarnKaro's terms say members should be 18 or older; people under 18 may access only with guidance and supervision of a parent or legal guardian. A minor must not create an account, submit identity/bank details, or handle payments alone. Tell them to ask a parent/legal guardian to review the current terms and supervise any permitted activity. Never suggest a false age or bypassing checks.\n4. Finding a retailer product and making a Profit Link using EarnKaro's current Make Links flow. If unsure about current interface details, tell the learner to follow the current in-app instructions rather than inventing buttons.\n5. Choosing a product people genuinely need: useful benefit, fair price, reliable retailer, recent reviews, clear product details, real offer, and suitable category. Avoid fake discounts, false scarcity, misleading images, copied claims, and exaggerated promises.\n6. Writing a short, honest product caption and sharing responsibly.\n7. Shopper's Suggestions: https://shopperssuggestions.online is a product-discovery and affiliate marketplace, not a retailer or shipping company. Promoters publish products there with descriptions, categories, images, and tracked product links. Visitors discover products and go to the retailer; the retailer handles orders and delivery. A product must first be uploaded and published on the website before the Telegram ads scheduler can promote it. /connect links an approved promoter account; /addproduct starts a product upload.\n8. Around the middle of the course, explain the Telegram groups: the free bot plan initially supports up to 3 verified Telegram groups/supergroups. The promoter must be an admin in each group and add the bot as an admin with only the permissions needed to post. Then run /adsverify inside each group. Invite friends or contacts only if they choose to join; never spam or add anyone without consent. The free scheduler sends eligible product ads about every 60 minutes. After 20 days, the promoter may add another batch of up to 3 groups; existing verified groups remain active. Explain this setup one action at a time and wait for the learner between actions.\n9. Explain how to check whether products are published and understand basic promotion status.\n\nIMPORTANT EARNKARO PROMOTION RESTRICTION\nEarnKaro terms restrict paid advertising that directs traffic to retailer platforms through EarnKaro. Do not recommend the bot's paid plan for EarnKaro Profit Links unless EarnKaro and the retailer explicitly confirm that this exact promotion is allowed. Prefer the free bot plan for EarnKaro links and tell the learner to check current programme rules. The optional bot plan is a separate service priced at ₹150 for 30 days, subject to admin approval; never pressure anyone to pay.\n\nTRUTHFULNESS\nCommissions depend on valid tracked purchases and retailer/programme approval. Orders that are cancelled, returned, rejected, excluded, or not tracked may not earn commission. Pending profit is not confirmed profit. Never promise income, guaranteed sales, a fixed commission, or a guaranteed payout date. Encourage honest sharing and checking the current official EarnKaro terms.\n\nFIRST LESSON\nThe bot code adds the exact opening line “you are ready to make some money?” before your first reply. After that, introduce only Step 1: explain affiliate marketing in a simple way with one relatable example, then ask whether the learner wants clarification or is ready for the next step. Do not explain EarnKaro registration, product selection, website uploads, or Telegram groups in this first reply.";


async function reserveExplainAiRequest(env, telegramUserId) {
  const day = new Date().toISOString().slice(0, 10);
  const global = await env.DB.prepare("INSERT INTO telegram_ai_daily_usage (usage_date, requests) VALUES (?, 1) ON CONFLICT(usage_date) DO UPDATE SET requests = requests + 1 WHERE requests < ?").bind(day, EXPLAIN_GLOBAL_DAILY_LIMIT).run();
  if (!(Number(global.meta?.changes) > 0)) return false;
  const personal = await env.DB.prepare("INSERT INTO telegram_ai_user_daily_usage (usage_date, telegram_user_id, requests) VALUES (?, ?, 1) ON CONFLICT(usage_date, telegram_user_id) DO UPDATE SET requests = requests + 1 WHERE requests < ?").bind(day, String(telegramUserId), EXPLAIN_USER_DAILY_LIMIT).run();
  if (!(Number(personal.meta?.changes) > 0)) {
    await env.DB.prepare("UPDATE telegram_ai_daily_usage SET requests = CASE WHEN requests > 0 THEN requests - 1 ELSE 0 END WHERE usage_date = ?").bind(day).run();
    return false;
  }
  return true;
}

async function sendExplainAiReply(env, session, chatId, telegramUserId, userText, isFirst = false) {
  if (!env.AI || typeof env.AI.run !== "function") {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "The learning assistant is being connected. Please try /explain again a little later." });
    return;
  }
  const reserved = await reserveExplainAiRequest(env, telegramUserId);
  if (!reserved) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Today's free AI lesson allowance has been reached. Please try again tomorrow. Your lesson progress is saved." });
    return;
  }
  const history = Array.isArray(session.data?.explain_history) ? session.data.explain_history.slice(-8) : [];
  const messages = [
    { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
    ...history,
    { role: "user", content: cleanText(userText, 1500) }
  ];
  try {
    const result = await env.AI.run(EXPLAIN_AI_MODEL, { messages, max_tokens: 350, temperature: 0.55 });
    const answer = cleanText(result?.response || result?.output_text || result?.choices?.[0]?.message?.content || "", 3500);
    if (!answer) throw new Error("The AI service returned an empty reply.");
    session.data = session.data || {};
    session.data.explain_history = [...history, { role: "user", content: cleanText(userText, 1500) }, { role: "assistant", content: answer }].slice(-8);
    await saveTelegramSession(env, session);
    const finalText = (isFirst ? "you are ready to make some money?\n\n" : "") + answer;
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: finalText.slice(0, 3900), disable_web_page_preview: true });
  } catch (error) {
    console.error("Affiliate lesson AI request failed", String(error?.message || error));
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "The free AI service is temporarily unavailable or has reached its daily allowance. Your lesson is still open—please try again later." });
  }
}

async function sendFeedbackToOwner(env, chat, user, kind, message) {
  const ownerChatId = cleanText(
    env.TELEGRAM_FEEDBACK_CHAT_ID ||
    env.TELEGRAM_OWNER_CHAT_ID ||
    DEFAULT_FEEDBACK_CHAT_ID,
    100
  );

  if (!ownerChatId) {
    throw new Error("Owner feedback chat is not configured.");
  }

  const username = user?.username
    ? `@${user.username}`
    : "No username";

  const body =
    `📩 <b>Shopper's Suggestions — ${escapeTelegramHtml(kind)}</b>\n\n` +
    `👤 <b>Name:</b> ${escapeTelegramHtml(user?.first_name || "Unknown")}\n` +
    `📱 <b>Username:</b> ${escapeTelegramHtml(username)}\n` +
    `🆔 <b>User ID:</b> <code>${escapeHtml(user?.id || "")}</code>\n` +
    `💬 <b>Chat ID:</b> <code>${escapeHtml(chat?.id || "")}</code>\n\n` +
    `📝 <b>Message</b>\n${escapeTelegramHtml(message, 3500)}`;

  await telegramApi(env, "sendMessage", {
    chat_id: ownerChatId,
    text: body,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });

  return true;
}

async function broadcastToTelegram(env, message, allowedTypes = null) {
  const rows = await env.DB.prepare(`
    SELECT chat_id, type, title, username
    FROM telegram_chats
    WHERE active = 1
    ORDER BY updated_at DESC
  `).all();

  const targets = [];
  const seen = new Set();

  const allowed = Array.isArray(allowedTypes) ? new Set(allowedTypes) : null;
  for (const row of rows.results || []) {
    const id = String(row.chat_id || "");
    if (!id || seen.has(id)) continue;
    if (allowed && !allowed.has(String(row.type || ""))) continue;
    seen.add(id);
    targets.push(row);
  }

  let sent = 0;
  let failed = 0;
  const failures = [];

  for (const row of targets) {
    try {
      await telegramSendWithRetry(env, "sendMessage", {
        chat_id: row.chat_id,
        text: cleanText(message, 4096),
        disable_web_page_preview: false
      });
      sent++;
      await new Promise(resolve => setTimeout(resolve, 60));
    } catch (error) {
      failed++;
      failures.push({
        chat_id: String(row.chat_id),
        type: String(row.type || ""),
        error: String(error.message || error)
      });

      const errorText = String(error.message || error);
      if (
        errorText.includes("bot was blocked") ||
        errorText.includes("CHAT_WRITE_FORBIDDEN") ||
        errorText.includes("chat not found")
      ) {
        try {
          await env.DB.prepare(
            "UPDATE telegram_chats SET active = 0, updated_at = ? WHERE chat_id = ?"
          ).bind(nowSql(), String(row.chat_id)).run();
        } catch {}
      }
    }
  }

  return {
    total: targets.length,
    sent,
    failed,
    failures
  };
}

async function sendToTelegramChat(env, chatId, message) {
  return telegramSendWithRetry(env, "sendMessage", {
    chat_id: String(chatId),
    text: cleanText(message, 4096),
    disable_web_page_preview: false
  });
}

async function getChatAndSave(env, chatId) {
  const id = cleanText(chatId, 100);
  if (!id) throw new Error("Chat ID is required.");

  const result = await telegramApi(env, "getChat", { chat_id: id });
  const chat = result.result;
  if (!chat?.id) throw new Error("Telegram returned no chat information.");

  await recordTelegramChat(env, chat);
  return chat;
}

async function chatsText(env) {
  const result = await env.DB.prepare(`
    SELECT chat_id, type, title, username, active
    FROM telegram_chats
    ORDER BY type, title, chat_id
    LIMIT 200
  `).all();

  const rows = result.results || [];
  if (!rows.length) return `🗂️ <b>No chats registered yet.</b>`;

  return (
    `🗂️ <b>Registered Telegram chats</b>\n\n` +
    rows.map((row, i) => {
      const name = row.title || (row.username ? `@${row.username}` : "Private chat");
      const state = Number(row.active) === 1 ? "✅" : "⛔";
      return `${i + 1}. ${escapeTelegramHtml(name)}\n` +
        `   <code>${escapeHtml(row.chat_id)}</code> · ${escapeTelegramHtml(row.type || "unknown")} · ${state}`;
    }).join("\n\n")
  );
}

async function getTelegramSession(env, chatId, userId = "") {
  const row = await env.DB.prepare("SELECT * FROM telegram_sessions WHERE chat_id = ? LIMIT 1").bind(String(chatId)).first();
  if (row) {
    let data = {};
    try { data = JSON.parse(row.data_json || "{}"); } catch { data = {}; }
    return { ...row, data };
  }

  const id = String(chatId);
  await env.DB.prepare(`
    INSERT INTO telegram_sessions (chat_id, user_id, unlocked, step, data_json, updated_at)
    VALUES (?, ?, 0, 'idle', '{}', ?)
  `).bind(id, String(userId), nowSql()).run();
  return { chat_id: id, user_id: String(userId), unlocked: 0, step: "idle", data: {} };
}

async function saveTelegramSession(env, session) {
  await env.DB.prepare(`
    INSERT INTO telegram_sessions (chat_id, user_id, unlocked, step, data_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      user_id = excluded.user_id,
      unlocked = excluded.unlocked,
      step = excluded.step,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).bind(
    String(session.chat_id),
    String(session.user_id || ""),
    session.unlocked ? 1 : 0,
    String(session.step || "idle"),
    JSON.stringify(session.data || {}),
    nowSql()
  ).run();
}

async function unlockTelegram(env, chatId, userId) {
  const s = await getTelegramSession(env, chatId, userId);
  s.user_id = String(userId);
  s.unlocked = 1;
  s.step = "idle";
  s.data = {};
  await saveTelegramSession(env, s);
  return s;
}

async function lockTelegram(env, chatId, userId) {
  const s = await getTelegramSession(env, chatId, userId);
  s.user_id = String(userId);
  s.unlocked = 0;
  s.step = "idle";
  s.data = {};
  await saveTelegramSession(env, s);
}

async function resetTelegramProductDraft(env, chatId) {
  const s = await getTelegramSession(env, chatId);
  s.step = "idle";
  s.data = {};
  // Keep unlocked so another product can be added without re-entering the code.
  await saveTelegramSession(env, s);
}

function categoryKeyboard() {
  const rows = [];
  for (let i = 0; i < CATEGORIES.length; i += 3) {
    rows.push(CATEGORIES.slice(i, i + 3).map((category) => ({ text: category, callback_data: `cat:${category}` })));
  }
  return { inline_keyboard: rows };
}

async function promptAddProduct(env, chatId) {
  const s = await getTelegramSession(env, chatId);
  s.step = "title";
  s.data = { images: [] };
  await saveTelegramSession(env, s);
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: "Send the product title."
  });
}

async function createProductFromTelegramSession(env, chatId) {
  const s = await getTelegramSession(env, chatId);
  const d = s.data || {};
  const category = d.category;
  const title = cleanText(d.title, 300);
  const description = cleanText(d.description, 5000);
  const affiliate = cleanText(d.affiliate_url, 2000);
  const images = Array.isArray(d.images) ? d.images.filter(Boolean).slice(0, 5) : [];
  const video = cleanText(d.video_url, 2000);

  if (!title || !affiliate || !category) {
    throw new Error("Missing title, affiliate URL or category.");
  }

  const result = await env.DB.prepare(`
    INSERT INTO products (
      title, description, affiliate_url, category,
      image1_url, image2_url, image3_url, image4_url, image5_url,
      video_url, published, featured, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
  `).bind(
    title,
    description,
    affiliate,
    category,
    images[0] || "",
    images[1] || "",
    images[2] || "",
    images[3] || "",
    images[4] || "",
    video,
    nowSql(),
    nowSql()
  ).run();

  const product = await getProduct(env, result.meta.last_row_id);
  const telegramResult = await postProductToTelegramGroups(product, env);
  await resetTelegramProductDraft(env, chatId);
  return { product, telegramResult };
}

function fileExtension(name, fallback = "jpg") {
  const match = String(name || "").toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  return match ? match[1] : fallback;
}

function mimeFromExtension(ext) {
  const m = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    gif: "image/gif", avif: "image/avif", svg: "image/svg+xml",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", m4v: "video/mp4"
  };
  return m[ext] || "application/octet-stream";
}

function extensionFromMime(type) {
  const m = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp",
    "image/gif": "gif", "image/avif": "avif", "image/svg+xml": "svg",
    "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm"
  };
  return m[String(type || "").toLowerCase()] || "bin";
}

function base64FromBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function normalizeGitHubRawUrl(owner, repo, branch, path) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function githubApiUrl(owner, repo, path = "") {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`.replace(/contents\/$/, "contents");
}

async function githubRequest(env, method, path, body) {
  const owner = cleanText(env.GITHUB_OWNER);
  const repo = cleanText(env.GITHUB_REPO);
  const token = cleanText(env.GITHUB_TOKEN);
  if (!owner || !repo || !token) throw new Error("GitHub media storage is not configured.");

  const response = await fetch(githubApiUrl(owner, repo, path), {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "shoppers-suggestions-worker",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function githubUpload(env, bytes, filename, contentType) {
  const owner = cleanText(env.GITHUB_OWNER);
  const repo = cleanText(env.GITHUB_REPO);
  const branch = cleanText(env.GITHUB_BRANCH) || "main";
  const ext = fileExtension(filename, extensionFromMime(contentType));
  const safeBase = cleanText(filename, 120).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/\.[^.]+$/, "");
  const unique = `${Date.now()}-${crypto.randomUUID()}-${safeBase || "media"}.${ext}`;
  const path = `media/${unique}`;
  const content = base64FromBytes(bytes);

  const result = await githubRequest(env, "PUT", path, {
    message: `Add media ${unique}`,
    content,
    branch
  });

  return {
    path,
    sha: result.content?.sha || "",
    url: normalizeGitHubRawUrl(owner, repo, branch, path),
    html_url: result.content?.html_url || "",
    content_type: contentType || mimeFromExtension(ext)
  };
}

async function githubDeleteByRawUrl(env, rawUrl) {
  if (!rawUrl) return { skipped: true };
  const owner = cleanText(env.GITHUB_OWNER);
  const repo = cleanText(env.GITHUB_REPO);
  const branch = cleanText(env.GITHUB_BRANCH) || "main";
  const prefix = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/`;
  if (!rawUrl.startsWith(prefix)) return { skipped: true, reason: "not-github-media" };
  const path = rawUrl.slice(prefix.length).split("?")[0].split("#")[0];
  if (!path.startsWith("media/")) return { skipped: true, reason: "not-media-path" };

  let sha = "";
  try {
    const current = await githubRequest(env, "GET", path);
    sha = current.sha || "";
  } catch (error) {
    if (String(error).includes("404")) return { skipped: true, reason: "already-missing" };
    throw error;
  }

  if (!sha) return { skipped: true, reason: "sha-missing" };
  await githubRequest(env, "DELETE", path, {
    message: `Delete media ${path}`,
    sha,
    branch
  });
  return { deleted: true, path };
}

async function downloadTelegramFile(env, fileId, originalType = "image") {
  const info = await telegramApi(env, "getFile", { file_id: fileId });
  const filePath = info.result?.file_path;
  if (!filePath) throw new Error("Telegram file path not returned.");

  const token = cleanText(env.TELEGRAM_BOT_TOKEN);
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let type = response.headers.get("content-type") || "";
  if (!type || type === "application/octet-stream") {
    type = originalType === "video"
      ? mimeFromExtension(fileExtension(filePath, "mp4"))
      : "image/jpeg";
  }
  if (originalType === "image" && !type.startsWith("image/")) type = "image/jpeg";

  let fallback = originalType === "video" ? "video.mp4" : "image.jpg";
  let originalName = filePath.split("/").pop() || fallback;
  if (originalType === "image" && !/\.[a-z0-9]{2,8}$/i.test(originalName)) originalName += ".jpg";
  if (originalType === "video" && !/\.[a-z0-9]{2,8}$/i.test(originalName)) originalName += ".mp4";
  return { bytes, type, filename: originalName };
}

async function verifyAdminSession(request, env) {
  const token = cookieValue(request, "ss_admin_session");
  if (!token) return false;
  const row = await env.DB.prepare("SELECT token, expires_at FROM admin_sessions WHERE token = ? LIMIT 1").bind(token).first();
  if (!row) return false;
  const expired = Date.parse(String(row.expires_at).replace(" ", "T") + (String(row.expires_at).includes("Z") ? "" : "Z")) <= Date.now();
  if (expired) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
    return false;
  }
  return true;
}

function adminPassword(env) {
  return cleanText(env.ADMIN_PASSWORD) || cleanText(env.TELEGRAM_ADMIN_CODE);
}

async function adminLogin(request, env) {
  const body = await parseBody(request);
  const password = cleanText(body.password || body.code || body.admin_code, 200);
  const expected = adminPassword(env);
  if (!expected || password !== expected) return api({ ok: false, error: "Invalid admin password." }, request, 401);

  const token = newToken();
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  await env.DB.prepare("INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)").bind(token, expires).run();
  return withCors(json({ ok: true, admin: true, authenticated: true }), request, {
    "Set-Cookie": `ss_admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
  });
}

async function adminLogout(request, env) {
  const token = cookieValue(request, "ss_admin_session");
  if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
  return withCors(new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Set-Cookie": "ss_admin_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    }
  }), request);
}

async function prepareProductInput(body, existing = {}) {
  const get = (name, fallback = "") => body instanceof FormData ? body.get(name) : body?.[name] ?? fallback;
  const title = cleanText(get("title", existing.title), 300);
  const description = cleanText(get("description", existing.description), 10000);
  const affiliate_url = cleanText(get("affiliate_url", existing.affiliate_url), 3000);
  const category = cleanText(get("category", existing.category), 100);
  const published = isTruthy(get("published", existing.published ?? 1)) ? 1 : 0;
  const featured = isTruthy(get("featured", existing.featured ?? 0)) ? 1 : 0;

  if (!title) throw new Error("Title is required.");
  if (!affiliate_url) throw new Error("Affiliate URL is required.");
  if (!isValidCategory(category)) throw new Error("Invalid category.");

  const imageUrls = [];
  for (let i = 1; i <= 5; i += 1) {
    const value = cleanText(get(`image${i}_url`, existing[`image${i}_url`] || ""), 5000);
    if (value) imageUrls.push(value);
  }
  return {
    title,
    description,
    affiliate_url,
    category,
    image1_url: imageUrls[0] || "",
    image2_url: imageUrls[1] || "",
    image3_url: imageUrls[2] || "",
    image4_url: imageUrls[3] || "",
    image5_url: imageUrls[4] || "",
    video_url: cleanText(get("video_url", existing.video_url || ""), 5000),
    published,
    featured
  };
}

async function createWebsiteProduct(request, env) {
  const body = await parseBody(request);
  const input = await prepareProductInput(body);
  const timestamp = nowSql();
  const result = await env.DB.prepare(`
    INSERT INTO products (
      title, description, affiliate_url, category,
      image1_url, image2_url, image3_url, image4_url, image5_url,
      video_url, published, featured, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.title, input.description, input.affiliate_url, input.category,
    input.image1_url, input.image2_url, input.image3_url, input.image4_url, input.image5_url,
    input.video_url, input.published, input.featured, timestamp, timestamp
  ).run();

  const product = await getProduct(env, result.meta.last_row_id);
  let telegram = null;
  if (Number(product.published) === 1) {
    telegram = await postProductToTelegramGroups(product, env);
  }
  return api({ ok: true, product: productPublic(product), telegram }, request, 201);
}

async function updateWebsiteProduct(request, env, id) {
  const existing = await getProduct(env, id);
  if (!existing) return api({ ok: false, error: "Product not found." }, request, 404);
  const body = await parseBody(request);
  const input = await prepareProductInput(body, existing);
  const oldMedia = productImages(existing);

  await env.DB.prepare(`
    UPDATE products SET
      title = ?, description = ?, affiliate_url = ?, category = ?,
      image1_url = ?, image2_url = ?, image3_url = ?, image4_url = ?, image5_url = ?,
      video_url = ?, published = ?, featured = ?, updated_at = ?
    WHERE id = ?
  `).bind(
    input.title, input.description, input.affiliate_url, input.category,
    input.image1_url, input.image2_url, input.image3_url, input.image4_url, input.image5_url,
    input.video_url, input.published, input.featured, nowSql(), id
  ).run();

  const updated = await getProduct(env, id);
  const newMedia = new Set(productImages(updated));
  for (const url of oldMedia) {
    if (url && !newMedia.has(url)) {
      try { await githubDeleteByRawUrl(env, url); } catch { /* do not fail a database update because optional media cleanup failed */ }
    }
  }
  return api({ ok: true, product: productPublic(updated) }, request);
}

async function deleteWebsiteProduct(request, env, id) {
  const product = await getProduct(env, id);
  if (!product) return api({ ok: false, error: "Product not found." }, request, 404);
  await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  for (const url of [...productImages(product), product.video_url || ""]) {
    try { await githubDeleteByRawUrl(env, url); } catch { /* optional cleanup */ }
  }
  return api({ ok: true, deleted: Number(id) }, request);
}

async function listPublicProducts(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (id) {
    const product = await getProduct(env, id);
    if (!product || Number(product.published) !== 1) return api({ ok: false, error: "Product not found." }, request, 404);
    return api({ ok: true, product: productPublic(product) }, request);
  }

  const search = cleanText(url.searchParams.get("search"), 200);
  const category = cleanText(url.searchParams.get("category"), 100);
  const featuredOnly = isTruthy(url.searchParams.get("featured"));
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 30);

  let sql = "SELECT * FROM products WHERE published = 1";
  const params = [];
  if (search) {
    sql += " AND (title LIKE ? OR description LIKE ? OR category LIKE ?)";
    const q = `%${search}%`;
    params.push(q, q, q);
  }
  if (category && isValidCategory(category)) {
    sql += " AND category = ?";
    params.push(category);
  }
  if (featuredOnly) sql += " AND featured = 1";
  sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
  params.push(limit);

  const result = await env.DB.prepare(sql).bind(...params).all();
  return api({ ok: true, products: (result.results || []).map(productPublic) }, request);
}

async function listAdminProducts(request, env) {
  if (!await verifyAdminSession(request, env)) return api({ ok: false, error: "Unauthorized." }, request, 401);
  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), 1, 200, 100);
  const result = await env.DB.prepare("SELECT * FROM products ORDER BY created_at DESC, id DESC LIMIT ?").bind(limit).all();
  return api({ ok: true, products: (result.results || []).map(productPublic) }, request);
}

async function handleUploadMedia(request, env) {
  if (!await verifyAdminSession(request, env)) return api({ ok: false, error: "Unauthorized." }, request, 401);
  const body = await request.formData();
  const file = body.get("file") || body.get("image") || body.get("media");
  if (!(file instanceof File)) return api({ ok: false, error: "No media file provided." }, request, 400);
  if (file.size > 20 * 1024 * 1024) return api({ ok: false, error: "File is too large. Maximum 20 MB." }, request, 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = file.type || mimeFromExtension(fileExtension(file.name, "jpg"));
  const result = await githubUpload(env, bytes, file.name, contentType);
  return api({ ok: true, ...result }, request);
}

async function handleTelegramCallback(update, env) {
  const callback = update.callback_query;
  const chatId = callback?.message?.chat?.id;
  const userId = callback?.from?.id;
  const data = String(callback?.data || "");
  if (!chatId) return;

  await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id });
  const s = await getTelegramSession(env, chatId, userId);
  const promoterLink = await getPromoterTelegramLink(env, userId);
  const promoterAccess = callback?.message?.chat?.type === "private" && promoterLink && String(promoterLink.chat_id) === String(chatId);
  const adminAccess = s.unlocked && isOwnerAdmin(env, callback?.message?.chat, userId);
  if (!adminAccess && !promoterAccess) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "🔒 Connect an approved promoter account first with /connect." });
    return;
  }

  if (data.startsWith("adminad:")) {
    if (!adminAccess || !isOwnerAdmin(env, callback?.message?.chat, userId)) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "🔒 Only the authenticated bot owner can manage promotional broadcasts." });
      return;
    }
    const action = data.slice("adminad:".length);
    try {
      if (action === "send") {
        const result = await broadcastAdminAdToGroups(env);
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: "📣 <b>Promotion sent</b>\n\nGroups: " + result.total + "\nSent: " + result.sent + "\nFailed: " + result.failed, parse_mode: "HTML" });
      } else if (["daily", "weekly", "monthly"].includes(action)) {
        const next = await saveAdminAdSchedule(env, action);
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: "✅ <b>" + action.charAt(0).toUpperCase() + action.slice(1) + " promotion schedule enabled.</b>\n\nNext send: " + next + "\n\nUse /adminad and choose Disable schedule to stop it.", parse_mode: "HTML" });
      } else if (action === "off") {
        await env.DB.prepare("UPDATE telegram_admin_ad_schedule SET active=0, updated_at=? WHERE id=1").bind(nowSql()).run();
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: "⏸ Promotional schedule disabled. You can still send manually with /adminad." });
      }
    } catch (error) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "❌ " + escapeTelegramHtml(error.message || "Could not complete that action."), parse_mode: "HTML" });
    }
    return;
  }

  if (data === "adsrun:free" || data === "adsrun:paid") {
    if (callback?.message?.chat?.type !== "private" || !promoterAccess) {
      await telegramApi(env, "sendMessage", {chat_id:chatId,text:"🔒 Connect your promoter account in a private chat before choosing a plan."});
      return;
    }
    await ensureAdsAccount(env,userId);
    if (data === "adsrun:free") {
      await env.DB.prepare("UPDATE telegram_ads_accounts SET plan='free',paid_until=NULL,updated_at=? WHERE telegram_user_id=?").bind(nowSql(),String(userId)).run();
      const count=await env.DB.prepare("SELECT COUNT(*) AS total FROM telegram_ads_verified_chats WHERE telegram_user_id=? AND active=1").bind(String(userId)).first();
      await telegramApi(env,"sendMessage",{chat_id:chatId,text:"🆓 <b>Free Plan</b>\\n\\nVerify 3 Telegram groups/supergroups where you are an admin and this bot can post. Use /adsverify inside each group.\\n\\n📣 Ads every 60 minutes. Each product gets 10 promotions, then a 40-minute cooldown.\\n🔁 Every 20 days, add 3 more groups. All previously verified groups stay active and continue receiving ads.\\n\\nVerified groups: "+Number(count?.total||0)+".",parse_mode:"HTML"});
    } else {
      const qr=await getAdsQr(env);
      if(!qr){await telegramApi(env,"sendMessage",{chat_id:chatId,text:"⭐ Paid Plan QR is not configured yet. Please try again later."});return;}
      const session=await getTelegramSession(env,chatId,userId);
      session.step="ads_payment_utr";session.data={};
      await saveTelegramSession(env,session);
      await telegramApi(env,"sendPhoto",{chat_id:chatId,photo:qr,caption:"⭐ <b>Paid Plan — ₹150 / 30 days</b>\\n\\nScan this QR to pay. After payment, send your UTR/reference number here. Your subscription starts only after admin approval.",parse_mode:"HTML"});
    }
    return;
  }

  if (data.startsWith("adsapprove:") || data.startsWith("adsreject:")) {
    if (!adminAccess || !isOwnerAdmin(env,callback?.message?.chat,userId)) {
      await telegramApi(env,"sendMessage",{chat_id:chatId,text:"🔒 Only the authenticated bot owner can review payment requests."});
      return;
    }
    const approve=data.startsWith("adsapprove:");
    const id=data.split(":")[1];
    try {
      const result=await reviewAdsPayment(env,id,userId,approve);
      await telegramApi(env,"editMessageReplyMarkup",{chat_id:chatId,message_id:callback.message.message_id,reply_markup:{inline_keyboard:[]}});
      await telegramApi(env,"sendMessage",{chat_id:chatId,text:approve?"✅ Payment approved. Paid plan active until "+result.until+".":"❌ Payment request rejected."});
    } catch(error) {
      await telegramApi(env,"sendMessage",{chat_id:chatId,text:"⚠️ "+escapeTelegramHtml(error.message||"Could not review payment.")});
    }
    return;
  }

  if (data.startsWith("cat:")) {
    const category = data.slice(4);
    if (!isValidCategory(category)) return;
    s.data.category = category;
    s.step = "images";
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: `Category selected: ${category}\n\nSend up to 5 direct image URLs (https://...). Type done when finished, or skip to continue without images.`
    });
  }
}

async function verifyAdsGroup(env, message) {
  const chat = message.chat;
  const user = message.from;
  const chatId = String(chat?.id || "");
  const telegramUserId = String(user?.id || "");
  if (!telegramUserId || !chatId) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "I couldn't identify the person running this command. Please use /adsverify from your own Telegram account." });
    return;
  }
  if (chat.type === "channel") {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Channel verification is not supported by this command yet. Please verify a group or supergroup instead." });
    return;
  }
  if (chat.type !== "group" && chat.type !== "supergroup") {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Run /adsverify inside the group you want to register, not in a private chat." });
    return;
  }

  const link = await getPromoterTelegramLink(env, telegramUserId);
  if (!link) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "🔒 First open a private chat with this bot, use /connect, and connect your approved Shopper's Suggestions promoter account. Then return here and run /adsverify." });
    return;
  }

  let member;
  let botInfo;
  try {
    [member, botInfo] = await Promise.all([
      telegramApi(env, "getChatMember", { chat_id: chatId, user_id: Number(telegramUserId) }),
      telegramApi(env, "getMe", {})
    ]);
  } catch (error) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "❌ I couldn't verify group permissions. Make sure the bot is still in this group, then try again." });
    return;
  }

  const userStatus = member.result?.status;
  if (!["creator", "administrator"].includes(userStatus)) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "❌ Only a group owner or administrator can register this group for their ads account." });
    return;
  }

  let botMember;
  try {
    botMember = await telegramApi(env, "getChatMember", { chat_id: chatId, user_id: botInfo.result.id });
  } catch {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "❌ I couldn't check my own group permissions. Please make me a group administrator and try again." });
    return;
  }
  const botStatus = botMember.result?.status;
  const canPost = botStatus === "creator" || botStatus === "administrator";
  if (!canPost) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "❌ I don't have permission to post in this group. Give me permission to send messages, then run /adsverify again." });
    return;
  }

  const existingOwner = await env.DB.prepare("SELECT telegram_user_id FROM telegram_ads_verified_chats WHERE chat_id = ? AND active = 1 LIMIT 1")
    .bind(chatId).first();
  if (existingOwner && String(existingOwner.telegram_user_id) !== telegramUserId) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "❌ This group is already registered to another Shopper's Suggestions account. It cannot be claimed by a different account." });
    return;
  }
  const existing = await env.DB.prepare("SELECT chat_id FROM telegram_ads_verified_chats WHERE chat_id = ? AND telegram_user_id = ? AND active = 1 LIMIT 1")
    .bind(chatId, telegramUserId).first();
  if (existing) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "✅ This group is already verified for your Shopper's Suggestions account." });
    return;
  }

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS total FROM telegram_ads_verified_chats WHERE telegram_user_id = ? AND active = 1")
    .bind(telegramUserId).first();
  const currentCount = Number(countRow?.total || 0);
  const account = await ensureAdsAccount(env, telegramUserId);
  const nextBatchAt = account?.next_group_batch_at ? Date.parse(String(account.next_group_batch_at).replace(" ", "T") + "Z") : 0;
  if (currentCount >= 3 && currentCount % 3 === 0 && nextBatchAt && nextBatchAt > Date.now()) {
    const daysLeft = Math.ceil((nextBatchAt - Date.now()) / 86400000);
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "⏳ Your next 3-group batch opens in about " + daysLeft + " day(s). All previously verified groups stay active and continue receiving ads." });
    return;
  }
  try {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "discover the best by shopper’s suggestions!" });
  } catch {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "❌ Telegram could not send the verification message, so this group has not been registered. Check my posting permission and try again." });
    return;
  }
  const newCount = currentCount + 1;
  const batchNumber = Math.floor(currentCount / 3) + 1;
  const batchComplete = newCount % 3 === 0;
  const nextBatch = batchComplete ? adsSqlAfterDays(20) : (account?.next_group_batch_at || null);
  await env.DB.prepare("INSERT INTO telegram_ads_verified_chats (chat_id,telegram_user_id,chat_type,title,verified_at,active,batch_number) VALUES (?,?,?,?,?,1,?) ON CONFLICT(chat_id) DO UPDATE SET telegram_user_id=excluded.telegram_user_id,chat_type=excluded.chat_type,title=excluded.title,verified_at=excluded.verified_at,active=1,batch_number=excluded.batch_number")
    .bind(chatId, telegramUserId, chat.type, cleanText(chat.title || chat.username || "Telegram group", 200), nowSql(), batchNumber).run();
  await env.DB.prepare("UPDATE telegram_ads_accounts SET groups_in_batch=?,batch_number=?,next_group_batch_at=?,next_run_at=CASE WHEN ? >= 3 THEN ? ELSE next_run_at END,updated_at=? WHERE telegram_user_id=?")
    .bind(newCount % 3, batchNumber, nextBatch, newCount, nowSql(), nowSql(), telegramUserId).run();
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: "✅ Group verified (" + newCount + " total). " +
      (batchComplete ? "This batch is complete. You can add 3 more groups in 20 days. All groups remain active for ads." : "Add " + (3 - (newCount % 3)) + " more group(s) in this batch. Previously verified groups stay active.")
  });
}

async function handleTelegramUpdate(update, env) {
  const message =
    update?.message ||
    update?.channel_post ||
    update?.edited_channel_post ||
    update?.edited_message;

  if (!message) return;

  const chat = message.chat;
  const chatId = chat?.id;
  const user = message.from || null;
  const userId = user?.id || message.sender_chat?.id || "";

  if (chatId == null) return;

  await recordTelegramUpdateChat(env, update);

  const text = cleanText(
    message.text || message.caption || "",
    5000
  );
  const command = telegramCommand(text);
  const args = telegramCommandArgs(text);
  const s = await getTelegramSession(env, chatId, userId || chatId);

  // A normal channel post is recorded but is not treated as an interactive
  // bot command unless the post actually contains a command.
  const isChannelPost = chat?.type === "channel";
  if (isChannelPost && !text.trim().startsWith("/")) return;

  if (command === "adsverify") {
    await verifyAdsGroup(env, message);
    return;
  }

  if (s.step === "ads_payment_utr" && chat?.type === "private" && user?.id && text && !text.startsWith("/")) {
    await handleAdsPaymentUtr(env, s, chatId, userId, text);
    return;
  }


  if (command === "explain") {
    if (chat?.type !== "private" || !user?.id) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Please open a private chat with the bot and use /explain there." });
      return;
    }
    s.step = "explain_chat";
    s.data = { explain_history: [] };
    await saveTelegramSession(env, s);
    await sendExplainAiReply(env, s, chatId, userId, "Start my beginner-friendly affiliate marketing lesson. Include the website and explain the first steps.", true);
    return;
  }

  if (s.step === "explain_chat" && text && !text.startsWith("/")) {
    if (chat?.type !== "private" || !user?.id) return;
    await sendExplainAiReply(env, s, chatId, userId, text, false);
    return;
  }

  if (command === "cancel") {
    await resetTelegramProductDraft(env, chatId);
    s.step = "idle";
    s.data = {};
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Current action cancelled." });
    return;
  }

  if (command === "connect") {
    if (chat?.type !== "private" || !user?.id) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "For account security, connect your API key in a private chat with this bot." });
      return;
    }
    s.step = "connect_api_key";
    s.data = {};
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "🔐 Send your Shopper's Suggestions Promoter API key in your next message. It will be verified and stored encrypted. Never send your key in a group." });
    return;
  }

  if (s.step === "connect_api_key" && text && !text.startsWith("/")) {
    if (chat?.type !== "private" || !user?.id || !/^ss_live_[a-f0-9]{64}$/i.test(text)) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "❌ That doesn't look like a valid API key. Send the key again, or /cancel." });
      return;
    }
    try { await telegramApi(env, "deleteMessage", { chat_id: chatId, message_id: message.message_id }); } catch {}
    try {
      if (!await verifyPromoterApiKey(text)) {
        s.step = "idle";
        await saveTelegramSession(env, s);
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: "❌ API key rejected. Check that it is active and belongs to an approved promoter account, then try /connect again." });
        return;
      }
      await connectPromoterTelegram(env, chatId, user.id, text);
      s.step = "idle";
      s.data = {};
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "✅ Your promoter account is connected securely. Use /addproduct to add a product. Disconnect anytime with /disconnect." });
    } catch (error) {
      s.step = "idle";
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: `⚠️ Could not connect: ${escapeTelegramHtml(error.message || "Unknown error")}`, parse_mode: "HTML" });
    }
    return;
  }


  if (command === "myproducts") {
    if (chat?.type !== "private" || !user?.id) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Use /myproducts in a private chat with the bot." });
      return;
    }
    try {
      const products = await getTelegramPromoterProducts(env, chatId, user.id);
      if (!products.length) {
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: "You haven't uploaded any products yet. Use /addproduct to publish your first one." });
        return;
      }
      const lines = products.slice(0, 30).map(p => {
        const status = p.published ? "Live" : "Not live";
        return `#${p.id} — ${escapeTelegramHtml(p.title)}\n${escapeTelegramHtml(p.category)} · ${status}`;
      });
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: `🛍️ <b>Your products (${products.length})</b>\n\n` + lines.join("\n\n") + `\n\nUse /editproduct ID or /deleteproduct ID.`,
        parse_mode: "HTML",
        disable_web_page_preview: true
      });
    } catch (error) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: `❌ ${escapeTelegramHtml(error.message || "Could not load products.")}`, parse_mode: "HTML" });
    }
    return;
  }

  if (command === "editproduct") {
    if (chat?.type !== "private" || !user?.id) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Use /editproduct in a private chat with the bot." });
      return;
    }
    try {
      const products = await getTelegramPromoterProducts(env, chatId, user.id);
      if (!args) {
        const lines = products.map(p => `#${p.id} — ${escapeTelegramHtml(p.title)}`);
        await telegramApi(env, "sendMessage", {
          chat_id: chatId,
          text: lines.length ? `Send /editproduct ID for the product you want to edit:\n\n${lines.slice(0,30).join("\n")}` : "You have no products to edit.",
          parse_mode: "HTML"
        });
        return;
      }
      const id = Number.parseInt(args, 10);
      const product = products.find(p => Number(p.id) === id);
      if (!product) throw new Error("That product is not in your account. Use /myproducts to see your product IDs.");
      s.data = { editProductId: id, editChanges: {} };
      s.step = "edit_title";
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: `Editing #${id}. Send a new title, or type skip to keep the current title:\n\n${cleanText(product.title, 250)}` });
    } catch (error) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: `❌ ${escapeTelegramHtml(error.message || "Could not start editing.")}`, parse_mode: "HTML" });
    }
    return;
  }

  if (command === "deleteproduct") {
    if (chat?.type !== "private" || !user?.id) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Use /deleteproduct in a private chat with the bot." });
      return;
    }
    try {
      const products = await getTelegramPromoterProducts(env, chatId, user.id);
      if (!args) {
        const lines = products.map(p => `#${p.id} — ${escapeTelegramHtml(p.title)}`);
        await telegramApi(env, "sendMessage", {
          chat_id: chatId,
          text: lines.length ? `Send /deleteproduct ID to choose a product:\n\n${lines.slice(0,30).join("\n")}` : "You have no products to delete.",
          parse_mode: "HTML"
        });
        return;
      }
      const id = Number.parseInt(String(args).trim().replace(/^#/, ""), 10);
      if (!Number.isSafeInteger(id) || id < 1) throw new Error("Use /deleteproduct followed by the product ID, for example /deleteproduct 123.");
      const product = products.find(p => Number(p.id) === id);
      if (!product) throw new Error("That product is not in your account. Use /myproducts to see your product IDs.");
      s.data = { deleteProductId: id };
      s.step = "delete_confirm";
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: `Delete “${cleanText(product.title, 200)}” (#${id})? Reply YES to confirm, or /cancel to keep it.` });
    } catch (error) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: `❌ ${escapeTelegramHtml(error.message || "Could not start deletion.")}`, parse_mode: "HTML" });
    }
    return;
  }

  if (command === "disconnect") {
    if (chat?.type !== "private" || !user?.id) return;
    await env.DB.prepare("DELETE FROM telegram_promoter_links WHERE telegram_user_id=?").bind(String(user.id)).run();
    s.step = "idle";
    s.data = {};
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "🔌 Your promoter account has been disconnected." });
    return;
  }

  if (command === "addproduct") {
    if (chat?.type !== "private" || !user?.id) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Use /addproduct in a private chat with the official bot." });
      return;
    }
    const link = await getPromoterTelegramLink(env, user.id);
    if (!link || String(link.chat_id) !== String(chatId)) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Connect your promoter account first using /connect." });
      return;
    }
    s.user_id = String(user.id);
    s.step = "title";
    s.data = { mode: "promoter", images: [] };
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "🛍️ Let's add a product. Send its title." });
    return;
  }

  if (command === "start") {
    if (args.trim().toLowerCase() === "explain" && chat?.type === "private" && user?.id) {
      s.step = "explain_chat";
      s.data = { explain_history: [] };
      await saveTelegramSession(env, s);
      await sendExplainAiReply(env, s, chatId, userId, "Start my beginner-friendly affiliate marketing lesson. Include the website and explain the first steps.", true);
      return;
    }
    if (isOwnerAdmin(env, chat, userId)) {
      await setTelegramCommandMenu(env, s.unlocked ? adminBotCommands() : publicBotCommands(), {
        type: "chat", chat_id: chatId
      });
    } else {
      await setTelegramCommandMenu(env, publicBotCommands());
    }
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `👋 <b>Welcome to Shopper's Suggestions!</b>\n\n` +
        `🌐 <a href="https://shopperssuggestions.online">Shopper Suggestions</a> is a product-discovery and affiliate platform. Promoters publish product listings on the website; visitors discover them and visit the retailer through the product link. The retailer handles orders and delivery.\n\n` +
        `Use /help to see every bot command, or /explain for a step-by-step affiliate marketing lesson.\n\n` +
        `To manage your own listings, connect your approved promoter account with /connect.`,
      parse_mode: "HTML"
    });
    return;
  }

  if (command === "profile") {
    if (chat?.type !== "private" || !user?.id) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "👤 Open a private chat with the bot to view your connected profile." });
      return;
    }
    try { await sendTelegramConnectedProfile(env, chatId, user.id); }
    catch (error) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "⚠️ " + escapeTelegramHtml(error.message || "Could not load your profile."), parse_mode: "HTML" });
    }
    return;
  }

  if (command === "products" || command === "browse") {
    await sendLatest(env, chatId);
    return;
  }

  if (command === "help") {
    await sendHelp(env, chatId);
    return;
  }

  if (command === "adsrun") {
    if (chat?.type !== "private" || !user?.id) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Open a private chat with the bot and use /adsrun there." });
      return;
    }
    try {
      await getTelegramPromoterProducts(env, chatId, user.id);
    } catch (error) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "🔒 Connect your approved Shopper's Suggestions promoter account first with /connect." });
      return;
    }
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "📢 <b>Shopper's Suggestions Ads</b>\n\nChoose a promotion plan:\n\n🆓 <b>Free Plan</b> — 3 groups initially, then 3 more every 20 days; all groups stay active. Ads every 60 minutes.\n\n⭐ <b>Paid Plan</b> — ₹150 / 30 days, activated after admin approval. Ads every 30 minutes.\n\nChoose below to continue.",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[
        { text: "🆓 Free Plan", callback_data: "adsrun:free" },
        { text: "⭐ Paid Plan — ₹150/month", callback_data: "adsrun:paid" }
      ]] }
    });
    return;
  }

  const allowedCommands = new Set(["start","help","connect","profile","products","browse","latest","search","categories","category","cat","featured","special","product","link","share","addproduct","myproducts","editproduct","deleteproduct","disconnect","adsrun","adsverify","myid","getid","id","cancel","admin","lock","broadcast","globalgroupmsg","globalusermsg","sendto","channel","chats","chatlist","refreshchat","registerchat","stats","paymentdts","setadsqr","showadsqr","removeadsqr","adminad"]);
  if (text.startsWith("/") && !allowedCommands.has(command)) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "That command is no longer available. Use /help to see the new command list." });
    return;
  }

  if (command === "getid" || command === "id") {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `🆔 <b>This Telegram chat</b>\n\n` +
        `ID: <code>${escapeHtml(chatId)}</code>\n` +
        `Type: <b>${escapeTelegramHtml(chat?.type || "unknown")}</b>\n\n` +
        `✅ This ID has been saved automatically.`,
      parse_mode: "HTML"
    });
    return;
  }

  if (command === "myid") {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `👤 <b>Your Telegram user ID</b>\n\n` +
        `<code>${escapeHtml(user?.id || "Not available in this chat")}</code>`,
      parse_mode: "HTML"
    });
    return;
  }

  if (command === "categories") {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `📚 <b>Available categories</b>\n\n` +
        CATEGORIES.map(c => `• ${escapeTelegramHtml(c)}`).join("\n") +
        `\n\nUse <code>/category Tech</code> to receive the products in that category.`,
      parse_mode: "HTML"
    });
    return;
  }

  if (command === "search") {
    if (!args) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: `🔎 Example:\n<code>/search wireless earbuds</code>`,
        parse_mode: "HTML"
      });
      return;
    }
    await sendSearchResults(env, chatId, args);
    return;
  }

  if (command === "category" || command === "cat") {
    if (!args) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: `📂 Example:\n<code>/category Tech</code>`,
        parse_mode: "HTML"
      });
      return;
    }
    await sendCategoryResults(env, chatId, args);
    return;
  }

  if (command === "latest") {
    await sendLatest(env, chatId);
    return;
  }

  if (command === "featured" || command === "special") {
    await sendFeatured(env, chatId);
    return;
  }

  if (command === "product" || command === "link" || command === "share") {
    const id = Number.parseInt(args, 10);
    if (!Number.isFinite(id)) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: `<code>/${command} 123</code>`,
        parse_mode: "HTML"
      });
      return;
    }

    const product = await getProduct(env, id);
    if (!product || Number(product.published) !== 1) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: "❌ Product not found."
      });
      return;
    }

    if (command === "link" || command === "share") {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `🔗 <b>${escapeTelegramHtml(product.title)}</b>\n\n` +
          `<a href="${productShareUrl(product.id)}">Open product page</a>`,
        parse_mode: "HTML",
        reply_markup: productButton(product),
        disable_web_page_preview: false
      });
      return;
    }

    await sendProductToChat(env, chatId, product);
    return;
  }

  if (command === "feedback" || command === "request") {
    const kind = command === "feedback" ? "Feedback" : "Request";

    if (!args) {
      s.step = command;
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          command === "feedback"
            ? `💬 Send your feedback in your next message.`
            : `💡 Send your request or idea in your next message.`
      });
      return;
    }

    try {
      await sendFeedbackToOwner(env, chat, user, kind, args);
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: `✅ <b>${kind} sent.</b> Thanks for helping improve Shopper's Suggestions!`,
        parse_mode: "HTML"
      });
    } catch (error) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `⚠️ Could not deliver your ${kind.toLowerCase()}.\n\n` +
          `${escapeTelegramHtml(error.message || "Unknown error")}`,
        parse_mode: "HTML"
      });
    }
    return;
  }

  if (
    (s.step === "feedback" || s.step === "request") &&
    text &&
    !text.startsWith("/")
  ) {
    const kind = s.step === "feedback" ? "Feedback" : "Request";
    s.step = "idle";
    await saveTelegramSession(env, s);

    try {
      await sendFeedbackToOwner(env, chat, user, kind, text);
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: `✅ <b>${kind} sent.</b>`,
        parse_mode: "HTML"
      });
    } catch (error) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `⚠️ Could not deliver your ${kind.toLowerCase()}.\n\n` +
          `${escapeTelegramHtml(error.message || "Unknown error")}`,
        parse_mode: "HTML"
      });
    }
    return;
  }

  // Admin authentication is intentionally limited to the owner's private chat.
  if (s.step === "ads_qr_upload" && s.unlocked && isOwnerAdmin(env,chat,userId)) {
    const photos=message.photo||[];
    const photo=photos.length?photos[photos.length-1]:null;
    if(!photo?.file_id){await telegramApi(env,"sendMessage",{chat_id:chatId,text:"Send the payment QR as a photo, or /cancel."});return;}
    await env.DB.prepare("INSERT INTO telegram_ads_settings (setting_key,setting_value,updated_at) VALUES ('payment_qr',?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at").bind(photo.file_id,nowSql()).run();
    s.step="idle";s.data={};await saveTelegramSession(env,s);
    await telegramApi(env,"sendMessage",{chat_id:chatId,text:"✅ Paid Ads QR saved. Promoters can now choose Paid Plan in /adsrun."});
    return;
  }

  if (command === "admin") {
    if (!isOwnerAdmin(env, chat, userId)) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: "🔒 Admin access is only available in the owner's private bot chat."
      });
      return;
    }

    // Show the owner-only admin command menu before account verification,
    // so the commands are visible while the owner completes /connect.
    await setTelegramCommandMenu(env, adminBotCommands(), {
      type: "chat", chat_id: chatId
    });

    try {
      const verified = await verifyTelegramAdminAccount(env, chatId, userId);
      if (!verified) {
        await telegramApi(env, "sendMessage", {
          chat_id: chatId,
          text: "🔐 First connect the Shopper's Suggestions API key belonging to your admin website account with /connect. Then send /admin again."
        });
        return;
      }
      await unlockTelegram(env, chatId, userId);
      await setTelegramCommandMenu(env, adminBotCommands(), {
        type: "chat", chat_id: chatId
      });
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `🔓 <b>Admin unlocked.</b>\n\n` +
          `Verified using your Shopper's Suggestions website account.\n\n` +
          `/addproduct\n` +
          `/broadcast message — Message all chats\n` +
          `/globalgroupmsg message — Message all groups/channels\n` +
          `/globalusermsg message — Message all private users\n` +
          `/sendto CHAT_ID message\n` +
          `/channel CHAT_ID message\n` +
          `/chats — List registered chats\n` +
          `/refreshchat CHAT_ID\n` +
          `/stats — Show bot statistics\n` +
          `/paymentdts — Review payment requests\n` +
          `/setadsqr — Set paid plan QR\n` +
          `/showadsqr — View current QR\n` +
          `/removeadsqr — Remove current QR\n` +
          `/adminad — Send or schedule the group promotion\n` +
          `/lock — Lock admin tools`,
        parse_mode: "HTML"
      });
    } catch (error) {
      console.error("Website API admin verification failed", String(error?.message || error));
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Could not verify your website account right now. Please try /admin again shortly."
      });
    }
    return;
  }

  if (command === "lock") {
    if (!isOwnerAdmin(env, chat, userId)) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: "🔒 Admin access is only available in the owner's private bot chat."
      });
      return;
    }
    await lockTelegram(env, chatId, userId);
    await setTelegramCommandMenu(env, publicBotCommands(), {
      type: "chat", chat_id: chatId
    });
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "🔒 Admin tools locked."
    });
    return;
  }

  // Promoter product drafts are normal-user actions, not admin commands.
  // Allow only the active private-chat draft owner to continue the upload flow.
  const promoterUploadActive =
    chat?.type === "private" &&
    !!user?.id &&
    // Telegram private-chat IDs equal the user's ID. Use that stable identity
    // instead of the mutable session user_id, which can be stale after reconnects.
    String(chatId) === String(userId) &&
    s.data?.mode === "promoter" &&
    ["title", "description", "affiliate", "category", "images", "video", "confirm"].includes(s.step);

  // Anything below this line is admin-only, except messages continuing that promoter draft.
  if ((!s.unlocked || !isOwnerAdmin(env, chat, userId)) && !promoterUploadActive) {
    if (text.startsWith("/")) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: `🔐 This command requires admin access. Use /admin in your private bot chat.`
      });
    }
    return;
  }

  if (command === "adminad") {
    const action = args.trim().toLowerCase();
    try {
      if (action === "now" || action === "send") {
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: "📣 Sending the Shopper's Suggestions promotion to all registered groups…" });
        const result = await broadcastAdminAdToGroups(env);
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: "📣 <b>Promotion finished</b>\n\nGroups: " + result.total + "\nSent: " + result.sent + "\nFailed: " + result.failed, parse_mode: "HTML" });
        return;
      }
      if (["daily", "weekly", "monthly"].includes(action)) {
        const next = await saveAdminAdSchedule(env, action);
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: "✅ <b>" + action.charAt(0).toUpperCase() + action.slice(1) + " promotion schedule enabled.</b>\n\nNext send: " + next + "\n\nUse /adminad off to stop it.", parse_mode: "HTML" });
        return;
      }
      if (action === "off" || action === "stop") {
        await env.DB.prepare("UPDATE telegram_admin_ad_schedule SET active=0, updated_at=? WHERE id=1").bind(nowSql()).run();
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: "⏸ Promotional schedule disabled." });
        return;
      }
      const schedule = await env.DB.prepare("SELECT frequency,next_run_at,active FROM telegram_admin_ad_schedule WHERE id=1 LIMIT 1").first();
      const status = schedule?.active ? (schedule.frequency + " — next send: " + schedule.next_run_at) : "No automatic schedule is active.";
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: "<b>Shopper's Suggestions group promotion</b>\n\nWant to learn how affiliate marketing works?\n\nDiscover the basics, explore useful products, and learn how to get started with Shopper's Suggestions.\n\nStart learning today!\n\n🌐 shopperssuggestions.online\n\n<b>Current schedule:</b> " + escapeTelegramHtml(status) + "\n\nChoose an action below, or use /adminad now, /adminad daily, /adminad weekly, /adminad monthly, or /adminad off.",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "📣 Send to groups now", callback_data: "adminad:send" }],
          [{ text: "Daily", callback_data: "adminad:daily" }, { text: "Weekly", callback_data: "adminad:weekly" }, { text: "Monthly", callback_data: "adminad:monthly" }],
          [{ text: "Disable schedule", callback_data: "adminad:off" }]
        ] }
      });
    } catch (error) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "❌ " + escapeTelegramHtml(error.message || "Could not load the promotion controls."), parse_mode: "HTML" });
    }
    return;
  }

  if (command === "setadsqr") {
    s.step="ads_qr_upload";s.data={};await saveTelegramSession(env,s);
    await telegramApi(env,"sendMessage",{chat_id:chatId,text:"📷 Send the payment QR image now. It will be used for the ₹150 / 30-day Paid Ads Plan."});
    return;
  }
  if (command === "showadsqr") {
    const qr=await getAdsQr(env);
    if(!qr) await telegramApi(env,"sendMessage",{chat_id:chatId,text:"No payment QR configured. Use /setadsqr."});
    else await telegramApi(env,"sendPhoto",{chat_id:chatId,photo:qr,caption:"Current Paid Ads payment QR."});
    return;
  }
  if (command === "removeadsqr") {
    await env.DB.prepare("DELETE FROM telegram_ads_settings WHERE setting_key='payment_qr'").run();
    await telegramApi(env,"sendMessage",{chat_id:chatId,text:"✅ Paid Ads QR removed."});
    return;
  }

  if (command === "globalgroupmsg" || command === "globalusermsg") {
    if (!args) {
      const example = command === "globalgroupmsg" ? "/globalgroupmsg New community update!" : "/globalusermsg A new update is available!";
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "📣 Add your message after the command.\n\nExample:\n<code>" + escapeHtml(example) + "</code>", parse_mode: "HTML" });
      return;
    }
    const groupsOnly = command === "globalgroupmsg";
    const result = await broadcastToTelegram(env, args, groupsOnly ? ["group", "supergroup", "channel"] : ["private"]);
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: (groupsOnly ? "📣 <b>Group/channel broadcast finished</b>" : "📨 <b>Private-user broadcast finished</b>") +
        "\n\n🎯 Targets: " + result.total + "\n✅ Sent: " + result.sent + "\n❌ Failed: " + result.failed,
      parse_mode: "HTML"
    });
    return;
  }

  if (command === "broadcast") {
    if (!args) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: `📣 Example:\n<code>/broadcast New products are live!</code>`,
        parse_mode: "HTML"
      });
      return;
    }

    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "📣 Broadcasting to all registered users, groups and channels…"
    });

    const result = await broadcastToTelegram(env, args);

    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `📣 <b>Broadcast finished</b>\n\n` +
        `🎯 Targets: ${result.total}\n` +
        `✅ Sent: ${result.sent}\n` +
        `❌ Failed: ${result.failed}`,
      parse_mode: "HTML"
    });
    return;
  }

  if (command === "sendto" || command === "channel") {
    const parts = args.split(/\s+/);
    const target = parts.shift();
    const messageText = parts.join(" ").trim();

    if (!target || !messageText) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: `📨 Example:\n<code>/${command} -1001234567890 Hello!</code>`,
        parse_mode: "HTML"
      });
      return;
    }

    try {
      if (command === "channel") {
        const info = await getChatAndSave(env, target);
        if (!["channel", "group", "supergroup"].includes(info.type)) {
          throw new Error(`Target is ${info.type}, not a channel/group.`);
        }
      }

      await sendToTelegramChat(env, target, messageText);
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `✅ <b>Message sent.</b>\n\n` +
          `Target: <code>${escapeHtml(target)}</code>`,
        parse_mode: "HTML"
      });
    } catch (error) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `❌ <b>Could not send message.</b>\n\n` +
          `${escapeTelegramHtml(error.message || "Unknown error")}`,
        parse_mode: "HTML"
      });
    }
    return;
  }

  if (command === "chats" || command === "chatlist") {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: await chatsText(env),
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
    return;
  }

  if (command === "refreshchat" || command === "registerchat") {
    if (!args) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: `🆔 Example:\n<code>/refreshchat -1001234567890</code>`,
        parse_mode: "HTML"
      });
      return;
    }

    try {
      const info = await getChatAndSave(env, args.split(/\s+/)[0]);
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `✅ <b>Chat registered</b>\n\n` +
          `Name: ${escapeTelegramHtml(info.title || info.username || info.first_name || "Untitled")}\n` +
          `Type: ${escapeTelegramHtml(info.type || "unknown")}\n` +
          `ID: <code>${escapeHtml(info.id)}</code>`,
        parse_mode: "HTML"
      });
    } catch (error) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `❌ <b>Could not register chat.</b>\n\n` +
          `${escapeTelegramHtml(error.message || "Unknown error")}`,
        parse_mode: "HTML"
      });
    }
    return;
  }

  if (command === "paymentdts") {
    const action = args.match(/^(approve|reject)\s+(\d+)$/i);
    if (action) {
      try {
        const approve = action[1].toLowerCase() === "approve";
        const result = await reviewAdsPayment(env, Number(action[2]), userId, approve);
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: approve ? "✅ Payment #" + action[2] + " approved until " + result.until + "." : "❌ Payment #" + action[2] + " rejected." });
      } catch (error) {
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: "⚠️ " + escapeTelegramHtml(error.message || "Could not review payment."), parse_mode: "HTML" });
      }
      return;
    }
    const payments = await env.DB.prepare("SELECT p.id,p.telegram_user_id,p.chat_id,p.utr,p.status,p.created_at,p.paid_until,COALESCE(c.title,c.username,'Telegram user') AS account_name FROM telegram_ads_payments p LEFT JOIN telegram_chats c ON c.chat_id=p.chat_id ORDER BY CASE WHEN p.status='pending' THEN 0 ELSE 1 END,p.created_at DESC LIMIT 20").all();
    const rows = payments.results || [];
    const pending = rows.filter(row => row.status === "pending");
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "💳 <b>Paid Ads payment requests</b>\n\nPending: " + pending.length +
        "\nShowing up to " + rows.length + " recent request(s)." +
        (pending.length ? "\nUse buttons or /paymentdts approve ID /paymentdts reject ID." : "\nNo pending payment requests.") +
        "\n\nQR tools: /setadsqr, /showadsqr, /removeadsqr",
      parse_mode: "HTML"
    });
    for (const row of rows) {
      const details = "💳 <b>Payment #" + Number(row.id) + "</b>\n" +
        "👤 " + escapeTelegramHtml(row.account_name || "Telegram user") + "\n" +
        "🆔 <code>" + escapeHtml(row.telegram_user_id) + "</code>\n" +
        "🔢 UTR: <code>" + escapeHtml(row.utr) + "</code>\n" +
        "📅 " + escapeTelegramHtml(row.created_at || "") + "\n" +
        "Status: <b>" + escapeTelegramHtml(String(row.status || "unknown").toUpperCase()) + "</b>" +
        (row.paid_until ? "\nPaid until: " + escapeTelegramHtml(row.paid_until) : "");
      const markup = row.status === "pending" ? { inline_keyboard: [[
        { text: "✅ Approve 30 days", callback_data: "adsapprove:" + row.id },
        { text: "❌ Reject", callback_data: "adsreject:" + row.id }
      ]] } : undefined;
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: details, parse_mode: "HTML", ...(markup ? { reply_markup: markup } : {}) });
    }
    const qr = await getAdsQr(env);
    if (qr) await telegramApi(env, "sendPhoto", { chat_id: chatId, photo: qr, caption: "Current Paid Ads payment QR." });
    else await telegramApi(env, "sendMessage", { chat_id: chatId, text: "⚠️ No payment QR configured. Use /setadsqr." });
    return;
  }

  if (command === "stats") {
    const rows = await env.DB.prepare(
      "SELECT type, COUNT(*) AS count FROM telegram_chats WHERE active = 1 GROUP BY type ORDER BY type"
    ).all();
    const products = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM products WHERE published = 1"
    ).first();

    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `📊 <b>Shopper's Suggestions Stats</b>\n\n` +
        `🛍️ Published products: ${products?.count || 0}\n` +
        `${(rows.results || []).map(x => `• ${escapeTelegramHtml(x.type)}: ${x.count}`).join("\n") || "No chats recorded"}`,
      parse_mode: "HTML"
    });
    return;
  }


  if (s.step === "delete_confirm") {
    const id = Number(s.data?.deleteProductId);
    if (text.trim().toUpperCase() !== "YES") {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Deletion not confirmed. Reply YES to delete, or /cancel." });
      return;
    }
    try {
      const result = await deleteTelegramPromoterProduct(env, chatId, userId, id);
      s.step = "idle"; s.data = {};
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: `🗑️ Product #${result.deleted} deleted from your account.` });
    } catch (error) {
      s.step = "idle"; s.data = {};
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: `❌ ${escapeTelegramHtml(error.message || "Could not delete product.")}`, parse_mode: "HTML" });
    }
    return;
  }

  if (["edit_title","edit_description","edit_link","edit_category"].includes(s.step)) {
    const key = s.step;
    const changes = s.data.editChanges || {};
    if (command !== "skip") {
      if (key === "edit_title") changes.title = cleanText(text, 300);
      if (key === "edit_description") changes.description = cleanText(text, 10000);
      if (key === "edit_link") {
        try { const u = new URL(text); if (!/^https?:$/.test(u.protocol)) throw new Error(); }
        catch { await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Send a valid http(s) affiliate link, or type skip." }); return; }
        changes.affiliate_url = text;
      }
      if (key === "edit_category") {
        if (!isValidCategory(text.trim())) {
          await telegramApi(env, "sendMessage", { chat_id: chatId, text: "That category isn't valid. Send one of the available categories, or type skip." });
          return;
        }
        changes.category = text.trim();
      }
    }
    s.data.editChanges = changes;
    if (key === "edit_title") {
      s.step = "edit_description";
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Send the new description, or type skip to keep it." });
      return;
    }
    if (key === "edit_description") {
      s.step = "edit_link";
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Send the new affiliate link, or type skip to keep it." });
      return;
    }
    if (key === "edit_link") {
      s.step = "edit_category";
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: `Send a new category (for example Tech), or type skip to keep it.\n\n${CATEGORIES.join(", ")}` });
      return;
    }
    try {
      const updated = await updateTelegramPromoterProduct(env, chatId, userId, s.data.editProductId, changes);
      s.step = "idle"; s.data = {};
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: `✅ Product #${updated.id} updated successfully.` });
    } catch (error) {
      s.step = "idle"; s.data = {};
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: `❌ ${escapeTelegramHtml(error.message || "Could not update product.")}`, parse_mode: "HTML" });
    }
    return;
  }

  if (s.step === "title") {
    if (!text) return;
    s.data.title = text;
    s.step = "description";
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "📝 Send the product description."
    });
    return;
  }

  if (s.step === "description") {
    if (!text) return;
    s.data.description = text;
    s.step = "affiliate";
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "🔗 Send the affiliate/product link."
    });
    return;
  }

  if (s.step === "affiliate") {
    try {
      const u = new URL(text);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: "❌ Please send a valid http(s) link."
      });
      return;
    }

    s.data.affiliate_url = text;
    s.step = "category";
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "📂 Choose a category:",
      reply_markup: categoryKeyboard()
    });
    return;
  }

  if (s.step === "category") {
    const category = CATEGORIES.find(item => item.toLowerCase() === text.toLowerCase());
    if (!category) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: "Please choose a category using the buttons, or send one of the listed category names.",
        reply_markup: categoryKeyboard()
      });
      return;
    }
    s.data.category = category;
    s.step = "images";
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "Category selected: " + category + "\n\nSend up to 5 direct image URLs (https://...). Type done when finished, or skip to continue without images."
    });
    return;
  }

  if (s.step === "images") {
    if (command === "skip" || command === "done") {
      s.data.video_url = "";
      s.step = "confirm";
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `✅ <b>Ready to publish</b>\\n\\n` +
          `🛍️ ${escapeTelegramHtml(s.data.title)}\\n` +
          `📂 ${escapeTelegramHtml(s.data.category)}\\n` +
          `🖼️ ${(s.data.images || []).length} image(s)\\n\\n` +
          `Type <code>publish</code> or use <code>/cancel</code>.`,
        parse_mode: "HTML"
      });
      return;
    }

    if (message.photo?.length) {
      const currentImages = Array.isArray(s.data.images) ? s.data.images : [];
      if (currentImages.length >= 5) {
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: "You already have 5 images. Type done to review and publish." });
        return;
      }
      try {
        const photo = message.photo[message.photo.length - 1];
        const file = await downloadTelegramFile(env, photo.file_id, "image");
        if (file.bytes.length > 15 * 1024 * 1024) throw new Error("That image is larger than 15 MB. Please send a smaller image.");
        const uploaded = await githubUpload(env, file.bytes, file.filename, file.type);
        s.data.images = [...currentImages, uploaded.url];
        await saveTelegramSession(env, s);
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: "✅ Image uploaded and saved (" + s.data.images.length + "/5). Send another photo or direct image URL, or type done to review." });
      } catch (error) {
        await telegramApi(env, "sendMessage", { chat_id: chatId, text: "❌ Image upload failed: " + escapeTelegramHtml(error.message || "Please try another image."), parse_mode: "HTML" });
      }
      return;
    }

    let imageUrl = "";
    try {
      const parsed = new URL(text.trim());
      if (!/^https?:$/.test(parsed.protocol)) throw new Error();
      imageUrl = parsed.href;
    } catch {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: "🖼️ Send a valid direct http(s) image URL, or type done to review and publish."
      });
      return;
    }

    s.data.images = Array.isArray(s.data.images) ? s.data.images : [];
    if (s.data.images.length >= 5) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "🖼️ You already added 5 images. Type done." });
      return;
    }
    s.data.images.push(imageUrl);
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "✅ Image link " + s.data.images.length + "/5 saved. Send another direct image URL or type done to review."
    });
    return;
  }

  // Older drafts may still be on the retired video step. Move them to confirmation without requesting video.
  if (s.step === "video") {
    s.data.video_url = "";
    s.step = "confirm";
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "Video uploads are no longer supported. Your product is ready without a video. Type publish to continue, or /cancel."
    });
    return;
  }

  if (s.step === "confirm" && command === "publish") {
    try {
      const created = s.data?.mode === "promoter"
        ? await createPromoterProductFromTelegramSession(env, chatId, userId)
        : await createProductFromTelegramSession(env, chatId);
      const delivery = created.telegramResult || {};
      const deliveryLine = Number(delivery.sent || 0) > 0
        ? `📣 Delivered to ${delivery.sent}/${delivery.total || delivery.sent} Telegram group(s).`
        : "⚠️ Saved on the website, but not delivered to Telegram yet.";
      const failureLine = delivery.failures?.length
        ? `\n⚠️ ${delivery.failures.length} group(s) could not receive it. Check the bot's posting permissions.`
        : "";
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `🎉 <b>Product #${created.product.id} published.</b>\n\n` +
          deliveryLine + failureLine +
          `\n\nWebsite link: ${productShareUrl(created.product.id)}` +
          `\nUse /addproduct for another product.`,
        parse_mode: "HTML",
        disable_web_page_preview: true
      });
    } catch (error) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `❌ Could not publish.\n\n` +
          `${escapeTelegramHtml(error.message || "Unknown error")}`,
        parse_mode: "HTML"
      });
    }
  }


}


function adsSqlAfterMinutes(minutes) {
  return new Date(Date.now() + Number(minutes) * 60000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}
function adsSqlAfterDays(days) { return adsSqlAfterMinutes(Number(days) * 1440); }
async function ensureAdsAccount(env, userId) {
  await env.DB.prepare("INSERT OR IGNORE INTO telegram_ads_accounts (telegram_user_id, plan, created_at, updated_at) VALUES (?, 'free', ?, ?)")
    .bind(String(userId), nowSql(), nowSql()).run();
  return env.DB.prepare("SELECT * FROM telegram_ads_accounts WHERE telegram_user_id=? LIMIT 1").bind(String(userId)).first();
}

async function getAdsQr(env) {
  const row = await env.DB.prepare("SELECT setting_value FROM telegram_ads_settings WHERE setting_key='payment_qr' LIMIT 1").first();
  return row?.setting_value || "";
}
async function submitAdsUtr(env, chatId, userId, utr) {
  const value = cleanText(utr, 40).replace(/\\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{6,30}$/.test(value)) throw new Error("Send a valid UTR/reference number (6–30 letters or numbers).");
  const result = await env.DB.prepare("INSERT INTO telegram_ads_payments (telegram_user_id,chat_id,utr,status,created_at) VALUES (?,?,?,'pending',?)")
    .bind(String(userId), String(chatId), value, nowSql()).run();
  const id = result.meta?.last_row_id;
  const owner = cleanText(env.TELEGRAM_FEEDBACK_CHAT_ID || DEFAULT_FEEDBACK_CHAT_ID, 100);
  const chat = await telegramApi(env, "getChat", { chat_id: chatId }).catch(() => ({result:{}}));
  await telegramApi(env, "sendMessage", {
    chat_id: owner,
    text: "💳 <b>New Paid Ads payment request</b>\n\n👤 " + escapeTelegramHtml(chat.result?.first_name || chat.result?.username || "Promoter") +
      "\n🆔 <code>" + escapeHtml(userId) + "</code>\n🔢 UTR: <code>" + escapeHtml(value) + "</code>\n📦 Request: #" + id + "\n💰 ₹150 / 30 days",
    parse_mode: "HTML",
    reply_markup: {inline_keyboard:[[
      {text:"✅ Approve 30 days",callback_data:"adsapprove:"+id},
      {text:"❌ Reject",callback_data:"adsreject:"+id}
    ]]}
  });
  return id;
}
async function reviewAdsPayment(env, id, reviewer, approve) {
  const payment = await env.DB.prepare("SELECT * FROM telegram_ads_payments WHERE id=? LIMIT 1").bind(Number(id)).first();
  if (!payment) throw new Error("Payment request not found.");
  if (payment.status !== "pending") throw new Error("This request has already been reviewed.");
  if (approve) {
    const link = await getPromoterTelegramLink(env, payment.telegram_user_id);
    if (!link) throw new Error("The promoter disconnected their account. Ask them to reconnect first.");
    const until = adsSqlAfterDays(30);
    await env.DB.prepare("INSERT INTO telegram_ads_accounts (telegram_user_id,plan,paid_until,next_run_at,created_at,updated_at) VALUES (?,'paid',?,?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET plan='paid',paid_until=excluded.paid_until,next_run_at=excluded.next_run_at,updated_at=excluded.updated_at")
      .bind(String(payment.telegram_user_id), until, nowSql(), nowSql(), nowSql()).run();
    await env.DB.prepare("UPDATE telegram_ads_payments SET status='approved',reviewed_at=?,reviewed_by=?,paid_until=? WHERE id=? AND status='pending'")
      .bind(nowSql(), String(reviewer), until, Number(id)).run();
    await telegramApi(env, "sendMessage", {chat_id:payment.chat_id,text:"🎉 Your Paid Ads Plan is approved! It is active for 30 days, until " + until + ". Promotions will run every 30 minutes in your verified groups."});
    return {status:"approved",until};
  }
  await env.DB.prepare("UPDATE telegram_ads_payments SET status='rejected',reviewed_at=?,reviewed_by=? WHERE id=? AND status='pending'")
    .bind(nowSql(), String(reviewer), Number(id)).run();
  await telegramApi(env, "sendMessage", {chat_id:payment.chat_id,text:"❌ Your Paid Ads payment request was not approved. Please check the UTR and contact support if you believe this is a mistake."});
  return {status:"rejected"};
}
async function handleAdsPaymentUtr(env, session, chatId, userId, text) {
  try {
    const id = await submitAdsUtr(env, chatId, userId, text);
    session.step="idle"; session.data={};
    await saveTelegramSession(env,session);
    await telegramApi(env,"sendMessage",{chat_id:chatId,text:"✅ UTR submitted. Request #"+id+" is pending admin approval. Your plan activates only after approval."});
  } catch(error) {
    await telegramApi(env,"sendMessage",{chat_id:chatId,text:"❌ "+escapeTelegramHtml(error.message || "Could not submit UTR.")+"\nSend it again, or use /cancel."});
  }
}

const ADMIN_PROMO_TEXT = "Want to learn how affiliate marketing works?\n\nDiscover the basics, explore useful products, and learn how to get started with Shopper's Suggestions.\n\nStart learning today!";
const ADMIN_PROMO_MARKUP = { inline_keyboard: [
  [{ text: "🌐 Visit Shopper's Suggestions", url: "https://shopperssuggestions.online" }],
  [{ text: "🚀 Join us & start learning", url: "https://t.me/Shopperssuggestions_bot?start=explain" }]
] };

async function broadcastAdminAdToGroups(env) {
  const rows = await env.DB.prepare("SELECT chat_id FROM telegram_chats WHERE active=1 AND type IN ('group','supergroup') ORDER BY updated_at DESC").all();
  const targets = rows.results || [];
  let sent = 0;
  let failed = 0;
  for (const row of targets) {
    try {
      await telegramSendWithRetry(env, "sendMessage", {
        chat_id: row.chat_id,
        text: ADMIN_PROMO_TEXT,
        reply_markup: ADMIN_PROMO_MARKUP,
        disable_web_page_preview: true
      });
      sent++;
      await new Promise(resolve => setTimeout(resolve, 60));
    } catch (error) {
      failed++;
      const message = String(error?.message || error);
      console.error("Admin promotion delivery failed", String(row.chat_id), message);
      if (/bot was blocked|CHAT_WRITE_FORBIDDEN|chat not found|not enough rights/i.test(message)) {
        await env.DB.prepare("UPDATE telegram_chats SET active=0,updated_at=? WHERE chat_id=?").bind(nowSql(), String(row.chat_id)).run();
      }
    }
  }
  return { total: targets.length, sent, failed };
}

function nextAdminAdDate(frequency, from = new Date()) {
  const next = new Date(from.getTime());
  if (frequency === "daily") next.setUTCDate(next.getUTCDate() + 1);
  else if (frequency === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  else if (frequency === "monthly") next.setUTCMonth(next.getUTCMonth() + 1);
  else throw new Error("Choose daily, weekly, or monthly.");
  return next.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

async function saveAdminAdSchedule(env, frequency) {
  const next = nextAdminAdDate(frequency);
  await env.DB.prepare("INSERT INTO telegram_admin_ad_schedule (id,frequency,next_run_at,active,updated_at) VALUES (1,?,?,1,?) ON CONFLICT(id) DO UPDATE SET frequency=excluded.frequency,next_run_at=excluded.next_run_at,active=1,updated_at=excluded.updated_at").bind(frequency, next, nowSql()).run();
  return next;
}

async function runScheduledAdminAd(env) {
  const now = nowSql();
  const schedule = await env.DB.prepare("SELECT frequency,next_run_at,active FROM telegram_admin_ad_schedule WHERE id=1 LIMIT 1").first();
  if (!schedule || Number(schedule.active) !== 1 || String(schedule.next_run_at) > now) return;
  const next = nextAdminAdDate(schedule.frequency);
  const claim = await env.DB.prepare("UPDATE telegram_admin_ad_schedule SET next_run_at=?,updated_at=? WHERE id=1 AND active=1 AND next_run_at=?").bind(next, nowSql(), schedule.next_run_at).run();
  if (!Number(claim.meta?.changes || 0)) return;
  const result = await broadcastAdminAdToGroups(env);
  console.log("Scheduled admin promotion finished", result);
}

async function runTelegramAdsScheduler(env) {
  await ensureSchema(env);
  const now = nowSql();
  const due = await env.DB.prepare("SELECT a.* FROM telegram_ads_accounts a WHERE (a.next_run_at IS NULL OR a.next_run_at<=?) AND ((a.plan='paid' AND a.paid_until>? AND EXISTS (SELECT 1 FROM telegram_ads_verified_chats g WHERE g.telegram_user_id=a.telegram_user_id AND g.active=1)) OR ((a.plan!='paid' OR a.paid_until IS NULL OR a.paid_until<=?) AND (SELECT COUNT(*) FROM telegram_ads_verified_chats g WHERE g.telegram_user_id=a.telegram_user_id AND g.active=1)>=3)) ORDER BY COALESCE(a.next_run_at,a.created_at) LIMIT 100").bind(now,now,now).all();
  for (const account of due.results || []) {
    const userId = String(account.telegram_user_id);
    const paidUntil = account.paid_until ? Date.parse(String(account.paid_until).replace(" ", "T") + "Z") : 0;
    const paid = account.plan === "paid" && paidUntil > Date.now();
    if (account.plan === "paid" && !paid) {
      await env.DB.prepare("UPDATE telegram_ads_accounts SET plan='free', paid_until=NULL, updated_at=? WHERE telegram_user_id=?").bind(nowSql(), userId).run();
    }
    const groupRows = await env.DB.prepare("SELECT chat_id FROM telegram_ads_verified_chats WHERE telegram_user_id=? AND active=1 ORDER BY verified_at").bind(userId).all();
    const groups = groupRows.results || [];
    if (groups.length < (paid ? 1 : 3)) continue;
    const interval = paid ? 30 : 60;
    const nextRun = adsSqlAfterMinutes(interval);
    const claim = await env.DB.prepare("UPDATE telegram_ads_accounts SET next_run_at=?, updated_at=? WHERE telegram_user_id=? AND (next_run_at IS NULL OR next_run_at<=?)").bind(nextRun, nowSql(), userId, now).run();
    if (!Number(claim.meta?.changes || 0)) continue;
    const link = await getPromoterTelegramLink(env, userId);
    if (!link) continue;
    let products = [];
    try { products = await getTelegramPromoterProducts(env, link.chat_id, userId); }
    catch (error) { console.error("Ads scheduler product lookup failed", userId, error); continue; }
    products = (products || []).filter(p => Number(p.published) === 1 && p.id != null);
    if (!products.length) continue;
    const eligible = [];
    let earliestCooldown = 0;
    for (const product of products) {
      const state = await env.DB.prepare("SELECT sent_count,cooldown_until FROM telegram_ads_product_cycles WHERE telegram_user_id=? AND product_id=? LIMIT 1").bind(userId, String(product.id)).first();
      let count = Number(state?.sent_count || 0);
      const cooldown = state?.cooldown_until ? Date.parse(String(state.cooldown_until).replace(" ", "T") + "Z") : 0;
      if (count >= 10 && cooldown && cooldown <= Date.now()) {
        count = 0;
        await env.DB.prepare("UPDATE telegram_ads_product_cycles SET sent_count=0,cooldown_until=NULL WHERE telegram_user_id=? AND product_id=?").bind(userId, String(product.id)).run();
      }
      if (count < 10) eligible.push({product, count});
      else if (cooldown && (!earliestCooldown || cooldown < earliestCooldown)) earliestCooldown = cooldown;
    }
    if (!eligible.length) {
      if (earliestCooldown) {
        const resume = new Date(earliestCooldown).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
        await env.DB.prepare("UPDATE telegram_ads_accounts SET next_run_at=? WHERE telegram_user_id=?").bind(resume, userId).run();
      }
      continue;
    }
    const choice = eligible[Math.floor(Math.random() * eligible.length)];
    let sent = 0;
    for (const group of groups) {
      try {
        await sendProductMediaToTelegram(env, group.chat_id, choice.product);
        sent++;
      } catch (error) {
        const message = String(error.message || error);
        console.error("Ads send failed", group.chat_id, message);
        if (/bot was blocked|CHAT_WRITE_FORBIDDEN|chat not found|not enough rights/i.test(message)) {
          await env.DB.prepare("UPDATE telegram_ads_verified_chats SET active=0 WHERE chat_id=? AND telegram_user_id=?").bind(String(group.chat_id), userId).run();
        }
      }
    }
    if (sent) {
      const count = choice.count + 1;
      const cooldownUntil = count >= 10 ? adsSqlAfterMinutes(paid ? 600 : 40) : null;
      await env.DB.prepare("INSERT INTO telegram_ads_product_cycles (telegram_user_id,product_id,sent_count,cooldown_until,last_sent_at) VALUES (?,?,?,?,?) ON CONFLICT(telegram_user_id,product_id) DO UPDATE SET sent_count=excluded.sent_count,cooldown_until=excluded.cooldown_until,last_sent_at=excluded.last_sent_at")
        .bind(userId, String(choice.product.id), count, cooldownUntil, nowSql()).run();
    }
  }
}

async function handleTelegramRequest(request, env) {
  const secret = cleanText(env.TELEGRAM_WEBHOOK_SECRET);
  if (secret) {
    const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (supplied !== secret) return new Response("Unauthorized", { status: 401 });
  }

  const update = await request.json();
  try {
    await recordTelegramUpdateChat(env, update);
    if (update?.callback_query) {
      await handleTelegramCallback(update, env);
    } else {
      await handleTelegramUpdate(update, env);
    }
  } catch (error) {
    console.error("Telegram update error", error);
    const chatId = update?.message?.chat?.id || update?.channel_post?.chat?.id || update?.callback_query?.message?.chat?.id;
    if (chatId) {
      try { await telegramApi(env, "sendMessage", { chat_id: chatId, text: "⚠️ Something went wrong while processing that message. Please try again." }); } catch {}
    }
  }
  return new Response("OK");
}

async function setupTelegramWebhook(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  const setupSecret = cleanText(env.TELEGRAM_SETUP_SECRET);
  if (!setupSecret || key !== setupSecret) return json({ ok: false, error: "Unauthorized." }, 401);

  const publicWebhook = `${url.origin}/api/telegram/webhook`;
  const payload = {
    url: publicWebhook,
    allowed_updates: [
      "message",
      "edited_message",
      "channel_post",
      "edited_channel_post",
      "callback_query"
    ]
  };
  if (cleanText(env.TELEGRAM_WEBHOOK_SECRET)) payload.secret_token = cleanText(env.TELEGRAM_WEBHOOK_SECRET);
  const result = await telegramApi(env, "setWebhook", payload);
  await setTelegramCommandMenu(env, publicBotCommands());
  return json({ ok: true, telegram: result.ok, webhook: publicWebhook });
}

async function telegramTestGroups(request, env) {
  const ids = telegramGroupIds(env);
  if (!ids.length) return api({ ok: false, error: "TELEGRAM_GROUP_IDS is empty." }, request, 400);
  const results = [];
  for (const chat_id of ids) {
    try {
      const result = await telegramApi(env, "getChat", { chat_id });
      results.push({ chat_id, ok: true, title: result.result?.title || result.result?.username || "" });
    } catch (error) {
      results.push({ chat_id, ok: false, error: String(error.message || error) });
    }
  }
  return api({ ok: results.every((x) => x.ok), groups: results }, request);
}

async function health(env) {
  const result = await env.DB.prepare("SELECT 1 AS ok").first();
  return { ok: result?.ok === 1, service: "shopper-s-suggestions" };
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runTelegramAdsScheduler(env).catch(error => console.error("Scheduled ads run failed", error)));
    ctx.waitUntil(runScheduledAdminAd(env).catch(error => console.error("Scheduled admin promotion failed", error)));
  },
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), request);

      await ensureSchema(env);
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

      if (path === "/api/health") return api(await health(env), request);
      if (path === "/api/categories") return api({ ok: true, categories: CATEGORIES }, request);

      if (path === "/api/telegram/setup" && request.method === "GET") {
        return setupTelegramWebhook(request, env);
      }

      if (path === "/api/telegram/webhook" && request.method === "POST") {
        return handleTelegramRequest(request, env);
      }

      if (path === "/api/telegram/test-groups" && request.method === "GET") {
        return telegramTestGroups(request, env);
      }

      if (path === "/api/admin/login" && request.method === "POST") {
        return adminLogin(request, env);
      }
      if (path === "/api/admin/logout" && request.method === "POST") {
        return adminLogout(request, env);
      }
      if (path === "/api/admin/check" && request.method === "GET") {
        const authenticated = await verifyAdminSession(request, env);
    return api({ ok: authenticated, admin: authenticated, authenticated }, request);
      }

      if (path === "/api/upload-media" && request.method === "POST") {
        return handleUploadMedia(request, env);
      }

      if (path === "/api/admin/products" && request.method === "GET") {
        return listAdminProducts(request, env);
      }
      if (path === "/api/admin/products" && request.method === "POST") {
        if (!await verifyAdminSession(request, env)) return api({ ok: false, error: "Unauthorized." }, request, 401);
        return createWebsiteProduct(request, env);
      }

      const adminProductMatch = path.match(/^\/api\/admin\/products\/(\d+)$/);
      if (adminProductMatch) {
        const id = Number(adminProductMatch[1]);
        if (!await verifyAdminSession(request, env)) return api({ ok: false, error: "Unauthorized." }, request, 401);
        if (request.method === "PUT" || request.method === "PATCH") return updateWebsiteProduct(request, env, id);
        if (request.method === "DELETE") return deleteWebsiteProduct(request, env, id);
      }

      if (path === "/api/products" && request.method === "GET") {
        return listPublicProducts(request, env);
      }
      if (path === "/api/products" && request.method === "POST") {
        if (!await verifyAdminSession(request, env)) return api({ ok: false, error: "Unauthorized." }, request, 401);
        return createWebsiteProduct(request, env);
      }

      const singularProductMatch = path.match(/^\/api\/product\/(\d+)$/);
      if (singularProductMatch && request.method === "GET") {
        const id = Number(singularProductMatch[1]);
        const product = await getProduct(env, id);
        if (!product || Number(product.published) !== 1) return api({ ok: false, error: "Product not found." }, request, 404);
        return api({ ok: true, product: productPublic(product) }, request);
      }

      const productMatch = path.match(/^\/api\/products\/(\d+)$/);
      if (productMatch) {
        const id = Number(productMatch[1]);
        if (request.method === "GET") {
          const product = await getProduct(env, id);
          if (!product || Number(product.published) !== 1) return api({ ok: false, error: "Product not found." }, request, 404);
          return api({ ok: true, product: productPublic(product) }, request);
        }
        if (request.method === "PUT" || request.method === "PATCH") {
          if (!await verifyAdminSession(request, env)) return api({ ok: false, error: "Unauthorized." }, request, 401);
          return updateWebsiteProduct(request, env, id);
        }
        if (request.method === "DELETE") {
          if (!await verifyAdminSession(request, env)) return api({ ok: false, error: "Unauthorized." }, request, 401);
          return deleteWebsiteProduct(request, env, id);
        }
      }

      // Optional media proxy for older pages that still use /media/<file>.
      if (path.startsWith("/media/") && request.method === "GET") {
        const filename = path.slice("/media/".length);
        const owner = cleanText(env.GITHUB_OWNER);
        const repo = cleanText(env.GITHUB_REPO);
        const branch = cleanText(env.GITHUB_BRANCH) || "main";
        if (owner && repo && filename) {
          return redirect(normalizeGitHubRawUrl(owner, repo, branch, `media/${filename}`));
        }
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error(error);
      return api({ ok: false, error: String(error?.message || error || "Internal server error") }, request, 500);
    }
  }
};
