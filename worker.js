const CATEGORIES = [
  "Tech", "Home", "Fashion", "Beauty", "Gaming", "Sports", "Travel",
  "Kitchen", "Office", "Automotive", "Electronics", "Kids", "Pets",
  "Fitness", "Books", "Accessories", "Photography", "Creator", "Other"
];

// Build marker lets us confirm which source version Cloudflare is serving.
const WORKER_BUILD = "2026-10-12-products-schema-fix-2";

// Keep these as separate SQL strings. Do not combine the products CREATE TABLE
// statement with another statement: D1 receives each statement independently.
const BASE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    affiliate_url TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Other',
    image1_url TEXT NOT NULL DEFAULT '', image2_url TEXT NOT NULL DEFAULT '',
    image3_url TEXT NOT NULL DEFAULT '', image4_url TEXT NOT NULL DEFAULT '',
    image5_url TEXT NOT NULL DEFAULT '', video_url TEXT NOT NULL DEFAULT '',
    published INTEGER NOT NULL DEFAULT 1, featured INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`
];

const USER_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id TEXT UNIQUE,
  email TEXT UNIQUE,
  username TEXT UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  is_banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS promoters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  username TEXT UNIQUE,
  avatar_url TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS promoter_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id INTEGER NOT NULL,
  promoter_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, promoter_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (promoter_id) REFERENCES promoters(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS product_favorites (
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, product_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY,
  theme TEXT NOT NULL DEFAULT 'system',
  email_notifications INTEGER NOT NULL DEFAULT 1,
  profile_public INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  image_url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS product_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  reporter_id INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
`;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      ...extraHeaders
    }
  });
}
function redirect(url, status = 302, headers = {}) {
  return new Response(null, { status, headers: { Location: url, ...headers } });
}
function clean(value, max = 10000) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, max);
}
function getCookie(request, name) {
  const all = request.headers.get("Cookie") || "";
  for (const part of all.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); }
      catch { return part.slice(index + 1).trim(); }
    }
  }
  return null;
}
function randomId() { return crypto.randomUUID(); }
function isTrue(value) { return value === true || value === 1 || value === "1" || value === "true"; }
function validCategory(category) { return CATEGORIES.includes(category); }
function validHttpUrl(value) {
  if (!value) return "";
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) ? u.href : "";
  } catch { return ""; }
}
function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function discountPercent(price, original) {
  const now = numberOrNull(price), was = numberOrNull(original);
  return now !== null && was !== null && was > now && was > 0
    ? Math.round(((was - now) / was) * 100) : null;
}

async function executeSchema(env, schema) {
  // Arrays are already individual SQL statements. Legacy schema strings are
  // split only for the older user-table definitions.
  const statements = Array.isArray(schema)
    ? schema
    : schema.split(';').map(statement => statement.trim()).filter(Boolean);
  for (const statement of statements) {
    if (!statement || !statement.trim()) continue;
    await env.DB.prepare(statement.trim()).run();
  }
}

