const CATEGORIES = [
  "Tech", "Home", "Fashion", "Beauty", "Gaming", "Sports", "Travel",
  "Kitchen", "Office", "Automotive", "Electronics", "Kids", "Pets",
  "Fitness", "Books", "Accessories", "Photography", "Creator", "Other"
];

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  affiliate_url TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Other',
  image1_url TEXT NOT NULL DEFAULT '', image2_url TEXT NOT NULL DEFAULT '',
  image3_url TEXT NOT NULL DEFAULT '', image4_url TEXT NOT NULL DEFAULT '',
  image5_url TEXT NOT NULL DEFAULT '', video_url TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 1, featured INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT, listing_duration_hours INTEGER NOT NULL DEFAULT 72, raised_at TEXT, expired_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

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
  shopping_preference TEXT NOT NULL DEFAULT 'All',
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


const COMMUNITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_allowlist (
  email TEXT PRIMARY KEY,
  is_root INTEGER NOT NULL DEFAULT 0,
  added_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_id INTEGER,
  email_requested INTEGER NOT NULL DEFAULT 0,
  email_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS login_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS product_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS hidden_products (
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  hidden_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id,product_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS promoter_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount_inr INTEGER NOT NULL DEFAULT 165,
  status TEXT NOT NULL DEFAULT 'inactive',
  started_at TEXT,
  expires_at TEXT,
  provider_reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS purchase_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  UNIQUE(user_id, product_id)
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
  // Run each CREATE TABLE statement individually. This avoids D1 receiving a
  // truncated/multi-statement schema string and makes SQL errors easier to isolate.
  const statements = schema
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
}

async function ensureSchema(env) {
  if (!env || !env.DB) throw new Error("Cloudflare D1 binding 'DB' is missing.");
  await executeSchema(env, BASE_SCHEMA);
  await executeSchema(env, USER_SCHEMA);
  await executeSchema(env, COMMUNITY_SCHEMA);
  const rootEmail = clean(env.ROOT_ADMIN_EMAIL || "fayasm379@gmail.com", 320).toLowerCase();
  if (rootEmail.includes("@")) {
    await env.DB.prepare("INSERT OR IGNORE INTO admin_allowlist (email, is_root) VALUES (?, 1)").bind(rootEmail).run();
  }

  // Add missing columns to older versions of these tables without deleting data.
  const migrations = {
    products: {
      featured: "INTEGER NOT NULL DEFAULT 0", price: "REAL", original_price: "REAL",
      expires_at: "TEXT", listing_duration_hours: "INTEGER NOT NULL DEFAULT 72", raised_at: "TEXT", expired_at: "TEXT",
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
      bio: "TEXT NOT NULL DEFAULT ''", affiliate_source: "TEXT NOT NULL DEFAULT ''", social_links: "TEXT NOT NULL DEFAULT ''", status: "TEXT NOT NULL DEFAULT 'pending'", created_at: "TEXT NOT NULL DEFAULT ''"
    },
    promoter_applications: {
      user_id: "INTEGER", message: "TEXT NOT NULL DEFAULT ''", status: "TEXT NOT NULL DEFAULT 'pending'",
      created_at: "TEXT NOT NULL DEFAULT ''", reviewed_at: "TEXT"
    },
    user_favorites: { user_id: "INTEGER", promoter_id: "INTEGER", created_at: "TEXT NOT NULL DEFAULT ''" },
    product_favorites: { user_id: "INTEGER", product_id: "INTEGER", created_at: "TEXT NOT NULL DEFAULT ''" },
    user_settings: {
      theme: "TEXT NOT NULL DEFAULT 'system'", email_notifications: "INTEGER NOT NULL DEFAULT 1",
      profile_public: "INTEGER NOT NULL DEFAULT 1", shopping_preference: "TEXT NOT NULL DEFAULT 'All'", updated_at: "TEXT NOT NULL DEFAULT ''"
    },
    product_images: {
      product_id: "INTEGER", image_url: "TEXT NOT NULL DEFAULT ''", sort_order: "INTEGER NOT NULL DEFAULT 0",
      created_at: "TEXT NOT NULL DEFAULT ''"
    },
    conversations: { closed_at: "TEXT" },
    messages: { expires_at: "TEXT", deleted_at: "TEXT" },
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

  // Backfill legacy products to the default 72-hour listing window without deleting existing data.
  await env.DB.prepare("UPDATE products SET expires_at = datetime(CASE WHEN created_at IS NULL OR created_at = '' THEN CURRENT_TIMESTAMP ELSE created_at END, '+' || COALESCE(listing_duration_hours,72) || ' hours') WHERE expires_at IS NULL OR expires_at = ''").run();
  await env.DB.prepare("UPDATE messages SET expires_at = datetime(created_at, '+24 hours') WHERE expires_at IS NULL OR expires_at = ''").run();
  // Expired messages are removed at every message request; this also catches deployments without cron.
  await env.DB.prepare("DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP").run();
  await env.DB.prepare("DELETE FROM hidden_products WHERE hidden_until<=CURRENT_TIMESTAMP").run();

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
function userCookie(id, slot = "a") {
  const name = slot === "b" ? "ss_user_session_b" : "ss_user_session_a";
  return [`${name}=${encodeURIComponent(id)}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=2592000"].join("; ");
}
function clearUserCookie(slot = "a") {
  const name = slot === "b" ? "ss_user_session_b" : "ss_user_session_a";
  return [`${name}=`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=0"].join("; ");
}
function activeAccountSlot(request) { return getCookie(request, "ss_active_account") === "b" ? "b" : "a"; }
function activeUserSession(request) {
  const slot = activeAccountSlot(request);
  return getCookie(request, slot === "b" ? "ss_user_session_b" : "ss_user_session_a") || getCookie(request, "ss_user_session");
}
async function isAdmin(request, env) {
  const user = await currentUser(request, env);
  if (!user?.email) return false;
  const email = clean(user.email, 320).toLowerCase();
  const allowed = await env.DB.prepare("SELECT email FROM admin_allowlist WHERE email = ? LIMIT 1").bind(email).first();
  return !!allowed;
}
async function adminUser(request, env) {
  const user = await currentUser(request, env);
  if (!user?.email) return null;
  const email = clean(user.email, 320).toLowerCase();
  const row = await env.DB.prepare("SELECT email, is_root FROM admin_allowlist WHERE email = ? LIMIT 1").bind(email).first();
  return row ? { ...user, is_admin: true, is_root_admin: Number(row.is_root) === 1, subscription: "permanent", admin_badge: true } : null;
}
async function currentUser(request, env) {
  const session = activeUserSession(request);
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
async function sendSingleEmail(env, to, subject, textBody) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !to) return { configured: false, sent: false };
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: clean(subject, 160), text: clean(textBody, 10000) }) });
  return { configured: true, sent: response.ok };
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
    pr.status AS uploader_status,
    (SELECT COUNT(*) FROM product_clicks pc WHERE pc.product_id = p.id) AS click_count
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
    expires_at: row.expires_at || "",
    listing_duration_hours: Number(row.listing_duration_hours || 72),
    raised_at: row.raised_at || "",
    expired_at: row.expired_at || "",
    click_count: Number(row.click_count || 0),
    hours_remaining: row.expires_at ? Math.max(0, Math.ceil((Date.parse(String(row.expires_at).replace(" ","T")+"Z")-Date.now())/3600000)) : null,
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

async function deleteExpiredProductMedia(env, product) {
  const fields = ["image1_url", "image2_url", "image3_url", "image4_url", "image5_url"];
  const prefix = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH || "main"}/`;
  const clear = new Set();
  for (const field of fields) {
    const mediaUrl = product[field];
    if (!mediaUrl) { clear.add(field); continue; }
    if (!mediaUrl.startsWith(prefix)) { clear.add(field); continue; }
    let path = "";
    try { path = decodeURIComponent(mediaUrl.slice(prefix.length)); } catch { continue; }
    if (!path.startsWith("media/")) { clear.add(field); continue; }
    const refs = await env.DB.prepare("SELECT id FROM products WHERE id != ? AND (image1_url=? OR image2_url=? OR image3_url=? OR image4_url=? OR image5_url=?) LIMIT 1").bind(product.id, mediaUrl, mediaUrl, mediaUrl, mediaUrl, mediaUrl).first();
    if (refs) { clear.add(field); continue; }
    try { await githubDelete(env, path, `Clean expired product ${product.id} media`); clear.add(field); }
    catch (error) { console.error("Expired media cleanup failed; will retry on a later cleanup:", error); }
  }
  return clear;
}
async function cleanupExpiredProducts(env) {
  const expired = await env.DB.prepare("SELECT * FROM products WHERE (published=1 AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP) OR (published=0 AND expired_at IS NOT NULL AND (image1_url!='' OR image2_url!='' OR image3_url!='' OR image4_url!='' OR image5_url!='')) LIMIT 100").all();
  for (const product of expired.results || []) {
    const clear = await deleteExpiredProductMedia(env, product);
    const columns = [...clear].map(k => `${k}=''`).join(', ');
    const assignments = ["published=0", "expired_at=COALESCE(expired_at,CURRENT_TIMESTAMP)", "updated_at=CURRENT_TIMESTAMP", columns].filter(Boolean).join(', ');
    await env.DB.prepare(`UPDATE products SET ${assignments} WHERE id=?`).bind(product.id).run();
    await env.DB.prepare("DELETE FROM product_images WHERE product_id=?").bind(product.id).run();
    await env.DB.prepare("DELETE FROM product_favorites WHERE product_id=?").bind(product.id).run();
  }
  return (expired.results || []).length;
}
async function handleRaiseProduct(request, env, id) {
  const admin = await adminUser(request, env);
  const user = await currentUser(request, env);
  if (!user) return json({ ok:false, error:"Sign in required" }, 401);
  const product = await env.DB.prepare("SELECT * FROM products WHERE id=? LIMIT 1").bind(id).first();
  if (!product) return json({ ok:false, error:"Product not found" }, 404);
  if (!admin && Number(product.uploader_id) !== Number(user.id)) return json({ ok:false, error:"Only the listing owner or an administrator can raise this listing" }, 403);
  const hours = 72;
  await env.DB.prepare("UPDATE products SET published=1, expires_at=datetime('now', ?), listing_duration_hours=?, raised_at=CURRENT_TIMESTAMP, expired_at=NULL, created_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(`+${hours} hours`, hours, id).run();
  const updated = await env.DB.prepare(`${PRODUCT_SELECT} WHERE p.id=?`).bind(id).first();
  return json({ok:true, product:productPublic(updated), message:`Listing raised for another 72 hours. Re-upload images if they were removed after expiry.`});
}

async function handleProducts(request, env) {
  await cleanupExpiredProducts(env);
  const url = new URL(request.url);
  const category = clean(url.searchParams.get("category"), 100);
  const search = clean(url.searchParams.get("search"), 200);
  const featured = ["1", "true"].includes(url.searchParams.get("featured"));
  let limit = Number(url.searchParams.get("limit") || 100);
  if (!Number.isFinite(limit)) limit = 100;
  limit = Math.max(1, Math.min(limit, 200));
  const conditions = ["p.published = 1", "p.expires_at IS NOT NULL", "p.expires_at > CURRENT_TIMESTAMP"];
  const values = [];
  if (category && category !== "All") { conditions.push("p.category = ?"); values.push(category); }
  if (search) {
    conditions.push("(LOWER(p.title) LIKE LOWER(?) OR LOWER(p.description) LIKE LOWER(?) OR LOWER(p.category) LIKE LOWER(?))");
    const q = `%${search}%`; values.push(q, q, q);
  }
  if (featured) conditions.push("p.featured = 1");
  const viewer = await currentUser(request,env);
  const viewerSubscription = viewer ? await activePromoterSubscription(env,viewer.id) : null;
  if (viewerSubscription) { conditions.push("NOT EXISTS (SELECT 1 FROM hidden_products hp WHERE hp.product_id=p.id AND hp.user_id=? AND hp.hidden_until>CURRENT_TIMESTAMP)"); values.push(viewer.id); }
  const sql = `${PRODUCT_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY datetime(p.created_at) DESC, p.id DESC LIMIT ?`;
  values.push(limit);
  const result = await env.DB.prepare(sql).bind(...values).all();
  return json({ ok: true, products: (result.results || []).map(productPublic) });
}
async function handleAdminProducts(request, env) {
  await cleanupExpiredProducts(env);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
  const result = await env.DB.prepare(`${PRODUCT_SELECT} ORDER BY datetime(p.created_at) DESC, p.id DESC`).all();
  return json({ ok: true, products: (result.results || []).map(productPublic) });
}
async function handleProduct(request, env, id) {
  const product = await env.DB.prepare(`${PRODUCT_SELECT} WHERE p.id = ? LIMIT 1`).bind(id).first();
  if (!product || ((Number(product.published) !== 1 || !product.expires_at || product.expires_at <= new Date().toISOString().replace("T", " ").slice(0,19)) && !(await isAdmin(request, env)))) return json({ ok: false, error: "Product not found" }, 404);
  return json({ ok: true, product: productPublic(product) });
}
async function activePromoterSubscription(env, userId) {
  return env.DB.prepare("SELECT id, amount_inr, status, started_at, expires_at FROM promoter_subscriptions WHERE user_id=? AND status='active' AND expires_at>CURRENT_TIMESTAMP ORDER BY expires_at DESC LIMIT 1").bind(userId).first();
}
async function approvedPromoter(env, userId) {
  return env.DB.prepare("SELECT id, status FROM promoters WHERE user_id=? AND status='approved' LIMIT 1").bind(userId).first();
}
async function handleMyAnalytics(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ok:false,error:"Sign in required"},401);
  await cleanupExpiredProducts(env);
  const row = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM products WHERE uploader_id=?) AS total_listings,
    (SELECT COUNT(*) FROM products WHERE uploader_id=? AND published=1 AND expires_at>CURRENT_TIMESTAMP) AS active_listings,
    (SELECT COUNT(*) FROM products WHERE uploader_id=? AND (published=0 OR expires_at<=CURRENT_TIMESTAMP)) AS expired_listings,
    (SELECT COUNT(*) FROM product_clicks pc JOIN products p ON p.id=pc.product_id WHERE p.uploader_id=?) AS clicks_received,
    (SELECT COUNT(*) FROM product_clicks WHERE user_id=?) AS clicks_made
  `).bind(user.id,user.id,user.id,user.id,user.id).first();
  return json({ok:true,...Object.fromEntries(Object.entries(row||{}).map(([k,v])=>[k,Number(v||0)]))});
}

async function handleMyProducts(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ok:false,error:"Sign in required"},401);
  await cleanupExpiredProducts(env);
  const result = await env.DB.prepare(`${PRODUCT_SELECT} WHERE p.uploader_id=? ORDER BY datetime(p.created_at) DESC,p.id DESC`).bind(user.id).all();
  return json({ok:true,products:(result.results||[]).map(productPublic)});
}
async function handleHideProduct(request, env, productId) {
  const user=await requireUser(request,env);
  if(!user)return json({ok:false,error:"Sign in required"},401);
  const subscription=await activePromoterSubscription(env,user.id);
  if(!subscription)return json({ok:false,error:"Hiding products until your subscription ends requires an active ₹165/month subscription"},403);
  const product=await env.DB.prepare("SELECT id FROM products WHERE id=? AND published=1 AND expires_at>CURRENT_TIMESTAMP").bind(productId).first();
  if(!product)return json({ok:false,error:"Product not found or expired"},404);
  if(request.method==="POST") await env.DB.prepare("INSERT INTO hidden_products(user_id,product_id,hidden_until) VALUES(?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET hidden_until=excluded.hidden_until,created_at=CURRENT_TIMESTAMP").bind(user.id,productId,subscription.expires_at).run();
  else await env.DB.prepare("DELETE FROM hidden_products WHERE user_id=? AND product_id=?").bind(user.id,productId).run();
  return json({ok:true,hidden:request.method==="POST",hidden_until:request.method==="POST"?subscription.expires_at:null});
}

async function handleSubscription(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ok:false,error:"Sign in required"},401);
  const active = await activePromoterSubscription(env,user.id);
  if (request.method === "GET") return json({ok:true,plan:{price_inr:165,period:"month",image_uploads:!!active,listing_days:active?30:3},subscription:active||null,payment_status:env.PAYMENT_PROVIDER&&env.PAYMENT_API_KEY?"provider_configured_checkout_not_implemented":"setup_required"});
  return json({ok:false,error:"₹165/month subscription checkout is not enabled yet. No payment was taken. Configure a real provider and signed webhook before activating a subscription.",status:"setup_required"},503);
}

async function handleCreateProduct(request, env) {
  const admin = await adminUser(request, env);
  const user = await currentUser(request, env);
  const promoter = user ? await approvedPromoter(env,user.id) : null;
  const subscription = user ? await activePromoterSubscription(env,user.id) : null;
  if (!admin && !promoter) return json({ok:false,error:"Only approved promoters or administrators can publish listings"},403);
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
  
  const durationHours = 72;
  const uploaderId = admin ? numberOrNull(body.uploader_id ?? body.user_id) : Number(user.id);
  if (uploaderId !== null) {
    const exists = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(uploaderId).first();
    if (!exists) return json({ ok: false, error: "Uploader account was not found" }, 400);
  }
  const result = await env.DB.prepare(`
    INSERT INTO products (title, description, affiliate_url, category, image1_url, image2_url, image3_url, image4_url, image5_url, video_url, published, featured, price, original_price, uploader_id, expires_at, listing_duration_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?)
    RETURNING id
  `).bind(title, description, affiliateUrl, category, ...images, videoUrl, body.published === undefined ? 1 : (isTrue(body.published) ? 1 : 0), isTrue(body.featured) ? 1 : 0, price, originalPrice, uploaderId, `+${durationHours} hours`, durationHours).first();
  const product = await env.DB.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).bind(result.id).first();
  return json({ ok: true, product: productPublic(product) }, 201);
}
async function handleUpdateProduct(request, env, id) {
  const user = await currentUser(request,env);
  const admin = await adminUser(request,env);
  const existingAuth = await env.DB.prepare("SELECT uploader_id FROM products WHERE id=? LIMIT 1").bind(id).first();
  if (!existingAuth || (!admin && Number(existingAuth.uploader_id)!==Number(user?.id))) return json({ ok: false, error: "Only the listing owner or an administrator can edit this product" }, 403);
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
  const activeSubForEdit = user ? await activePromoterSubscription(env,user.id) : null;
  if (!admin && !activeSubForEdit && Object.keys(body).some(key => /^image[1-5]_url$/.test(key) && clean(body[key],3000))) return json({ok:false,error:"Adding product images requires an active ₹165/month promoter subscription"},403);
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
  const user = await currentUser(request,env);
  const admin = await adminUser(request,env);
  const product = await env.DB.prepare("SELECT * FROM products WHERE id = ? LIMIT 1").bind(id).first();
  if (!product) return json({ ok: false, error: "Product not found" }, 404);
  if (!admin && Number(product.uploader_id)!==Number(user?.id)) return json({ok:false,error:"Only the listing owner or an administrator can delete this product"},403);
  const mediaUrls = [product.image1_url, product.image2_url, product.image3_url, product.image4_url, product.image5_url].filter(Boolean);
  for (const mediaUrl of mediaUrls) {
    try {
      const prefix = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH || "main"}/`;
      if (mediaUrl.startsWith(prefix)) {
        const path = decodeURIComponent(mediaUrl.slice(prefix.length));
        if (path.startsWith("media/")) { const refs = await env.DB.prepare("SELECT id FROM products WHERE id != ? AND (image1_url=? OR image2_url=? OR image3_url=? OR image4_url=? OR image5_url=?) LIMIT 1").bind(id,mediaUrl,mediaUrl,mediaUrl,mediaUrl,mediaUrl).first(); if (!refs) await githubDelete(env, path, `Delete media for product ${id}`); }
      }
    } catch (error) { console.error("GitHub media delete failed:", error); }
  }
  await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  return json({ ok: true, deleted: Number(id) });
}
async function handleUploadMedia(request, env) {
  const admin = await adminUser(request,env);
  const user = await currentUser(request,env);
  const promoter = user ? await approvedPromoter(env,user.id) : null;
  const subscription = user ? await activePromoterSubscription(env,user.id) : null;
  if (!admin && !promoter) return json({ok:false,error:"Become a promoter before uploading product media"},403);
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
  const slot = url.searchParams.get("slot") === "b" ? "b" : "a";
  const redirectUri = `${url.origin}/auth/google/callback`;
  const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  google.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  google.searchParams.set("redirect_uri", redirectUri);
  google.searchParams.set("response_type", "code");
  google.searchParams.set("scope", "openid email profile");
  google.searchParams.set("state", state);
  google.searchParams.set("prompt", "select_account");
  const headers = new Headers({ Location: google.toString() });
  headers.append("Set-Cookie", [`ss_oauth_state=${state}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"].join("; "));
  headers.append("Set-Cookie", [`ss_oauth_slot=${slot}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"].join("; "));
  return new Response(null, { status: 302, headers });
}
async function handleGoogleCallback(request, env) {
  const url = new URL(request.url);
  const code = clean(url.searchParams.get("code"), 3000);
  const state = clean(url.searchParams.get("state"), 200);
  const savedState = getCookie(request, "ss_oauth_state");
  const slot = getCookie(request, "ss_oauth_slot") === "b" ? "b" : "a";
  const clearState = "ss_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
  const clearSlot = "ss_oauth_slot=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
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
  let isNewUser = false;
  let user = await env.DB.prepare("SELECT id, username FROM users WHERE google_id = ? OR email = ? LIMIT 1").bind(profile.sub, email).first();
  if (user) {
    await env.DB.prepare("UPDATE users SET google_id=?, email=?, display_name=?, avatar_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(profile.sub, email, displayName, avatar, user.id).run();
  } else {
    isNewUser = true;
    user = await env.DB.prepare("INSERT INTO users (google_id, email, username, display_name, avatar_url) VALUES (?, ?, NULL, ?, ?) RETURNING id, username").bind(profile.sub, email, displayName, avatar).first();
  }
  const sessionId = randomId();
  await env.DB.prepare("INSERT INTO user_sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))").bind(sessionId, user.id).run();
  await env.DB.prepare("INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)").bind(user.id).run();
  await logActivity(env, user.id, "google_sign_in", "user", user.id);
  await env.DB.prepare("INSERT INTO login_notices (user_id,title,body) VALUES (?,?,?)").bind(user.id, "New sign-in", `A Google sign-in to your Shopper’s Suggestions account occurred at ${new Date().toISOString()}. If this was not you, sign out of other sessions and secure your Google account.`).run();
  try { await sendSingleEmail(env, email, "New sign-in to Shopper’s Suggestions", `A Google sign-in to your Shopper’s Suggestions account occurred at ${new Date().toISOString()}. If this was not you, secure your Google account.`); } catch (error) { console.error("Login notification email failed", error); }
  const headers = new Headers({ Location: isNewUser || !user.username ? "/?onboarding=1" : "/" });
  headers.append("Set-Cookie", userCookie(sessionId, slot));
  headers.append("Set-Cookie", [`ss_active_account=${slot}`, "Secure", "SameSite=Lax", "Path=/", "Max-Age=2592000"].join("; "));
  headers.append("Set-Cookie", clearState);
  headers.append("Set-Cookie", clearSlot);
  return new Response(null, { status: 302, headers });
}
async function handleMe(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ ok: true, authenticated: false, user: null });
  const promoter = await env.DB.prepare("SELECT id, status FROM promoters WHERE user_id = ? LIMIT 1").bind(user.id).first();
  const activeSubscription = await activePromoterSubscription(env,user.id);
  const favorites = await env.DB.prepare("SELECT promoter_id FROM user_favorites WHERE user_id = ?").bind(user.id).all();
  const productFavorites = await env.DB.prepare("SELECT product_id FROM product_favorites WHERE user_id = ?").bind(user.id).all();
  const admin = await adminUser(request, env);
  return json({ ok: true, authenticated: true, user: { ...user, is_promoter: !!promoter && promoter.status === "approved", promoter_status: promoter?.status || "none", promoter_id: promoter?.id || null, has_active_subscription: !!activeSubscription, subscription_expires_at: activeSubscription?.expires_at || null, is_admin: !!admin, is_root_admin: !!admin?.is_root_admin, admin_badge: !!admin, subscription: admin ? "permanent" : "free" }, favorite_promoter_ids: (favorites.results || []).map(x => String(x.promoter_id)), favorite_product_ids: (productFavorites.results || []).map(x => String(x.product_id)) });
}
async function handleLogout(request, env) {
  const slot = activeAccountSlot(request);
  const session = activeUserSession(request);
  if (session) await env.DB.prepare("DELETE FROM user_sessions WHERE id = ?").bind(session).run();
  const otherSlot = slot === "a" ? "b" : "a";
  const otherSession = getCookie(request, otherSlot === "b" ? "ss_user_session_b" : "ss_user_session_a");
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  headers.append("Set-Cookie", clearUserCookie(slot));
  headers.append("Set-Cookie", "ss_user_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  if (otherSession) headers.append("Set-Cookie", [`ss_active_account=${otherSlot}`, "Secure", "SameSite=Lax", "Path=/", "Max-Age=2592000"].join("; "));
  else headers.append("Set-Cookie", `ss_active_account=; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  return new Response(JSON.stringify({ ok: true, switched_to_other_account: !!otherSession }), { status: 200, headers });
}
async function handleAccounts(request, env) {
  const slots = ["a", "b"], accounts = [];
  for (const slot of slots) {
    const session = getCookie(request, slot === "b" ? "ss_user_session_b" : "ss_user_session_a");
    if (!session) continue;
    const row = await env.DB.prepare(`SELECT u.id,u.email,u.username,u.display_name,u.avatar_url,u.role,u.is_banned FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>CURRENT_TIMESTAMP LIMIT 1`).bind(session).first();
    if (row && !Number(row.is_banned)) accounts.push({ slot, id: row.id, email: row.email, username: row.username, display_name: row.display_name, avatar_url: row.avatar_url, active: slot === activeAccountSlot(request) });
  }
  if (request.method === "GET") return json({ ok: true, active_slot: activeAccountSlot(request), accounts, max_accounts: 2 });
  const user = await currentUser(request, env);
  if (!user) return json({ ok: false, error: "Sign in required" }, 401);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const slot = body.slot === "b" ? "b" : body.slot === "a" ? "a" : "";
  if (!slot || !accounts.some(a => a.slot === slot)) return json({ ok: false, error: "That account is not signed in" }, 404);
  return json({ ok: true, active_slot: slot }, 200, { "Set-Cookie": [`ss_active_account=${slot}`, "Secure", "SameSite=Lax", "Path=/", "Max-Age=2592000"].join("; ") });
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
  const source = clean(body.affiliate_source, 300);
  const socials = clean(body.social_links, 1500);
  const bio = clean(body.bio, 1000);
  if (!source || !socials) return json({ ok: false, error: "Tell us which affiliate source you use and where you share recommendations." }, 400);
  const profileBio = [bio, `Affiliate source: ${source}`, `Sharing channels: ${socials}`].filter(Boolean).join("\n\n");
  await env.DB.prepare(`INSERT INTO promoters (user_id, display_name, username, avatar_url, bio, affiliate_source, social_links, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')
    ON CONFLICT(user_id) DO UPDATE SET bio=excluded.bio, affiliate_source=excluded.affiliate_source, social_links=excluded.social_links, status='approved', display_name=excluded.display_name, username=excluded.username, avatar_url=excluded.avatar_url`).bind(user.id, user.display_name || "", user.username || null, user.avatar_url || "", profileBio, source, socials).run();
  await env.DB.prepare("INSERT INTO promoter_applications (user_id, message, status, reviewed_at) VALUES (?, ?, 'approved', CURRENT_TIMESTAMP)").bind(user.id, profileBio).run();
  await logActivity(env, user.id, "promoter_self_activated", "user", user.id);
  return json({ ok: true, status: "approved", message: "Promoter account activated." }, 201);
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
    const settings = await env.DB.prepare("SELECT theme, email_notifications, profile_public, shopping_preference FROM user_settings WHERE user_id=?").bind(user.id).first();
    return json({ ok: true, settings: settings || { theme: "system", email_notifications: 1, profile_public: 1, shopping_preference: "All" } });
  }
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const theme = ["light", "dark", "system"].includes(body.theme) ? body.theme : "system";
  const emailNotifications = body.email_notifications === undefined ? 1 : (isTrue(body.email_notifications) ? 1 : 0);
  const profilePublic = body.profile_public === undefined ? 1 : (isTrue(body.profile_public) ? 1 : 0);
  const shoppingPreference = validCategory(body.shopping_preference) || body.shopping_preference === "All" ? clean(body.shopping_preference, 100) : "All";
  await env.DB.prepare(`INSERT INTO user_settings (user_id, theme, email_notifications, profile_public, shopping_preference, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme, email_notifications=excluded.email_notifications, profile_public=excluded.profile_public, shopping_preference=excluded.shopping_preference, updated_at=CURRENT_TIMESTAMP`)
    .bind(user.id, theme, emailNotifications, profilePublic, shoppingPreference).run();
  return json({ ok: true, settings: { theme, email_notifications: emailNotifications, profile_public: profilePublic, shopping_preference: shoppingPreference } });
}
async function handleMyNotices(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ ok: false, error: "Sign in required" }, 401);
  const rows = await env.DB.prepare("SELECT id,title,body,created_at FROM login_notices WHERE user_id=? ORDER BY id DESC LIMIT 30").bind(user.id).all();
  return json({ ok: true, notices: rows.results || [] });
}
async function requireAdmin(request, env) {
  const admin = await adminUser(request, env);
  return admin;
}
async function handleAdminAccess(request, env) {
  const admin = await adminUser(request, env);
  return json({ ok: true, is_admin: !!admin, is_root: !!admin?.is_root_admin, permanent_subscription: !!admin, admin_badge: !!admin, user: admin ? { email: admin.email, username: admin.username, subscription: "permanent" } : null });
}
async function handleAdminList(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ ok: false, error: "Administrator access required" }, 403);
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT email, is_root, created_at FROM admin_allowlist ORDER BY is_root DESC, email ASC").all();
    return json({ ok: true, admins: (rows.results || []).map(r => ({ email: r.email, is_root: Number(r.is_root) === 1, created_at: r.created_at })) });
  }
  if (!admin.is_root_admin) return json({ ok: false, error: "Only the root administrator can change the admin allowlist" }, 403);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const email = clean(body.email, 320).toLowerCase();
  if (!/^[^\s@]+@gmail\.com$/i.test(email)) return json({ ok: false, error: "Enter a valid Gmail address" }, 400);
  await env.DB.prepare("INSERT OR IGNORE INTO admin_allowlist (email, is_root, added_by) VALUES (?, 0, ?)").bind(email, admin.id).run();
  return json({ ok: true, email });
}
async function handleAdminRemove(request, env, emailEncoded) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ ok: false, error: "Administrator access required" }, 403);
  if (!admin.is_root_admin) return json({ ok: false, error: "Only the root administrator can change the admin allowlist" }, 403);
  let email; try { email = decodeURIComponent(emailEncoded).toLowerCase(); } catch { return json({ ok: false, error: "Invalid email" }, 400); }
  const target = await env.DB.prepare("SELECT is_root FROM admin_allowlist WHERE email = ?").bind(email).first();
  if (!target) return json({ ok: false, error: "Administrator not found" }, 404);
  if (Number(target.is_root) === 1) return json({ ok: false, error: "The root administrator cannot be removed" }, 403);
  await env.DB.prepare("DELETE FROM admin_allowlist WHERE email = ?").bind(email).run();
  return json({ ok: true, removed: email });
}
async function handleAdminUsers(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "Administrator access required" }, 403);
  const result = await env.DB.prepare(`SELECT u.id, u.email, u.username, u.display_name, u.created_at,
    CASE WHEN a.email IS NOT NULL THEN 1 ELSE 0 END AS is_admin,
    CASE WHEN a.email IS NOT NULL THEN 'permanent' ELSE 'free' END AS subscription
    FROM users u LEFT JOIN admin_allowlist a ON lower(a.email)=lower(u.email)
    ORDER BY u.id DESC LIMIT 500`).all();
  return json({ ok: true, users: result.results || [] });
}
async function handleAdminPromoters(request, env) {
  const admin = await requireAdmin(request,env);
  if (!admin) return json({ok:false,error:"Administrator access required"},403);
  if (request.method === "GET") {
    const result = await env.DB.prepare("SELECT p.id,p.user_id,p.display_name,p.username,p.bio,p.status,p.created_at,u.email FROM promoters p LEFT JOIN users u ON u.id=p.user_id ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END,p.id DESC LIMIT 200").all();
    return json({ok:true,promoters:result.results||[]});
  }
  let body; try { body=await request.json(); } catch { return json({ok:false,error:"Invalid JSON"},400); }
  const id=Number(body.promoter_id), status=String(body.status||"");
  if (!Number.isInteger(id)||id<1||!['approved','rejected','pending'].includes(status)) return json({ok:false,error:"Choose a valid promoter and status"},400);
  const result=await env.DB.prepare("UPDATE promoters SET status=? WHERE id=? RETURNING id,user_id,status").bind(status,id).first();
  if (!result) return json({ok:false,error:"Promoter application not found"},404);
  await env.DB.prepare("UPDATE promoter_applications SET status=?,reviewed_at=CURRENT_TIMESTAMP WHERE user_id=? AND status='pending'").bind(status,result.user_id).run();
  return json({ok:true,promoter:result});
}

async function sendCommunityEmail(env, subject, body) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { configured: false, sent: 0 };
  const result = await env.DB.prepare("SELECT email FROM users WHERE email IS NOT NULL AND email != '' AND is_banned = 0").all();
  const emails = [...new Set((result.results || []).map(x => clean(x.email, 320).toLowerCase()).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)))];
  let sent = 0;
  // Keep provider requests small and explicit; report only provider-accepted messages.
  for (const email of emails) {
    const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: env.EMAIL_FROM, to: [email], subject, text: body }) });
    if (response.ok) sent++;
  }
  return { configured: true, sent, total: emails.length };
}
async function handleAnnouncements(request, env) {
  if (request.method === "GET") {
    const result = await env.DB.prepare("SELECT id, title, body, created_at FROM announcements ORDER BY id DESC LIMIT 100").all();
    return json({ ok: true, announcements: result.results || [] });
  }
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ ok: false, error: "Administrator access required" }, 403);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const title = clean(body.title, 160), message = clean(body.body, 10000), emailRequested = isTrue(body.send_email);
  if (!title || !message) return json({ ok: false, error: "Title and message are required" }, 400);
  const inserted = await env.DB.prepare("INSERT INTO announcements (title, body, author_id, email_requested, email_sent) VALUES (?, ?, ?, ?, 0) RETURNING id, title, body, created_at").bind(title, message, admin.id, emailRequested ? 1 : 0).first();
  let delivery = { configured: false, sent: 0 };
  if (emailRequested) {
    try { delivery = await sendCommunityEmail(env, clean(body.email_subject || title, 160), message); }
    catch (error) { console.error("Community email send failed", error); delivery = { configured: true, sent: 0, error: "provider_error" }; }
    await env.DB.prepare("UPDATE announcements SET email_sent = ? WHERE id = ?").bind(delivery.configured && delivery.sent > 0 ? 1 : 0, inserted.id).run();
  }
  // Create an in-app notice for all existing users; the announcement itself remains globally visible too.
  await env.DB.prepare("INSERT INTO login_notices (user_id, title, body) SELECT id, ?, ? FROM users WHERE is_banned = 0").bind(title, message).run();
  return json({ ok: true, announcement: inserted, email_requested: emailRequested, email_configured: !!delivery.configured, email_sent: !!delivery.configured && Number(delivery.sent || 0) > 0, email_count: Number(delivery.sent || 0), email_total: Number(delivery.total || 0) }, 201);
}
async function handleUserSearch(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ ok: false, error: "Sign in required" }, 401);
  const q = clean(new URL(request.url).searchParams.get("q"), 60).replace(/^@/, "").toLowerCase();
  if (q.length < 2) return json({ ok: true, users: [] });
  const result = await env.DB.prepare("SELECT id, username, display_name, avatar_url FROM users WHERE id != ? AND username IS NOT NULL AND lower(username) LIKE ? AND is_banned = 0 ORDER BY username LIMIT 30").bind(user.id, `%${q}%`).all();
  return json({ ok: true, users: result.results || [] });
}
async function handleConversations(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ ok: false, error: "Sign in required" }, 401);
  if (request.method === "GET") {
    const result = await env.DB.prepare(`SELECT c.id, c.updated_at, c.closed_at,
      (SELECT m.body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
      (SELECT m.created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message_at,
      (SELECT u.id FROM conversation_members cm2 JOIN users u ON u.id=cm2.user_id WHERE cm2.conversation_id=c.id AND u.id != ? LIMIT 1) AS other_user_id,
      (SELECT u.username FROM conversation_members cm2 JOIN users u ON u.id=cm2.user_id WHERE cm2.conversation_id=c.id AND u.id != ? LIMIT 1) AS username,
      (SELECT u.display_name FROM conversation_members cm2 JOIN users u ON u.id=cm2.user_id WHERE cm2.conversation_id=c.id AND u.id != ? LIMIT 1) AS display_name,
      (SELECT u.avatar_url FROM conversation_members cm2 JOIN users u ON u.id=cm2.user_id WHERE cm2.conversation_id=c.id AND u.id != ? LIMIT 1) AS avatar_url
      FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=? ORDER BY c.updated_at DESC LIMIT 100`).bind(user.id,user.id,user.id,user.id,user.id).all();
    return json({ ok: true, conversations: result.results || [] });
  }
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const username = clean(body.username, 30).toLowerCase().replace(/^@/, "");
  if (!/^[a-z0-9_.]{3,30}$/.test(username)) return json({ ok: false, error: "Enter a valid username" }, 400);
  const target = await env.DB.prepare("SELECT id, username FROM users WHERE lower(username)=? AND is_banned=0 LIMIT 1").bind(username).first();
  if (!target) return json({ ok: false, error: "No user found with that username" }, 404);
  if (Number(target.id) === Number(user.id)) return json({ ok: false, error: "You cannot start a chat with yourself" }, 400);
  let existing = await env.DB.prepare(`SELECT c.id FROM conversations c JOIN conversation_members a ON a.conversation_id=c.id JOIN conversation_members b ON b.conversation_id=c.id WHERE a.user_id=? AND b.user_id=? AND (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id=c.id)=2 LIMIT 1`).bind(user.id,target.id).first();
  let conversationId = existing?.id;
  if (!conversationId) {
    const c = await env.DB.prepare("INSERT INTO conversations DEFAULT VALUES RETURNING id").first();
    conversationId = c.id;
    await env.DB.prepare("INSERT INTO conversation_members (conversation_id,user_id) VALUES (?,?),(?,?)").bind(conversationId,user.id,conversationId,target.id).run();
  }
  return json({ ok: true, conversation_id: conversationId }, 201);
}
async function handleConversationMessages(request, env, conversationId) {
  const user = await requireUser(request, env);
  if (!user) return json({ ok: false, error: "Sign in required" }, 401);
  const member = await env.DB.prepare("SELECT 1 AS ok FROM conversation_members WHERE conversation_id=? AND user_id=?").bind(conversationId,user.id).first();
  if (!member) return json({ ok: false, error: "Conversation not found" }, 404);
  await env.DB.prepare("DELETE FROM messages WHERE conversation_id=? AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP").bind(conversationId).run();
  const conversation = await env.DB.prepare("SELECT closed_at FROM conversations WHERE id=?").bind(conversationId).first();
  if (request.method === "GET") {
    const result = await env.DB.prepare(`SELECT m.id,m.conversation_id,m.sender_id,m.body,m.created_at,m.expires_at,u.username,u.display_name,u.avatar_url,CASE WHEN m.sender_id=? THEN 1 ELSE 0 END AS is_mine FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? ORDER BY m.id ASC LIMIT 500`).bind(user.id,conversationId).all();
    return json({ ok: true, messages: result.results || [] });
  }
  if (conversation?.closed_at) return json({ ok:false, error:"This deal is closed. Messaging is disabled for both participants." }, 403);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const message = clean(body.message || body.body, 2000);
  if (!message) return json({ ok: false, error: "Message cannot be empty" }, 400);
  const inserted = await env.DB.prepare("INSERT INTO messages (conversation_id,sender_id,body,expires_at) VALUES (?,?,?,datetime('now', '+24 hours')) RETURNING id,conversation_id,sender_id,body,created_at,expires_at").bind(conversationId,user.id,message).first();
  await env.DB.prepare("UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(conversationId).run();
  return json({ ok: true, message: { ...inserted, is_mine: 1 } }, 201);
}
async function handleCloseDeal(request, env, conversationId) {
  const user = await requireUser(request, env);
  if (!user) return json({ok:false,error:"Sign in required"},401);
  const member = await env.DB.prepare("SELECT 1 AS ok FROM conversation_members WHERE conversation_id=? AND user_id=?").bind(conversationId,user.id).first();
  if (!member) return json({ok:false,error:"Conversation not found"},404);
  await env.DB.prepare("UPDATE conversations SET closed_at=COALESCE(closed_at,CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(conversationId).run();
  return json({ok:true,closed:true,message:"Deal closed. Neither participant can send more messages."});
}
async function handleDeleteMessage(request, env, conversationId, messageId) {
  const user = await requireUser(request, env);
  if (!user) return json({ok:false,error:"Sign in required"},401);
  const member = await env.DB.prepare("SELECT 1 AS ok FROM conversation_members WHERE conversation_id=? AND user_id=?").bind(conversationId,user.id).first();
  if (!member) return json({ok:false,error:"Conversation not found"},404);
  const result = await env.DB.prepare("DELETE FROM messages WHERE id=? AND conversation_id=? AND sender_id=?").bind(messageId,conversationId,user.id).run();
  if (!result.meta?.changes) return json({ok:false,error:"Message not found or not yours"},404);
  return json({ok:true,deleted:Number(messageId)});
}
async function handlePurchaseFeedback(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ok:false,error:"Sign in to add a purchase to your profile"},401);
  if (request.method === "GET") {
    const result = await env.DB.prepare("SELECT product_id FROM purchase_feedback WHERE user_id=? AND confirmed=1 ORDER BY created_at DESC").bind(user.id).all();
    return json({ok:true,product_ids:(result.results||[]).map(row=>String(row.product_id))});
  }
  let form;
  try { form = await request.formData(); } catch { return json({ok:false,error:"Please choose a screenshot"},400); }
  const productId = Number(form.get("product_id"));
  const bought = String(form.get("bought") || "") === "true";
  if (!Number.isInteger(productId) || productId < 1) return json({ok:false,error:"Invalid product"},400);
  const product = await env.DB.prepare("SELECT id FROM products WHERE id=? AND published=1 AND expires_at>CURRENT_TIMESTAMP").bind(productId).first();
  if (!product) return json({ok:false,error:"Product not found or expired"},404);
  if (!bought) return json({ok:true,recorded:false,message:"Thanks for the feedback."});
  const screenshot = form.get("screenshot");
  if (!screenshot || typeof screenshot.arrayBuffer !== "function" || !String(screenshot.type || "").startsWith("image/") || Number(screenshot.size || 0) > 8*1024*1024) return json({ok:false,error:"Please select an image screenshot under 8 MB"},400);
  // Read the screenshot only in memory to validate it; never write it to D1, R2, GitHub, logs or disk.
  const bytes = new Uint8Array(await screenshot.arrayBuffer());
  if (bytes.length < 16) return json({ok:false,error:"The selected screenshot is not a valid image"},400);
  await env.DB.prepare("INSERT INTO purchase_feedback (user_id,product_id,confirmed) VALUES (?,?,1) ON CONFLICT(user_id,product_id) DO UPDATE SET confirmed=1, created_at=CURRENT_TIMESTAMP").bind(user.id,productId).run();
  await logActivity(env,user.id,"purchase_screenshot_confirmed","product",productId);
  return json({ok:true,recorded:true,screenshot_saved:false,message:"Thanks for uploading. Your screenshot was checked in memory and was not saved."});
}

async function handleProductFavorites(request, env, productId) {
  const user = await requireUser(request, env);
  if (!user) return json({ ok: false, error: "Sign in required" }, 401);
  const product = await env.DB.prepare("SELECT id FROM products WHERE id=? AND published=1").bind(productId).first();
  if (!product) return json({ ok: false, error: "Product not found" }, 404);
  if (request.method === "POST") await env.DB.prepare("INSERT OR IGNORE INTO product_favorites (user_id,product_id) VALUES (?,?)").bind(user.id,productId).run();
  else await env.DB.prepare("DELETE FROM product_favorites WHERE user_id=? AND product_id=?").bind(user.id,productId).run();
  return json({ ok: true, favorited: request.method === "POST" });
}
async function handleMyProductFavorites(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ ok: false, error: "Sign in required" }, 401);
  const result = await env.DB.prepare(`${PRODUCT_SELECT} JOIN product_favorites pf ON pf.product_id=p.id WHERE pf.user_id=? AND p.published=1 AND p.expires_at>CURRENT_TIMESTAMP ORDER BY pf.created_at DESC`).bind(user.id).all();
  return json({ ok: true, products: (result.results || []).map(productPublic) });
}
async function handlePaymentSetup(request, env) {
  if (request.method === "GET") return json({ ok: true, status: env.PAYMENT_PROVIDER && env.PAYMENT_API_KEY ? "configured" : "setup_required", checkout_endpoint: "/api/payments/checkout", message: "Payment processing remains disabled until a provider, secrets, webhook signature validation and pricing are configured." });
  const user = await requireUser(request, env);
  if (!user) return json({ ok: false, error: "Sign in required" }, 401);
  if (!env.PAYMENT_PROVIDER || !env.PAYMENT_API_KEY) return json({ ok: false, error: "Payments are not configured. No charge was made.", status: "setup_required" }, 503);
  return json({ ok: false, error: "Provider-specific checkout and signed webhook verification must be implemented before accepting payments. No charge was made." }, 501);
}
async function handleTrackClick(request, env, productId) {
  await cleanupExpiredProducts(env);
  const product = await env.DB.prepare("SELECT id,affiliate_url,published,expires_at FROM products WHERE id=? LIMIT 1").bind(productId).first();
  if (product && (!product.expires_at || product.expires_at <= new Date().toISOString().replace("T", " ").slice(0,19))) return json({ok:false,error:"This listing has expired"},410);
  /*old query removed*/

  if (!product || Number(product.published)!==1 || !validHttpUrl(product.affiliate_url)) return json({ok:false,error:"Product link not available"},404);
  const user = await currentUser(request,env);
  await env.DB.prepare("INSERT INTO product_clicks (product_id,user_id) VALUES (?,?)").bind(productId,user?.id||null).run();
  return redirect(product.affiliate_url,302);
}

async function handleShareProduct(request, env, id) {
  const product = await env.DB.prepare("SELECT id, published, expires_at FROM products WHERE id = ? LIMIT 1").bind(id).first();
  if (!product || ((Number(product.published) !== 1 || !product.expires_at || product.expires_at <= new Date().toISOString().replace("T", " ").slice(0,19)) && !(await isAdmin(request, env)))) return json({ ok: false, error: "Product not found" }, 404);
  return json({ ok: true, url: `https://shopperssuggestions.online/?product=${encodeURIComponent(id)}` });
}
async function handleCategories() { return json({ ok: true, categories: CATEGORIES }); }

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => { await ensureSchema(env); await cleanupExpiredProducts(env); await env.DB.prepare("DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP").run(); })());
  },
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS" } });
      await ensureSchema(env);
      const url = new URL(request.url), path = url.pathname;
      if (path === "/api/health") return json({ ok: true, service: "shopper-s-suggestions-web", build: "2026-10-21-megfo-marketplace-v1", database: "connected", googleOAuthConfigured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), emailConfigured: !!(env.RESEND_API_KEY && env.EMAIL_FROM), paymentStatus: env.PAYMENT_PROVIDER && env.PAYMENT_API_KEY ? "provider-configured-but-checkout-not-enabled" : "setup-required" });
      if (path === "/api/categories" && request.method === "GET") return handleCategories();
      if (path === "/api/admin/login" && request.method === "POST") return handleAdminLogin(request, env);
      if (path === "/api/admin/logout" && request.method === "POST") return handleAdminLogout(request, env);
      if (path === "/api/admin/check" && request.method === "GET") return handleAdminCheck(request, env);
      if (path === "/api/admin/access" && request.method === "GET") return handleAdminAccess(request, env);
      if (path === "/api/admin/admins" && ["GET", "POST"].includes(request.method)) return handleAdminList(request, env);
      const adminRemoveMatch = path.match(/^\/api\/admin\/admins\/(.+)$/);
      if (adminRemoveMatch && request.method === "DELETE") return handleAdminRemove(request, env, adminRemoveMatch[1]);
      if (path === "/api/admin/users" && request.method === "GET") return handleAdminUsers(request, env);
      if (path === "/api/admin/promoters" && ["GET","POST"].includes(request.method)) return handleAdminPromoters(request, env);
      if (path === "/api/admin/announcements" && request.method === "POST") return handleAnnouncements(request, env);
      if (path === "/api/announcements" && request.method === "GET") return handleAnnouncements(request, env);
      if (path === "/api/notices" && request.method === "GET") return handleMyNotices(request, env);
      if (path === "/api/users/search" && request.method === "GET") return handleUserSearch(request, env);
      if (path === "/api/my/products" && request.method === "GET") return handleMyProducts(request, env);
      if (path === "/api/my/analytics" && request.method === "GET") return handleMyAnalytics(request, env);
      if (path === "/api/subscription" && ["GET","POST"].includes(request.method)) return handleSubscription(request, env);
      const hideProductMatch = path.match(/^\/api\/products\/(\d+)\/hide$/);
      if (hideProductMatch && ["POST","DELETE"].includes(request.method)) return handleHideProduct(request, env, hideProductMatch[1]);
      if (path === "/api/conversations" && ["GET", "POST"].includes(request.method)) return handleConversations(request, env);
      const closeDealMatch = path.match(/^\/api\/conversations\/(\d+)\/close$/);
      if (closeDealMatch && request.method === "POST") return handleCloseDeal(request, env, closeDealMatch[1]);
      const messageDeleteMatch = path.match(/^\/api\/conversations\/(\d+)\/messages\/(\d+)$/);
      if (messageDeleteMatch && request.method === "DELETE") return handleDeleteMessage(request, env, messageDeleteMatch[1], messageDeleteMatch[2]);
      const messagesMatch = path.match(/^\/api\/conversations\/(\d+)\/messages$/);
      if (messagesMatch && ["GET", "POST"].includes(request.method)) return handleConversationMessages(request, env, messagesMatch[1]);
      if (path === "/api/purchase-feedback" && ["GET", "POST"].includes(request.method)) return handlePurchaseFeedback(request, env);
      if (path === "/api/favorites/products" && request.method === "GET") return handleMyProductFavorites(request, env);
      const productFavoriteMatch = path.match(/^\/api\/products\/(\d+)\/favorite$/);
      if (productFavoriteMatch && ["POST", "DELETE"].includes(request.method)) return handleProductFavorites(request, env, productFavoriteMatch[1]);
      if (path === "/payments" && request.method === "GET") return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payments setup · Shopper’s Suggestions</title><body style="font-family:system-ui;max-width:680px;margin:12vh auto;padding:24px;color:#182230"><h1>Payments setup</h1><p>This route is live for future checkout integration, but payments are not enabled yet. No money can be charged from this page.</p><p>Before enabling payments, configure a payment provider, API secrets, product pricing, signed webhook verification, refund handling and test transactions.</p><p><a href="/">← Back to Shopper’s Suggestions</a></p><p><small>Setup status: <a href="/api/payments">/api/payments</a></small></p></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      if (path === "/api/payments" && request.method === "GET") return handlePaymentSetup(request, env);
      if (path === "/api/payments/checkout" && request.method === "POST") return handlePaymentSetup(request, env);
      const clickMatch = path.match(/^\/go\/product\/(\d+)$/);
      if (clickMatch && request.method === "GET") return handleTrackClick(request, env, clickMatch[1]);
      if (path === "/api/upload-media" && request.method === "POST") return handleUploadMedia(request, env);
      if (path === "/api/delete-media" && request.method === "POST") return handleDeleteMedia(request, env);
      if (path === "/api/products" && request.method === "GET") return handleProducts(request, env);
      if (path === "/api/products" && request.method === "POST") return handleCreateProduct(request, env);
      if (path === "/api/admin/products" && request.method === "GET") return handleAdminProducts(request, env);
      if ((path === "/auth/google" || path === "/auth/google/" ) && request.method === "GET") return handleGoogleStart(request, env);
      if (path === "/auth/google/callback" && request.method === "GET") return handleGoogleCallback(request, env);
      if (path === "/api/me" && request.method === "GET") return handleMe(request, env);
      if (["/api/accounts", "/api/accounts/active"].includes(path) && ["GET", "POST"].includes(request.method)) return handleAccounts(request, env);
      if (path === "/api/logout" && request.method === "POST") return handleLogout(request, env);
      if (path === "/api/profile" && ["GET", "PUT", "PATCH"].includes(request.method)) return handleProfile(request, env);
      if (path === "/api/settings" && ["GET", "PUT", "PATCH"].includes(request.method)) return handleSettings(request, env);
      if (path === "/api/promoters" && request.method === "GET") return handlePromoters(request, env);
      if (path === "/api/promoter-application" && request.method === "POST") return handlePromoterApplication(request, env);
      const favoriteMatch = path.match(/^\/api\/promoters\/(\d+)\/favorite$/);
      if (favoriteMatch && ["POST", "DELETE"].includes(request.method)) return handleFavorite(request, env, favoriteMatch[1]);
      const raiseMatch = path.match(/^\/api\/products\/(\d+)\/raise$/);
      if (raiseMatch && request.method === "POST") return handleRaiseProduct(request, env, raiseMatch[1]);
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
