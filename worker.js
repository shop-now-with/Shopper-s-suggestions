// SHOPPER'S SUGGESTIONS - Cloudflare Worker
// GitHub media upload + D1 product API

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
  affiliate_url TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  image1_url TEXT NOT NULL DEFAULT '',
  image2_url TEXT NOT NULL DEFAULT '',
  image3_url TEXT NOT NULL DEFAULT '',
  image4_url TEXT NOT NULL DEFAULT '',
  image5_url TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      ...extraHeaders
    }
  });
}

function isAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.ADMIN_PASSWORD}`;
}

async function ensureSchema(env) {
  await env.DB.prepare(BASE_SCHEMA).run();

  const columns = await env.DB.prepare(
    "PRAGMA table_info(products)"
  ).all();

  const hasVideo = (columns.results || []).some(
    column => column.name === "video_url"
  );

  if (!hasVideo) {
    await env.DB.prepare(
      "ALTER TABLE products ADD COLUMN video_url TEXT NOT NULL DEFAULT ''"
    ).run();
  }
}

function cleanCategory(category) {
  return CATEGORIES.includes(category) ? category : "Other";
}

function safeFileName(name) {
  const original = String(name || "media");

  const extMatch = original.match(/(\.[a-zA-Z0-9]{1,10})$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : "";

  const base = original
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "media";

  return `${Date.now()}-${crypto.randomUUID()}-${base}${ext}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function uploadToGitHub(file, env) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is not configured.");
  }

  if (!env.GITHUB_OWNER || !env.GITHUB_REPO || !env.GITHUB_BRANCH) {
    throw new Error("GitHub repository settings are not configured.");
  }

  const fileName = safeFileName(file.name);
  const path = `media/${fileName}`;

  const content = arrayBufferToBase64(
    await file.arrayBuffer()
  );

  const apiUrl =
    `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}` +
    `/${encodeURIComponent(env.GITHUB_REPO)}/contents/${path}`;

  const response = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "shopper-s-suggestions-worker"
    },
    body: JSON.stringify({
      message: `Upload product media: ${fileName}`,
      content,
      branch: env.GITHUB_BRANCH
    })
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result?.message ||
      `GitHub upload failed with status ${response.status}.`
    );
  }

  const rawUrl =
    `https://raw.githubusercontent.com/${env.GITHUB_OWNER}` +
    `/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/${path}`;

  return {
    url: rawUrl,
    path,
    sha: result?.content?.sha || ""
  };
}

async function deleteFromGitHub(path, env) {
  if (!path || !env.GITHUB_TOKEN) return;

  const apiUrl =
    `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}` +
    `/${encodeURIComponent(env.GITHUB_REPO)}/contents/${path}`;

  const getResponse = await fetch(apiUrl, {
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "shopper-s-suggestions-worker"
    }
  });

  if (!getResponse.ok) return;

  const fileInfo = await getResponse.json();

  if (!fileInfo.sha) return;

  await fetch(apiUrl, {
    method: "DELETE",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "shopper-s-suggestions-worker"
    },
    body: JSON.stringify({
      message: `Delete product media: ${path}`,
      sha: fileInfo.sha,
      branch: env.GITHUB_BRANCH
    })
  });
}

function githubPathFromRawUrl(url, env) {
  const prefix =
    `https://raw.githubusercontent.com/${env.GITHUB_OWNER}` +
    `/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/`;

  if (!String(url || "").startsWith(prefix)) {
    return "";
  }

  return decodeURIComponent(
    String(url).slice(prefix.length)
  );
}