async function ensureSchema(env) {
  if (!env || !env.DB) throw new Error("Cloudflare D1 binding 'DB' is missing.");
  await executeSchema(env, BASE_SCHEMA);
  await executeSchema(env, USER_SCHEMA);

  // Add missing columns to older versions of these tables without deleting data.
  const migrations = {
    products: {
      featured: "INTEGER NOT NULL DEFAULT 0", price: "REAL", original_price: "REAL",
      uploader_id: "INTEGER", uploader_name: "TEXT NOT NULL DEFAULT ''", uploader_avatar: "TEXT NOT NULL DEFAULT ''",
      image1_url: "TEXT NOT NULL DEFAULT ''", image2_url: "TEXT NOT NULL DEFAULT ''",
      image3_url: "TEXT NOT NULL DEFAULT ''", image4_url: "TEXT NOT NULL DEFAULT ''",
      image5_url: "TEXT NOT NULL DEFAULT ''", video_url: "TEXT NOT NULL DEFAULT ''",
      published: "INTEGER NOT NULL DEFAULT 1", created_at: "TEXT NOT NULL DEFAULT ''",
      updated_at: "TEXT NOT NULL DEFAULT ''"
    },
    admin_sessions: { created_at: "TEXT NOT NULL DEFAULT ''" },
    users: {
      google_id: "TEXT", email: "TEXT", username: "TEXT", display_name: "TEXT NOT NULL DEFAULT ''",
      avatar_url: "TEXT NOT NULL DEFAULT ''", bio: "TEXT NOT NULL DEFAULT ''", role: "TEXT NOT NULL DEFAULT 'user'",
      is_banned: "INTEGER NOT NULL DEFAULT 0", created_at: "TEXT NOT NULL DEFAULT ''",
      updated_at: "TEXT NOT NULL DEFAULT ''"
    },
    user_sessions: { user_id: "INTEGER", created_at: "TEXT NOT NULL DEFAULT ''", expires_at: "TEXT" },
    promoters: {
      user_id: "INTEGER", display_name: "TEXT NOT NULL DEFAULT ''", username: "TEXT", avatar_url: "TEXT NOT NULL DEFAULT ''",
      bio: "TEXT NOT NULL DEFAULT ''", status: "TEXT NOT NULL DEFAULT 'pending'", created_at: "TEXT NOT NULL DEFAULT ''"
    },
    promoter_applications: {
      user_id: "INTEGER", message: "TEXT NOT NULL DEFAULT ''", status: "TEXT NOT NULL DEFAULT 'pending'",
      created_at: "TEXT NOT NULL DEFAULT ''", reviewed_at: "TEXT"
    },
    user_favorites: { user_id: "INTEGER", promoter_id: "INTEGER", created_at: "TEXT NOT NULL DEFAULT ''" },
    product_favorites: { user_id: "INTEGER", product_id: "INTEGER", created_at: "TEXT NOT NULL DEFAULT ''" },
    user_settings: {
      theme: "TEXT NOT NULL DEFAULT 'system'", email_notifications: "INTEGER NOT NULL DEFAULT 1",
      profile_public: "INTEGER NOT NULL DEFAULT 1", updated_at: "TEXT NOT NULL DEFAULT ''"
    },
    product_images: {
      product_id: "INTEGER", image_url: "TEXT NOT NULL DEFAULT ''", sort_order: "INTEGER NOT NULL DEFAULT 0",
      created_at: "TEXT NOT NULL DEFAULT ''"
    },
    product_reports: {
      product_id: "INTEGER", reporter_id: "INTEGER", reason: "TEXT NOT NULL DEFAULT ''",
      status: "TEXT NOT NULL DEFAULT 'pending'", created_at: "TEXT NOT NULL DEFAULT ''"
    },
    activity_logs: {
      user_id: "INTEGER", action: "TEXT NOT NULL DEFAULT ''", target_type: "TEXT NOT NULL DEFAULT ''",
      target_id: "TEXT NOT NULL DEFAULT ''", created_at: "TEXT NOT NULL DEFAULT ''"
    }
  };

  const tableColumns = {};
  for (const [table, columns] of Object.entries(migrations)) {
    const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const present = new Set((info.results || []).map(row => row.name));
    for (const [column, definition] of Object.entries(columns)) {
      if (present.has(column)) continue;
      try {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
        present.add(column);
      } catch (error) {
        const refreshed = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
        const nowPresent = new Set((refreshed.results || []).map(row => row.name));
        if (!nowPresent.has(column)) throw error;
        present.add(column);
      }
    }
    tableColumns[table] = present;
  }

  // Do not let an old, partially migrated table make every API request fail on index creation.
  const indexes = [
    ["products", ["category"], "CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)"],
    ["products", ["published"], "CREATE INDEX IF NOT EXISTS idx_products_published ON products(published)"],
    ["products", ["created_at"], "CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at)"],
    ["products", ["uploader_id"], "CREATE INDEX IF NOT EXISTS idx_products_uploader ON products(uploader_id)"],
    ["promoters", ["status"], "CREATE INDEX IF NOT EXISTS idx_promoters_status ON promoters(status)"],
    ["user_favorites", ["promoter_id"], "CREATE INDEX IF NOT EXISTS idx_user_favorites_promoter ON user_favorites(promoter_id)"],
    ["product_favorites", ["product_id"], "CREATE INDEX IF NOT EXISTS idx_product_favorites_product ON product_favorites(product_id)"],
    ["promoter_applications", ["status"], "CREATE INDEX IF NOT EXISTS idx_applications_status ON promoter_applications(status)"]
  ];
  for (const [table, requiredColumns, sql] of indexes) {
    const columns = tableColumns[table] || new Set();
    if (requiredColumns.every(column => columns.has(column))) await env.DB.prepare(sql).run();
  }
}
function adminCookie(id) {
  return [`shopper_admin_session=${encodeURIComponent(id)}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=604800"].join("; ");
}
function clearAdminCookie() {
  return ["shopper_admin_session=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=0"].join("; ");
}
function userCookie(id) {
  return [`ss_user_session=${encodeURIComponent(id)}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=2592000"].join("; ");
}
function clearUserCookie() {
  return ["ss_user_session=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=0"].join("; ");
}
async function isAdmin(request, env) {
  const session = getCookie(request, "shopper_admin_session");
  if (!session) return false;
  return !!(await env.DB.prepare("SELECT id FROM admin_sessions WHERE id = ? LIMIT 1").bind(session).first());
}
async function currentUser(request, env) {
  const session = getCookie(request, "ss_user_session");
  if (!session) return null;
  const row = await env.DB.prepare(`
    SELECT u.id, u.google_id, u.email, u.username, u.display_name, u.avatar_url,
           u.bio, u.role, u.is_banned, u.created_at
    FROM user_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > CURRENT_TIMESTAMP LIMIT 1
  `).bind(session).first();
  if (!row || Number(row.is_banned) === 1) return null;
  return row;
}
async function requireUser(request, env) {
  const user = await currentUser(request, env);
  return user;
}
async function logActivity(env, userId, action, targetType = "", targetId = "") {
  try {
    await env.DB.prepare(`INSERT INTO activity_logs (user_id, action, target_type, target_id) VALUES (?, ?, ?, ?)`)
      .bind(userId || null, action, targetType, String(targetId || "")).run();
  } catch (error) { console.error("Activity log failed", error); }
}

function githubRawUrl(env, path) {
  return `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH || "main"}/${path}`;
}
async function githubGet(env, path) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) throw new Error("GitHub media storage is not configured.");
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(env.GITHUB_BRANCH || "main")}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "Shopper-Suggestions" } });
  if (!response.ok) throw new Error(`GitHub GET failed: ${response.status}`);
  return response.json();
}
function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
async function githubUpload(env, path, bytes, contentType, message) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) throw new Error("GitHub media storage is not configured.");
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  let sha = null;
  try { sha = (await githubGet(env, path)).sha; } catch (_) {}
  const response = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "Shopper-Suggestions" },
    body: JSON.stringify({ message, content: bytesToBase64(bytes), branch: env.GITHUB_BRANCH || "main", ...(sha ? { sha } : {}) })
  });
  if (!response.ok) throw new Error(`GitHub upload failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  return { path, url: githubRawUrl(env, path), contentType };
}
async function githubDelete(env, path, message) {
  const existing = await githubGet(env, path);
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "Shopper-Suggestions" },
    body: JSON.stringify({ message, sha: existing.sha, branch: env.GITHUB_BRANCH || "main" })
  });
  if (!response.ok) throw new Error(`GitHub delete failed: ${response.status}`);
  return true;
}
function safeExtension(filename, contentType = "") {
  const match = String(filename || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  const allowed = ["jpg", "jpeg", "png", "webp", "gif", "avif", "mp4", "webm", "mov"];
  if (match && allowed.includes(match[1])) return match[1];
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("avif")) return "avif";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("quicktime")) return "mov";
  if (contentType.includes("mp4")) return "mp4";
  return contentType.startsWith("video/") ? "mp4" : "jpg";
}

const PRODUCT_SELECT = `
  SELECT p.*,
    u.id AS actual_uploader_user_id,
    u.display_name AS profile_display_name,
    u.username AS profile_username,
    u.avatar_url AS profile_avatar_url,
    u.bio AS profile_bio,
    pr.id AS uploader_profile_id,
    pr.status AS uploader_status
  FROM products p
  LEFT JOIN users u ON u.id = p.uploader_id
  LEFT JOIN promoters pr ON pr.user_id = u.id
`;
function productPublic(row) {
  if (!row) return null;
  const price = row.price === undefined ? null : row.price;
  const original = row.original_price === undefined ? null : row.original_price;
  const uploaderName = clean(row.profile_display_name || row.uploader_name || "", 200);
  const uploaderAvatar = clean(row.profile_avatar_url || row.uploader_avatar || "", 2000);
  const uploaderUsername = clean(row.profile_username || "", 100);
  const uploaderBio = clean(row.profile_bio || "", 1000);
  const publicUploaderId = row.uploader_profile_id || "";
  return {
    id: row.id,
    title: row.title || "",
    description: row.description || "",
    affiliate_url: row.affiliate_url || "",
    affiliate_link: row.affiliate_url || "",
    affiliateUrl: row.affiliate_url || "",
    product_url: row.affiliate_url || "",
    category: row.category || "Other",
    image1_url: row.image1_url || "",
    image2_url: row.image2_url || "",
    image3_url: row.image3_url || "",
    image4_url: row.image4_url || "",
    image5_url: row.image5_url || "",
    image_url: row.image1_url || "",
    image: row.image1_url || "",
    images: [row.image1_url, row.image2_url, row.image3_url, row.image4_url, row.image5_url].filter(Boolean),
    video_url: row.video_url || "",
    price,
    original_price: original,
    originalPrice: original,
    discount_percent: discountPercent(price, original),
    uploader_id: publicUploaderId,
    user_id: row.actual_uploader_user_id || row.uploader_id || "",
    uploader_name: uploaderName,
    uploader_username: uploaderUsername,
    uploader_avatar: uploaderAvatar,
    uploader_bio: uploaderBio,
    uploader: {
      id: publicUploaderId,
      user_id: row.actual_uploader_user_id || row.uploader_id || "",
      name: uploaderName || "Community uploader",
      username: uploaderUsername,
      avatar: uploaderAvatar,
      bio: uploaderBio,
      status: row.uploader_status || ""
    },
    published: Number(row.published) === 1,
    featured: Number(row.featured) === 1,
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
    share_url: `https://shopperssuggestions.online/?product=${encodeURIComponent(row.id)}`
  };
}
async function handleAdminLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const password = clean(body.password, 200);
  if (!password || password !== String(env.ADMIN_PASSWORD || "")) return json({ ok: false, error: "Invalid password" }, 401);
  const id = randomId();
  await env.DB.prepare("INSERT INTO admin_sessions (id) VALUES (?)").bind(id).run();
  return json({ ok: true }, 200, { "Set-Cookie": adminCookie(id) });
}
async function handleAdminLogout(request, env) {
  const session = getCookie(request, "shopper_admin_session");
  if (session) await env.DB.prepare("DELETE FROM admin_sessions WHERE id = ?").bind(session).run();
  return json({ ok: true }, 200, { "Set-Cookie": clearAdminCookie() });
}
async function handleAdminCheck(request, env) {
  return json({ ok: true, authenticated: await isAdmin(request, env) });
}

