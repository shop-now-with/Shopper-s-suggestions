const CATEGORIES = [
  "Tech", "Home", "Fashion", "Beauty", "Gaming", "Sports", "Travel",
  "Kitchen", "Office", "Automotive", "Electronics", "Kids", "Pets",
  "Fitness", "Books", "Accessories", "Photography", "Creator", "Other"
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");

  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin"
  };
}

function response(data, status = 200, request) {
  const headers = corsHeaders(request);
  headers["Content-Type"] = "application/json; charset=utf-8";
  headers["Cache-Control"] = "no-store";

  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

async function getBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function clean(value, max = 5000) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function validUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function normalizeCategory(category) {
  const value = clean(category, 100);
  return CATEGORIES.includes(value) ? value : "Other";
}

async function ensureDatabase(db) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        affiliate_url TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Other',
        image1_url TEXT NOT NULL DEFAULT '',
        image2_url TEXT NOT NULL DEFAULT '',
        image3_url TEXT NOT NULL DEFAULT '',
        image4_url TEXT NOT NULL DEFAULT '',
        image5_url TEXT NOT NULL DEFAULT '',
        published INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_products_category
      ON products(category)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_products_published
      ON products(published)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_products_created_at
      ON products(created_at DESC)
    `)
  ]);
}

async function requireAdmin(request, env) {
  const configuredPassword = env.ADMIN_PASSWORD;

  if (!configuredPassword) {
    return {
      ok: false,
      error: "ADMIN_PASSWORD is not configured."
    };
  }

  const authorization = request.headers.get("Authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    return {
      ok: false,
      error: "Admin authorization required."
    };
  }

  const suppliedPassword = authorization.slice(7);

  if (suppliedPassword !== configuredPassword) {
    return {
      ok: false,
      error: "Invalid admin password."
    };
  }

  return { ok: true };
}

function productFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    affiliate_url: row.affiliate_url,
    category: row.category,
    images: [
      row.image1_url,
      row.image2_url,
      row.image3_url,
      row.image4_url,
      row.image5_url
    ].filter(Boolean),
    image_url: row.image1_url || "",
    published: Boolean(row.published),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function getProducts(request, env) {
  const url = new URL(request.url);
  const category = clean(url.searchParams.get("category") || "", 100);
  const search = clean(url.searchParams.get("search") || "", 200);

  let query = `
    SELECT
      id,
      title,
      description,
      affiliate_url,
      category,
      image1_url,
      image2_url,
      image3_url,
      image4_url,
      image5_url,
      published,
      created_at,
      updated_at
    FROM products
    WHERE published = 1
  `;

  const params = [];

  if (category && category !== "All") {
    query += ` AND category = ?`;
    params.push(category);
  }

  if (search) {
    query += `
      AND (
        title LIKE ?
        OR description LIKE ?
        OR category LIKE ?
      )
    `;

    const term = `%${search}%`;
    params.push(term, term, term);
  }

  query += ` ORDER BY created_at DESC, id DESC`;

  const result = await env.DB.prepare(query).bind(...params).all();

  return response({
    success: true,
    products: result.results.map(productFromRow)
  }, 200, request);
}

async function getSingleProduct(request, env, id) {
  const product = await env.DB.prepare(`
    SELECT
      id,
      title,
      description,
      affiliate_url,
      category,
      image1_url,
      image2_url,
      image3_url,
      image4_url,
      image5_url,
      published,
      created_at,
      updated_at
    FROM products
    WHERE id = ?
      AND published = 1
    LIMIT 1
  `).bind(id).first();

  if (!product) {
    return response({
      success: false,
      error: "Product not found."
    }, 404, request);
  }

  return response({
    success: true,
    product: productFromRow(product)
  }, 200, request);
}

async function createProduct(request, env) {
  const admin = await requireAdmin(request, env);

  if (!admin.ok) {
    return response({
      success: false,
      error: admin.error
    }, 401, request);
  }

  const body = await getBody(request);

  if (!body) {
    return response({
      success: false,
      error: "Invalid JSON body."
    }, 400, request);
  }

  const title = clean(body.title, 200);
  const description = clean(body.description, 5000);
  const affiliateUrl = validUrl(body.affiliate_url || body.affiliateLink);
  const category = normalizeCategory(body.category);

  const images = Array.isArray(body.images)
    ? body.images
    : [
        body.image1_url,
        body.image2_url,
        body.image3_url,
        body.image4_url,
        body.image5_url
      ];

  const imageUrls = images
    .slice(0, 5)
    .map(validUrl);

  while (imageUrls.length < 5) {
    imageUrls.push("");
  }

  if (!title) {
    return response({
      success: false,
      error: "Product title is required."
    }, 400, request);
  }

  if (!affiliateUrl) {
    return response({
      success: false,
      error: "A valid affiliate URL is required."
    }, 400, request);
  }

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
      published
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(
    title,
    description,
    affiliateUrl,
    category,
    imageUrls[0],
    imageUrls[1],
    imageUrls[2],
    imageUrls[3],
    imageUrls[4]
  ).run();

  const id = result.meta.last_row_id;

  const product = await env.DB.prepare(`
    SELECT
      id,
      title,
      description,
      affiliate_url,
      category,
      image1_url,
      image2_url,
      image3_url,
      image4_url,
      image5_url,
      published,
      created_at,
      updated_at
    FROM products
    WHERE id = ?
  `).bind(id).first();

  return response({
    success: true,
    message: "Product created successfully.",
    product: productFromRow(product)
  }, 201, request);
}

async function updateProduct(request, env, id) {
  const admin = await requireAdmin(request, env);

  if (!admin.ok) {
    return response({
      success: false,
      error: admin.error
    }, 401, request);
  }

  const body = await getBody(request);

  if (!body) {
    return response({
      success: false,
      error: "Invalid JSON body."
    }, 400, request);
  }

  const existing = await env.DB.prepare(`
    SELECT *
    FROM products
    WHERE id = ?
    LIMIT 1
  `).bind(id).first();

  if (!existing) {
    return response({
      success: false,
      error: "Product not found."
    }, 404, request);
  }

  const title = clean(
    body.title !== undefined ? body.title : existing.title,
    200
  );

  const description = clean(
    body.description !== undefined ? body.description : existing.description,
    5000
  );

  const affiliateUrl = validUrl(
    body.affiliate_url !== undefined
      ? body.affiliate_url
      : existing.affiliate_url
  );

  const category = body.category !== undefined
    ? normalizeCategory(body.category)
    : existing.category;

  const images = Array.isArray(body.images)
    ? body.images
    : [
        body.image1_url !== undefined ? body.image1_url : existing.image1_url,
        body.image2_url !== undefined ? body.image2_url : existing.image2_url,
        body.image3_url !== undefined ? body.image3_url : existing.image3_url,
        body.image4_url !== undefined ? body.image4_url : existing.image4_url,
        body.image5_url !== undefined ? body.image5_url : existing.image5_url
      ];

  const imageUrls = images
    .slice(0, 5)
    .map(validUrl);

  while (imageUrls.length < 5) {
    imageUrls.push("");
  }

  const published = body.published === undefined
    ? existing.published
    : body.published ? 1 : 0;

  if (!title) {
    return response({
      success: false,
      error: "Product title is required."
    }, 400, request);
  }

  if (!affiliateUrl) {
    return response({
      success: false,
      error: "A valid affiliate URL is required."
    }, 400, request);
  }

  await env.DB.prepare(`
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
      published = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    title,
    description,
    affiliateUrl,
    category,
    imageUrls[0],
    imageUrls[1],
    imageUrls[2],
    imageUrls[3],
    imageUrls[4],
    published,
    id
  ).run();

  const product = await env.DB.prepare(`
    SELECT
      id,
      title,
      description,
      affiliate_url,
      category,
      image1_url,
      image2_url,
      image3_url,
      image4_url,
      image5_url,
      published,
      created_at,
      updated_at
    FROM products
    WHERE id = ?
  `).bind(id).first();

  return response({
    success: true,
    message: "Product updated successfully.",
    product: productFromRow(product)
  }, 200, request);
}

