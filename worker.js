const SITE_URL = "https://shopperssuggestions.online";

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
  description TEXT DEFAULT '',
  affiliate_url TEXT NOT NULL,
  category TEXT DEFAULT 'Other',
  image1_url TEXT DEFAULT '',
  image2_url TEXT DEFAULT '',
  image3_url TEXT DEFAULT '',
  image4_url TEXT DEFAULT '',
  image5_url TEXT DEFAULT '',
  video_url TEXT DEFAULT '',
  published INTEGER NOT NULL DEFAULT 1,
  featured INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`;

const TELEGRAM_SESSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id TEXT PRIMARY KEY,
  admin_unlocked INTEGER NOT NULL DEFAULT 0,
  step TEXT DEFAULT '',
  title TEXT DEFAULT '',
  description TEXT DEFAULT '',
  affiliate_url TEXT DEFAULT '',
  category TEXT DEFAULT '',
  image_urls TEXT DEFAULT '[]',
  video_url TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeBool(value) {
  return value === true ||
    value === 1 ||
    value === "1" ||
    value === "true";
}

function safeString(value) {
  return String(value ?? "").trim();
}

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/* =========================================================
   ADMIN
========================================================= */

function isAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";

  if (
    env.ADMIN_TOKEN &&
    auth === `Bearer ${env.ADMIN_TOKEN}`
  ) {
    return true;
  }

  const supplied =
    request.headers.get("X-Admin-Token") ||
    request.headers.get("x-admin-token") ||
    "";

  if (
    env.ADMIN_TOKEN &&
    supplied === env.ADMIN_TOKEN
  ) {
    return true;
  }

  return false;
}

/* =========================================================
   TELEGRAM
========================================================= */

function telegramConfigured(env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

function telegramApiUrl(env, method) {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function telegramCall(env, method, payload = {}) {
  if (!telegramConfigured(env)) {
    throw new Error("Telegram bot is not configured.");
  }

  const response = await fetch(
    telegramApiUrl(env, method),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    throw new Error(
      data?.description ||
      `Telegram API error (${response.status})`
    );
  }

  return data;
}

async function telegramSendMessage(
  env,
  chatId,
  text,
  extra = {}
) {
  return telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

async function telegramSendPhoto(
  env,
  chatId,
  photo,
  caption = ""
) {
  return telegramCall(env, "sendPhoto", {
    chat_id: chatId,
    photo,
    ...(caption ? { caption } : {})
  });
}

async function telegramSendVideo(
  env,
  chatId,
  video,
  caption = ""
) {
  return telegramCall(env, "sendVideo", {
    chat_id: chatId,
    video,
    ...(caption ? { caption } : {})
  });
}

async function telegramSendMediaGroup(
  env,
  chatId,
  images
) {
  const media = images.map((url) => ({
    type: "photo",
    media: url
  }));

  return telegramCall(env, "sendMediaGroup", {
    chat_id: chatId,
    media
  });
}

function telegramGroupIds(env) {
  return String(env.TELEGRAM_GROUP_IDS || "")
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/* =========================================================
   DATABASE
========================================================= */

async function ensureSchema(env) {
  await env.DB.prepare(BASE_SCHEMA).run();

  try {
    await env.DB.prepare(
      "ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0"
    ).run();
  } catch {}

  await env.DB.prepare(TELEGRAM_SESSIONS_SCHEMA).run();
}

/* =========================================================
   GITHUB
========================================================= */

function githubConfigured(env) {
  return Boolean(
    env.GITHUB_TOKEN &&
    env.GITHUB_OWNER &&
    env.GITHUB_REPO
  );
}

function githubHeaders(env) {
  return {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };
}

async function githubUpload(
  env,
  path,
  base64Content,
  message
) {
  if (!githubConfigured(env)) {
    throw new Error("GitHub is not configured.");
  }

  const branch = env.GITHUB_BRANCH || "main";

  const url =
    `https://api.github.com/repos/` +
    `${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(env),
    body: JSON.stringify({
      message,
      content: base64Content,
      branch
    })
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message ||
      `GitHub upload failed (${response.status})`
    );
  }

  return data;
}

async function githubDelete(
  env,
  path,
  sha,
  message
) {
  const branch = env.GITHUB_BRANCH || "main";

  const url =
    `https://api.github.com/repos/` +
    `${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: githubHeaders(env),
    body: JSON.stringify({
      message,
      sha,
      branch
    })
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message ||
      `GitHub delete failed (${response.status})`
    );
  }

  return data;
}

/* =========================================================
   TELEGRAM FILE DOWNLOAD
========================================================= */

async function getTelegramFile(
  fileId,
  env,
  mediaType = "image"
) {
  const result = await telegramCall(
    env,
    "getFile",
    {
      file_id: fileId
    }
  );

  const filePath = result?.result?.file_path;

  if (!filePath) {
    throw new Error("Telegram did not return a file path.");
  }

  const downloadUrl =
    `https://api.telegram.org/file/bot` +
    `${env.TELEGRAM_BOT_TOKEN}/${filePath}`;

  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(
      `Telegram media download failed (${response.status})`
    );
  }

  const buffer = await response.arrayBuffer();

  let contentType =
    response.headers.get("content-type") ||
    "";

  /*
   * Telegram can sometimes return:
   * application/octet-stream
   *
   * Use the actual Telegram file extension instead.
   */

  if (
    !contentType ||
    contentType === "application/octet-stream"
  ) {
    const lower = filePath.toLowerCase();

    if (
      lower.endsWith(".jpg") ||
      lower.endsWith(".jpeg")
    ) {
      contentType = "image/jpeg";
    } else if (lower.endsWith(".png")) {
      contentType = "image/png";
    } else if (lower.endsWith(".webp")) {
      contentType = "image/webp";
    } else if (lower.endsWith(".gif")) {
      contentType = "image/gif";
    } else if (lower.endsWith(".mp4")) {
      contentType = "video/mp4";
    } else if (mediaType === "video") {
      contentType = "video/mp4";
    } else {
      contentType = "image/jpeg";
    }
  }

  return {
    buffer,
    contentType,
    filePath
  };
}