async function handleProducts(request, env) {
  const url = new URL(request.url);
  const category = clean(url.searchParams.get("category"), 100);
  const search = clean(url.searchParams.get("search"), 200);
  const featured = ["1", "true"].includes(url.searchParams.get("featured"));
  let limit = Number(url.searchParams.get("limit") || 100);
  if (!Number.isFinite(limit)) limit = 100;
  limit = Math.max(1, Math.min(limit, 200));
  const conditions = ["p.published = 1"];
  const values = [];
  if (category && category !== "All") { conditions.push("p.category = ?"); values.push(category); }
  if (search) {
    conditions.push("(LOWER(p.title) LIKE LOWER(?) OR LOWER(p.description) LIKE LOWER(?) OR LOWER(p.category) LIKE LOWER(?))");
    const q = `%${search}%`; values.push(q, q, q);
  }
  if (featured) conditions.push("p.featured = 1");
  const sql = `${PRODUCT_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY datetime(p.created_at) DESC, p.id DESC LIMIT ?`;
  values.push(limit);
  const result = await env.DB.prepare(sql).bind(...values).all();
  return json({ ok: true, products: (result.results || []).map(productPublic) });
}
async function handleAdminProducts(request, env) {
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
  const result = await env.DB.prepare(`${PRODUCT_SELECT} ORDER BY datetime(p.created_at) DESC, p.id DESC`).all();
  return json({ ok: true, products: (result.results || []).map(productPublic) });
}
async function handleProduct(request, env, id) {
  const product = await env.DB.prepare(`${PRODUCT_SELECT} WHERE p.id = ? LIMIT 1`).bind(id).first();
  if (!product || (Number(product.published) !== 1 && !(await isAdmin(request, env)))) return json({ ok: false, error: "Product not found" }, 404);
  return json({ ok: true, product: productPublic(product) });
}
async function handleCreateProduct(request, env) {
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const title = clean(body.title, 300);
  const description = clean(body.description, 10000);
  const affiliateUrl = validHttpUrl(clean(body.affiliate_url ?? body.affiliate_link ?? body.product_url, 2000));
  const category = clean(body.category || "Other", 100);
  const videoUrl = validHttpUrl(clean(body.video_url, 2000));
  const price = numberOrNull(body.price);
  const originalPrice = numberOrNull(body.original_price ?? body.originalPrice ?? body.mrp);
  if (!title) return json({ ok: false, error: "Title is required" }, 400);
  if (!validCategory(category)) return json({ ok: false, error: "Invalid category" }, 400);
  if ((body.affiliate_url || body.affiliate_link || body.product_url) && !affiliateUrl) return json({ ok: false, error: "Shopping link must be a valid http or https URL" }, 400);
  const images = [];
  for (let i = 1; i <= 5; i++) images.push(validHttpUrl(clean(body[`image${i}_url`], 3000)));
  const uploaderId = numberOrNull(body.uploader_id ?? body.user_id);
  if (uploaderId !== null) {
    const exists = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(uploaderId).first();
    if (!exists) return json({ ok: false, error: "Uploader account was not found" }, 400);
  }
  const result = await env.DB.prepare(`
    INSERT INTO products (title, description, affiliate_url, category, image1_url, image2_url, image3_url, image4_url, image5_url, video_url, published, featured, price, original_price, uploader_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).bind(title, description, affiliateUrl, category, ...images, videoUrl, body.published === undefined ? 1 : (isTrue(body.published) ? 1 : 0), isTrue(body.featured) ? 1 : 0, price, originalPrice, uploaderId).first();
  const product = await env.DB.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).bind(result.id).first();
  return json({ ok: true, product: productPublic(product) }, 201);
}
async function handleUpdateProduct(request, env, id) {
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const existing = await env.DB.prepare("SELECT * FROM products WHERE id = ? LIMIT 1").bind(id).first();
  if (!existing) return json({ ok: false, error: "Product not found" }, 404);
  const title = body.title === undefined ? existing.title : clean(body.title, 300);
  const description = body.description === undefined ? existing.description : clean(body.description, 10000);
  const rawAffiliate = body.affiliate_url ?? body.affiliate_link ?? body.product_url;
  const affiliateUrl = rawAffiliate === undefined ? (existing.affiliate_url || "") : validHttpUrl(clean(rawAffiliate, 2000));
  const category = body.category === undefined ? existing.category : clean(body.category, 100);
  const videoUrl = body.video_url === undefined ? (existing.video_url || "") : validHttpUrl(clean(body.video_url, 2000));
  if (!title) return json({ ok: false, error: "Title is required" }, 400);
  if (!validCategory(category)) return json({ ok: false, error: "Invalid category" }, 400);
  if (rawAffiliate !== undefined && rawAffiliate && !affiliateUrl) return json({ ok: false, error: "Shopping link must be a valid http or https URL" }, 400);
  const images = [];
  for (let i = 1; i <= 5; i++) images.push(body[`image${i}_url`] === undefined ? (existing[`image${i}_url`] || "") : validHttpUrl(clean(body[`image${i}_url`], 3000)));
  const price = body.price === undefined ? existing.price : numberOrNull(body.price);
  const originalPrice = body.original_price === undefined && body.originalPrice === undefined && body.mrp === undefined ? existing.original_price : numberOrNull(body.original_price ?? body.originalPrice ?? body.mrp);
  const uploaderId = body.uploader_id === undefined && body.user_id === undefined ? existing.uploader_id : numberOrNull(body.uploader_id ?? body.user_id);
  if (uploaderId !== null && uploaderId !== undefined && !(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(uploaderId).first())) return json({ ok: false, error: "Uploader account was not found" }, 400);
  const published = body.published === undefined ? Number(existing.published) : (isTrue(body.published) ? 1 : 0);
  const featured = body.featured === undefined ? Number(existing.featured) : (isTrue(body.featured) ? 1 : 0);
  await env.DB.prepare(`UPDATE products SET title=?, description=?, affiliate_url=?, category=?, image1_url=?, image2_url=?, image3_url=?, image4_url=?, image5_url=?, video_url=?, published=?, featured=?, price=?, original_price=?, uploader_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(title, description, affiliateUrl, category, ...images, videoUrl, published, featured, price, originalPrice, uploaderId ?? null, id).run();
  const updated = await env.DB.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).bind(id).first();
  return json({ ok: true, product: productPublic(updated) });
}
async function handleDeleteProduct(request, env, id) {
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
  const product = await env.DB.prepare("SELECT * FROM products WHERE id = ? LIMIT 1").bind(id).first();
  if (!product) return json({ ok: false, error: "Product not found" }, 404);
  const mediaUrls = [product.image1_url, product.image2_url, product.image3_url, product.image4_url, product.image5_url].filter(Boolean);
  for (const mediaUrl of mediaUrls) {
    try {
      const prefix = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH || "main"}/`;
      if (mediaUrl.startsWith(prefix)) {
        const path = decodeURIComponent(mediaUrl.slice(prefix.length));
        if (path.startsWith("media/")) await githubDelete(env, path, `Delete media for product ${id}`);
      }
    } catch (error) { console.error("GitHub media delete failed:", error); }
  }
  await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  return json({ ok: true, deleted: Number(id) });
}
async function handleUploadMedia(request, env) {
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
  if (!(request.headers.get("Content-Type") || "").startsWith("multipart/form-data")) return json({ ok: false, error: "Expected multipart/form-data" }, 400);
  const form = await request.formData();
  const file = form.get("file") || form.get("image") || form.get("media");
  if (!(file instanceof File)) return json({ ok: false, error: "No file received" }, 400);
  const isVideo = file.type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(file.name);
  const maxSize = isVideo ? 100 * 1024 * 1024 : 15 * 1024 * 1024;
  if (file.size <= 0) return json({ ok: false, error: "Empty file" }, 400);
  if (file.size > maxSize) return json({ ok: false, error: isVideo ? "Video is too large. Maximum 100 MB." : "Image is too large. Maximum 15 MB." }, 413);
  const extension = safeExtension(file.name, file.type);
  const filename = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const path = `media/${filename}`;
  const uploaded = await githubUpload(env, path, new Uint8Array(await file.arrayBuffer()), file.type || (isVideo ? "video/mp4" : "image/jpeg"), `Upload media ${filename}`);
  return json({ ok: true, url: uploaded.url, path: uploaded.path, type: isVideo ? "video" : "image" });
}
async function handleDeleteMedia(request, env) {
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const suppliedPath = clean(body.path, 1000), suppliedUrl = clean(body.url, 3000);
  let path = suppliedPath;
  if (!path && suppliedUrl) {
    const prefix = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH || "main"}/`;
    if (suppliedUrl.startsWith(prefix)) path = decodeURIComponent(suppliedUrl.slice(prefix.length));
  }
  if (!path || !path.startsWith("media/") || path.includes("..")) return json({ ok: false, error: "Invalid media path" }, 400);
  await githubDelete(env, path, `Delete media ${path}`);
  return json({ ok: true, deleted: path });
}

