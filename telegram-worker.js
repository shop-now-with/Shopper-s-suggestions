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
  if (!link || String(link.chat_id) !== String(chatId)) throw new Error("Connect your promoter account first using /connect.");
  const apiKey = await decryptPromoterApiKey(env, link.encrypted_api_key);
  const d = (await getTelegramSession(env, chatId, telegramUserId)).data || {};
  const body = {
    title: cleanText(d.title, 300),
    description: cleanText(d.description, 10000),
    affiliate_url: cleanText(d.affiliate_url, 2000),
    category: cleanText(d.category, 100),
    video_url: cleanText(d.video_url, 2000)
  };
  (Array.isArray(d.images) ? d.images : []).slice(0, 5).forEach((url, i) => body[`image${i + 1}_url`] = url);
  const response = await fetch("https://shopperssuggestions.online/api/integrations/products", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok || !result.product) throw new Error(result.error || "The website could not publish this product.");
  const telegramResult = await postProductToTelegramGroups(result.product, env);
  await resetTelegramProductDraft(env, chatId);
  return { product: result.product, telegramResult };
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
  if (!response.ok || !result.ok) throw new Error(result.error || "Could not delete this product.");
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

  if (images.length) {
    await telegramSendWithRetry(env, "sendPhoto", {
      chat_id: chatId,
      photo: images[0],
      caption,
      parse_mode: "HTML",
      reply_markup: markup
    });

    for (const image of images.slice(1)) {
      await telegramSendWithRetry(env, "sendPhoto", {
        chat_id: chatId,
        photo: image
      });
    }

    if (product.video_url) {
      await telegramSendWithRetry(env, "sendVideo", {
        chat_id: chatId,
        video: product.video_url,
        reply_markup: markup
      });
    }

    return;
  }

  if (product.video_url) {
    await telegramSendWithRetry(env, "sendVideo", {
      chat_id: chatId,
      video: product.video_url,
      caption,
      parse_mode: "HTML",
      reply_markup: markup
    });
    return;
  }

  await telegramSendWithRetry(env, "sendMessage", {
    chat_id: chatId,
    text: "✨ <b>CHECK IT OUT!</b> ✨\n\n" + caption,
    parse_mode: "HTML",
    disable_web_page_preview: false,
    reply_markup: markup
  });
}

