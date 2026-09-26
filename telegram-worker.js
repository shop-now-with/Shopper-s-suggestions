/*
 * Shopper's Suggestions — Telegram + Website Cloudflare Worker
 *
 * Features:
 * - Telegram product search
 * - Category search
 * - Latest / featured products
 * - Product sharing
 * - Feedback + requests
 * - Admin unlock
 * - Product creation from Telegram
 * - GitHub media storage
 * - Automatic group/channel posting
 * - Global broadcasts
 * - Specific chat/channel messages
 * - Chat/channel ID detection
 * - Bot-user tracking
 * - Website API
 */

const CATEGORIES = [
  "Tech", "Home", "Fashion", "Beauty", "Gaming", "Sports", "Travel", "Kitchen",
  "Office", "Automotive", "Electronics", "Kids", "Pets", "Fitness", "Books",
  "Accessories", "Photography", "Creator", "Other"
];

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
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );
  headers.set("Vary", "Origin");

  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    headers
  });
}

function api(data, request, status = 200) {
  return withCors(json(data, status), request);
}

function redirect(url, status = 302) {
  return new Response(null, {
    status,
    headers: {
      Location: url
    }
  });
}

function cleanText(value, max = 100000) {
  return String(value ?? "").trim().slice(0, max);
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, n));
}

function isTruthy(value) {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    String(value).toLowerCase() === "true" ||
    String(value).toLowerCase() === "on"
  );
}

function isValidCategory(category) {
  return CATEGORIES.includes(category);
}

function nowSql() {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

function cookieValue(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const parts = cookie.split(";");

  for (const part of parts) {
    const [k, ...rest] = part.trim().split("=");

    if (k === name) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return "";
}

function newToken() {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

function escapeHtml(value) {
  return cleanText(value, 5000)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeTelegramHtml(value) {
  return cleanText(value, 4000)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function productShareUrl(id) {
  return `https://shopperssuggestions.online/?product=${encodeURIComponent(id)}`;
}

function productImages(product) {
  return [1, 2, 3, 4, 5]
    .map(n => product[`image${n}_url`])
    .filter(Boolean);
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

function telegramGroupIds(env) {
  return cleanText(env.TELEGRAM_GROUP_IDS)
    .split(/[\s,]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

async function ensureSchema(env) {
  for (
    const statement of BASE_SCHEMA
      .split(";")
      .map(s => s.trim())
      .filter(Boolean)
  ) {
    await env.DB.prepare(statement).run();
  }

  const cols = await env.DB
    .prepare("PRAGMA table_info(products)")
    .all();

  const names = new Set(
    (cols.results || []).map(row => row.name)
  );

  if (!names.has("featured")) {
    await env.DB
      .prepare(
        "ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0"
      )
      .run();
  }
}

async function getProduct(env, id) {
  return await env.DB
    .prepare(
      "SELECT * FROM products WHERE id = ? LIMIT 1"
    )
    .bind(id)
    .first();
}

function telegramCaption(product) {
  const featured =
    Number(product.featured) === 1
      ? "\n\n⭐ <b>Worth discovering</b>"
      : "";

  return (
    `🛍️ <b>${escapeTelegramHtml(product.title)}</b>\n\n` +
    `${escapeTelegramHtml(product.description)}\n\n` +
    `📂 <b>Category:</b> ${escapeTelegramHtml(product.category)}` +
    featured +
    `\n\n🔗 <a href="${productShareUrl(product.id)}">View product</a>`
  );
}

async function telegramApi(env, method, payload) {
  const token = cleanText(env.TELEGRAM_BOT_TOKEN);

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram ${method} failed: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function saveTelegramChat(env, chat, user = null) {
  if (!chat?.id) return;

  const chatId = String(chat.id);

  await env.DB.prepare(`
    INSERT INTO telegram_chats (
      chat_id,
      type,
      title,
      username,
      user_id,
      first_name,
      last_name,
      active,
      updated_at
    )
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
  `)
    .bind(
      chatId,
      String(chat.type || "unknown"),
      String(
        chat.title ||
        chat.first_name ||
        ""
      ),
      String(chat.username || ""),
      String(user?.id || ""),
      String(user?.first_name || ""),
      String(user?.last_name || ""),
      nowSql()
    )
    .run();
}

async function getTelegramSession(env, chatId, userId = "") {
  const id = String(chatId);

  const row = await env.DB
    .prepare(
      "SELECT * FROM telegram_sessions WHERE chat_id = ? LIMIT 1"
    )
    .bind(id)
    .first();

  if (row) {
    let data = {};

    try {
      data = JSON.parse(row.data_json || "{}");
    } catch {
      data = {};
    }

    return {
      ...row,
      data
    };
  }

  await env.DB.prepare(`
    INSERT INTO telegram_sessions (
      chat_id,
      user_id,
      unlocked,
      step,
      data_json,
      updated_at
    )
    VALUES (?, ?, 0, 'idle', '{}', ?)
  `)
    .bind(
      id,
      String(userId),
      nowSql()
    )
    .run();

  return {
    chat_id: id,
    user_id: String(userId),
    unlocked: 0,
    step: "idle",
    data: {}
  };
}

async function saveTelegramSession(env, session) {
  await env.DB.prepare(`
    INSERT INTO telegram_sessions (
      chat_id,
      user_id,
      unlocked,
      step,
      data_json,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      user_id = excluded.user_id,
      unlocked = excluded.unlocked,
      step = excluded.step,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `)
    .bind(
      String(session.chat_id),
      String(session.user_id || ""),
      session.unlocked ? 1 : 0,
      String(session.step || "idle"),
      JSON.stringify(session.data || {}),
      nowSql()
    )
    .run();
}

async function unlockTelegram(env, chatId, userId) {
  const s = await getTelegramSession(
    env,
    chatId,
    userId
  );

  s.user_id = String(userId);
  s.unlocked = 1;
  s.step = "idle";
  s.data = {};

  await saveTelegramSession(env, s);

  return s;
}

async function lockTelegram(env, chatId, userId) {
  const s = await getTelegramSession(
    env,
    chatId,
    userId
  );

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

  await saveTelegramSession(env, s);
}

function categoryKeyboard() {
  const rows = [];

  for (let i = 0; i < CATEGORIES.length; i += 3) {
    rows.push(
      CATEGORIES
        .slice(i, i + 3)
        .map(category => ({
          text: category,
          callback_data: `cat:${category}`
        }))
    );
  }

  return {
    inline_keyboard: rows
  };
}

async function sendProduct(env, chatId, product) {
  if (!product) {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "❌ Product not found."
    });

    return;
  }

  const images = productImages(product);
  const caption = telegramCaption(product);

  if (images.length) {
    await telegramApi(env, "sendPhoto", {
      chat_id: chatId,
      photo: images[0],
      caption,
      parse_mode: "HTML"
    });

    for (const image of images.slice(1)) {
      await telegramApi(env, "sendPhoto", {
        chat_id: chatId,
        photo: image
      });
    }

    if (product.video_url) {
      await telegramApi(env, "sendVideo", {
        chat_id: chatId,
        video: product.video_url
      });
    }

    return;
  }

  if (product.video_url) {
    await telegramApi(env, "sendVideo", {
      chat_id: chatId,
      video: product.video_url,
      caption,
      parse_mode: "HTML"
    });

    return;
  }

  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: caption,
    parse_mode: "HTML",
    disable_web_page_preview: false
  });
}

async function postProductToTelegramGroups(product, env) {
  const groups = telegramGroupIds(env);

  if (!groups.length) {
    return {
      sent: 0,
      groups: [],
      failures: []
    };
  }

  const sent = [];
  const failures = [];

  for (const chatId of groups) {
    try {
      await sendProduct(env, chatId, product);
      sent.push(chatId);
    } catch (error) {
      failures.push({
        chat_id: chatId,
        error: String(error.message || error)
      });
    }
  }

  return {
    sent: sent.length,
    groups: sent,
    failures
  };
}

function fileExtension(name, fallback = "jpg") {
  const match = String(name || "")
    .toLowerCase()
    .match(/\.([a-z0-9]{1,10})$/);

  return match ? match[1] : fallback;
}

function mimeFromExtension(ext) {
  const m = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif",
    svg: "image/svg+xml",

    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    m4v: "video/mp4"
  };

  return m[ext] || "application/octet-stream";
}

function extensionFromMime(type) {
  const m = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/svg+xml": "svg",

    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm"
  };

  return m[String(type || "").toLowerCase()] || "bin";
}

function base64FromBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunk)
    );
  }

  return btoa(binary);
}

