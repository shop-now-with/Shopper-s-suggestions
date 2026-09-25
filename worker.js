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

async function hashText(value) {
  const bytes = new TextEncoder().encode(value);

  const hash = await crypto.subtle.digest(
    "SHA-256",
    bytes
  );

  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function parseBody(request) {
  const type = request.headers.get("Content-Type") || "";

  if (type.includes("multipart/form-data")) {
    return await request.formData();
  }

  const text = await request.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    const params = new URLSearchParams(text);
    return Object.fromEntries(params.entries());
  }
}

async function ensureSchema(env) {
  for (
    const statement of BASE_SCHEMA
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
  ) {
    await env.DB.prepare(statement).run();
  }

  const cols = await env.DB
    .prepare("PRAGMA table_info(products)")
    .all();

  const names = new Set(
    (cols.results || []).map((r) => r.name)
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

function productPublic(product) {
  if (!product) {
    return null;
  }

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
  return `https://shopperssuggestions.online/?product=${encodeURIComponent(id)}`;
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

function telegramCaption(product) {
  const link = productShareUrl(product.id);

  const featured =
    Number(product.featured) === 1
      ? "\n⭐ <b>Worth discovering</b>"
      : "";

  return (
    `<b>${escapeTelegramHtml(product.title)}</b>\n\n` +
    `${escapeTelegramHtml(product.description)}\n\n` +
    `<b>Category:</b> ${escapeTelegramHtml(product.category)}` +
    `${featured}\n\n` +
    `<a href="${link}">View this product</a>`
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

  const data = await response
    .json()
    .catch(() => ({}));

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram ${method} failed: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function postProductToTelegramGroups(product, env) {
  const groups = telegramGroupIds(env);

  if (!groups.length) {
    return {
      sent: 0,
      groups: []
    };
  }

  const images = productImages(product);
  const caption = telegramCaption(product);

  const sent = [];
  const failures = [];

  for (const chatId of groups) {
    try {
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
      } else if (product.video_url) {
        await telegramApi(env, "sendVideo", {
          chat_id: chatId,
          video: product.video_url,
          caption,
          parse_mode: "HTML"
        });
      } else {
        await telegramApi(env, "sendMessage", {
          chat_id: chatId,
          text: caption,
          parse_mode: "HTML",
          disable_web_page_preview: false
        });
      }

      if (product.video_url && images.length) {
        await telegramApi(env, "sendVideo", {
          chat_id: chatId,
          video: product.video_url
        });
      }

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

async function getTelegramSession(
  env,
  chatId,
  userId = ""
) {
  const row = await env.DB
    .prepare(
      "SELECT * FROM telegram_sessions WHERE chat_id = ? LIMIT 1"
    )
    .bind(String(chatId))
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

  const id = String(chatId);

  await env.DB
    .prepare(`
      INSERT INTO telegram_sessions
      (chat_id, user_id, unlocked, step, data_json, updated_at)
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
  await env.DB
    .prepare(`
      INSERT INTO telegram_sessions
      (chat_id, user_id, unlocked, step, data_json, updated_at)
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

async function lockTelegram(env, chatId) {
  const s = await getTelegramSession(env, chatId);

  s.unlocked = 0;
  s.step = "idle";
  s.data = {};

  await saveTelegramSession(env, s);

  return s;
}

async function clearTelegramSession(env, chatId) {
  await env.DB
    .prepare(
      "DELETE FROM telegram_sessions WHERE chat_id = ?"
    )
    .bind(String(chatId))
    .run();
}

function categoryKeyboard() {
  const rows = [];

  for (let i = 0; i < CATEGORIES.length; i += 2) {
    rows.push(
      CATEGORIES
        .slice(i, i + 2)
        .map((category) => ({
          text: category,
          callback_data: `category:${category}`
        }))
    );
  }

  return {
    inline_keyboard: rows
  };
}

function adminKeyboard() {
  return {
    keyboard: [
      [
        { text: "/addproduct" },
        { text: "/getid" }
      ],
      [
        { text: "/lock" }
      ]
    ],
    resize_keyboard: true
  };
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
    `/${encodeURIComponent(branch)}/` +
    path
      .split("/")
      .map(encodeURIComponent)
      .join("/")
  );
}

function githubApiBase(env) {
  const owner = cleanText(env.GITHUB_OWNER);
  const repo = cleanText(env.GITHUB_REPO);

  if (!owner || !repo) {
    throw new Error(
      "GITHUB_OWNER or GITHUB_REPO is missing"
    );
  }

  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function githubHeaders(env) {
  const token = cleanText(env.GITHUB_TOKEN);

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not configured"
    );
  }

  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Shopper-Suggestions-Worker"
  };
}

function safeFilename(name, fallback = "file") {
  const cleaned = cleanText(name, 200)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned || fallback;
}

function extensionFromType(type) {
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov"
  };

  return map[type] || "";
}

async function githubUpload(
  env,
  bytes,
  filename,
  contentType = ""
) {
  const owner = cleanText(env.GITHUB_OWNER);
  const repo = cleanText(env.GITHUB_REPO);
  const branch =
    cleanText(env.GITHUB_BRANCH) || "main";

  const safe = safeFilename(
    filename,
    "upload" + extensionFromType(contentType)
  );

  const path =
    `media/${Date.now()}-${crypto.randomUUID()}-${safe}`;

  const base64 = bytesToBase64(bytes);

  const response = await fetch(
    `${githubApiBase(env)}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        ...githubHeaders(env),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: `Add media ${safe}`,
        content: base64,
        branch
      })
    }
  );

  const data = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `GitHub upload failed: ${response.status} ${JSON.stringify(data)}`
    );
  }

  return {
    path,
    url: normalizeGitHubRawUrl(
      owner,
      repo,
      branch,
      path
    ),
    html_url: data.content?.html_url || "",
    sha: data.content?.sha || ""
  };
}

async function githubDelete(
  env,
  rawUrl
) {
  const owner = cleanText(env.GITHUB_OWNER);
  const repo = cleanText(env.GITHUB_REPO);
  const branch =
    cleanText(env.GITHUB_BRANCH) || "main";

  if (!rawUrl) {
    return {
      ok: true,
      skipped: true
    };
  }

  let pathname = "";

  try {
    const u = new URL(rawUrl);

    if (
      u.hostname ===
      "raw.githubusercontent.com"
    ) {
      pathname = u.pathname
        .split("/")
        .slice(4)
        .join("/");
    }
  } catch {
    return {
      ok: true,
      skipped: true
    };
  }

  if (!pathname.startsWith("media/")) {
    return {
      ok: true,
      skipped: true
    };
  }

  const getResponse = await fetch(
    `${githubApiBase(env)}/contents/${pathname}?ref=${encodeURIComponent(branch)}`,
    {
      headers: githubHeaders(env)
    }
  );

  const getData = await getResponse
    .json()
    .catch(() => ({}));

  if (getResponse.status === 404) {
    return {
      ok: true,
      missing: true
    };
  }

  if (!getResponse.ok) {
    throw new Error(
      `GitHub lookup failed: ${getResponse.status}`
    );
  }

  const delResponse = await fetch(
    `${githubApiBase(env)}/contents/${pathname}`,
    {
      method: "DELETE",
      headers: {
        ...githubHeaders(env),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: `Delete media ${pathname}`,
        sha: getData.sha,
        branch
      })
    }
  );

  const delData = await delResponse
    .json()
    .catch(() => ({}));

  if (!delResponse.ok) {
    throw new Error(
      `GitHub delete failed: ${delResponse.status} ${JSON.stringify(delData)}`
    );
  }

  return {
    ok: true
  };
}

function bytesToBase64(bytes) {
  let binary = "";

  const chunkSize = 0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    binary += String.fromCharCode(
      ...bytes.subarray(
        i,
        Math.min(i + chunkSize, bytes.length)
      )
    );
  }

  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(
    binary.length
  );

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function downloadTelegramFile(
  env,
  fileId,
  kind
) {
  const fileInfo = await telegramApi(
    env,
    "getFile",
    {
      file_id: fileId
    }
  );

  const filePath =
    fileInfo.result?.file_path;

  if (!filePath) {
    throw new Error(
      "Telegram did not return a file path."
    );
  }

  const token =
    cleanText(env.TELEGRAM_BOT_TOKEN);

  const response = await fetch(
    `https://api.telegram.org/file/bot${token}/${filePath}`
  );

  if (!response.ok) {
    throw new Error(
      `Telegram file download failed: ${response.status}`
    );
  }

  const bytes = new Uint8Array(
    await response.arrayBuffer()
  );

  let type =
    response.headers.get("content-type") ||
    "";

  let extension = "";

  const originalName =
    filePath.split("/").pop() ||
    "";

  const originalExtension =
    originalName.includes(".")
      ? "." +
        originalName
          .split(".")
          .pop()
          .toLowerCase()
      : "";

  if (
    !type ||
    type === "application/octet-stream"
  ) {
    if (kind === "image") {
      type = "image/jpeg";
      extension = originalExtension || ".jpg";
    } else {
      type = "video/mp4";
      extension = originalExtension || ".mp4";
    }
  }

  if (!extension) {
    extension =
      originalExtension ||
      extensionFromType(type) ||
      (kind === "image"
        ? ".jpg"
        : ".mp4");
  }

  return {
    bytes,
    type,
    filename:
      safeFilename(
        originalName,
        `${kind}${extension}`
      ) || `${kind}${extension}`
  };
}

async function adminLogin(request, env) {
  const body = await parseBody(request);

  const code = cleanText(
    body.code ||
    body.password ||
    body.admin_code
  );

  const expected =
    cleanText(env.TELEGRAM_ADMIN_CODE);

  if (
    !expected ||
    code !== expected
  ) {
    return api(
      {
        ok: false,
        error: "Invalid admin code."
      },
      request,
      401
    );
  }

  const token = newToken();

  const expiresAt =
    new Date(
      Date.now() +
        1000 * 60 * 60 * 24 * 30
    ).toISOString();

  await env.DB
    .prepare(`
      INSERT INTO admin_sessions
      (token, created_at, expires_at)
      VALUES (?, ?, ?)
    `)
    .bind(
      token,
      nowSql(),
      expiresAt
    )
    .run();

  const response = api(
    {
      ok: true,
      admin: true
    },
    request
  );

  const headers = new Headers(
    response.headers
  );

  headers.append(
    "Set-Cookie",
    `zilnet_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
  );

  return new Response(
    response.body,
    {
      status: response.status,
      headers
    }
  );
}

async function verifyAdminSession(
  request,
  env
) {
  const token =
    cookieValue(
      request,
      "zilnet_admin"
    );

  if (!token) {
    return false;
  }

  const row =
    await env.DB
      .prepare(`
        SELECT token
        FROM admin_sessions
        WHERE token = ?
        AND expires_at > ?
        LIMIT 1
      `)
      .bind(
        token,
        new Date().toISOString()
      )
      .first();

  return Boolean(row);
}

async function adminLogout(request, env) {
  const token =
    cookieValue(
      request,
      "zilnet_admin"
    );

  if (token) {
    await env.DB
      .prepare(
        "DELETE FROM admin_sessions WHERE token = ?"
      )
      .bind(token)
      .run();
  }

  const response =
    api(
      {
        ok: true
      },
      request
    );

  const headers =
    new Headers(
      response.headers
    );

  headers.append(
    "Set-Cookie",
    "zilnet_admin=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );

  return new Response(
    response.body,
    {
      status: response.status,
      headers
    }
  );
}

function readProductFields(body) {
  const category =
    cleanText(body.category);

  if (
    category &&
    !isValidCategory(category)
  ) {
    throw new Error(
      "Invalid category."
    );
  }

  const fields = {
    title: cleanText(
      body.title,
      500
    ),

    description: cleanText(
      body.description,
      100000
    ),

    affiliate_url:
      cleanText(
        body.affiliate_url ||
        body.affiliateUrl,
        4000
      ),

    category:
      category || "Other",

    image1_url:
      cleanText(
        body.image1_url ||
        body.image1 ||
        "",
        4000
      ),

    image2_url:
      cleanText(
        body.image2_url ||
        body.image2 ||
        "",
        4000
      ),

    image3_url:
      cleanText(
        body.image3_url ||
        body.image3 ||
        "",
        4000
      ),

    image4_url:
      cleanText(
        body.image4_url ||
        body.image4 ||
        "",
        4000
      ),

    image5_url:
      cleanText(
        body.image5_url ||
        body.image5 ||
        "",
        4000
      ),

    video_url:
      cleanText(
        body.video_url ||
        body.videoUrl ||
        "",
        4000
      ),

    published:
      isTruthy(
        body.published ??
        1
      )
        ? 1
        : 0,

    featured:
      isTruthy(
        body.featured ??
        body.special ??
        0
      )
        ? 1
        : 0
  };

  if (!fields.title) {
    throw new Error(
      "Title is required."
    );
  }

  if (!fields.affiliate_url) {
    throw new Error(
      "Affiliate URL is required."
    );
  }

  try {
    const u =
      new URL(
        fields.affiliate_url
      );

    if (
      !["http:", "https:"].includes(
        u.protocol
      )
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "Affiliate URL must be a valid http(s) URL."
    );
  }

  return fields;
}

async function createWebsiteProduct(
  request,
  env
) {
  try {
    const body =
      await parseBody(request);

    const fields =
      readProductFields(body);

    const result =
      await env.DB
        .prepare(`
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
          fields.title,
          fields.description,
          fields.affiliate_url,
          fields.category,
          fields.image1_url,
          fields.image2_url,
          fields.image3_url,
          fields.image4_url,
          fields.image5_url,
          fields.video_url,
          fields.published,
          fields.featured,
          nowSql(),
          nowSql()
        )
        .run();

    const id =
      result.meta?.last_row_id;

    const product =
      await getProduct(
        env,
        id
      );

    let telegramResult =
      null;

    if (
      product &&
      Number(product.published) === 1
    ) {
      try {
        telegramResult =
          await postProductToTelegramGroups(
            product,
            env
          );
      } catch (error) {
        telegramResult = {
          sent: 0,
          error: String(
            error.message || error
          )
        };
      }
    }

    return api(
      {
        ok: true,
        product:
          productPublic(product),
        telegram:
          telegramResult
      },
      request,
      201
    );
  } catch (error) {
    return api(
      {
        ok: false,
        error: String(
          error.message ||
          error
        )
      },
      request,
      400
    );
  }
}

async function updateWebsiteProduct(
  request,
  env,
  id
) {
  try {
    const existing =
      await getProduct(
        env,
        id
      );

    if (!existing) {
      return api(
        {
          ok: false,
          error: "Product not found."
        },
        request,
        404
      );
    }

    const body =
      await parseBody(request);

    const fields =
      readProductFields({
        ...existing,
        ...body
      });

    await env.DB
      .prepare(`
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
        fields.title,
        fields.description,
        fields.affiliate_url,
        fields.category,
        fields.image1_url,
        fields.image2_url,
        fields.image3_url,
        fields.image4_url,
        fields.image5_url,
        fields.video_url,
        fields.published,
        fields.featured,
        nowSql(),
        id
      )
      .run();

    const product =
      await getProduct(
        env,
        id
      );

    return api(
      {
        ok: true,
        product:
          productPublic(product)
      },
      request
    );
  } catch (error) {
    return api(
      {
        ok: false,
        error: String(
          error.message ||
          error
        )
      },
      request,
      400
    );
  }
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
        error: "Product not found."
      },
      request,
      404
    );
  }

  const urls =
    productImages(product);

  if (product.video_url) {
    urls.push(
      product.video_url
    );
  }

  const githubResults = [];

  for (const url of urls) {
    try {
      githubResults.push(
        await githubDelete(
          env,
          url
        )
      );
    } catch (error) {
      githubResults.push({
        ok: false,
        error: String(
          error.message ||
          error
        )
      });
    }
  }

  await env.DB
    .prepare(
      "DELETE FROM products WHERE id = ?"
    )
    .bind(id)
    .run();

  return api(
    {
      ok: true,
      deleted: id,
      github: githubResults
    },
    request
  );
}

async function listAdminProducts(
  request,
  env
) {
  const url =
    new URL(request.url);

  const limit =
    clampInt(
      url.searchParams.get("limit"),
      1,
      100,
      50
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
        (result.results || [])
          .map(productPublic)
    },
    request
  );
}

async function listPublicProducts(
  request,
  env
) {
  const url =
    new URL(request.url);

  const limit =
    clampInt(
      url.searchParams.get("limit"),
      1,
      100,
      50
    );

  const search =
    cleanText(
      url.searchParams.get("search"),
      300
    );

  const category =
    cleanText(
      url.searchParams.get(
        "category"
      ),
      100
    );

  const featuredParam =
    url.searchParams.get(
      "featured"
    );

  let sql =
    "SELECT * FROM products WHERE published = 1";

  const params = [];

  if (search) {
    sql +=
      " AND (title LIKE ? OR description LIKE ? OR category LIKE ?)";

    const q = `%${search}%`;

    params.push(
      q,
      q,
      q
    );
  }

  if (
    category &&
    isValidCategory(category)
  ) {
    sql +=
      " AND category = ?";

    params.push(
      category
    );
  }

  if (
    featuredParam !== null &&
    isTruthy(featuredParam)
  ) {
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
        (result.results || [])
          .map(productPublic)
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
        error: "Unauthorized."
      },
      request,
      401
    );
  }

  try {
    const form =
      await request.formData();

    const file =
      form.get("file");

    if (
      !file ||
      typeof file.arrayBuffer !==
        "function"
    ) {
      return api(
        {
          ok: false,
          error: "No file supplied."
        },
        request,
        400
      );
    }

    const originalName =
      cleanText(
        file.name ||
        "upload"
      );

    const type =
      cleanText(
        file.type ||
        "application/octet-stream"
      );

    const maxBytes =
      type.startsWith("video/")
        ? 50 * 1024 * 1024
        : 15 * 1024 * 1024;

    if (
      file.size >
      maxBytes
    ) {
      return api(
        {
          ok: false,
          error:
            type.startsWith("video/")
              ? "Video is too large. Maximum is 50 MB."
              : "Image is too large. Maximum is 15 MB."
        },
        request,
        413
      );
    }

    const bytes =
      new Uint8Array(
        await file.arrayBuffer()
      );

    const uploaded =
      await githubUpload(
        env,
        bytes,
        originalName,
        type
      );

    return api(
      {
        ok: true,
        ...uploaded,
        type
      },
      request,
      201
    );
  } catch (error) {
    return api(
      {
        ok: false,
        error: String(
          error.message ||
          error
        )
      },
      request,
      500
    );
  }
}

async function createProductFromTelegramSession(
  env,
  chatId
) {
  const session =
    await getTelegramSession(
      env,
      chatId
    );

  if (!session.unlocked) {
    throw new Error(
      "Admin is locked."
    );
  }

  const data =
    session.data || {};

  const fields =
    readProductFields({
      title: data.title,
      description:
        data.description || "",
      affiliate_url:
        data.affiliate_url,
      category:
        data.category,
      image1_url:
        data.images?.[0] || "",
      image2_url:
        data.images?.[1] || "",
      image3_url:
        data.images?.[2] || "",
      image4_url:
        data.images?.[3] || "",
      image5_url:
        data.images?.[4] || "",
      video_url:
        data.video_url || "",
      published: 1,
      featured:
        data.featured || 0
    });

  const result =
    await env.DB
      .prepare(`
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
        fields.title,
        fields.description,
        fields.affiliate_url,
        fields.category,
        fields.image1_url,
        fields.image2_url,
        fields.image3_url,
        fields.image4_url,
        fields.image5_url,
        fields.video_url,
        fields.published,
        fields.featured,
        nowSql(),
        nowSql()
      )
      .run();

  const product =
    await getProduct(
      env,
      result.meta?.last_row_id
    );

  const telegramResult =
    await postProductToTelegramGroups(
      product,
      env
    );

  const s =
    await getTelegramSession(
      env,
      chatId
    );

  s.step = "idle";
  s.data = {};
  s.unlocked = 1;

  await saveTelegramSession(
    env,
    s
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

  if (!callback) {
    return;
  }

  const chatId =
    callback.message?.chat?.id;

  const userId =
    callback.from?.id || "";

  const data =
    cleanText(
      callback.data
    );

  if (!chatId) {
    return;
  }

  const session =
    await getTelegramSession(
      env,
      chatId,
      userId
    );

  if (
    data.startsWith(
      "category:"
    )
  ) {
    if (!session.unlocked) {
      await telegramApi(
        env,
        "answerCallbackQuery",
        {
          callback_query_id:
            callback.id,
          text:
            "Admin is locked."
        }
      );

      return;
    }

    const category =
      data.slice(
        "category:".length
      );

    if (
      !isValidCategory(
        category
      )
    ) {
      await telegramApi(
        env,
        "answerCallbackQuery",
        {
          callback_query_id:
            callback.id,
          text:
            "Invalid category."
        }
      );

      return;
    }

    session.data =
      session.data || {};

    session.data.category =
      category;

    session.step =
      "images";

    await saveTelegramSession(
      env,
      session
    );

    await telegramApi(
      env,
      "answerCallbackQuery",
      {
        callback_query_id:
          callback.id
      }
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "Category saved.\n\nSend up to 5 product images. Send /done when finished."
      }
    );
  }
}

async function handleTelegramUpdate(
  update,
  env
) {
  const message =
    update?.message;

  if (!message) {
    return;
  }

  const chatId =
    message.chat?.id;

  const userId =
    message.from?.id || "";

  if (!chatId) {
    return;
  }

  const text =
    cleanText(
      message.text
    );

  const lower =
    text.toLowerCase();

  if (lower === "/start") {
    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "Shopper's Suggestions bot is ready.\n\nUse /admin followed by the 4-digit admin code."
      }
    );

    return;
  }

  if (
    lower === "/getid"
  ) {
    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `Chat ID: ${chatId}`
      }
    );

    return;
  }

  const session =
    await getTelegramSession(
      env,
      chatId,
      userId
    );

  if (
    lower === "/lock"
  ) {
    await lockTelegram(
      env,
      chatId
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "Admin locked."
      }
    );

    return;
  }

  if (
    lower === "/admin"
  ) {
    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "Send the 4-digit admin code."
      }
    );

    const s =
      await getTelegramSession(
        env,
        chatId,
        userId
      );

    s.step =
      "admin_code";

    await saveTelegramSession(
      env,
      s
    );

    return;
  }

  if (
    session.step ===
    "admin_code"
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
            "Admin unlocked.",
          reply_markup:
            adminKeyboard()
        }
      );
    } else {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            "Incorrect admin code."
        }
      );
    }

    return;
  }

  if (!session.unlocked) {
    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "Admin is locked. Use /admin."
      }
    );

    return;
  }

  if (
    lower === "/addproduct"
  ) {
    session.step =
      "title";

    session.data =
      {};

    await saveTelegramSession(
      env,
      session
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "Send the product title."
      }
    );

    return;
  }

  if (
    lower === "/cancel"
  ) {
    session.step =
      "idle";

    session.data =
      {};

    await saveTelegramSession(
      env,
      session
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "Cancelled. Admin is still unlocked."
      }
    );

    return;
  }

  if (
    session.step ===
    "title"
  ) {
    if (!text) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            "Please send a product title."
        }
      );

      return;
    }

    session.data.title =
      text;

    session.step =
      "description";

    await saveTelegramSession(
      env,
      session
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "Send the product description."
      }
    );

    return;
  }

  if (
    session.step ===
    "description"
  ) {
    session.data.description =
      text;

    session.step =
      "affiliate";

    await saveTelegramSession(
      env,
      session
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "Send the affiliate/product link."
      }
    );

    return;
  }

  if (
    session.step ===
    "affiliate"
  ) {
    try {
      const u =
        new URL(text);

      if (
        !["http:", "https:"].includes(
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
            "Please send a valid http(s) link."
        }
      );

      return;
    }

    session.data.affiliate_url =
      text;

    session.step =
      "category";

    await saveTelegramSession(
      env,
      session
    );

    await telegramApi(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "Choose a category:",
        reply_markup:
          categoryKeyboard()
      }
    );

    return;
  }

  if (
    session.step ===
    "images"
  ) {
    if (
      lower === "/skip" ||
      lower === "/done"
    ) {
      session.step =
        "video";

      await saveTelegramSession(
        env,
        session
      );

      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            "Send a product video, or /skip for no video."
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

      session.data.images =
        Array.isArray(
          session.data.images
        )
          ? session.data.images
          : [];

      if (
        session.data.images.length <
        5
      ) {
        session.data.images.push(
          uploaded.url
        );
      }

      await saveTelegramSession(
        env,
        session
      );

      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `Image ${session.data.images.length}/5 saved. Send another image or /done.`
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
          "Send an image, or /done when finished."
      }
    );

    return;
  }

  if (
    session.step ===
    "video"
  ) {
    if (
      lower === "/skip"
    ) {
      session.data.video_url =
        "";

      session.step =
        "confirm";

      await saveTelegramSession(
        env,
        session
      );

      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `Ready to publish:\n\nTitle: ${session.data.title}\nCategory: ${session.data.category}\nImages: ${(session.data.images || []).length}\nVideo: No\n\nSend /publish to post, or /cancel.`
        }
      );

      return;
    }

    if (
      message.video?.file_id
    ) {
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

      session.data.video_url =
        uploaded.url;

      session.step =
        "confirm";

      await saveTelegramSession(
        env,
        session
      );

      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            "Video saved.\n\nSend /publish to post, or /cancel."
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
          "Send a video, or /skip."
      }
    );

    return;
  }

  if (
    session.step ===
      "confirm" &&
    lower === "/publish"
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
            `Product #${created.product.id} published.\n\n${
              created.telegramResult.failures?.length
                ? "Some group posts failed; check Worker logs."
                : "Group posting complete."
            }\n\nAdmin is still unlocked. Use /addproduct for another product.`
        }
      );
    } catch (error) {
      await telegramApi(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `Could not publish: ${String(error.message || error)}`
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

  const update =
    await request.json();

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

  if (
    cleanText(
      env.TELEGRAM_WEBHOOK_SECRET
    )
  ) {
    payload.secret_token =
      cleanText(
        env.TELEGRAM_WEBHOOK_SECRET
      );
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
            error.message ||
            error
          )
      });
    }
  }

  return api(
    {
      ok:
        results.every(
          (x) => x.ok
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
        new URL(request.url);

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
          "/api/telegram/setup" &&
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
          "/api/telegram/webhook" &&
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
          "/api/telegram/test-groups" &&
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
          "/api/admin/login" &&
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
          "/api/admin/logout" &&
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
          "/api/admin/check" &&
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
          "/api/upload-media" &&
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
          "/api/admin/products" &&
        request.method ===
          "GET"
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

        return listAdminProducts(
          request,
          env
        );
      }

      if (
        path ===
          "/api/admin/products" &&
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
          error: String(
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