async function deleteProduct(request, env, id) {
  const admin = await requireAdmin(request, env);

  if (!admin.ok) {
    return response({
      success: false,
      error: admin.error
    }, 401, request);
  }

  const result = await env.DB.prepare(`
    DELETE FROM products
    WHERE id = ?
  `).bind(id).run();

  if (!result.meta.changes) {
    return response({
      success: false,
      error: "Product not found."
    }, 404, request);
  }

  return response({
    success: true,
    message: "Product deleted successfully."
  }, 200, request);
}

async function getCategories(request) {
  return response({
    success: true,
    categories: ["All", ...CATEGORIES]
  }, 200, request);
}

async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request)
    });
  }

  const url = new URL(request.url);
  const pathname = url.pathname;

  try {
    await ensureDatabase(env.DB);

    if (pathname === "/api/health" && request.method === "GET") {
      return response({
        success: true,
        status: "connected",
        service: "shopper-s-suggestions"
      }, 200, request);
    }

    if (pathname === "/api/categories" && request.method === "GET") {
      return await getCategories(request);
    }

    if (pathname === "/api/products" && request.method === "GET") {
      return await getProducts(request, env);
    }

    if (pathname === "/api/products" && request.method === "POST") {
      return await createProduct(request, env);
    }

    const productMatch = pathname.match(/^\/api\/products\/(\d+)$/);

    if (productMatch) {
      const id = Number(productMatch[1]);

      if (request.method === "GET") {
        return await getSingleProduct(request, env, id);
      }

      if (request.method === "PUT" || request.method === "PATCH") {
        return await updateProduct(request, env, id);
      }

      if (request.method === "DELETE") {
        return await deleteProduct(request, env, id);
      }
    }

    if (pathname.startsWith("/api/")) {
      return response({
        success: false,
        error: "API endpoint not found."
      }, 404, request);
    }

    return env.ASSETS
      ? env.ASSETS.fetch(request)
      : new Response("Shopper's Suggestions", {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8"
          }
        });

  } catch (error) {
    return response({
      success: false,
      error: "Server error.",
      details: error?.message || String(error)
    }, 500, request);
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};