export default {
  async fetch(request, env) {

    try {

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Allow-Methods":
              "GET, POST, PUT, PATCH, DELETE, OPTIONS"
          }
        });
      }

      const url = new URL(request.url);
      const path = url.pathname;

      if (path.startsWith("/api/")) {
        await ensureSchema(env);
      }

      // HEALTH
      if (
        path === "/api/health" &&
        request.method === "GET"
      ) {
        return json({
          ok: true,
          service: "shopper-s-suggestions"
        });
      }

      // CATEGORIES
      if (
        path === "/api/categories" &&
        request.method === "GET"
      ) {
        return json({
          categories: CATEGORIES
        });
      }

      // ADMIN CHECK
      if (
        path === "/api/admin/check" &&
        request.method === "GET"
      ) {
        if (!isAdmin(request, env)) {
          return json({
            ok: false,
            error: "Unauthorized"
          }, 401);
        }

        return json({
          ok: true
        });
      }

      // UPLOAD IMAGE / VIDEO
      if (
        path === "/api/upload-media" &&
        request.method === "POST"
      ) {

        if (!isAdmin(request, env)) {
          return json({
            error: "Unauthorized"
          }, 401);
        }

        const contentType =
          request.headers.get("Content-Type") || "";

        if (
          !contentType
            .toLowerCase()
            .includes("multipart/form-data")
        ) {
          return json({
            error: "Use multipart/form-data."
          }, 400);
        }

        const form = await request.formData();
        const file = form.get("file");

        if (!(file instanceof File)) {
          return json({
            error: "No file was received."
          }, 400);
        }

        const allowed = [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif",
          "image/avif",
          "video/mp4",
          "video/webm",
          "video/quicktime"
        ];

        if (!allowed.includes(file.type)) {
          return json({
            error:
              "Unsupported file type. Use JPG, PNG, WEBP, GIF, AVIF, MP4, WEBM, or MOV."
          }, 400);
        }

        const maxBytes = 25 * 1024 * 1024;

        if (file.size > maxBytes) {
          return json({
            error:
              "This file is larger than 25 MB. Please use a smaller image or video."
          }, 413);
        }

        const uploaded =
          await uploadToGitHub(file, env);

        return json({
          ok: true,
          url: uploaded.url,
          path: uploaded.path,
          type: file.type,
          size: file.size
        });
      }

      // PUBLIC PRODUCTS
      if (
        path === "/api/products" &&
        request.method === "GET"
      ) {

        const search =
          (url.searchParams.get("search") || "").trim();

        const category =
          (url.searchParams.get("category") || "").trim();

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
            video_url,
            published,
            created_at,
            updated_at
          FROM products
          WHERE published = 1
        `;

        const params = [];

        if (
          category &&
          CATEGORIES.includes(category)
        ) {
          query += " AND category = ?";
          params.push(category);
        }

        if (search) {
          query +=
            " AND (title LIKE ? OR description LIKE ?)";

          const term = `%${search}%`;

          params.push(term, term);
        }

        query += " ORDER BY id DESC";

        const result =
          await env.DB
            .prepare(query)
            .bind(...params)
            .all();

        return json({
          products: result.results || []
        });
      }

      // SINGLE PRODUCT
      const singleMatch =
        path.match(/^\/api\/products\/(\d+)$/);

      if (
        singleMatch &&
        request.method === "GET"
      ) {

        const id =
          Number(singleMatch[1]);

        const result =
          await env.DB
            .prepare(`
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
                video_url,
                published,
                created_at,
                updated_at
              FROM products
              WHERE id = ?
            `)
            .bind(id)
            .first();

        if (!result) {
          return json({
            error: "Product not found."
          }, 404);
        }

        return json({
          product: result
        });
      }

      // ADMIN PRODUCT LIST
      if (
        path === "/api/admin/products" &&
        request.method === "GET"
      ) {

        if (!isAdmin(request, env)) {
          return json({
            error: "Unauthorized"
          }, 401);
        }

        const result =
          await env.DB
            .prepare(`
              SELECT *
              FROM products
              ORDER BY id DESC
            `)
            .all();

        return json({
          products: result.results || []
        });
      }

      // CREATE PRODUCT
      if (
        path === "/api/products" &&
        request.method === "POST"
      ) {

        if (!isAdmin(request, env)) {
          return json({
            error: "Unauthorized"
          }, 401);
        }

        const body =
          await request.json();

        const title =
          String(body.title || "").trim();

        const description =
          String(body.description || "").trim();

        const affiliateUrl =
          String(
            body.affiliate_url || ""
          ).trim();

        const category =
          cleanCategory(body.category);

        if (!title) {
          return json({
            error:
              "Product title is required."
          }, 400);
        }

        if (!affiliateUrl) {
          return json({
            error:
              "Affiliate URL is required."
          }, 400);
        }

        try {
          new URL(affiliateUrl);
        } catch {
          return json({
            error:
              "Affiliate URL is invalid."
          }, 400);
        }

        const images =
          Array.isArray(body.images)
            ? body.images
                .slice(0, 5)
                .map(v =>
                  String(v || "").trim()
                )
            : [
                body.image1_url,
                body.image2_url,
                body.image3_url,
                body.image4_url,
                body.image5_url
              ].map(v =>
                String(v || "").trim()
              );

        while (images.length < 5) {
          images.push("");
        }

        const videoUrl =
          String(
            body.video_url || ""
          ).trim();

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
                published
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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
              videoUrl
            )
            .run();

        return json({
          ok: true,
          id: result.meta?.last_row_id
        }, 201);
      }

      // UPDATE PRODUCT
      if (
        singleMatch &&
        ["PUT", "PATCH"].includes(
          request.method
        )
      ) {

        if (!isAdmin(request, env)) {
          return json({
            error: "Unauthorized"
          }, 401);
        }

        const id =
          Number(singleMatch[1]);

        const existing =
          await env.DB
            .prepare(
              "SELECT * FROM products WHERE id = ?"
            )
            .bind(id)
            .first();

        if (!existing) {
          return json({
            error: "Product not found."
          }, 404);
        }

        const body =
          await request.json();

        const title =
          String(
            body.title ?? existing.title
          ).trim();

        const description =
          String(
            body.description ??
            existing.description
          ).trim();

        const affiliateUrl =
          String(
            body.affiliate_url ??
            existing.affiliate_url
          ).trim();

        const category =
          cleanCategory(
            body.category ??
            existing.category
          );

        const images =
          Array.isArray(body.images)
            ? body.images
                .slice(0, 5)
                .map(v =>
                  String(v || "").trim()
                )
            : [
                body.image1_url ??
                  existing.image1_url,
                body.image2_url ??
                  existing.image2_url,
                body.image3_url ??
                  existing.image3_url,
                body.image4_url ??
                  existing.image4_url,
                body.image5_url ??
                  existing.image5_url
              ].map(v =>
                String(v || "").trim()
              );

        while (images.length < 5) {
          images.push("");
        }

        const videoUrl =
          String(
            body.video_url ??
            existing.video_url ??
            ""
          ).trim();

        await env.DB
          .prepare(`
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
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
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
            id
          )
          .run();

        return json({
          ok: true
        });
      }

      // DELETE PRODUCT
      if (
        singleMatch &&
        request.method === "DELETE"
      ) {

        if (!isAdmin(request, env)) {
          return json({
            error: "Unauthorized"
          }, 401);
        }

        const id =
          Number(singleMatch[1]);

        const existing =
          await env.DB
            .prepare(
              "SELECT * FROM products WHERE id = ?"
            )
            .bind(id)
            .first();

        if (!existing) {
          return json({
            error: "Product not found."
          }, 404);
        }

        const mediaUrls = [
          existing.image1_url,
          existing.image2_url,
          existing.image3_url,
          existing.image4_url,
          existing.image5_url,
          existing.video_url
        ].filter(Boolean);

        await env.DB
          .prepare(
            "DELETE FROM products WHERE id = ?"
          )
          .bind(id)
          .run();

        for (const mediaUrl of mediaUrls) {

          const mediaPath =
            githubPathFromRawUrl(
              mediaUrl,
              env
            );

          if (mediaPath) {
            try {
              await deleteFromGitHub(
                mediaPath,
                env
              );
            } catch {}
          }
        }

        return json({
          ok: true
        });
      }

      // WEBSITE FILES
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response(
        "Not found",
        { status: 404 }
      );

    } catch (error) {

      console.error(error);

      return json({
        error:
          error?.message ||
          "Server error."
      }, 500);
    }
  }
};