function extensionFromContentType(
  contentType,
  fallback = "jpg"
) {
  const type = String(contentType || "").toLowerCase();

  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  if (type.includes("mp4")) return "mp4";
  if (type.includes("webm")) return "webm";
  if (type.includes("jpeg")) return "jpg";

  return fallback;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  let binary = "";

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }

  return btoa(binary);
}

async function saveTelegramMedia(
  fileId,
  env,
  type = "image"
) {
  const file = await getTelegramFile(
    fileId,
    env,
    type
  );

  const extension =
    extensionFromContentType(
      file.contentType,
      type === "video" ? "mp4" : "jpg"
    );

  const filename =
    `media/telegram-${Date.now()}-${crypto.randomUUID()}.${extension}`;

  const base64 =
    arrayBufferToBase64(file.buffer);

  await githubUpload(
    env,
    filename,
    base64,
    `Add Telegram ${type}`
  );

  const branch =
    env.GITHUB_BRANCH || "main";

  const rawUrl =
    `https://raw.githubusercontent.com/` +
    `${env.GITHUB_OWNER}/` +
    `${env.GITHUB_REPO}/` +
    `${branch}/${filename}`;

  return rawUrl;
}

/* =========================================================
   TELEGRAM SESSIONS
========================================================= */

async function getTelegramSession(
  chatId,
  env
) {
  return env.DB.prepare(
    "SELECT * FROM telegram_sessions WHERE chat_id=?"
  )
    .bind(String(chatId))
    .first();
}

async function createTelegramSession(
  chatId,
  env
) {
  await env.DB.prepare(`
    INSERT INTO telegram_sessions
      (chat_id, admin_unlocked, step, title, description,
       affiliate_url, category, image_urls, video_url)
    VALUES (?, 0, '', '', '', '', '', '[]', '')
    ON CONFLICT(chat_id) DO NOTHING
  `)
    .bind(String(chatId))
    .run();
}

async function updateTelegramSession(
  chatId,
  env,
  values
) {
  const current =
    await getTelegramSession(chatId, env);

  if (!current) {
    await createTelegramSession(chatId, env);
  }

  const fields = [];
  const bindings = [];

  for (const [key, value] of Object.entries(values)) {
    fields.push(`${key}=?`);
    bindings.push(value);
  }

  fields.push("updated_at=CURRENT_TIMESTAMP");

  await env.DB.prepare(
    `UPDATE telegram_sessions
     SET ${fields.join(", ")}
     WHERE chat_id=?`
  )
    .bind(...bindings, String(chatId))
    .run();
}

async function clearTelegramSession(
  chatId,
  env
) {
  await env.DB.prepare(
    "DELETE FROM telegram_sessions WHERE chat_id=?"
  )
    .bind(String(chatId))
    .run();
}

/* =========================================================
   TELEGRAM KEYBOARD
========================================================= */