function normalizeGitHubRawUrl(
  owner,
  repo,
  branch,
  path
) {
  return (
    `https://raw.githubusercontent.com/` +
    `${encodeURIComponent(owner)}/` +
    `${encodeURIComponent(repo)}/` +
    `${encodeURIComponent(branch)}/` +
    path
      .split("/")
      .map(encodeURIComponent)
      .join("/")
  );
}

function githubApiUrl(owner, repo, path = "") {
  return (
    `https://api.github.com/repos/` +
    `${encodeURIComponent(owner)}/` +
    `${encodeURIComponent(repo)}/contents/` +
    path
      .split("/")
      .map(encodeURIComponent)
      .join("/")
  ).replace(/contents\/$/, "contents");
}

async function githubRequest(
  env,
  method,
  path,
  body
) {
  const owner = cleanText(env.GITHUB_OWNER);
  const repo = cleanText(env.GITHUB_REPO);
  const token = cleanText(env.GITHUB_TOKEN);

  if (!owner || !repo || !token) {
    throw new Error(
      "GitHub media storage is not configured."
    );
  }

  const response = await fetch(
    githubApiUrl(owner, repo, path),
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent":
          "shoppers-suggestions-telegram-worker",

        ...(body
          ? {
              "Content-Type":
                "application/json"
            }
          : {})
      },
      body: body
        ? JSON.stringify(body)
        : undefined
    }
  );

  const data = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `GitHub ${method} ${path} failed: ` +
      `${response.status} ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function githubUpload(
  env,
  bytes,
  filename,
  contentType
) {
  const owner = cleanText(env.GITHUB_OWNER);
  const repo = cleanText(env.GITHUB_REPO);
  const branch =
    cleanText(env.GITHUB_BRANCH) || "main";

  const ext = fileExtension(
    filename,
    extensionFromMime(contentType)
  );

  const safeBase = cleanText(
    filename,
    120
  )
    .replace(
      /[^a-zA-Z0-9._-]+/g,
      "-"
    )
    .replace(/\.[^.]+$/, "");

  const unique =
    `${Date.now()}-` +
    `${crypto.randomUUID()}-` +
    `${safeBase || "media"}.` +
    ext;

  const path = `media/${unique}`;

  const content = base64FromBytes(bytes);

  const result = await githubRequest(
    env,
    "PUT",
    path,
    {
      message: `Add media ${unique}`,
      content,
      branch
    }
  );

  return {
    path,
    sha: result.content?.sha || "",
    url: normalizeGitHubRawUrl(
      owner,
      repo,
      branch,
      path
    ),
    html_url:
      result.content?.html_url || "",
    content_type:
      contentType ||
      mimeFromExtension(ext)
  };
}

async function githubDeleteByRawUrl(
  env,
  rawUrl
) {
  if (!rawUrl) {
    return {
      skipped: true
    };
  }

  const owner =
    cleanText(env.GITHUB_OWNER);

  const repo =
    cleanText(env.GITHUB_REPO);

  const branch =
    cleanText(env.GITHUB_BRANCH) ||
    "main";

  const prefix =
    `https://raw.githubusercontent.com/` +
    `${owner}/${repo}/${branch}/`;

  if (!rawUrl.startsWith(prefix)) {
    return {
      skipped: true,
      reason: "not-github-media"
    };
  }

  const path = rawUrl
    .slice(prefix.length)
    .split("?")[0]
    .split("#")[0];

  if (!path.startsWith("media/")) {
    return {
      skipped: true,
      reason: "not-media-path"
    };
  }

  let sha = "";

  try {
    const current =
      await githubRequest(
        env,
        "GET",
        path
      );

    sha = current.sha || "";
  } catch (error) {
    if (String(error).includes("404")) {
      return {
        skipped: true,
        reason: "already-missing"
      };
    }

    throw error;
  }

  if (!sha) {
    return {
      skipped: true,
      reason: "sha-missing"
    };
  }

  await githubRequest(
    env,
    "DELETE",
    path,
    {
      message:
        `Delete media ${path}`,
      sha,
      branch
    }
  );

  return {
    deleted: true,
    path
  };
}

async function downloadTelegramFile(
  env,
  fileId,
  originalType = "image"
) {
  const info = await telegramApi(
    env,
    "getFile",
    {
      file_id: fileId
    }
  );

  const filePath =
    info.result?.file_path;

  if (!filePath) {
    throw new Error(
      "Telegram file path not returned."
    );
  }

  const token =
    cleanText(env.TELEGRAM_BOT_TOKEN);

  const url =
    `https://api.telegram.org/file/` +
    `bot${token}/${filePath}`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Telegram file download failed: ${response.status}`
    );
  }

  const buffer =
    await response.arrayBuffer();

  const bytes =
    new Uint8Array(buffer);

  let type =
    response.headers.get(
      "content-type"
    ) || "";

  /*
   * Telegram sometimes returns
   * application/octet-stream.
   *
   * Therefore we NEVER trust the
   * response MIME type alone.
   */

  if (
    !type ||
    type ===
      "application/octet-stream"
  ) {
    const guessedExt =
      fileExtension(
        filePath,
        originalType === "video"
          ? "mp4"
          : "jpg"
      );

    type =
      mimeFromExtension(
        guessedExt
      );
  }

  let fallback =
    originalType === "video"
      ? "video.mp4"
      : "image.jpg";

  const originalName =
    filePath
      .split("/")
      .pop() ||
    fallback;

  let filename =
    originalName;

  if (
    !/\.[a-z0-9]{1,10}$/i.test(
      filename
    )
  ) {
    filename =
      `${filename}.` +
      extensionFromMime(type);
  }

  return {
    bytes,
    type,
    filename
  };
}

async function searchProducts(
  env,
  query,
  limit = 10
) {
  const q =
    cleanText(query, 200);

  if (!q) return [];

  const like =
    `%${q}%`;

  const result =
    await env.DB.prepare(`
      SELECT *
      FROM products
      WHERE published = 1
      AND (
        title LIKE ?
        OR description LIKE ?
        OR category LIKE ?
      )
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
      .bind(
        like,
        like,
        like,
        clampInt(
          limit,
          1,
          50,
          10
        )
      )
      .all();

  return result.results || [];
}

async function categoryProducts(
  env,
  category
) {
  const normalized =
    CATEGORIES.find(
      c =>
        c.toLowerCase() ===
        cleanText(category)
          .toLowerCase()
    );

  if (!normalized) {
    return [];
  }

  const result =
    await env.DB.prepare(`
      SELECT *
      FROM products
      WHERE published = 1
      AND category = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    `)
      .bind(normalized)
      .all();

  return result.results || [];
}

