const CATEGORIES = [
  "Tech",
  "Home",
  "Fashion",
  "Beauty",
  "Gaming",
  "Sports",
  "Travel",
  "Kitchen",
  "Office",
  "Automotive",
  "Electronics",
  "Kids",
  "Pets",
  "Fitness",
  "Books",
  "Accessories",
  "Photography",
  "Creator",
  "Other"
];

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  affiliate_url TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Other',
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

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      ...extraHeaders
    }
  });
}

function text(data, status = 200, extraHeaders = {}) {
  return new Response(data, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}

function redirect(url, status = 302) {
  return new Response(null, {
    status,
    headers: {
      Location: url,
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const parts = cookie.split(";");

  for (const part of parts) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return null;
}

function randomId() {
  return crypto.randomUUID();
}

function clean(value, max = 10000) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, max);
}

function validCategory(category) {
  return CATEGORIES.includes(category);
}

function productPublic(row) {
  if (!row) return null;

  return {
    id: row.id,
    title: row.title || "",
    description: row.description || "",
    affiliate_url: row.affiliate_url || "",
    category: row.category || "Other",

    image1_url: row.image1_url || "",
    image2_url: row.image2_url || "",
    image3_url: row.image3_url || "",
    image4_url: row.image4_url || "",
    image5_url: row.image5_url || "",

    video_url: row.video_url || "",

    published: Number(row.published) === 1,
    featured: Number(row.featured) === 1,

    created_at: row.created_at || "",
    updated_at: row.updated_at || "",

    share_url:
      `https://shopperssuggestions.online/?product=${encodeURIComponent(row.id)}`
  };
}

async function ensureSchema(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      affiliate_url TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'Other',
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
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  try {
    await env.DB.prepare(
      `ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0`
    ).run();
  } catch (_) {
    // Column already exists.
  }
}

async function isAdmin(request, env) {
  const session = getCookie(request, "shopper_admin_session");

  if (!session) return false;

  const result = await env.DB.prepare(
    `SELECT id FROM admin_sessions WHERE id = ? LIMIT 1`
  )
    .bind(session)
    .first();

  return !!result;
}

function adminCookie(id) {
  return [
    `shopper_admin_session=${encodeURIComponent(id)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=604800"
  ].join("; ");
}

function clearAdminCookie() {
  return [
    "shopper_admin_session=",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0"
  ].join("; ");
}

function githubRawUrl(env, path) {
  return `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH || "main"}/${path}`;
}

async function githubGet(env, path) {
  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}` +
    `?ref=${encodeURIComponent(env.GITHUB_BRANCH || "main")}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Shopper-Suggestions"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub GET failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function githubUpload(env, path, bytes, contentType, message) {
  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;

  const base64 = bytesToBase64(bytes);

  const body = {
    message,
    content: base64,
    branch: env.GITHUB_BRANCH || "main"
  };

  let existingSha = null;

  try {
    const existing = await githubGet(env, path);
    existingSha = existing.sha;
  } catch (_) {
    existingSha = null;
  }

  if (existingSha) {
    body.sha = existingSha;
  }

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "Shopper-Suggestions"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub upload failed: ${response.status} ${error}`);
  }

  return {
    path,
    url: githubRawUrl(env, path),
    contentType
  };
}