// Google sign-in requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET Worker secrets/vars.
async function handleGoogleStart(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ ok: false, error: "Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Cloudflare, then add this site's /auth/google/callback URL to Google OAuth authorized redirect URIs." }, 503);
  const url = new URL(request.url);
  const state = randomId();
  const redirectUri = `${url.origin}/auth/google/callback`;
  const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  google.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  google.searchParams.set("redirect_uri", redirectUri);
  google.searchParams.set("response_type", "code");
  google.searchParams.set("scope", "openid email profile");
  google.searchParams.set("state", state);
  google.searchParams.set("prompt", "select_account");
  return redirect(google.toString(), 302, { "Set-Cookie": [`ss_oauth_state=${state}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"].join("; ") });
}
async function handleGoogleCallback(request, env) {
  const url = new URL(request.url);
  const code = clean(url.searchParams.get("code"), 3000);
  const state = clean(url.searchParams.get("state"), 200);
  const savedState = getCookie(request, "ss_oauth_state");
  const clearState = "ss_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
  if (!code || !state || !savedState || state !== savedState) return redirect("/?signin=failed", 302, { "Set-Cookie": clearState });
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ ok: false, error: "Google sign-in is not configured." }, 503);
  const redirectUri = `${url.origin}/auth/google/callback`;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code" })
  });
  if (!tokenResponse.ok) return redirect("/?signin=failed", 302, { "Set-Cookie": clearState });
  const tokens = await tokenResponse.json();
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!profileResponse.ok) return redirect("/?signin=failed", 302, { "Set-Cookie": clearState });
  const profile = await profileResponse.json();
  if (!profile.sub || !profile.email || profile.email_verified !== true) return redirect("/?signin=failed", 302, { "Set-Cookie": clearState });
  const email = clean(profile.email, 320).toLowerCase();
  const displayName = clean(profile.name || email.split("@")[0], 200);
  const avatar = validHttpUrl(clean(profile.picture, 2000));
  const baseUsername = clean((email.split("@")[0] || "shopper").toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 24) || "shopper", 24);
  let user = await env.DB.prepare("SELECT id FROM users WHERE google_id = ? OR email = ? LIMIT 1").bind(profile.sub, email).first();
  if (user) {
    await env.DB.prepare("UPDATE users SET google_id=?, email=?, display_name=?, avatar_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(profile.sub, email, displayName, avatar, user.id).run();
  } else {
    let username = baseUsername;
    const exists = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
    if (exists) username = `${baseUsername.slice(0, 16)}_${crypto.randomUUID().slice(0, 7)}`;
    user = await env.DB.prepare("INSERT INTO users (google_id, email, username, display_name, avatar_url) VALUES (?, ?, ?, ?, ?) RETURNING id").bind(profile.sub, email, username, displayName, avatar).first();
  }
  const sessionId = randomId();
  await env.DB.prepare("INSERT INTO user_sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))").bind(sessionId, user.id).run();
  await env.DB.prepare("INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)").bind(user.id).run();
  await logActivity(env, user.id, "google_sign_in", "user", user.id);
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", userCookie(sessionId));
  headers.append("Set-Cookie", clearState);
  return new Response(null, { status: 302, headers });
}
async function handleMe(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ ok: true, authenticated: false, user: null });
  const promoter = await env.DB.prepare("SELECT id, status FROM promoters WHERE user_id = ? LIMIT 1").bind(user.id).first();
  const favorites = await env.DB.prepare("SELECT promoter_id FROM user_favorites WHERE user_id = ?").bind(user.id).all();
  return json({ ok: true, authenticated: true, user: { ...user, is_promoter: !!promoter && promoter.status === "approved", promoter_id: promoter?.id || null }, favorite_promoter_ids: (favorites.results || []).map(x => String(x.promoter_id)) });
}
async function handleLogout(request, env) {
  const session = getCookie(request, "ss_user_session");
  if (session) await env.DB.prepare("DELETE FROM user_sessions WHERE id = ?").bind(session).run();
  return json({ ok: true }, 200, { "Set-Cookie": clearUserCookie() });
}
async function handlePromoters(request, env) {
  const user = await currentUser(request, env);
  const result = await env.DB.prepare(`
    SELECT p.id, p.user_id, COALESCE(p.display_name, u.display_name, '') AS display_name,
      COALESCE(p.username, u.username, '') AS username,
      COALESCE(p.avatar_url, u.avatar_url, '') AS avatar_url,
      COALESCE(p.bio, u.bio, '') AS bio,
      p.status,
      (SELECT COUNT(*) FROM user_favorites f WHERE f.promoter_id = p.id) AS favorite_count,
      CASE WHEN ? IS NOT NULL AND EXISTS (SELECT 1 FROM user_favorites f2 WHERE f2.user_id = ? AND f2.promoter_id = p.id) THEN 1 ELSE 0 END AS is_favorited
    FROM promoters p LEFT JOIN users u ON u.id = p.user_id
    WHERE p.status = 'approved' AND (u.is_banned IS NULL OR u.is_banned = 0)
    ORDER BY favorite_count DESC, p.id DESC LIMIT 200
  `).bind(user?.id || null, user?.id || null).all();
  return json({ ok: true, promoters: (result.results || []).map(p => ({ ...p, favorite_count: Number(p.favorite_count || 0), is_favorited: Number(p.is_favorited) === 1 })) });
}
async function handleFavorite(request, env, promoterId) {
  const user = await requireUser(request, env);
  if (!user) return json({ ok: false, error: "Sign in required" }, 401);
  const promoter = await env.DB.prepare("SELECT id FROM promoters WHERE id = ? AND status = 'approved'").bind(promoterId).first();
  if (!promoter) return json({ ok: false, error: "Promoter not found" }, 404);
  if (request.method === "POST") {
    await env.DB.prepare("INSERT OR IGNORE INTO user_favorites (user_id, promoter_id) VALUES (?, ?)").bind(user.id, promoterId).run();
  } else {
    await env.DB.prepare("DELETE FROM user_favorites WHERE user_id = ? AND promoter_id = ?").bind(user.id, promoterId).run();
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM user_favorites WHERE promoter_id = ?").bind(promoterId).first();
  await logActivity(env, user.id, request.method === "POST" ? "favorite_promoter" : "unfavorite_promoter", "promoter", promoterId);
  return json({ ok: true, favorited: request.method === "POST", favorite_count: Number(count?.count || 0) });
}
async function handlePromoterApplication(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ ok: false, error: "Sign in required" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const bio = clean(body.bio, 2000);
  if (bio.length < 10) return json({ ok: false, error: "Please provide at least 10 characters about your recommendations." }, 400);
  const previous = await env.DB.prepare("SELECT id, status FROM promoter_applications WHERE user_id = ? AND status = 'pending' LIMIT 1").bind(user.id).first();
  if (previous) {
    await env.DB.prepare("UPDATE promoter_applications SET message = ? WHERE id = ?").bind(bio, previous.id).run();
  } else {
    await env.DB.prepare("INSERT INTO promoter_applications (user_id, message, status) VALUES (?, ?, 'pending')").bind(user.id, bio).run();
  }
  await env.DB.prepare(`INSERT INTO promoters (user_id, display_name, username, avatar_url, bio, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(user_id) DO UPDATE SET bio=excluded.bio, display_name=excluded.display_name, avatar_url=excluded.avatar_url`).bind(user.id, user.display_name || "", user.username || null, user.avatar_url || "", bio).run();
  await logActivity(env, user.id, "promoter_application_submitted", "user", user.id);
  return json({ ok: true, status: "pending" }, 201);
}
async function handleProfile(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ ok: false, error: "Sign in required" }, 401);
  if (request.method === "GET") return json({ ok: true, user });
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const displayName = body.display_name === undefined ? user.display_name : clean(body.display_name, 200);
  const bio = body.bio === undefined ? user.bio : clean(body.bio, 1000);
  const avatar = body.avatar_url === undefined ? user.avatar_url : validHttpUrl(clean(body.avatar_url, 2000));
  const username = body.username === undefined ? user.username : clean(body.username, 30).toLowerCase().replace(/[^a-z0-9_.]/g, "");
  if (!displayName) return json({ ok: false, error: "Display name is required" }, 400);
  if (username && !/^[a-z0-9_.]{3,30}$/.test(username)) return json({ ok: false, error: "Username must be 3–30 characters using letters, numbers, dots or underscores." }, 400);
  try {
    await env.DB.prepare("UPDATE users SET display_name=?, bio=?, avatar_url=?, username=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(displayName, bio, avatar, username || null, user.id).run();
  } catch (error) {
    if (String(error?.message || error).toLowerCase().includes("unique")) return json({ ok: false, error: "That username is already taken." }, 409);
    throw error;
  }
  const updated = await env.DB.prepare("SELECT id, email, username, display_name, avatar_url, bio, role, created_at FROM users WHERE id=?").bind(user.id).first();
  return json({ ok: true, user: updated });
}
async function handleSettings(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ ok: false, error: "Sign in required" }, 401);
  if (request.method === "GET") {
    const settings = await env.DB.prepare("SELECT theme, email_notifications, profile_public FROM user_settings WHERE user_id=?").bind(user.id).first();
    return json({ ok: true, settings: settings || { theme: "system", email_notifications: 1, profile_public: 1 } });
  }
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const theme = ["light", "dark", "system"].includes(body.theme) ? body.theme : "system";
  const emailNotifications = body.email_notifications === undefined ? 1 : (isTrue(body.email_notifications) ? 1 : 0);
  const profilePublic = body.profile_public === undefined ? 1 : (isTrue(body.profile_public) ? 1 : 0);
  await env.DB.prepare(`INSERT INTO user_settings (user_id, theme, email_notifications, profile_public, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme, email_notifications=excluded.email_notifications, profile_public=excluded.profile_public, updated_at=CURRENT_TIMESTAMP`)
    .bind(user.id, theme, emailNotifications, profilePublic).run();
  return json({ ok: true, settings: { theme, email_notifications: emailNotifications, profile_public: profilePublic } });
}
async function handleShareProduct(request, env, id) {
  const product = await env.DB.prepare("SELECT id, published FROM products WHERE id = ? LIMIT 1").bind(id).first();
  if (!product || (Number(product.published) !== 1 && !(await isAdmin(request, env)))) return json({ ok: false, error: "Product not found" }, 404);
  return json({ ok: true, url: `https://shopperssuggestions.online/?product=${encodeURIComponent(id)}` });
}
async function handleCategories() { return json({ ok: true, categories: CATEGORIES }); }

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS" } });
      const url = new URL(request.url), path = url.pathname;
      // Health/build check must not depend on schema initialization succeeding.
      if (path === "/api/health") return json({ ok: true, service: "shopper-s-suggestions-web", build: WORKER_BUILD, databaseBindingPresent: !!env.DB, googleOAuthConfigured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
      await ensureSchema(env);
      if (path === "/api/categories" && request.method === "GET") return handleCategories();
      if (path === "/api/admin/login" && request.method === "POST") return handleAdminLogin(request, env);
      if (path === "/api/admin/logout" && request.method === "POST") return handleAdminLogout(request, env);
      if (path === "/api/admin/check" && request.method === "GET") return handleAdminCheck(request, env);
      if (path === "/api/upload-media" && request.method === "POST") return handleUploadMedia(request, env);
      if (path === "/api/delete-media" && request.method === "POST") return handleDeleteMedia(request, env);
      if (path === "/api/products" && request.method === "GET") return handleProducts(request, env);
      if (path === "/api/products" && request.method === "POST") return handleCreateProduct(request, env);
      if (path === "/api/admin/products" && request.method === "GET") return handleAdminProducts(request, env);
      if ((path === "/auth/google" || path === "/auth/google/" ) && request.method === "GET") return handleGoogleStart(request, env);
      if (path === "/auth/google/callback" && request.method === "GET") return handleGoogleCallback(request, env);
      if (path === "/api/me" && request.method === "GET") return handleMe(request, env);
      if (path === "/api/logout" && request.method === "POST") return handleLogout(request, env);
      if (path === "/api/profile" && ["GET", "PUT", "PATCH"].includes(request.method)) return handleProfile(request, env);
      if (path === "/api/settings" && ["GET", "PUT", "PATCH"].includes(request.method)) return handleSettings(request, env);
      if (path === "/api/promoters" && request.method === "GET") return handlePromoters(request, env);
      if (path === "/api/promoter-application" && request.method === "POST") return handlePromoterApplication(request, env);
      const favoriteMatch = path.match(/^\/api\/promoters\/(\d+)\/favorite$/);
      if (favoriteMatch && ["POST", "DELETE"].includes(request.method)) return handleFavorite(request, env, favoriteMatch[1]);
      const singleProductMatch = path.match(/^\/api\/product\/(\d+)$/);
      if (singleProductMatch && request.method === "GET") return handleProduct(request, env, singleProductMatch[1]);
      const productMatch = path.match(/^\/api\/products\/(\d+)$/);
      if (productMatch) {
        const id = productMatch[1];
        if (request.method === "GET") return handleProduct(request, env, id);
        if (["PUT", "PATCH"].includes(request.method)) return handleUpdateProduct(request, env, id);
        if (request.method === "DELETE") return handleDeleteProduct(request, env, id);
      }
      const shareMatch = path.match(/^\/api\/share\/(\d+)$/);
      if (shareMatch && request.method === "GET") return handleShareProduct(request, env, shareMatch[1]);
      if (path.startsWith("/api/telegram")) return json({ ok: false, error: "Telegram is handled by the separate bot Worker." }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("SHOPPER'S SUGGESTIONS WORKER ERROR:", error);
      // Temporary safe diagnostic: visit /api/health?debug=1 to reveal the error message.
      // Remove this diagnostic after the root cause is fixed.
      const debug = new URL(request.url).searchParams.get("debug") === "1";
      const diagnostic = String(error?.message || error || "Unknown error").slice(0, 400);
      return json({ ok: false, error: "Internal server error", ...(debug ? { diagnostic } : {}) }, 500);
    }
  }
};