async function latestProducts(
  env,
  limit = 10
) {
  const result =
    await env.DB.prepare(`
      SELECT *
      FROM products
      WHERE published = 1
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
      .bind(
        clampInt(
          limit,
          1,
          50,
          10
        )
      )
      .all();

  return result.results || [];
}

async function featuredProducts(
  env,
  limit = 10
) {
  const result =
    await env.DB.prepare(`
      SELECT *
      FROM products
      WHERE published = 1
      AND featured = 1
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
      .bind(
        clampInt(
          limit,
          1,
          50,
          10
        )
      )
      .all();

  return result.results || [];
}

async function sendProductList(
  env,
  chatId,
  products,
  heading
) {
  if (!products.length) {
    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `😕 <b>${escapeTelegramHtml(heading)}</b>\n\n` +
          `No matching products were found.`,
        parse_mode: "HTML"
      }
    );

    return;
  }

  await telegramApi(
    env,
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `✨ <b>${escapeTelegramHtml(heading)}</b>\n\n` +
        `Found ${products.length} product(s).`,
      parse_mode: "HTML"
    }
  );

  for (const product of products) {
    try {
      await sendProduct(
        env,
        chatId,
        product
      );
    } catch (error) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `⚠️ Could not send ` +
            `<b>${escapeTelegramHtml(product.title)}</b>.`,
          parse_mode: "HTML"
        }
      );
    }
  }
}

function helpText(admin = false) {
  let text =
    `🛍️ <b>Shopper's Suggestions</b>\n\n` +
    `Discover products, search categories and send feedback.\n\n` +

    `🔎 <b>Search</b>\n` +
    `/search product name\n\n` +

    `📂 <b>Categories</b>\n` +
    `/categories\n` +
    `/category Tech\n\n` +

    `🔥 <b>Discover</b>\n` +
    `/latest\n` +
    `/featured\n` +
    `/product 123\n\n` +

    `💬 <b>Contact</b>\n` +
    `/feedback your message\n` +
    `/request your idea\n\n` +

    `ℹ️ /help\n` +
    `🆔 /getid`;

  if (admin) {
    text +=
      `\n\n🔐 <b>Admin</b>\n` +
      `/addproduct\n` +
      `/broadcast message\n` +
      `/sendto CHAT_ID message\n` +
      `/stats\n` +
      `/lock`;
  }

  return text;
}

async function forwardFeedback(
  env,
  type,
  chat,
  user,
  message
) {
  const ownerChatId =
    cleanText(
      env.TELEGRAM_FEEDBACK_CHAT_ID ||
      env.TELEGRAM_OWNER_CHAT_ID
    );

  if (!ownerChatId) {
    throw new Error(
      "TELEGRAM_FEEDBACK_CHAT_ID is not configured."
    );
  }

  const label =
    type === "request"
      ? "💡 NEW REQUEST"
      : "💬 NEW FEEDBACK";

  const text =
    `${label}\n\n` +
    `👤 Name: ${escapeTelegramHtml(
      user?.first_name || "Unknown"
    )}\n` +
    `🆔 User ID: <code>${escapeHtml(
      user?.id || ""
    )}</code>\n` +
    `💬 Chat ID: <code>${escapeHtml(
      chat?.id || ""
    )}</code>\n` +
    `📱 Username: @${escapeHtml(
      user?.username || "none"
    )}\n\n` +
    `${escapeTelegramHtml(message)}`;

  await telegramApi(
    env,
    "sendMessage",
    {
      chat_id: ownerChatId,
      text,
      parse_mode: "HTML"
    }
  );
}

async function broadcastMessage(
  env,
  message
) {
  const result =
    await env.DB.prepare(`
      SELECT chat_id
      FROM telegram_chats
      WHERE active = 1
    `)
      .all();

  const chats =
    result.results || [];

  let sent = 0;
  let failed = 0;

  for (const row of chats) {
    try {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: row.chat_id,
          text: message,
          parse_mode: "HTML"
        }
      );

      sent++;
    } catch {
      failed++;
    }
  }

  return {
    total: chats.length,
    sent,
    failed
  };
}

async function sendAdminMessage(
  env,
  chatId,
  message
) {
  await telegramApi(
    env,
    "sendMessage",
    {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML"
    }
  );
}

async function statsText(env) {
  const users =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM telegram_chats
      WHERE type = 'private'
      AND active = 1
    `).first();

  const groups =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM telegram_chats
      WHERE type = 'group'
      AND active = 1
    `).first();

  const supergroups =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM telegram_chats
      WHERE type = 'supergroup'
      AND active = 1
    `).first();

  const channels =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM telegram_chats
      WHERE type = 'channel'
      AND active = 1
    `).first();

  const products =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM products
      WHERE published = 1
    `).first();

  return (
    `📊 <b>Shopper's Suggestions Stats</b>\n\n` +
    `👤 Bot users: ${users?.count || 0}\n` +
    `👥 Groups: ${groups?.count || 0}\n` +
    `📢 Supergroups: ${supergroups?.count || 0}\n` +
    `📣 Channels: ${channels?.count || 0}\n` +
    `🛍️ Published products: ${products?.count || 0}`
  );
}