async function githubDelete(env, path, message) {
  const existing = await githubGet(env, path);

  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "Shopper-Suggestions"
    },
    body: JSON.stringify({
      message,
      sha: existing.sha,
      branch: env.GITHUB_BRANCH || "main"
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub delete failed: ${response.status} ${error}`);
  }

  return true;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function safeExtension(filename, contentType = "") {
  const original = String(filename || "").toLowerCase();

  const match = original.match(/\.([a-z0-9]{1,8})$/);
  if (match) {
    const ext = match[1];

    const allowed = [
      "jpg",
      "jpeg",
      "png",
      "webp",
      "gif",
      "avif",
      "mp4",
      "webm",
      "mov"
    ];

    if (allowed.includes(ext)) return ext;
  }

  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("avif")) return "avif";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("quicktime")) return "mov";
  if (contentType.includes("mp4")) return "mp4";

  if (contentType.startsWith("video/")) return "mp4";

  return "jpg";
}

async function handleAdminLogin(request, env) {
  let body;

  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const password = clean(body.password, 200);

  if (!password || password !== String(env.ADMIN_PASSWORD || "")) {
    return json(
      {
        ok: false,
        error: "Invalid password"
      },
      401
    );
  }

  const sessionId = randomId();

  await env.DB.prepare(
    `INSERT INTO admin_sessions (id) VALUES (?)`
  )
    .bind(sessionId)
    .run();

  return json(
    {
      ok: true
    },
    200,
    {
      "Set-Cookie": adminCookie(sessionId)
    }
  );
}

async function handleAdminLogout(request, env) {
  const session = getCookie(request, "shopper_admin_session");

  if (session) {
    await env.DB.prepare(
      `DELETE FROM admin_sessions WHERE id = ?`
    )
      .bind(session)
      .run();
  }

  return json(
    {
      ok: true
    },
    200,
    {
      "Set-Cookie": clearAdminCookie()
    }
  );
}

async function handleAdminCheck(request, env) {
  const loggedIn = await isAdmin(request, env);

  return json({
    ok: true,
    authenticated: loggedIn
  });
}

async function handleProducts(request, env) {
  const url = new URL(request.url);

  const category = clean(url.searchParams.get("category"), 100);
  const search = clean(url.searchParams.get("search"), 200);
  const featuredOnly =
    url.searchParams.get("featured") === "1" ||
    url.searchParams.get("featured") === "true";

  let limit = Number(url.searchParams.get("limit") || 100);

  if (!Number.isFinite(limit)) limit = 100;

  limit = Math.max(1, Math.min(limit, 200));

  const conditions = ["published = 1"];
  const values = [];

  if (category && category !== "All") {
    conditions.push("category = ?");
    values.push(category);
  }

  if (search) {
    conditions.push(
      `(LOWER(title) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?) OR LOWER(category) LIKE LOWER(?))`
    );

    const q = `%${search}%`;

    values.push(q, q, q);
  }

  if (featuredOnly) {
    conditions.push("featured = 1");
  }

  const sql = `
    SELECT *
    FROM products
    WHERE ${conditions.join(" AND ")}
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `;

  values.push(limit);

  const result = await env.DB.prepare(sql)
    .bind(...values)
    .all();

  return json({
    ok: true,
    products: (result.results || []).map(productPublic)
  });
}

async function handleAdminProducts(request, env) {
  if (!(await isAdmin(request, env))) {
    return json(
      {
        ok: false,
        error: "Unauthorized"
      },
      401
    );
  }

  const result = await env.DB.prepare(`
    SELECT *
    FROM products
    ORDER BY datetime(created_at) DESC, id DESC
  `).all();

  return json({
    ok: true,
    products: (result.results || []).map(productPublic)
  });
}

async function handleProduct(request, env, id) {
  const product = await env.DB.prepare(
    `SELECT * FROM products WHERE id = ? LIMIT 1`
  )
    .bind(id)
    .first();

  if (!product) {
    return json(
      {
        ok: false,
        error: "Product not found"
      },
      404
    );
  }

  if (Number(product.published) !== 1) {
    if (!(await isAdmin(request, env))) {
      return json(
        {
          ok: false,
          error: "Product not found"
        },
        404
      );
    }
  }

  return json({
    ok: true,
    product: productPublic(product)
  });
}

async function handleCreateProduct(request, env) {
  if (!(await isAdmin(request, env))) {
    return json(
      {
        ok: false,
        error: "Unauthorized"
      },
      401
    );
  }

  let body;

  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const title = clean(body.title, 300);
  const description = clean(body.description, 10000);
  const affiliateUrl = clean(body.affiliate_url, 2000);
  const category = clean(body.category, 100);
  const videoUrl = clean(body.video_url, 2000);

  if (!title) {
    return json(
      {
        ok: false,
        error: "Title is required"
      },
      400
    );
  }

  if (!validCategory(category)) {
    return json(
      {
        ok: false,
        error: "Invalid category"
      },
      400
    );
  }

  const images = [];

  for (let i = 1; i <= 5; i++) {
    images.push(clean(body[`image${i}_url`], 3000));
  }

  const featured =
    body.featured === true ||
    body.featured === 1 ||
    body.featured === "1" ||
    body.featured === "true"
      ? 1
      : 0;

  const result = await env.DB.prepare(`
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
      featured
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    RETURNING *
  `)
    .bind(
      title,
      description,
      affiliateUrl,
      category,
      images[0],
      images[1],
      images[2],
      images[3],
      images[4],
      videoUrl,
      featured
    )
    .first();

  return json(
    {
      ok: true,
      product: productPublic(result)
    },
    201
  );
}

async function handleUpdateProduct(request, env, id) {
  if (!(await isAdmin(request, env))) {
    return json(
      {
        ok: false,
        error: "Unauthorized"
      },
      401
    );
  }

  let body;

  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const existing = await env.DB.prepare(
    `SELECT * FROM products WHERE id = ? LIMIT 1`
  )
    .bind(id)
    .first();

  if (!existing) {
    return json(
      {
        ok: false,
        error: "Product not found"
      },
      404
    );
  }

  const title =
    body.title !== undefined
      ? clean(body.title, 300)
      : existing.title;

  const description =
    body.description !== undefined
      ? clean(body.description, 10000)
      : existing.description;

  const affiliateUrl =
    body.affiliate_url !== undefined
      ? clean(body.affiliate_url, 2000)
      : existing.affiliate_url;

  const category =
    body.category !== undefined
      ? clean(body.category, 100)
      : existing.category;

  const videoUrl =
    body.video_url !== undefined
      ? clean(body.video_url, 2000)
      : existing.video_url;

  if (!title) {
    return json(
      {
        ok: false,
        error: "Title is required"
      },
      400
    );
  }

  if (!validCategory(category)) {
    return json(
      {
        ok: false,
        error: "Invalid category"
      },
      400
    );
  }

  const imageValues = [];

  for (let i = 1; i <= 5; i++) {
    imageValues.push(
      body[`image${i}_url`] !== undefined
        ? clean(body[`image${i}_url`], 3000)
        : existing[`image${i}_url`] || ""
    );
  }

  let featured = Number(existing.featured) === 1 ? 1 : 0;

  if (body.featured !== undefined) {
    featured =
      body.featured === true ||
      body.featured === 1 ||
      body.featured === "1" ||
      body.featured === "true"
        ? 1
        : 0;
  }

  let published = Number(existing.published) === 1 ? 1 : 0;

  if (body.published !== undefined) {
    published =
      body.published === true ||
      body.published === 1 ||
      body.published === "1" ||
      body.published === "true"
        ? 1
        : 0;
  }

  const result = await env.DB.prepare(`
    UPDATE products
    SET
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
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    RETURNING *
  `)
    .bind(
      title,
      description,
      affiliateUrl,
      category,
      imageValues[0],
      imageValues[1],
      imageValues[2],
      imageValues[3],
      imageValues[4],
      videoUrl,
      published,
      featured,
      id
    )
    .first();

  return json({
    ok: true,
    product: productPublic(result)
  });
}

async function handleDeleteProduct(request, env, id) {
  if (!(await isAdmin(request, env))) {
    return json(
      {
        ok: false,
        error: "Unauthorized"
      },
      401
    );
  }

  const product = await env.DB.prepare(
    `SELECT * FROM products WHERE id = ? LIMIT 1`
  )
    .bind(id)
    .first();

  if (!product) {
    return json(
      {
        ok: false,
        error: "Product not found"
      },
      404
    );
  }

  const mediaUrls = [
    product.image1_url,
    product.image2_url,
    product.image3_url,
    product.image4_url,
    product.image5_url
  ].filter(Boolean);

  /*
   * Try to remove media files from GitHub when the URL belongs
   * to this repository's media folder.
   */
  for (const mediaUrl of mediaUrls) {
    try {
      const prefix =
        `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH || "main"}/`;

      if (mediaUrl.startsWith(prefix)) {
        const path = decodeURIComponent(
          mediaUrl.slice(prefix.length)
        );

        if (path.startsWith("media/")) {
          await githubDelete(
            env,
            path,
            `Delete media for product ${id}`
          );
        }
      }
    } catch (error) {
      console.error("GitHub media delete failed:", error);
    }
  }

  await env.DB.prepare(
    `DELETE FROM products WHERE id = ?`
  )
    .bind(id)
    .run();

  return json({
    ok: true,
    deleted: Number(id)
  });
}

async function handleUploadMedia(request, env) {
  if (!(await isAdmin(request, env))) {
    return json(
      {
        ok: false,
        error: "Unauthorized"
      },
      401
    );
  }

  const contentType =
    request.headers.get("Content-Type") || "";

  if (!contentType.startsWith("multipart/form-data")) {
    return json(
      {
        ok: false,
        error: "Expected multipart/form-data"
      },
      400
    );
  }

  const form = await request.formData();

  const file =
    form.get("file") ||
    form.get("image") ||
    form.get("media");

  if (!(file instanceof File)) {
    return json(
      {
        ok: false,
        error: "No file received"
      },
      400
    );
  }

  const maxImageSize = 15 * 1024 * 1024;
  const maxVideoSize = 100 * 1024 * 1024;

  const isVideo =
    file.type.startsWith("video/") ||
    /\.(mp4|webm|mov)$/i.test(file.name);

  const maxSize = isVideo ? maxVideoSize : maxImageSize;

  if (file.size <= 0) {
    return json(
      {
        ok: false,
        error: "Empty file"
      },
      400
    );
  }

  if (file.size > maxSize) {
    return json(
      {
        ok: false,
        error: isVideo
          ? "Video is too large. Maximum 100 MB."
          : "Image is too large. Maximum 15 MB."
      },
      413
    );
  }

  const extension = safeExtension(
    file.name,
    file.type
  );

  const filename =
    `${Date.now()}-${crypto.randomUUID()}.${extension}`;

  const path = `media/${filename}`;

  const bytes = new Uint8Array(
    await file.arrayBuffer()
  );

  const uploaded = await githubUpload(
    env,
    path,
    bytes,
    file.type || (isVideo ? "video/mp4" : "image/jpeg"),
    `Upload media ${filename}`
  );

  return json({
    ok: true,
    url: uploaded.url,
    path: uploaded.path,
    type: isVideo ? "video" : "image"
  });
}

async function handleDeleteMedia(request, env) {
  if (!(await isAdmin(request, env))) {
    return json(
      {
        ok: false,
        error: "Unauthorized"
      },
      401
    );
  }

  let body;

  try {
    body = await request.json();
  } catch (_) {
    return json(
      {
        ok: false,
        error: "Invalid JSON"
      },
      400
    );
  }

  const suppliedPath = clean(body.path, 1000);
  const suppliedUrl = clean(body.url, 3000);

  let path = suppliedPath;

  if (!path && suppliedUrl) {
    const prefix =
      `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH || "main"}/`;

    if (suppliedUrl.startsWith(prefix)) {
      path = decodeURIComponent(
        suppliedUrl.slice(prefix.length)
      );
    }
  }

  if (!path || !path.startsWith("media/")) {
    return json(
      {
        ok: false,
        error: "Invalid media path"
      },
      400
    );
  }

  await githubDelete(
    env,
    path,
    `Delete media ${path}`
  );

  return json({
    ok: true,
    deleted: path
  });
}

async function handleCategories() {
  return json({
    ok: true,
    categories: CATEGORIES
  });
}

async function handleShareProduct(request, env, id) {
  const product = await env.DB.prepare(
    `SELECT id, published FROM products WHERE id = ? LIMIT 1`
  )
    .bind(id)
    .first();

  if (!product) {
    return json(
      {
        ok: false,
        error: "Product not found"
      },
      404
    );
  }

  if (
    Number(product.published) !== 1 &&
    !(await isAdmin(request, env))
  ) {
    return json(
      {
        ok: false,
        error: "Product not found"
      },
      404
    );
  }

  return json({
    ok: true,
    url:
      `https://shopperssuggestions.online/?product=${encodeURIComponent(id)}`
  });
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers":
              "Content-Type, Authorization",
            "Access-Control-Allow-Methods":
              "GET, POST, PUT, DELETE, OPTIONS"
          }
        });
      }

      await ensureSchema(env);

      const url = new URL(request.url);
      const path = url.pathname;

      /*
       * Health check
       */
      if (path === "/api/health") {
        return json({
          ok: true,
          service: "shopper-s-suggestions-web",
          telegram: false
        });
      }

      /*
       * Categories
       */
      if (
        path === "/api/categories" &&
        request.method === "GET"
      ) {
        return handleCategories();
      }

      /*
       * Admin authentication
       */
      if (
        path === "/api/admin/login" &&
        request.method === "POST"
      ) {
        return handleAdminLogin(request, env);
      }

      if (
        path === "/api/admin/logout" &&
        request.method === "POST"
      ) {
        return handleAdminLogout(request, env);
      }

      if (
        path === "/api/admin/check" &&
        request.method === "GET"
      ) {
        return handleAdminCheck(request, env);
      }

      /*
       * Media upload/delete
       */
      if (
        path === "/api/upload-media" &&
        request.method === "POST"
      ) {
        return handleUploadMedia(request, env);
      }

      if (
        path === "/api/delete-media" &&
        request.method === "POST"
      ) {
        return handleDeleteMedia(request, env);
      }

      /*
       * Public products
       */
      if (
        path === "/api/products" &&
        request.method === "GET"
      ) {
        return handleProducts(request, env);
      }

      /*
       * Admin products
       */
      if (
        path === "/api/admin/products" &&
        request.method === "GET"
      ) {
        return handleAdminProducts(request, env);
      }

      /*
       * Create product
       */
      if (
        path === "/api/products" &&
        request.method === "POST"
      ) {
        return handleCreateProduct(request, env);
      }

      /*
       * Product by ID
       */
      const productMatch =
        path.match(/^\/api\/product\/(\d+)$/);

      if (
        productMatch &&
        request.method === "GET"
      ) {
        return handleProduct(
          request,
          env,
          productMatch[1]
        );
      }

      /*
       * Product update/delete
       */
      const productsIdMatch =
        path.match(/^\/api\/products\/(\d+)$/);

      if (productsIdMatch) {
        const id = productsIdMatch[1];

        if (request.method === "GET") {
          return handleProduct(
            request,
            env,
            id
          );
        }

        if (
          request.method === "PUT" ||
          request.method === "PATCH"
        ) {
          return handleUpdateProduct(
            request,
            env,
            id
          );
        }

        if (request.method === "DELETE") {
          return handleDeleteProduct(
            request,
            env,
            id
          );
        }
      }

      /*
       * Share-link API.
       *
       * The actual share link is:
       * https://shopperssuggestions.online/?product=ID
       */
      const shareMatch =
        path.match(/^\/api\/share\/(\d+)$/);

      if (
        shareMatch &&
        request.method === "GET"
      ) {
        return handleShareProduct(
          request,
          env,
          shareMatch[1]
        );
      }

      /*
       * If someone directly requests /api/telegram/*
       * don't accidentally make the website Worker
       * pretend that Telegram is active.
       */
      if (path.startsWith("/api/telegram")) {
        return json(
          {
            ok: false,
            error: "Telegram is handled by the separate bot Worker."
          },
          404
        );
      }

      /*
       * Let Cloudflare Assets serve index.html,
       * upload.html, CSS, JS, images, etc.
       */
      return env.ASSETS.fetch(request);

    } catch (error) {
      console.error("SHOPPER'S SUGGESTIONS WORKER ERROR:", error);

      return json(
        {
          ok: false,
          error: "Internal server error"
        },
        500
      );
    }
  }
};