function telegramCategoryKeyboard() {
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

/* =========================================================
   CREATE PRODUCT FROM TELEGRAM
========================================================= */

async function createProductFromTelegramSession(
  chatId,
  env
) {
  const session =
    await getTelegramSession(chatId, env);

  if (!session) {
    throw new Error("Telegram session not found.");
  }

  let imageUrls = [];

  try {
    imageUrls =
      JSON.parse(session.image_urls || "[]");
  } catch {
    imageUrls = [];
  }

  imageUrls = imageUrls
    .filter(Boolean)
    .slice(0, 5);

  const images = [
    imageUrls[0] || "",
    imageUrls[1] || "",
    imageUrls[2] || "",
    imageUrls[3] || "",
    imageUrls[4] || ""
  ];

  const result =
    await env.DB.prepare(`
      INSERT INTO products
      (
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
    `)
      .bind(
        session.title,
        session.description,
        session.affiliate_url,
        session.category || "Other",
        ...images,
        session.video_url || ""
      )
      .run();

  const productId =
    result?.meta?.last_row_id;

  if (!productId) {
    throw new Error(
      "Product was created but its ID could not be found."
    );
  }

  return Number(productId);
}

/* =========================================================
   TELEGRAM PRODUCT POSTING
========================================================= */

async function postProductToTelegramGroups(
  product,
  env
) {
  const ids =
    telegramGroupIds(env);

  if (
    !ids.length ||
    !telegramConfigured(env)
  ) {
    return {
      posted: 0,
      errors: []
    };
  }

  const productUrl =
    `${SITE_URL}/?product=${product.id}`;

  const text =
`🛍️ ${product.title}

📂 Category: ${product.category || "Other"}

${product.description || "No description."}

🔗 View product:
${productUrl}

🛒 Make it yours:
${product.affiliate_url}`;

  const images = [
    product.image1_url,
    product.image2_url,
    product.image3_url,
    product.image4_url,
    product.image5_url
  ].filter(Boolean);

  const errors = [];
  let posted = 0;

  for (const chatId of ids) {
    try {
      /*
       * Send full product information as a normal
       * Telegram message so long descriptions aren't
       * limited by photo caption length.
       */
      await telegramSendMessage(
        env,
        chatId,
        text
      );

      /*
       * Images
       */
      if (images.length === 1) {
        await telegramSendPhoto(
          env,
          chatId,
          images[0]
        );
      } else if (images.length > 1) {
        await telegramSendMediaGroup(
          env,
          chatId,
          images
        );
      }

      /*
       * Video
       */
      if (product.video_url) {
        await telegramSendVideo(
          env,
          chatId,
          product.video_url
        );
      }

      posted++;
    } catch (error) {
      errors.push({
        chatId,
        error: error?.message || String(error)
      });
    }
  }

  return {
    posted,
    errors
  };
}

/* =========================================================
   TELEGRAM UPDATE HANDLER
========================================================= */

async function handleTelegramUpdate(
  update,
  env
) {
  /*
   * IMPORTANT:
   *
   * Normal chats/groups:
   * update.message
   *
   * Channels:
   * update.channel_post
   */
  const message =
    update?.message ||
    update?.channel_post;

  if (!message) {
    return;
  }

  const chat =
    message.chat || {};

  const chatId =
    chat.id;

  if (
    chatId === undefined ||
    chatId === null
  ) {
    return;
  }

  const text =
    String(message.text || "")
      .trim();

  /*
   * /getid works for:
   * private chats
   * groups
   * supergroups
   * channels
   *
   * For channels, publish /getid as a channel post.
   */
  if (text === "/getid") {
    const chatTitle =
      chat.title ||
      chat.username ||
      "Private Chat";

    const chatType =
      chat.type ||
      "unknown";

    await telegramSendMessage(
      env,
      chatId,
`📌 Telegram Chat Information

Name: ${chatTitle}
Type: ${chatType}
Chat ID: ${chatId}`
    );

    return;
  }

  /*
   * Channel posts don't have a normal user sender.
   * Product management commands should be done
   * from the private chat with the bot.
   */
  if (
    chat.type === "channel"
  ) {
    return;
  }

  await createTelegramSession(
    chatId,
    env
  );

  const session =
    await getTelegramSession(
      chatId,
      env
    );

  /*
   * /start
   */
  if (text === "/start") {
    await telegramSendMessage(
      env,
      chatId,
`🛍️ Welcome to Shopper's Suggestions.

Use /admin to unlock product management.

Use /getid to see this chat's Telegram ID.`
    );

    return;
  }

  /*
   * /help
   */
  if (text === "/help") {
    await telegramSendMessage(
      env,
      chatId,
`Shopper's Suggestions Bot

/admin - unlock product management
/lock - lock product management
/addproduct - add a product
/cancel - cancel current product
/getid - show Telegram chat ID`
    );

    return;
  }

  /*
   * /lock
   */
  if (text === "/lock") {
    await updateTelegramSession(
      chatId,
      env,
      {
        admin_unlocked: 0,
        step: ""
      }
    );

    await telegramSendMessage(
      env,
      chatId,
      "🔒 Product management locked."
    );

    return;
  }

  /*
   * /admin
   */
  if (text === "/admin") {
    await updateTelegramSession(
      chatId,
      env,
      {
        step: "admin_code"
      }
    );

    await telegramSendMessage(
      env,
      chatId,
      "🔐 Enter the 4-digit admin access code:"
    );

    return;
  }

  /*
   * ADMIN CODE
   */
  if (
    session?.step === "admin_code"
  ) {
    const expected =
      String(
        env.TELEGRAM_ADMIN_CODE || ""
      );

    if (
      expected &&
      text === expected &&
      /^\d{4}$/.test(text)
    ) {
      await updateTelegramSession(
        chatId,
        env,
        {
          admin_unlocked: 1,
          step: ""
        }
      );

      await telegramSendMessage(
        env,
        chatId,
`✅ Access granted.

🔓 Product management unlocked.

Use /addproduct.`
      );
    } else {
      await telegramSendMessage(
        env,
        chatId,
        "❌ Incorrect admin code."
      );
    }

    return;
  }

  /*
   * Require unlock for product management
   */
  if (
    !session?.admin_unlocked
  ) {
    if (text.startsWith("/")) {
      await telegramSendMessage(
        env,
        chatId,
        "🔒 Use /admin to unlock it."
      );
    }

    return;
  }

  /*
   * /cancel
   */
  if (text === "/cancel") {
    await updateTelegramSession(
      chatId,
      env,
      {
        step: "",
        title: "",
        description: "",
        affiliate_url: "",
        category: "",
        image_urls: "[]",
        video_url: ""
      }
    );

    await telegramSendMessage(
      env,
      chatId,
      "❌ Product creation cancelled."
    );

    return;
  }

  /*
   * /addproduct
   */
  if (text === "/addproduct") {
    await updateTelegramSession(
      chatId,
      env,
      {
        step: "title",
        title: "",
        description: "",
        affiliate_url: "",
        category: "",
        image_urls: "[]",
        video_url: ""
      }
    );

    await telegramSendMessage(
      env,
      chatId,
      "🛍️ Enter the product title:"
    );

    return;
  }

  /*
   * PRODUCT TITLE
   */
  if (
    session?.step === "title"
  ) {
    if (!text) {
      await telegramSendMessage(
        env,
        chatId,
        "Please enter a product title."
      );
      return;
    }

    await updateTelegramSession(
      chatId,
      env,
      {
        title: text,
        step: "description"
      }
    );

    await telegramSendMessage(
      env,
      chatId,
      "📝 Enter the product description:"
    );

    return;
  }

  /*
   * DESCRIPTION
   */
  if (
    session?.step === "description"
  ) {
    await updateTelegramSession(
      chatId,
      env,
      {
        description: text,
        step: "affiliate"
      }
    );

    await telegramSendMessage(
      env,
      chatId,
      "🔗 Enter the affiliate URL:"
    );

    return;
  }

  /*
   * AFFILIATE URL
   */
  if (
    session?.step === "affiliate"
  ) {
    if (!isValidUrl(text)) {
      await telegramSendMessage(
        env,
        chatId,
        "❌ Please send a valid http/https affiliate URL."
      );
      return;
    }

    await updateTelegramSession(
      chatId,
      env,
      {
        affiliate_url: text,
        step: "category"
      }
    );

    await telegramSendMessage(
      env,
      chatId,
      "📂 Choose the product category:",
      {
        reply_markup:
          telegramCategoryKeyboard()
      }
    );

    return;
  }

  /*
   * CATEGORY
   *
   * Also accept normal text category names.
   */
  if (
    session?.step === "category"
  ) {
    const category =
      CATEGORIES.find(
        (item) =>
          item.toLowerCase() ===
          text.toLowerCase()
      );

    if (!category) {
      await telegramSendMessage(
        env,
        chatId,
        "Please choose one of the listed categories."
      );
      return;
    }

    await updateTelegramSession(
      chatId,
      env,
      {
        category,
        step: "images"
      }
    );

    await telegramSendMessage(
      env,
      chatId,
`📸 Send up to 5 product images.

Send the images one by one.

When finished, send:
DONE

Or send:
SKIP

You can also send a video after the images.`
    );

    return;
  }

  /*
   * CATEGORY CALLBACK
   */
  if (
    update?.callback_query
  ) {
    return;
  }

  /*
   * IMAGES
   */
  if (
    session?.step === "images"
  ) {
    let imageUrls = [];

    try {
      imageUrls =
        JSON.parse(
          session.image_urls || "[]"
        );
    } catch {
      imageUrls = [];
    }

    if (
      text.toUpperCase() === "SKIP" ||
      text.toUpperCase() === "DONE"
    ) {
      await updateTelegramSession(
        chatId,
        env,
        {
          step: "video",
          image_urls:
            JSON.stringify(imageUrls)
        }
      );

      await telegramSendMessage(
        env,
        chatId,
`🎥 Send a product video now.

Or send SKIP if there is no video.`
      );

      return;
    }

    const photo =
      message.photo?.[
        message.photo.length - 1
      ];

    if (photo?.file_id) {
      if (imageUrls.length >= 5) {
        await telegramSendMessage(
          env,
          chatId,
          "You already added 5 images. Send DONE."
        );
        return;
      }

      try {
        await telegramSendMessage(
          env,
          chatId,
          "⏳ Uploading image..."
        );

        const imageUrl =
          await saveTelegramMedia(
            photo.file_id,
            env,
            "image"
          );

        imageUrls.push(imageUrl);

        await updateTelegramSession(
          chatId,
          env,
          {
            image_urls:
              JSON.stringify(imageUrls)
          }
        );

        await telegramSendMessage(
          env,
          chatId,
`✅ Image ${imageUrls.length}/5 added.

Send another image, DONE, or SKIP.`
        );
      } catch (error) {
        await telegramSendMessage(
          env,
          chatId,
`❌ Image upload failed:

${error?.message || String(error)}`
        );
      }

      return;
    }

    await telegramSendMessage(
      env,
      chatId,
      "Send a product image, DONE, or SKIP."
    );

    return;
  }

  /*
   * VIDEO
   */
  if (
    session?.step === "video"
  ) {
    if (
      text.toUpperCase() === "SKIP"
    ) {
      await updateTelegramSession(
        chatId,
        env,
        {
          video_url: "",
          step: "confirm"
        }
      );

      await sendTelegramProductConfirmation(
        chatId,
        env
      );

      return;
    }

    const video =
      message.video;

    if (video?.file_id) {
      try {
        await telegramSendMessage(
          env,
          chatId,
          "⏳ Uploading video..."
        );

        const videoUrl =
          await saveTelegramMedia(
            video.file_id,
            env,
            "video"
          );

        await updateTelegramSession(
          chatId,
          env,
          {
            video_url: videoUrl,
            step: "confirm"
          }
        );

        await sendTelegramProductConfirmation(
          chatId,
          env
        );
      } catch (error) {
        await telegramSendMessage(
          env,
          chatId,
`❌ Video upload failed:

${error?.message || String(error)}`
        );
      }

      return;
    }

    await telegramSendMessage(
      env,
      chatId,
      "Send a video or SKIP."
    );

    return;
  }

  /*
   * CONFIRM
   */
  if (
    session?.step === "confirm"
  ) {
    const answer =
      text.toLowerCase();

    if (
      answer === "yes" ||
      answer === "confirm" ||
      answer === "publish"
    ) {
      try {
        await telegramSendMessage(
          env,
          chatId,
          "⏳ Publishing product..."
        );

        const productId =
          await createProductFromTelegramSession(
            chatId,
            env
          );

        const product =
          await env.DB.prepare(
            "SELECT * FROM products WHERE id=?"
          )
            .bind(productId)
            .first();

        let telegramResult = {
          posted: 0,
          errors: []
        };

        try {
          telegramResult =
            await postProductToTelegramGroups(
              product,
              env
            );
        } catch (error) {
          telegramResult.errors.push({
            error:
              error?.message ||
              String(error)
          });
        }

        /*
         * Clear session after successful product creation.
         */
        await clearTelegramSession(
          chatId,
          env
        );

        let resultText =
`✅ Product published!

Product ID: ${productId}

🔗 ${SITE_URL}/?product=${productId}`;

        if (
          telegramResult.posted > 0
        ) {
          resultText +=
            `\n\n📢 Telegram: posted to ${telegramResult.posted} chat(s).`;
        } else {
          resultText +=
            `\n\n📢 Telegram: no configured destination.`;
        }

        await telegramSendMessage(
          env,
          chatId,
          resultText
        );
      } catch (error) {
        await telegramSendMessage(
          env,
          chatId,
`❌ Product creation failed:

${error?.message || String(error)}`
        );
      }

      return;
    }

    if (
      answer === "no" ||
      answer === "cancel"
    ) {
      await clearTelegramSession(
        chatId,
        env
      );

      await telegramSendMessage(
        env,
        chatId,
        "❌ Product cancelled."
      );

      return;
    }

    await telegramSendMessage(
      env,
      chatId,
      "Reply YES to publish or NO to cancel."
    );

    return;
  }
}

/* =========================================================
   TELEGRAM CONFIRMATION
========================================================= */

async function sendTelegramProductConfirmation(
  chatId,
  env
) {
  const session =
    await getTelegramSession(
      chatId,
      env
    );

  if (!session) return;

  let images = [];

  try {
    images =
      JSON.parse(
        session.image_urls || "[]"
      );
  } catch {
    images = [];
  }

  let preview =
`🛍️ PRODUCT PREVIEW

Title:
${session.title}

Category:
${session.category}

Description:
${session.description}

Affiliate URL:
${session.affiliate_url}

Images:
${images.length}

Video:
${session.video_url ? "Yes" : "No"}

Publish this product?`;

  await telegramSendMessage(
    env,
    chatId,
    preview
  );

  await telegramSendMessage(
    env,
    chatId,
    "Reply YES to publish or NO to cancel."
  );
}

/* =========================================================
   CALLBACK QUERY
========================================================= */

async function handleTelegramCallback(
  callback,
  env
) {
  const callbackId =
    callback?.id;

  const message =
    callback?.message;

  const chatId =
    message?.chat?.id;

  const data =
    String(
      callback?.data || ""
    );

  if (
    callbackId
  ) {
    try {
      await telegramCall(
        env,
        "answerCallbackQuery",
        {
          callback_query_id:
            callbackId
        }
      );
    } catch {}
  }

  if (
    !chatId ||
    !data.startsWith("category:")
  ) {
    return;
  }

  const category =
    data.substring(
      "category:".length
    );

  if (
    !CATEGORIES.includes(category)
  ) {
    return;
  }

  const session =
    await getTelegramSession(
      chatId,
      env
    );

  if (
    !session?.admin_unlocked
  ) {
    return;
  }

  await updateTelegramSession(
    chatId,
    env,
    {
      category,
      step: "images"
    }
  );

  await telegramSendMessage(
    env,
    chatId,
`✅ Category: ${category}

📸 Send up to 5 product images.

When finished send DONE.
Or send SKIP.`
  );
}

/* =========================================================
   WEBHOOK
========================================================= */

async function handleTelegramWebhook(
  request,
  env
) {
  let update;

  try {
    update =
      await request.json();
  } catch {
    return json({
      ok: false,
      error: "Invalid JSON"
    }, 400);
  }

  try {
    if (
      update?.callback_query
    ) {
      await handleTelegramCallback(
        update.callback_query,
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
      "Telegram webhook error:",
      error
    );
  }

  return json({
    ok: true
  });
}

/* =========================================================
   TELEGRAM WEBHOOK SETUP
========================================================= */

async function setupTelegramWebhook(
  env
) {
  const webhookUrl =
    `${SITE_URL.replace(
      /\/$/,
      ""
    )}/api/telegram/webhook`;

  return telegramCall(
    env,
    "setWebhook",
    {
      url: webhookUrl,
      secret_token:
        env.TELEGRAM_WEBHOOK_SECRET || undefined,
      allowed_updates: [
        "message",
        "channel_post",
        "callback_query"
      ]
    }
  );
}

/* =========================================================
   MAIN WORKER
========================================================= */

export default {
  async fetch(request, env) {
    const url =
      new URL(request.url);

    const path =
      url.pathname;

    /*
     * CORS
     */
    if (
      request.method === "OPTIONS"
    ) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods":
            "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization"
        }
      });
    }

    try {
      await ensureSchema(env);
    } catch (error) {
      console.error(
        "Schema error:",
        error
      );
    }

    /* =====================================================
       TELEGRAM WEBHOOK
    ===================================================== */

    if (
      path ===
      "/api/telegram/webhook"
    ) {
      const secret =
        request.headers.get(
          "X-Telegram-Bot-Api-Secret-Token"
        );

      if (
        env.TELEGRAM_WEBHOOK_SECRET &&
        secret !==
          env.TELEGRAM_WEBHOOK_SECRET
      ) {
        return json({
          ok: false,
          error: "Unauthorized"
        }, 401);
      }

      return handleTelegramWebhook(
        request,
        env
      );
    }

    /* =====================================================
       TELEGRAM SETUP
    ===================================================== */

    if (
      path ===
      "/api/telegram/setup" &&
      request.method === "GET"
    ) {
      const key =
        url.searchParams.get(
          "key"
        ) || "";

      if (
        !env.TELEGRAM_SETUP_SECRET ||
        key !==
          env.TELEGRAM_SETUP_SECRET
      ) {
        return json({
          ok: false,
          error: "Unauthorized"
        }, 401);
      }

      const result =
        await setupTelegramWebhook(
          env
        );

      return json({
        ok: true,
        telegram: result?.ok === true,
        webhook:
          `${SITE_URL}/api/telegram/webhook`
      });
    }

    /* =====================================================
       TEST TELEGRAM GROUPS / CHANNELS
    ===================================================== */

    if (
      path ===
      "/api/telegram/test-groups" &&
      request.method === "GET"
    ) {
      const key =
        url.searchParams.get(
          "key"
        ) || "";

      if (
        !env.TELEGRAM_SETUP_SECRET ||
        key !==
          env.TELEGRAM_SETUP_SECRET
      ) {
        return json({
          ok: false,
          error: "Unauthorized"
        }, 401);
      }

      const ids =
        telegramGroupIds(env);

      const results = [];

      for (
        const chatId of ids
      ) {
        try {
          await telegramSendMessage(
            env,
            chatId,
            "✅ Shopper's Suggestions bot is connected."
          );

          results.push({
            chatId,
            ok: true
          });
        } catch (error) {
          results.push({
            chatId,
            ok: false,
            error:
              error?.message ||
              String(error)
          });
        }
      }

      return json({
        ok: true,
        groups: results
      });
    }

    /* =====================================================
       HEALTH
    ===================================================== */

    if (
      path === "/api/health"
    ) {
      return json({
        ok: true,
        service:
          "Shopper's Suggestions",
        telegram:
          telegramConfigured(env),
        telegram_destinations:
          telegramGroupIds(env).length
      });
    }

    /* =====================================================
       CATEGORIES
    ===================================================== */

    if (
      path === "/api/categories"
    ) {
      return json({
        ok: true,
        categories: CATEGORIES
      });
    }

    /* =====================================================
       ADMIN CHECK
    ===================================================== */

    if (
      path === "/api/admin/check" &&
      request.method === "GET"
    ) {
      return json({
        ok: true,
        admin: isAdmin(
          request,
          env
        )
      });
    }

    /* =====================================================
       UPLOAD MEDIA
    ===================================================== */

    if (
      path === "/api/upload-media" &&
      request.method === "POST"
    ) {
      if (
        !isAdmin(
          request,
          env
        )
      ) {
        return json({
          ok: false,
          error: "Unauthorized"
        }, 401);
      }

      let body;

      try {
        body =
          await request.json();
      } catch {
        return json({
          ok: false,
          error: "Invalid JSON"
        }, 400);
      }

      const fileName =
        safeString(
          body.fileName ||
          body.filename ||
          `upload-${Date.now()}`
        );

      const contentBase64 =
        String(
          body.contentBase64 ||
          body.base64 ||
          ""
        )
          .replace(
            /^data:[^;]+;base64,/,
            ""
          );

      if (!contentBase64) {
        return json({
          ok: false,
          error:
            "Missing base64 content"
        }, 400);
      }

      const extension =
        fileName.includes(".")
          ? fileName
              .split(".")
              .pop()
              .toLowerCase()
          : "jpg";

      const cleanName =
        fileName
          .replace(
            /[^a-zA-Z0-9._-]/g,
            "-"
          )
          .slice(-120);

      const pathName =
        `media/${Date.now()}-${crypto.randomUUID()}-${cleanName}`;

      try {
        await githubUpload(
          env,
          pathName,
          contentBase64,
          `Upload media ${cleanName}`
        );

        const rawUrl =
          `https://raw.githubusercontent.com/` +
          `${env.GITHUB_OWNER}/` +
          `${env.GITHUB_REPO}/` +
          `${env.GITHUB_BRANCH || "main"}/` +
          `${pathName}`;

        return json({
          ok: true,
          url: rawUrl,
          path: pathName
        });
      } catch (error) {
        return json({
          ok: false,
          error:
            error?.message ||
            String(error)
        }, 500);
      }
    }

    /* =====================================================
       PUBLIC PRODUCTS
    ===================================================== */

    if (
      path === "/api/products" &&
      request.method === "GET"
    ) {
      const search =
        safeString(
          url.searchParams.get(
            "search"
          )
        );

      const category =
        safeString(
          url.searchParams.get(
            "category"
          )
        );

      const featured =
        url.searchParams.get(
          "featured"
        );

      let sql =
        "SELECT * FROM products WHERE published=1";

      const binds = [];

      if (category) {
        sql +=
          " AND category=?";

        binds.push(category);
      }

      if (
        normalizeBool(featured)
      ) {
        sql +=
          " AND featured=1";
      }

      if (search) {
        sql += `
          AND (
            title LIKE ?
            OR description LIKE ?
            OR category LIKE ?
          )
        `;

        const q =
          `%${search}%`;

        binds.push(
          q,
          q,
          q
        );
      }

      sql +=
        " ORDER BY created_at DESC";

      const result =
        await env.DB.prepare(
          sql
        )
          .bind(...binds)
          .all();

      return json({
        ok: true,
        products:
          result.results || []
      });
    }

    /* =====================================================
       SINGLE PRODUCT
    ===================================================== */

    const productMatch =
      path.match(
        /^\/api\/products\/(\d+)$/
      );

    if (
      productMatch &&
      request.method === "GET"
    ) {
      const id =
        Number(
          productMatch[1]
        );

      const product =
        await env.DB.prepare(
          "SELECT * FROM products WHERE id=? AND published=1"
        )
          .bind(id)
          .first();

      if (!product) {
        return json({
          ok: false,
          error:
            "Product not found"
        }, 404);
      }

      return json({
        ok: true,
        product
      });
    }

    /* =====================================================
       ADMIN PRODUCTS LIST
    ===================================================== */

    if (
      path ===
        "/api/admin/products" &&
      request.method === "GET"
    ) {
      if (
        !isAdmin(
          request,
          env
        )
      ) {
        return json({
          ok: false,
          error: "Unauthorized"
        }, 401);
      }

      const result =
        await env.DB.prepare(
          "SELECT * FROM products ORDER BY created_at DESC"
        ).all();

      return json({
        ok: true,
        products:
          result.results || []
      });
    }

    /* =====================================================
       CREATE PRODUCT FROM WEBSITE
    ===================================================== */

    if (
      path === "/api/products" &&
      request.method === "POST"
    ) {
      if (
        !isAdmin(
          request,
          env
        )
      ) {
        return json({
          ok: false,
          error: "Unauthorized"
        }, 401);
      }

      let body;

      try {
        body =
          await request.json();
      } catch {
        return json({
          ok: false,
          error: "Invalid JSON"
        }, 400);
      }

      const title =
        safeString(
          body.title
        );

      const description =
        safeString(
          body.description
        );

      const affiliateUrl =
        safeString(
          body.affiliate_url ||
          body.affiliateUrl
        );

      const category =
        CATEGORIES.includes(
          safeString(
            body.category
          )
        )
          ? safeString(
              body.category
            )
          : "Other";

      if (!title) {
        return json({
          ok: false,
          error:
            "Title is required"
        }, 400);
      }

      if (
        !isValidUrl(
          affiliateUrl
        )
      ) {
        return json({
          ok: false,
          error:
            "Valid affiliate URL is required"
        }, 400);
      }

      const images = [
        body.image1_url,
        body.image2_url,
        body.image3_url,
        body.image4_url,
        body.image5_url
      ].map(safeString);

      const videoUrl =
        safeString(
          body.video_url ||
          body.videoUrl
        );

      const published =
        normalizeBool(
          body.published
        )
          ? 1
          : 0;

      const featured =
        normalizeBool(
          body.featured
        )
          ? 1
          : 0;

      const result =
        await env.DB.prepare(`
          INSERT INTO products
          (
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
          .bind(
            title,
            description,
            affiliateUrl,
            category,
            ...images,
            videoUrl,
            published,
            featured
          )
          .run();

      const id =
        result?.meta?.last_row_id;

      const product =
        await env.DB.prepare(
          "SELECT * FROM products WHERE id=?"
        )
          .bind(id)
          .first();

      let telegram = {
        posted: 0,
        errors: []
      };

      if (
        product &&
        published === 1
      ) {
        try {
          telegram =
            await postProductToTelegramGroups(
              product,
              env
            );
        } catch (error) {
          telegram.errors.push({
            error:
              error?.message ||
              String(error)
          });
        }
      }

      return json({
        ok: true,
        id,
        product,
        telegram
      }, 201);
    }

    /* =====================================================
       UPDATE PRODUCT
    ===================================================== */

    if (
      productMatch &&
      (
        request.method === "PUT" ||
        request.method === "PATCH"
      )
    ) {
      if (
        !isAdmin(
          request,
          env
        )
      ) {
        return json({
          ok: false,
          error: "Unauthorized"
        }, 401);
      }

      const id =
        Number(
          productMatch[1]
        );

      let body;

      try {
        body =
          await request.json();
      } catch {
        return json({
          ok: false,
          error: "Invalid JSON"
        }, 400);
      }

      const allowed = [
        "title",
        "description",
        "affiliate_url",
        "category",
        "image1_url",
        "image2_url",
        "image3_url",
        "image4_url",
        "image5_url",
        "video_url",
        "published",
        "featured"
      ];

      const sets = [];
      const binds = [];

      for (
        const key of allowed
      ) {
        if (
          Object.prototype.hasOwnProperty.call(
            body,
            key
          )
        ) {
          sets.push(
            `${key}=?`
          );

          let value =
            body[key];

          if (
            key === "published" ||
            key === "featured"
          ) {
            value =
              normalizeBool(
                value
              )
                ? 1
                : 0;
          }

          binds.push(
            value
          );
        }
      }

      if (!sets.length) {
        return json({
          ok: false,
          error:
            "Nothing to update"
        }, 400);
      }

      sets.push(
        "updated_at=CURRENT_TIMESTAMP"
      );

      await env.DB.prepare(
        `UPDATE products
         SET ${sets.join(", ")}
         WHERE id=?`
      )
        .bind(
          ...binds,
          id
        )
        .run();

      const product =
        await env.DB.prepare(
          "SELECT * FROM products WHERE id=?"
        )
          .bind(id)
          .first();

      return json({
        ok: true,
        product
      });
    }

    /* =====================================================
       DELETE PRODUCT
    ===================================================== */

    if (
      productMatch &&
      request.method === "DELETE"
    ) {
      if (
        !isAdmin(
          request,
          env
        )
      ) {
        return json({
          ok: false,
          error: "Unauthorized"
        }, 401);
      }

      const id =
        Number(
          productMatch[1]
        );

      const product =
        await env.DB.prepare(
          "SELECT * FROM products WHERE id=?"
        )
          .bind(id)
          .first();

      if (!product) {
        return json({
          ok: false,
          error:
            "Product not found"
        }, 404);
      }

      await env.DB.prepare(
        "DELETE FROM products WHERE id=?"
      )
        .bind(id)
        .run();

      return json({
        ok: true,
        deleted: id
      });
    }

    /* =====================================================
       ASSETS
    ===================================================== */

    if (
      env.ASSETS
    ) {
      return env.ASSETS.fetch(
        request
      );
    }

    return textResponse(
      "Not found",
      404
    );

  } catch (error) {
    console.error(
      "Worker error:",
      error
    );

    return json({
      ok: false,
      error:
        error?.message ||
        String(error)
    }, 500);
  }
};