async function promptAddProduct(
  env,
  chatId
) {
  const s =
    await getTelegramSession(
      env,
      chatId
    );

  s.step = "title";
  s.data = {
    images: []
  };

  await saveTelegramSession(
    env,
    s
  );

  await telegramApi(
    env,
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🛍️ <b>New product</b>\n\n` +
        `Send the product title.`,
      parse_mode: "HTML"
    }
  );
}

async function createProductFromTelegramSession(
  env,
  chatId
) {
  const s =
    await getTelegramSession(
      env,
      chatId
    );

  const d =
    s.data || {};

  const category =
    d.category;

  const title =
    cleanText(
      d.title,
      300
    );

  const description =
    cleanText(
      d.description,
      5000
    );

  const affiliate =
    cleanText(
      d.affiliate_url,
      2000
    );

  const images =
    Array.isArray(d.images)
      ? d.images
          .filter(Boolean)
          .slice(0, 5)
      : [];

  const video =
    cleanText(
      d.video_url,
      2000
    );

  if (
    !title ||
    !affiliate ||
    !category
  ) {
    throw new Error(
      "Missing title, affiliate URL or category."
    );
  }

  const timestamp =
    nowSql();

  const result =
    await env.DB.prepare(`
      INSERT INTO products (
        title,
        description,
        affiliate_url,
        category,
        image1_url,
        image2_url,
        image3_url,
        image4_url,
        image5_url,
        video_url,
        published,
        featured,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
    `)
      .bind(
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
        timestamp,
        timestamp
      )
      .run();

  const product =
    await getProduct(
      env,
      result.meta.last_row_id
    );

  const telegramResult =
    await postProductToTelegramGroups(
      product,
      env
    );

  await resetTelegramProductDraft(
    env,
    chatId
  );

  return {
    product,
    telegramResult
  };
}

async function handleTelegramCallback(
  update,
  env
) {
  const callback =
    update.callback_query;

  const chatId =
    callback?.message?.chat?.id;

  const userId =
    callback?.from?.id;

  const data =
    String(
      callback?.data || ""
    );

  if (!chatId) return;

  await telegramApi(
    env,
    "answerCallbackQuery",
    {
      callback_query_id:
        callback.id
    }
  );

  const s =
    await getTelegramSession(
      env,
      chatId,
      userId
    );

  if (!s.unlocked) {
    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "🔐 Admin access required. Use /admin first."
      }
    );

    return;
  }

  if (
    data.startsWith("cat:")
  ) {
    const category =
      data.slice(4);

    if (!isValidCategory(category)) {
      return;
    }

    s.data.category =
      category;

    s.step = "images";

    await saveTelegramSession(
      env,
      s
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `📂 <b>${escapeTelegramHtml(category)}</b> selected.\n\n` +
          `Send product images one by one.\n\n` +
          `Send /done when finished or /skip for no images.`,
        parse_mode: "HTML"
      }
    );
  }
}

async function handleTelegramUpdate(
  update,
  env
) {
  if (!update?.message) {
    return;
  }

  const message =
    update.message;

  const chat =
    message.chat;

  const chatId =
    chat?.id;

  const user =
    message.from;

  const userId =
    user?.id;

  if (chatId == null) {
    return;
  }

  /*
   * Save every chat that interacts
   * with the bot.
   *
   * This allows /broadcast to reach
   * users later.
   */

  await saveTelegramChat(
    env,
    chat,
    user
  );

  const text =
    cleanText(
      message.text ||
      message.caption ||
      "",
      5000
    );

  /*
   * Telegram can send:
   *
   * /admin
   * /admin@MyBot
   *
   * Normalize the command so both work.
   */

  const firstToken =
    text
      .split(/\s+/)[0]
      .toLowerCase();

  const command =
    firstToken
      .split("@")[0];

  const args =
    text
      .slice(firstToken.length)
      .trim();

  const s =
    await getTelegramSession(
      env,
      chatId,
      userId
    );

  /*
   * START
   */

  if (command === "/start") {
    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `👋 <b>Welcome to Shopper's Suggestions!</b>\n\n` +
          `Discover useful products, search categories and find something worth discovering.\n\n` +
          `Use /help to see everything I can do.`,
        parse_mode: "HTML"
      }
    );

    return;
  }

  /*
   * HELP
   */

  if (
    command === "/help" ||
    command === "/menu"
  ) {
    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          helpText(
            Boolean(s.unlocked)
          ),
        parse_mode: "HTML"
      }
    );

    return;
  }

  /*
   * GET ID
   *
   * Works in private chats,
   * groups, supergroups and channels
   * whenever Telegram sends the update.
   */

  if (
    command === "/getid" ||
    command === "/id"
  ) {
    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `🆔 <b>This chat ID</b>\n\n` +
          `<code>${escapeHtml(chatId)}</code>\n\n` +
          `Type: <b>${escapeHtml(chat?.type || "unknown")}</b>`,
        parse_mode: "HTML"
      }
    );

    return;
  }

  /*
   * CATEGORIES
   */

  if (
    command === "/categories"
  ) {
    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `📚 <b>Available categories</b>\n\n` +
          CATEGORIES
            .map(c => `• ${escapeTelegramHtml(c)}`)
            .join("\n") +
          `\n\nUse:\n<code>/category Tech</code>`,
        parse_mode: "HTML"
      }
    );

    return;
  }

  /*
   * SEARCH
   */

  if (
    command === "/search"
  ) {
    if (!args) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `🔎 <b>Product search</b>\n\n` +
            `Example:\n` +
            `<code>/search wireless earbuds</code>`,
          parse_mode: "HTML"
        }
      );

      return;
    }

    const products =
      await searchProducts(
        env,
        args,
        10
      );

    await sendProductList(
      env,
      chatId,
      products,
      `Search results for "${args}"`
    );

    return;
  }

  /*
   * CATEGORY
   */

  if (
    command === "/category"
  ) {
    if (!args) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `📂 <b>Category search</b>\n\n` +
            `Example:\n` +
            `<code>/category Tech</code>`,
          parse_mode: "HTML"
        }
      );

      return;
    }

    const products =
      await categoryProducts(
        env,
        args
      );

    if (!products.length) {
      const valid =
        CATEGORIES.find(
          c =>
            c.toLowerCase() ===
            args.toLowerCase()
        );

      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            valid
              ? `📂 No published products are currently available in <b>${escapeTelegramHtml(valid)}</b>.`
              : `❌ Unknown category.\n\nUse /categories to see the available categories.`,
          parse_mode: "HTML"
        }
      );

      return;
    }

    await sendProductList(
      env,
      chatId,
      products,
      `${args} products`
    );

    return;
  }

  /*
   * LATEST
   */

  if (
    command === "/latest"
  ) {
    const products =
      await latestProducts(
        env,
        10
      );

    await sendProductList(
      env,
      chatId,
      products,
      "Latest products"
    );

    return;
  }

  /*
   * FEATURED
   */

  if (
    command === "/featured"
  ) {
    const products =
      await featuredProducts(
        env,
        10
      );

    await sendProductList(
      env,
      chatId,
      products,
      "Worth discovering"
    );

    return;
  }

  /*
   * PRODUCT ID
   */

  if (
    command === "/product"
  ) {
    const id =
      Number.parseInt(
        args,
        10
      );

    if (!Number.isFinite(id)) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `🔎 Example:\n<code>/product 123</code>`,
          parse_mode: "HTML"
        }
      );

      return;
    }

    const product =
      await getProduct(
        env,
        id
      );

    if (
      !product ||
      Number(product.published) !== 1
    ) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            "❌ Product not found."
        }
      );

      return;
    }

    await sendProduct(
      env,
      chatId,
      product
    );

    return;
  }

  /*
   * FEEDBACK
   */

  if (
    command === "/feedback"
  ) {
    if (!args) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `💬 <b>Send feedback</b>\n\n` +
            `Example:\n` +
            `<code>/feedback The search page is great!</code>`,
          parse_mode: "HTML"
        }
      );

      return;
    }

    try {
      await forwardFeedback(
        env,
        "feedback",
        chat,
        user,
        args
      );

      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `✅ <b>Feedback sent.</b>\n\n` +
            `Thanks for helping improve Shopper's Suggestions!`,
          parse_mode: "HTML"
        }
      );
    } catch (error) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `⚠️ Feedback could not be delivered.\n\n` +
            `${escapeTelegramHtml(error.message || "Unknown error")}`,
          parse_mode: "HTML"
        }
      );
    }

    return;
  }

  /*
   * REQUEST
   */

  if (
    command === "/request"
  ) {
    if (!args) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `💡 <b>Send a request</b>\n\n` +
            `Example:\n` +
            `<code>/request Add more creator products</code>`,
          parse_mode: "HTML"
        }
      );

      return;
    }

    try {
      await forwardFeedback(
        env,
        "request",
        chat,
        user,
        args
      );

      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `✅ <b>Request received.</b>\n\n` +
            `Thanks for the suggestion!`,
          parse_mode: "HTML"
        }
      );
    } catch (error) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `⚠️ Request could not be delivered.\n\n` +
            `${escapeTelegramHtml(error.message || "Unknown error")}`,
          parse_mode: "HTML"
        }
      );
    }

    return;
  }

  /*
   * ADMIN UNLOCK
   *
   * Supports:
   *
   * /admin
   * /admin@BotName
   * /admin 7034
   */

  if (
    command === "/admin"
  ) {
    if (args) {
      const expected =
        cleanText(
          env.TELEGRAM_ADMIN_CODE
        );

      if (
        /^\d{4}$/.test(args) &&
        expected &&
        args === expected
      ) {
        await unlockTelegram(
          env,
          chatId,
          userId
        );

        await telegramApi(
          env,
          "sendMessage",
          {
            chat_id: chatId,
            text:
              `🔓 <b>Admin unlocked.</b>\n\n` +
              helpText(true),
            parse_mode: "HTML"
          }
        );
      } else {
        await telegramApi(
          env,
          "sendMessage",
          {
            chat_id: chatId,
            text:
              "❌ Invalid admin code."
          }
        );
      }

      return;
    }

    s.step =
      "admin_code";

    s.data = {};

    await saveTelegramSession(
      env,
      s
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `🔐 <b>Admin authentication</b>\n\n` +
          `Send the 4-digit admin code.`,
        parse_mode: "HTML"
      }
    );

    return;
  }

  /*
   * ADMIN CODE STEP
   */

  if (
    !s.unlocked &&
    s.step === "admin_code" &&
    /^\d{4}$/.test(text)
  ) {
    const expected =
      cleanText(
        env.TELEGRAM_ADMIN_CODE
      );

    if (
      expected &&
      text === expected
    ) {
      await unlockTelegram(
        env,
        chatId,
        userId
      );

      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `🔓 <b>Admin unlocked.</b>\n\n` +
            helpText(true),
          parse_mode: "HTML"
        }
      );
    } else {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            "❌ Invalid admin code."
        }
      );
    }

    return;
  }

  /*
   * LOCK
   */

  if (
    command === "/lock"
  ) {
    await lockTelegram(
      env,
      chatId,
      userId
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "🔒 Admin tools locked."
      }
    );

    return;
  }

  /*
   * EVERYTHING BELOW THIS POINT
   * REQUIRES ADMIN ACCESS.
   */

  if (!s.unlocked) {
    if (command.startsWith("/")) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `🔐 This command requires admin access.\n\n` +
            `Use /admin to unlock.`
        }
      );
    }

    return;
  }

  /*
   * ADMIN BROADCAST
   *
   * /broadcast Hello everyone!
   */

  if (
    command === "/broadcast"
  ) {
    if (!args) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `📣 Example:\n` +
            `<code>/broadcast New products are live!</code>`,
          parse_mode: "HTML"
        }
      );

      return;
    }

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "📣 Sending global message..."
      }
    );

    const result =
      await broadcastMessage(
        env,
        args
      );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `📣 <b>Broadcast finished</b>\n\n` +
          `👥 Targets: ${result.total}\n` +
          `✅ Sent: ${result.sent}\n` +
          `❌ Failed: ${result.failed}`,
        parse_mode: "HTML"
      }
    );

    return;
  }

  /*
   * ADMIN SEND TO
   *
   * /sendto CHAT_ID message
   */

  if (
    command === "/sendto"
  ) {
    const parts =
      args.split(/\s+/);

    const target =
      parts.shift();

    const messageText =
      parts.join(" ").trim();

    if (
      !target ||
      !messageText
    ) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `📨 Example:\n` +
            `<code>/sendto -1001234567890 Hello!</code>`,
          parse_mode: "HTML"
        }
      );

      return;
    }

    try {
      await sendAdminMessage(
        env,
        target,
        messageText
      );

      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `✅ Message sent to <code>${escapeHtml(target)}</code>.`,
          parse_mode: "HTML"
        }
      );
    } catch (error) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `❌ Could not send message.\n\n` +
            `${escapeTelegramHtml(error.message || "Unknown error")}`,
          parse_mode: "HTML"
        }
      );
    }

    return;
  }

  /*
   * ADMIN CHANNEL
   *
   * Alias for /sendto, specifically
   * intended for channels.
   *
   * /channel -1001234567890 message
   */

  if (
    command === "/channel"
  ) {
    const parts =
      args.split(/\s+/);

    const target =
      parts.shift();

    const messageText =
      parts.join(" ").trim();

    if (
      !target ||
      !messageText
    ) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `📢 Example:\n` +
            `<code>/channel -1001234567890 New announcement!</code>`,
          parse_mode: "HTML"
        }
      );

      return;
    }

    try {
      await sendAdminMessage(
        env,
        target,
        messageText
      );

      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `📢 <b>Channel message sent.</b>\n\n` +
            `<code>${escapeHtml(target)}</code>`,
          parse_mode: "HTML"
        }
      );
    } catch (error) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `❌ Channel message failed.\n\n` +
            `${escapeTelegramHtml(error.message || "Unknown error")}`,
          parse_mode: "HTML"
        }
      );
    }

    return;
  }

  /*
   * ADMIN STATS
   */

  if (
    command === "/stats"
  ) {
    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          await statsText(env),
        parse_mode: "HTML"
      }
    );

    return;
  }

  /*
   * ADD PRODUCT
   */

  if (
    command === "/addproduct"
  ) {
    await promptAddProduct(
      env,
      chatId
    );

    return;
  }

  /*
   * CANCEL PRODUCT CREATION
   */

  if (
    command === "/cancel"
  ) {
    await resetTelegramProductDraft(
      env,
      chatId
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "🗑️ Product draft cancelled."
      }
    );

    return;
  }

  /*
   * PRODUCT TITLE
   */

  if (
    s.step === "title"
  ) {
    if (!text) return;

    s.data.title =
      text;

    s.step =
      "description";

    await saveTelegramSession(
      env,
      s
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "📝 Send the product description."
      }
    );

    return;
  }

  /*
   * DESCRIPTION
   */

  if (
    s.step === "description"
  ) {
    if (!text) return;

    s.data.description =
      text;

    s.step =
      "affiliate";

    await saveTelegramSession(
      env,
      s
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "🔗 Send the affiliate/product link."
      }
    );

    return;
  }

  /*
   * AFFILIATE LINK
   */

  if (
    s.step === "affiliate"
  ) {
    if (!text) return;

    try {
      const u =
        new URL(text);

      if (
        !/^https?:$/.test(
          u.protocol
        )
      ) {
        throw new Error();
      }
    } catch {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            "❌ Please send a valid http(s) link."
        }
      );

      return;
    }

    s.data.affiliate_url =
      text;

    s.step =
      "category";

    await saveTelegramSession(
      env,
      s
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "📂 Choose a category:",
        reply_markup:
          categoryKeyboard()
      }
    );

    return;
  }

  /*
   * PRODUCT IMAGES
   */

  if (
    s.step === "images"
  ) {
    if (
      command === "/skip" ||
      command === "/done"
    ) {
      s.step =
        "video";

      await saveTelegramSession(
        env,
        s
      );

      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `🎥 Send a product video, or /skip for no video.`
        }
      );

      return;
    }

    if (
      message.photo?.length
    ) {
      const photo =
        message.photo[
          message.photo.length - 1
        ];

      try {
        const file =
          await downloadTelegramFile(
            env,
            photo.file_id,
            "image"
          );

        const uploaded =
          await githubUpload(
            env,
            file.bytes,
            file.filename,
            file.type
          );

        s.data.images =
          Array.isArray(
            s.data.images
          )
            ? s.data.images
            : [];

        if (
          s.data.images.length < 5
        ) {
          s.data.images.push(
            uploaded.url
          );
        }

        await saveTelegramSession(
          env,
          s
        );

        await telegramApi(
          env,
          "sendMessage",
          {
            chat_id: chatId,
            text:
              `🖼️ Image ${s.data.images.length}/5 saved.\n\n` +
              `Send another image or /done.`
          }
        );
      } catch (error) {
        await telegramApi(
          env,
          "sendMessage",
          {
            chat_id: chatId,
            text:
              `❌ Image upload failed.\n\n` +
              `${escapeTelegramHtml(error.message || "Unknown error")}`,
            parse_mode: "HTML"
          }
        );
      }

      return;
    }

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "🖼️ Send an image or /done."
      }
    );

    return;
  }

  /*
   * PRODUCT VIDEO
   */

  if (
    s.step === "video"
  ) {
    if (
      command === "/skip"
    ) {
      s.data.video_url =
        "";

      s.step =
        "confirm";

      await saveTelegramSession(
        env,
        s
      );

      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `✅ <b>Ready to publish</b>\n\n` +
            `🛍️ ${escapeTelegramHtml(s.data.title)}\n` +
            `📂 ${escapeTelegramHtml(s.data.category)}\n` +
            `🖼️ ${(s.data.images || []).length} image(s)\n` +
            `🎥 No video\n\n` +
            `Send <code>/publish</code> to publish or <code>/cancel</code>.`,
          parse_mode: "HTML"
        }
      );

      return;
    }

    if (
      message.video?.file_id
    ) {
      try {
        const file =
          await downloadTelegramFile(
            env,
            message.video.file_id,
            "video"
          );

        const uploaded =
          await githubUpload(
            env,
            file.bytes,
            file.filename,
            file.type
          );

        s.data.video_url =
          uploaded.url;

        s.step =
          "confirm";

        await saveTelegramSession(
          env,
          s
        );

        await telegramApi(
          env,
          "sendMessage",
          {
            chat_id: chatId,
            text:
              `🎥 <b>Video saved.</b>\n\n` +
              `Send <code>/publish</code> to publish or <code>/cancel</code>.`,
            parse_mode: "HTML"
          }
        );
      } catch (error) {
        await telegramApi(
          env,
          "sendMessage",
          {
            chat_id: chatId,
            text:
              `❌ Video upload failed.\n\n` +
              `${escapeTelegramHtml(error.message || "Unknown error")}`,
            parse_mode: "HTML"
          }
        );
      }

      return;
    }

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "🎥 Send a video or /skip."
      }
    );

    return;
  }

  /*
   * PUBLISH
   */

  if (
    s.step === "confirm" &&
    command === "/publish"
  ) {
    try {
      const created =
        await createProductFromTelegramSession(
          env,
          chatId
        );

      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `🎉 <b>Product #${created.product.id} published!</b>\n\n` +
            (
              created.telegramResult.failures?.length
                ? "⚠️ Some group/channel posts failed."
                : "📣 Group/channel posting complete."
            ) +
            `\n\nUse /addproduct for another product.`,
          parse_mode: "HTML"
        }
      );
    } catch (error) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `❌ Could not publish.\n\n` +
            `${escapeTelegramHtml(error.message || "Unknown error")}`,
          parse_mode: "HTML"
        }
      );
    }

    return;
  }
}