async function postProductToTelegramGroups(product, env) {
  const targets = telegramGroupIds(env);
  if (!targets.length) return { sent: 0, groups: [], failures: [] };

  const sent = [];
  const failures = [];

  for (const chatId of [...new Set(targets)]) {
    try {
      await sendProductMediaToTelegram(env, chatId, product);
      sent.push(chatId);
    } catch (error) {
      failures.push({
        chat_id: chatId,
        error: String(error.message || error)
      });
    }
  }

  return { sent: sent.length, groups: sent, failures };
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

async function sendHelp(env, chatId) {
  const text =
    `🛍️ <b>Shopper's Suggestions</b>\n\n` +
    `Connect your promoter account to manage your products directly from Telegram.\n\n` +
    `/start — Open the bot\n` +
    `/help — Show instructions\n` +
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
    `/cancel — Cancel the current action`;
  return telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
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

async function broadcastToTelegram(env, message) {
  const rows = await env.DB.prepare(`
    SELECT chat_id, type, title, username
    FROM telegram_chats
    WHERE active = 1
    ORDER BY updated_at DESC
  `).all();

  const targets = [];
  const seen = new Set();

  for (const row of rows.results || []) {
    const id = String(row.chat_id || "");
    if (!id || seen.has(id)) continue;
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
      const id = Number.parseInt(args, 10);
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
    s.step = "title";
    s.data = { mode: "promoter", images: [] };
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: "🛍️ Let's add a product. Send its title." });
    return;
  }

  if (command === "start") {
    try {
      await telegramApi(env, "setMyCommands", {
        commands: [
          { command: "start", description: "Open the bot" },
          { command: "help", description: "Show instructions" },
          { command: "connect", description: "Connect your account" },
          { command: "profile", description: "View your profile" },
          { command: "products", description: "Browse live products" },
          { command: "latest", description: "See newest products" },
          { command: "search", description: "Search products" },
          { command: "categories", description: "Browse categories" },
          { command: "featured", description: "View featured products" },
          { command: "addproduct", description: "Upload a product" },
          { command: "myproducts", description: "View your products" },
          { command: "editproduct", description: "Edit your product" },
          { command: "deleteproduct", description: "Delete your product" },
          { command: "disconnect", description: "Disconnect your account" },
          { command: "cancel", description: "Cancel the current action" }
        ]
      });
    } catch (error) {
      console.error("Could not refresh Telegram command menu", error);
    }
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        `👋 <b>Welcome to Shopper's Suggestions!</b>\n\n` +
        `Connect your promoter account with /connect, then manage your listings using /addproduct, /myproducts, /editproduct and /deleteproduct.\n\n` +
        `Use /help to see the available commands.`,
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

  const allowedCommands = new Set(["start","help","connect","profile","products","browse","latest","search","categories","category","cat","featured","special","product","link","share","addproduct","myproducts","editproduct","deleteproduct","disconnect","cancel"]);
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
  if (command === "admin") {
    if (!isOwnerAdmin(env, chat, userId)) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: "🔒 Admin access is only available in the owner's private bot chat."
      });
      return;
    }

    if (args) {
      const expected = adminCode(env);
      if (/^\d{4}$/.test(args) && expected && args === expected) {
        await unlockTelegram(env, chatId, userId);
        await telegramApi(env, "sendMessage", {
          chat_id: chatId,
          text:
            `🔓 <b>Admin unlocked.</b>\n\n` +
            `Your admin tools are now available.\n\n` +
            `/addproduct\n` +
            `/broadcast message\n` +
            `/sendto CHAT_ID message\n` +
            `/channel CHAT_ID message\n` +
            `/chats\n` +
            `/refreshchat CHAT_ID\n` +
            `/stats\n` +
            `/lock`,
          parse_mode: "HTML"
        });
      } else {
        await telegramApi(env, "sendMessage", {
          chat_id: chatId,
          text: "❌ Invalid admin code."
        });
      }
      return;
    }

    s.step = "admin_code";
    s.data = {};
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: `🔐 <b>Admin authentication</b>\n\nSend the 4-digit admin code.`,
      parse_mode: "HTML"
    });
    return;
  }

  if (
    !s.unlocked &&
    s.step === "admin_code" &&
    /^\d{4}$/.test(text) &&
    isOwnerAdmin(env, chat, userId)
  ) {
    const expected = adminCode(env);
    if (expected && text === expected) {
      await unlockTelegram(env, chatId, userId);
      await sendHelp(env, chatId, true);
    } else {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: "❌ Invalid admin code."
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
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "🔒 Admin tools locked."
    });
    return;
  }

  // Anything below this line is admin-only.
  if (!s.unlocked || !isOwnerAdmin(env, chat, userId)) {
    if (text.startsWith("/")) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: `🔐 This command requires admin access. Use /admin in your private bot chat.`
      });
    }
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

  if (s.step === "images") {
    if (command === "skip" || command === "done") {
      s.step = "video";
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: "🎥 Send a product video, or type skip for no video."
      });
      return;
    }

    if (message.photo?.length) {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: "🖼️ Please send a direct image URL instead of a Telegram photo. Example: https://example.com/product-image.jpg"
      });
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
        text: "🖼️ Send a valid direct http(s) image URL, or type done to continue without images."
      });
      return;
    }

    s.data.images = Array.isArray(s.data.images) ? s.data.images : [];
    if (s.data.images.length >= 5) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "🖼️ You already added 5 image links. Type done." });
      return;
    }
    s.data.images.push(imageUrl);
    await saveTelegramSession(env, s);
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "✅ Image link " + s.data.images.length + "/5 saved. Send another direct image URL or type done."
    });
    return;
  }

  if (s.step === "video") {
    if (command === "skip") {
      s.data.video_url = "";
      s.step = "confirm";
      await saveTelegramSession(env, s);
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `✅ <b>Ready to publish</b>\n\n` +
          `🛍️ ${escapeTelegramHtml(s.data.title)}\n` +
          `📂 ${escapeTelegramHtml(s.data.category)}\n` +
          `🖼️ ${(s.data.images || []).length} image(s)\n` +
          `🎥 No video\n\n` +
          `Type <code>publish</code> or use <code>/cancel</code>.`,
        parse_mode: "HTML"
      });
      return;
    }

    if (message.video?.file_id) {
      try {
        const file = await downloadTelegramFile(env, message.video.file_id, "video");
        const uploaded = await githubUpload(env, file.bytes, file.filename, file.type);
        s.data.video_url = uploaded.url;
        s.step = "confirm";
        await saveTelegramSession(env, s);
        await telegramApi(env, "sendMessage", {
          chat_id: chatId,
          text: "🎥 Video saved. Type publish or use /cancel."
        });
      } catch (error) {
        await telegramApi(env, "sendMessage", {
          chat_id: chatId,
          text:
            `❌ Video upload failed.\n\n` +
            `${escapeTelegramHtml(error.message || "Unknown error")}`,
          parse_mode: "HTML"
        });
      }
      return;
    }

    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "🎥 Send a video or type skip."
    });
    return;
  }

  if (s.step === "confirm" && command === "publish") {
    try {
      const created = s.data?.mode === "promoter"
        ? await createPromoterProductFromTelegramSession(env, chatId, userId)
        : await createProductFromTelegramSession(env, chatId);
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text:
          `🎉 <b>Product #${created.product.id} published.</b>\n\n` +
          (created.telegramResult.failures?.length
            ? `⚠️ Some group/channel posts failed.`
            : `📣 Group/channel posting complete.`) +
          `\n\nUse /addproduct for another product.`,
        parse_mode: "HTML"
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
  await telegramApi(env, "setMyCommands", {
    commands: [
      { command: "start", description: "Open the bot" },
      { command: "help", description: "Show instructions" },
      { command: "connect", description: "Connect your account" },
      { command: "profile", description: "View your profile" },
      { command: "products", description: "Browse live products" },
      { command: "latest", description: "See newest products" },
      { command: "search", description: "Search products" },
      { command: "categories", description: "Browse categories" },
      { command: "featured", description: "View featured products" },
      { command: "addproduct", description: "Upload a product" },
      { command: "myproducts", description: "View your products" },
      { command: "editproduct", description: "Edit your product" },
      { command: "deleteproduct", description: "Delete your product" },
      { command: "disconnect", description: "Disconnect your account" },
      { command: "cancel", description: "Cancel the current action" }
    ]
  });
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