async function handleTelegramRequest(
  request,
  env
) {
  const secret =
    cleanText(
      env.TELEGRAM_WEBHOOK_SECRET
    );

  if (secret) {
    const supplied =
      request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token"
      ) || "";

    if (
      supplied !== secret
    ) {
      return new Response(
        "Unauthorized",
        {
          status: 401
        }
      );
    }
  }

  let update;

  try {
    update =
      await request.json();
  } catch {
    return new Response(
      "Invalid JSON",
      {
        status: 400
      }
    );
  }

  try {
    if (
      update?.callback_query
    ) {
      await handleTelegramCallback(
        update,
        env
      );
    } else {
      await handleTelegramUpdate(
        update,
        env
      );
    }
  } catch (error) {
    console.error(
      "Telegram update error:",
      error
    );
  }

  return new Response(
    "OK"
  );
}

async function setupTelegramWebhook(
  request,
  env
) {
  const url =
    new URL(request.url);

  const key =
    url.searchParams.get(
      "key"
    ) || "";

  const setupSecret =
    cleanText(
      env.TELEGRAM_SETUP_SECRET
    );

  if (
    !setupSecret ||
    key !== setupSecret
  ) {
    return json(
      {
        ok: false,
        error: "Unauthorized."
      },
      401
    );
  }

  const publicWebhook =
    `${url.origin}/api/telegram/webhook`;

  const payload = {
    url: publicWebhook
  };

  const webhookSecret =
    cleanText(
      env.TELEGRAM_WEBHOOK_SECRET
    );

  if (webhookSecret) {
    payload.secret_token =
      webhookSecret;
  }

  const result =
    await telegramApi(
      env,
      "setWebhook",
      payload
    );

  return json({
    ok: true,
    telegram: result.ok,
    webhook: publicWebhook
  });
}

async function telegramTestGroups(
  request,
  env
) {
  const ids =
    telegramGroupIds(env);

  if (!ids.length) {
    return api(
      {
        ok: false,
        error:
          "TELEGRAM_GROUP_IDS is empty."
      },
      request,
      400
    );
  }

  const results = [];

  for (const chat_id of ids) {
    try {
      const result =
        await telegramApi(
          env,
          "getChat",
          {
            chat_id
          }
        );

      results.push({
        chat_id,
        ok: true,
        type:
          result.result?.type || "",
        title:
          result.result?.title ||
          result.result?.username ||
          ""
      });
    } catch (error) {
      results.push({
        chat_id,
        ok: false,
        error:
          String(
            error.message || error
          )
      });
    }
  }

  return api(
    {
      ok:
        results.every(
          x => x.ok
        ),
      groups: results
    },
    request
  );
}

async function health(env) {
  const result =
    await env.DB
      .prepare(
        "SELECT 1 AS ok"
      )
      .first();

  return {
    ok:
      result?.ok === 1,
    service:
      "shopper-s-suggestions"
  };
}

async function verifyAdminSession(
  request,
  env
) {
  const token =
    cookieValue(
      request,
      "ss_admin_session"
    );

  if (!token) {
    return false;
  }

  const row =
    await env.DB
      .prepare(`
        SELECT token, expires_at
        FROM admin_sessions
        WHERE token = ?
        LIMIT 1
      `)
      .bind(token)
      .first();

  if (!row) {
    return false;
  }

  const expired =
    Date.parse(
      String(
        row.expires_at
      ).replace(
        " ",
        "T"
      ) +
      (
        String(
          row.expires_at
        ).includes("Z")
          ? ""
          : "Z"
      )
    ) <= Date.now();

  if (expired) {
    await env.DB
      .prepare(
        "DELETE FROM admin_sessions WHERE token = ?"
      )
      .bind(token)
      .run();

    return false;
  }

  return true;
}

function adminPassword(env) {
  return (
    cleanText(
      env.ADMIN_PASSWORD
    ) ||
    cleanText(
      env.TELEGRAM_ADMIN_CODE
    )
  );
}

async function adminLogin(
  request,
  env
) {
  const body =
    await parseBody(request);

  const password =
    cleanText(
      body.password ||
      body.code ||
      body.admin_code,
      200
    );

  const expected =
    adminPassword(env);

  if (
    !expected ||
    password !== expected
  ) {
    return api(
      {
        ok: false,
        error:
          "Invalid admin password."
      },
      request,
      401
    );
  }

  const token =
    newToken();

  const expires =
    new Date(
      Date.now() +
      1000 * 60 * 60 * 24 * 7
    )
      .toISOString()
      .replace(
        "T",
        " "
      )
      .replace(
        /\.000Z$/,
        ""
      );

  await env.DB
    .prepare(`
      INSERT INTO admin_sessions (
        token,
        expires_at
      )
      VALUES (?, ?)
    `)
    .bind(
      token,
      expires
    )
    .run();

  return withCors(
    json({
      ok: true,
      admin: true,
      authenticated: true
    }),
    request,
    {
      "Set-Cookie":
        `ss_admin_session=${encodeURIComponent(token)}; ` +
        `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
    }
  );
}

async function adminLogout(
  request,
  env
) {
  const token =
    cookieValue(
      request,
      "ss_admin_session"
    );

  if (token) {
    await env.DB
      .prepare(
        "DELETE FROM admin_sessions WHERE token = ?"
      )
      .bind(token)
      .run();
  }

  return withCors(
    new Response(
      JSON.stringify({
        ok: true
      }),
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/json; charset=UTF-8",
          "Set-Cookie":
            "ss_admin_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
        }
      }
    ),
    request
  );
}

async function parseBody(
  request
) {
  const type =
    request.headers.get(
      "Content-Type"
    ) || "";

  if (
    type.includes(
      "multipart/form-data"
    )
  ) {
    return await request.formData();
  }

  const text =
    await request.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    const params =
      new URLSearchParams(text);

    return Object.fromEntries(
      params.entries()
    );
  }
}

async function prepareProductInput(
  body,
  existing = {}
) {
  const get =
    (
      name,
      fallback = ""
    ) =>
      body instanceof FormData
        ? body.get(name)
        : body?.[name] ??
          fallback;

  const title =
    cleanText(
      get(
        "title",
        existing.title
      ),
      300
    );

  const description =
    cleanText(
      get(
        "description",
        existing.description
      ),
      10000
    );

  const affiliate_url =
    cleanText(
      get(
        "affiliate_url",
        existing.affiliate_url
      ),
      3000
    );

  const category =
    cleanText(
      get(
        "category",
        existing.category
      ),
      100
    );

  const published =
    isTruthy(
      get(
        "published",
        existing.published ?? 1
      )
    )
      ? 1
      : 0;

  const featured =
    isTruthy(
      get(
        "featured",
        existing.featured ?? 0
      )
    )
      ? 1
      : 0;

  if (!title) {
    throw new Error(
      "Title is required."
    );
  }

  if (!affiliate_url) {
    throw new Error(
      "Affiliate URL is required."
    );
  }

  if (
    !isValidCategory(
      category
    )
  ) {
    throw new Error(
      "Invalid category."
    );
  }

  const imageUrls = [];

  for (
    let i = 1;
    i <= 5;
    i++
  ) {
    const value =
      cleanText(
        get(
          `image${i}_url`,
          existing[
            `image${i}_url`
          ] || ""
        ),
        5000
      );

    if (value) {
      imageUrls.push(
        value
      );
    }
  }

  return {
    title,
    description,
    affiliate_url,
    category,

    image1_url:
      imageUrls[0] || "",

    image2_url:
      imageUrls[1] || "",

    image3_url:
      imageUrls[2] || "",

    image4_url:
      imageUrls[3] || "",

    image5_url:
      imageUrls[4] || "",

    video_url:
      cleanText(
        get(
          "video_url",
          existing.video_url ||
          ""
        ),
        5000
      ),

    published,
    featured
  };
}

async function createWebsiteProduct(
  request,
  env
) {
  const body =
    await parseBody(request);

  const input =
    await prepareProductInput(
      body
    );

  const timestamp =
    nowSql();

  const result =
    await env.DB.prepare(`
      INSERT INTO products (
        title,
        description,
        affiliate_url,
        category,
        image1_url,
        image2_url,
        image3_url,
        image4_url,
        image5_url,
        video_url,
        published,
        featured,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        input.title,
        input.description,
        input.affiliate_url,
        input.category,

        input.image1_url,
        input.image2_url,
        input.image3_url,
        input.image4_url,
        input.image5_url,

        input.video_url,

        input.published,
        input.featured,

        timestamp,
        timestamp
      )
      .run();

  const product =
    await getProduct(
      env,
      result.meta.last_row_id
    );

  let telegram = null;

  if (
    Number(
      product.published
    ) === 1
  ) {
    telegram =
      await postProductToTelegramGroups(
        product,
        env
      );
  }

  return api(
    {
      ok: true,
      product:
        productPublic(
          product
        ),
      telegram
    },
    request,
    201
  );
}

async function updateWebsiteProduct(
  request,
  env,
  id
) {
  const existing =
    await getProduct(
      env,
      id
    );

  if (!existing) {
    return api(
      {
        ok: false,
        error:
          "Product not found."
      },
      request,
      404
    );
  }

  const body =
    await parseBody(request);

  const input =
    await prepareProductInput(
      body,
      existing
    );

  const oldMedia =
    productImages(
      existing
    );

  await env.DB.prepare(`
    UPDATE products SET
      title = ?,
      description = ?,
      affiliate_url = ?,
      category = ?,
      image1_url = ?,
      image2_url = ?,
      image3_url = ?,
      image4_url = ?,
      image5_url = ?,
      video_url = ?,
      published = ?,
      featured = ?,
      updated_at = ?
    WHERE id = ?
  `)
    .bind(
      input.title,
      input.description,
      input.affiliate_url,
      input.category,

      input.image1_url,
      input.image2_url,
      input.image3_url,
      input.image4_url,
      input.image5_url,

      input.video_url,
      input.published,
      input.featured,

      nowSql(),
      id
    )
    .run();

  const updated =
    await getProduct(
      env,
      id
    );

  const newMedia =
    new Set(
      productImages(
        updated
      )
    );

  for (
    const url of oldMedia
  ) {
    if (
      url &&
      !newMedia.has(url)
    ) {
      try {
        await githubDeleteByRawUrl(
          env,
          url
        );
      } catch {}
    }
  }

  return api(
    {
      ok: true,
      product:
        productPublic(
          updated
        )
    },
    request
  );
}

async function deleteWebsiteProduct(
  request,
  env,
  id
) {
  const product =
    await getProduct(
      env,
      id
    );

  if (!product) {
    return api(
      {
        ok: false,
        error:
          "Product not found."
      },
      request,
      404
    );
  }

  await env.DB
    .prepare(
      "DELETE FROM products WHERE id = ?"
    )
    .bind(id)
    .run();

  for (
    const url of [
      ...productImages(
        product
      ),
      product.video_url || ""
    ]
  ) {
    try {
      await githubDeleteByRawUrl(
        env,
        url
      );
    } catch {}
  }

  return api(
    {
      ok: true,
      deleted:
        Number(id)
    },
    request
  );
}

async function listPublicProducts(
  request,
  env
) {
  const url =
    new URL(
      request.url
    );

  const id =
    url.searchParams.get(
      "id"
    );

  if (id) {
    const product =
      await getProduct(
        env,
        id
      );

    if (
      !product ||
      Number(
        product.published
      ) !== 1
    ) {
      return api(
        {
          ok: false,
          error:
            "Product not found."
        },
        request,
        404
      );
    }

    return api(
      {
        ok: true,
        product:
          productPublic(
            product
          )
      },
      request
    );
  }

  const search =
    cleanText(
      url.searchParams.get(
        "search"
      ),
      200
    );

  const category =
    cleanText(
      url.searchParams.get(
        "category"
      ),
      100
    );

  const featuredOnly =
    isTruthy(
      url.searchParams.get(
        "featured"
      )
    );

  const limit =
    clampInt(
      url.searchParams.get(
        "limit"
      ),
      1,
      100,
      30
    );

  let sql =
    "SELECT * FROM products WHERE published = 1";

  const params = [];

  if (search) {
    sql +=
      " AND (title LIKE ? OR description LIKE ? OR category LIKE ?)";

    const q =
      `%${search}%`;

    params.push(
      q,
      q,
      q
    );
  }

  if (
    category &&
    isValidCategory(
      category
    )
  ) {
    sql +=
      " AND category = ?";

    params.push(
      category
    );
  }

  if (featuredOnly) {
    sql +=
      " AND featured = 1";
  }

  sql +=
    " ORDER BY created_at DESC, id DESC LIMIT ?";

  params.push(
    limit
  );

  const result =
    await env.DB
      .prepare(sql)
      .bind(...params)
      .all();

  return api(
    {
      ok: true,
      products:
        (
          result.results ||
          []
        ).map(
          productPublic
        )
    },
    request
  );
}

async function listAdminProducts(
  request,
  env
) {
  if (
    !await verifyAdminSession(
      request,
      env
    )
  ) {
    return api(
      {
        ok: false,
        error:
          "Unauthorized."
      },
      request,
      401
    );
  }

  const url =
    new URL(
      request.url
    );

  const limit =
    clampInt(
      url.searchParams.get(
        "limit"
      ),
      1,
      200,
      100
    );

  const result =
    await env.DB
      .prepare(`
        SELECT *
        FROM products
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .bind(limit)
      .all();

  return api(
    {
      ok: true,
      products:
        (
          result.results ||
          []
        ).map(
          productPublic
        )
    },
    request
  );
}

async function handleUploadMedia(
  request,
  env
) {
  if (
    !await verifyAdminSession(
      request,
      env
    )
  ) {
    return api(
      {
        ok: false,
        error:
          "Unauthorized."
      },
      request,
      401
    );
  }

  const body =
    await request.formData();

  const file =
    body.get("file") ||
    body.get("image") ||
    body.get("media");

  if (!(file instanceof File)) {
    return api(
      {
        ok: false,
        error:
          "No media file provided."
      },
      request,
      400
    );
  }

  if (
    file.size >
    20 * 1024 * 1024
  ) {
    return api(
      {
        ok: false,
        error:
          "File is too large. Maximum 20 MB."
      },
      request,
      413
    );
  }

  const bytes =
    new Uint8Array(
      await file.arrayBuffer()
    );

  const contentType =
    file.type ||
    mimeFromExtension(
      fileExtension(
        file.name,
        "jpg"
      )
    );

  const result =
    await githubUpload(
      env,
      bytes,
      file.name,
      contentType
    );

  return api(
    {
      ok: true,
      ...result
    },
    request
  );
}

async function handleTelegramTest(
  request,
  env
) {
  const result =
    await telegramApi(
      env,
      "getMe",
      {}
    );

  return api(
    {
      ok: true,
      bot:
        result.result
    },
    request
  );
}

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    try {
      if (
        request.method ===
        "OPTIONS"
      ) {
        return withCors(
          new Response(
            null,
            {
              status: 204
            }
          ),
          request
        );
      }

      await ensureSchema(
        env
      );

      const url =
        new URL(
          request.url
        );

      const path =
        url.pathname
          .replace(
            /\/+/g,
            "/"
          )
          .replace(
            /\/$/,
            ""
          ) || "/";

      if (
        path ===
        "/api/health"
      ) {
        return api(
          await health(env),
          request
        );
      }

      if (
        path ===
        "/api/categories"
      ) {
        return api(
          {
            ok: true,
            categories:
              CATEGORIES
          },
          request
        );
      }

      if (
        path ===
        "/api/telegram/test"
        &&
        request.method ===
        "GET"
      ) {
        return handleTelegramTest(
          request,
          env
        );
      }

      if (
        path ===
        "/api/telegram/setup"
        &&
        request.method ===
        "GET"
      ) {
        return setupTelegramWebhook(
          request,
          env
        );
      }

      if (
        path ===
        "/api/telegram/webhook"
        &&
        request.method ===
        "POST"
      ) {
        return handleTelegramRequest(
          request,
          env
        );
      }

      if (
        path ===
        "/api/telegram/test-groups"
        &&
        request.method ===
        "GET"
      ) {
        return telegramTestGroups(
          request,
          env
        );
      }

      if (
        path ===
        "/api/admin/login"
        &&
        request.method ===
        "POST"
      ) {
        return adminLogin(
          request,
          env
        );
      }

      if (
        path ===
        "/api/admin/logout"
        &&
        request.method ===
        "POST"
      ) {
        return adminLogout(
          request,
          env
        );
      }

      if (
        path ===
        "/api/admin/check"
        &&
        request.method ===
        "GET"
      ) {
        const authenticated =
          await verifyAdminSession(
            request,
            env
          );

        return api(
          {
            ok:
              authenticated,
            admin:
              authenticated,
            authenticated
          },
          request
        );
      }

      if (
        path ===
        "/api/upload-media"
        &&
        request.method ===
        "POST"
      ) {
        return handleUploadMedia(
          request,
          env
        );
      }

      if (
        path ===
        "/api/admin/products"
        &&
        request.method ===
        "GET"
      ) {
        return listAdminProducts(
          request,
          env
        );
      }

      if (
        path ===
        "/api/admin/products"
        &&
        request.method ===
        "POST"
      ) {
        if (
          !await verifyAdminSession(
            request,
            env
          )
        ) {
          return api(
            {
              ok: false,
              error:
                "Unauthorized."
            },
            request,
            401
          );
        }

        return createWebsiteProduct(
          request,
          env
        );
      }

      const adminProductMatch =
        path.match(
          /^\/api\/admin\/products\/(\d+)$/
        );

      if (
        adminProductMatch
      ) {
        const id =
          Number(
            adminProductMatch[1]
          );

        if (
          !await verifyAdminSession(
            request,
            env
          )
        ) {
          return api(
            {
              ok: false,
              error:
                "Unauthorized."
            },
            request,
            401
          );
        }

        if (
          request.method ===
            "PUT" ||
          request.method ===
            "PATCH"
        ) {
          return updateWebsiteProduct(
            request,
            env,
            id
          );
        }

        if (
          request.method ===
          "DELETE"
        ) {
          return deleteWebsiteProduct(
            request,
            env,
            id
          );
        }
      }

      if (
        path ===
        "/api/products" &&
        request.method ===
        "GET"
      ) {
        return listPublicProducts(
          request,
          env
        );
      }

      if (
        path ===
        "/api/products" &&
        request.method ===
        "POST"
      ) {
        if (
          !await verifyAdminSession(
            request,
            env
          )
        ) {
          return api(
            {
              ok: false,
              error:
                "Unauthorized."
            },
            request,
            401
          );
        }

        return createWebsiteProduct(
          request,
          env
        );
      }

      const singularProductMatch =
        path.match(
          /^\/api\/product\/(\d+)$/
        );

      if (
        singularProductMatch &&
        request.method ===
          "GET"
      ) {
        const id =
          Number(
            singularProductMatch[1]
          );

        const product =
          await getProduct(
            env,
            id
          );

        if (
          !product ||
          Number(
            product.published
          ) !== 1
        ) {
          return api(
            {
              ok: false,
              error:
                "Product not found."
            },
            request,
            404
          );
        }

        return api(
          {
            ok: true,
            product:
              productPublic(
                product
              )
          },
          request
        );
      }

      const productMatch =
        path.match(
          /^\/api\/products\/(\d+)$/
        );

      if (
        productMatch
      ) {
        const id =
          Number(
            productMatch[1]
          );

        if (
          request.method ===
          "GET"
        ) {
          const product =
            await getProduct(
              env,
              id
            );

          if (
            !product ||
            Number(
              product.published
            ) !== 1
          ) {
            return api(
              {
                ok: false,
                error:
                  "Product not found."
              },
              request,
              404
            );
          }

          return api(
            {
              ok: true,
              product:
                productPublic(
                  product
                )
            },
            request
          );
        }

        if (
          request.method ===
            "PUT" ||
          request.method ===
            "PATCH"
        ) {
          if (
            !await verifyAdminSession(
              request,
              env
            )
          ) {
            return api(
              {
                ok: false,
                error:
                  "Unauthorized."
              },
              request,
              401
            );
          }

          return updateWebsiteProduct(
            request,
            env,
            id
          );
        }

        if (
          request.method ===
          "DELETE"
        ) {
          if (
            !await verifyAdminSession(
              request,
              env
            )
          ) {
            return api(
              {
                ok: false,
                error:
                  "Unauthorized."
              },
              request,
              401
            );
          }

          return deleteWebsiteProduct(
            request,
            env,
            id
          );
        }
      }

      /*
       * Optional media proxy.
       */

      if (
        path.startsWith(
          "/media/"
        ) &&
        request.method ===
          "GET"
      ) {
        const filename =
          path.slice(
            "/media/".length
          );

        const owner =
          cleanText(
            env.GITHUB_OWNER
          );

        const repo =
          cleanText(
            env.GITHUB_REPO
          );

        const branch =
          cleanText(
            env.GITHUB_BRANCH
          ) || "main";

        if (
          owner &&
          repo &&
          filename
        ) {
          return redirect(
            normalizeGitHubRawUrl(
              owner,
              repo,
              branch,
              `media/${filename}`
            )
          );
        }
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(
          request
        );
      }

      return new Response(
        "Not found",
        {
          status: 404
        }
      );
    } catch (error) {
      console.error(error);

      return api(
        {
          ok: false,
          error:
            String(
              error?.message ||
              error ||
              "Internal server error"
            )
        },
        request,
        500
      );
    }
  }
};
