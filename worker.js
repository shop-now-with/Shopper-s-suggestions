// SHOPPER'S SUGGESTIONS - Cloudflare Worker
// GitHub media upload + D1 product API + Telegram Bot
// Telegram admin code protection

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
  featured INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const TELEGRAM_SESSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id TEXT PRIMARY KEY,
  step TEXT NOT NULL DEFAULT 'idle',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  affiliate_url TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Other',
  image1_url TEXT NOT NULL DEFAULT '',
  image2_url TEXT NOT NULL DEFAULT '',
  image3_url TEXT NOT NULL DEFAULT '',
  image4_url TEXT NOT NULL DEFAULT '',
  image5_url TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  admin_unlocked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token",
      "Access-Control-Allow-Methods":
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      ...extraHeaders
    }
  });
}

function isAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.ADMIN_PASSWORD}`;
}

function telegramConfigured(env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

function telegramApiUrl(env, method) {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function telegramCall(env, method, payload = {}) {
  if (!telegramConfigured(env)) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
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

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    throw new Error(
      result?.description ||
      `Telegram API error (${response.status}).`
    );
  }

  return result;
}

async function telegramSendMessage(env, chatId, text, extra = {}) {
  return telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

async function telegramSendPhoto(env, chatId, photo, caption = "") {
  return telegramCall(env, "sendPhoto", {
    chat_id: chatId,
    photo,
    caption
  });
}

async function telegramSendVideo(env, chatId, video, caption = "") {
  return telegramCall(env, "sendVideo", {
    chat_id: chatId,
    video,
    caption
  });
}

async function ensureSchema(env) {
  await env.DB.prepare(BASE_SCHEMA).run();
  await env.DB.prepare(TELEGRAM_SESSIONS_SCHEMA).run();

  const productColumns = await env.DB.prepare(
    "PRAGMA table_info(products)"
  ).all();

  const hasVideo = (productColumns.results || []).some(
    column => column.name === "video_url"
  );

  if (!hasVideo) {
    await env.DB.prepare(
      "ALTER TABLE products ADD COLUMN video_url TEXT NOT NULL DEFAULT ''"
    ).run();
  }

  const hasFeatured = (productColumns.results || []).some(
    column => column.name === "featured"
  );

  if (!hasFeatured) {
    await env.DB.prepare(
      "ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0"
    ).run();
  }

  const telegramColumns = await env.DB.prepare(
    "PRAGMA table_info(telegram_sessions)"
  ).all();

  const hasAdminUnlocked = (telegramColumns.results || []).some(
    column => column.name === "admin_unlocked"
  );

  if (!hasAdminUnlocked) {
    await env.DB.prepare(
      "ALTER TABLE telegram_sessions ADD COLUMN admin_unlocked INTEGER NOT NULL DEFAULT 0"
    ).run();
  }
}

function cleanCategory(category) {
  return CATEGORIES.includes(category)
    ? category
    : "Other";
}

function safeFileName(name) {
  const original = String(name || "media");

  const extMatch =
    original.match(/(\.[a-zA-Z0-9]{1,10})$/);

  const ext =
    extMatch
      ? extMatch[1].toLowerCase()
      : "";

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

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    const chunk =
      bytes.subarray(i, i + chunkSize);

    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function uploadToGitHub(file, env) {
  if (!env.GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_TOKEN is not configured."
    );
  }

  if (
    !env.GITHUB_OWNER ||
    !env.GITHUB_REPO ||
    !env.GITHUB_BRANCH
  ) {
    throw new Error(
      "GitHub repository settings are not configured."
    );
  }

  const fileName =
    safeFileName(file.name);

  const path =
    `media/${fileName}`;

  const content =
    arrayBufferToBase64(
      await file.arrayBuffer()
    );

  const apiUrl =
    `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}` +
    `/${encodeURIComponent(env.GITHUB_REPO)}/contents/${path}`;

  const response =
    await fetch(apiUrl, {
      method: "PUT",
      headers: {
        "Authorization":
          `Bearer ${env.GITHUB_TOKEN}`,
        "Accept":
          "application/vnd.github+json",
        "Content-Type":
          "application/json",
        "X-GitHub-Api-Version":
          "2022-11-28",
        "User-Agent":
          "shopper-s-suggestions-worker"
      },
      body: JSON.stringify({
        message:
          `Upload product media: ${fileName}`,
        content,
        branch:
          env.GITHUB_BRANCH
      })
    });

  const result =
    await response.json().catch(
      () => ({})
    );

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
    sha:
      result?.content?.sha || ""
  };
}

async function deleteFromGitHub(path, env) {
  if (
    !path ||
    !env.GITHUB_TOKEN
  ) {
    return;
  }

  const apiUrl =
    `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}` +
    `/${encodeURIComponent(env.GITHUB_REPO)}/contents/${path}`;

  const getResponse =
    await fetch(apiUrl, {
      headers: {
        "Authorization":
          `Bearer ${env.GITHUB_TOKEN}`,
        "Accept":
          "application/vnd.github+json",
        "X-GitHub-Api-Version":
          "2022-11-28",
        "User-Agent":
          "shopper-s-suggestions-worker"
      }
    });

  if (!getResponse.ok) {
    return;
  }

  const fileInfo =
    await getResponse.json();

  if (!fileInfo.sha) {
    return;
  }

  await fetch(apiUrl, {
    method: "DELETE",
    headers: {
      "Authorization":
        `Bearer ${env.GITHUB_TOKEN}`,
      "Accept":
        "application/vnd.github+json",
      "Content-Type":
        "application/json",
      "X-GitHub-Api-Version":
        "2022-11-28",
      "User-Agent":
        "shopper-s-suggestions-worker"
    },
    body: JSON.stringify({
      message:
        `Delete product media: ${path}`,
      sha:
        fileInfo.sha,
      branch:
        env.GITHUB_BRANCH
    })
  });
}

function githubPathFromRawUrl(url, env) {
  const prefix =
    `https://raw.githubusercontent.com/${env.GITHUB_OWNER}` +
    `/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/`;

  if (
    !String(url || "")
      .startsWith(prefix)
  ) {
    return "";
  }

  return decodeURIComponent(
    String(url).slice(
      prefix.length
    )
  );
}

/*
 * TELEGRAM FILE DOWNLOAD
 *
 * Telegram can sometimes return
 * application/octet-stream.
 *
 * We determine the actual type from
 * the Telegram file path.
 */

async function getTelegramFile(
  fileId,
  env,
  type = "image"
) {
  const result =
    await telegramCall(
      env,
      "getFile",
      {
        file_id: fileId
      }
    );

  const filePath =
    result?.result?.file_path;

  if (!filePath) {
    throw new Error(
      "Telegram file path was not returned."
    );
  }

  const fileUrl =
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;

  const response =
    await fetch(fileUrl);

  if (!response.ok) {
    throw new Error(
      `Telegram media download failed with status ${response.status}.`
    );
  }

  const lowerPath =
    filePath.toLowerCase();

  let extension = "";
  let contentType = "";

  if (
    lowerPath.endsWith(".jpg") ||
    lowerPath.endsWith(".jpeg")
  ) {
    extension = ".jpg";
    contentType = "image/jpeg";

  } else if (
    lowerPath.endsWith(".png")
  ) {
    extension = ".png";
    contentType = "image/png";

  } else if (
    lowerPath.endsWith(".webp")
  ) {
    extension = ".webp";
    contentType = "image/webp";

  } else if (
    lowerPath.endsWith(".gif")
  ) {
    extension = ".gif";
    contentType = "image/gif";

  } else if (
    lowerPath.endsWith(".avif")
  ) {
    extension = ".avif";
    contentType = "image/avif";

  } else if (
    lowerPath.endsWith(".mp4")
  ) {
    extension = ".mp4";
    contentType = "video/mp4";

  } else if (
    lowerPath.endsWith(".webm")
  ) {
    extension = ".webm";
    contentType = "video/webm";

  } else if (
    lowerPath.endsWith(".mov") ||
    lowerPath.endsWith(".quicktime")
  ) {
    extension = ".mov";
    contentType = "video/quicktime";
  }

  if (!extension) {
    if (type === "video") {
      extension = ".mp4";
      contentType = "video/mp4";
    } else {
      extension = ".jpg";
      contentType = "image/jpeg";
    }
  }

  return new File(
    [
      await response.arrayBuffer()
    ],
    `telegram-media${extension}`,
    {
      type: contentType
    }
  );
}

async function saveTelegramMedia(
  fileId,
  env,
  type
) {
  const file =
    await getTelegramFile(
      fileId,
      env,
      type
    );

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
    throw new Error(
      `Unsupported Telegram ${type} file type: ${file.type}`
    );
  }

  const maxBytes =
    25 * 1024 * 1024;

  if (file.size > maxBytes) {
    throw new Error(
      "The Telegram media file is larger than 25 MB."
    );
  }

  const uploaded =
    await uploadToGitHub(
      file,
      env
    );

  return uploaded.url;
}

async function getTelegramSession(
  chatId,
  env
) {
  return env.DB
    .prepare(
      "SELECT * FROM telegram_sessions WHERE chat_id = ?"
    )
    .bind(String(chatId))
    .first();
}

async function createTelegramSession(
  chatId,
  env
) {
  await env.DB
    .prepare(`
      INSERT INTO telegram_sessions (
        chat_id,
        step,
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
        admin_unlocked,
        updated_at
      )
      VALUES (?, 'title', '', '', '', 'Other', '', '', '', '', '', '', 1, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id)
      DO UPDATE SET
        step = 'title',
        title = '',
        description = '',
        affiliate_url = '',
        category = 'Other',
        image1_url = '',
        image2_url = '',
        image3_url = '',
        image4_url = '',
        image5_url = '',
        video_url = '',
        admin_unlocked = 1,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(String(chatId))
    .run();
}

async function updateTelegramSession(
  chatId,
  fields,
  env
) {
  const allowed = [
    "step",
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
    "admin_unlocked"
  ];

  const entries =
    Object.entries(fields)
      .filter(([key]) =>
        allowed.includes(key)
      );

  if (!entries.length) {
    return;
  }

  const sets =
    entries.map(
      ([key]) =>
        `${key} = ?`
    );

  const values =
    entries.map(
      ([, value]) =>
        value
    );

  sets.push(
    "updated_at = CURRENT_TIMESTAMP"
  );

  await env.DB
    .prepare(`
      UPDATE telegram_sessions
      SET ${sets.join(", ")}
      WHERE chat_id = ?
    `)
    .bind(
      ...values,
      String(chatId)
    )
    .run();
}

async function clearTelegramSession(
  chatId,
  env
) {
  await env.DB
    .prepare(
      "DELETE FROM telegram_sessions WHERE chat_id = ?"
    )
    .bind(String(chatId))
    .run();
}

async function telegramIsUnlocked(
  chatId,
  env
) {
  const session =
    await getTelegramSession(
      chatId,
      env
    );

  return Boolean(
    session &&
    Number(session.admin_unlocked) === 1
  );
}

async function unlockTelegramAdmin(
  chatId,
  env
) {
  const existing =
    await getTelegramSession(
      chatId,
      env
    );

  if (!existing) {
    await env.DB
      .prepare(`
        INSERT INTO telegram_sessions (
          chat_id,
          step,
          admin_unlocked,
          updated_at
        )
        VALUES (?, 'idle', 1, CURRENT_TIMESTAMP)
      `)
      .bind(String(chatId))
      .run();

    return;
  }

  await updateTelegramSession(
    chatId,
    {
      step: "idle",
      admin_unlocked: 1
    },
    env
  );
}

function categoryKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        CATEGORIES.slice(0, 2),
        CATEGORIES.slice(2, 4),
        CATEGORIES.slice(4, 6),
        CATEGORIES.slice(6, 8),
        CATEGORIES.slice(8, 10),
        CATEGORIES.slice(10, 12),
        CATEGORIES.slice(12, 14),
        CATEGORIES.slice(14, 16),
        CATEGORIES.slice(16, 18),
        CATEGORIES.slice(18, 20)
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
}

function removeKeyboard() {
  return {
    reply_markup: {
      remove_keyboard: true
    }
  };
}

async function createProductFromTelegramSession(
  chatId,
  env
) {
  if (
    !(await telegramIsUnlocked(
      chatId,
      env
    ))
  ) {
    throw new Error(
      "Telegram admin access is locked."
    );
  }

  const session =
    await getTelegramSession(
      chatId,
      env
    );

  if (!session) {
    throw new Error(
      "Product session not found."
    );
  }

  const images = [
    session.image1_url,
    session.image2_url,
    session.image3_url,
    session.image4_url,
    session.image5_url
  ];

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
          featured,
          published
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
      `)
      .bind(
        session.title,
        session.description,
        session.affiliate_url,
        cleanCategory(
          session.category
        ),
        images[0],
        images[1],
        images[2],
        images[3],
        images[4],
        session.video_url || ""
      )
      .run();

  const id =
    result.meta?.last_row_id;

  if (!id) {
    throw new Error(
      "Product was created but no product ID was returned."
    );
  }

  await clearTelegramSession(
    chatId,
    env
  );

  /*
   * IMPORTANT:
   * Clearing the session also removes
   * the unlocked state.
   *
   * So the next product requires
   * entering the admin code again.
   */

  return id;
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
    message?.chat?.id;

  if (
    chatId === undefined ||
    chatId === null
  ) {
    return;
  }

  const text =
    String(
      message?.text || ""
    ).trim();

  /*
   * START
   */

  if (text === "/start") {
    await telegramSendMessage(
      env,
      chatId,
      "🛍️ Shopper's Suggestions bot is connected.\n\n" +
      "🔐 Product management is locked.\n\n" +
      "Use /admin to unlock it.\n" +
      "Use /help to see the commands."
    );

    return;
  }

  /*
   * HELP
   */

  if (text === "/help") {
    await telegramSendMessage(
      env,
      chatId,
      "Commands:\n\n" +
      "/start — Start the bot\n" +
      "/admin — Unlock product management\n" +
      "/lock — Lock product management\n" +
      "/addproduct — Create a product\n" +
      "/cancel — Cancel the current product\n" +
      "/help — Show this help"
    );

    return;
  }

  /*
   * ADMIN UNLOCK START
   */

  if (text === "/admin") {
    const existing =
      await getTelegramSession(
        chatId,
        env
      );

    if (
      existing &&
      Number(existing.admin_unlocked) === 1
    ) {
      await telegramSendMessage(
        env,
        chatId,
        "🔓 Admin access is already unlocked.\n\n" +
        "You can use /addproduct."
      );

      return;
    }

    if (!env.TELEGRAM_ADMIN_CODE) {
      await telegramSendMessage(
        env,
        chatId,
        "Admin code is not configured on the server."
      );

      return;
    }

    if (!existing) {
      await env.DB
        .prepare(`
          INSERT INTO telegram_sessions (
            chat_id,
            step,
            admin_unlocked,
            updated_at
          )
          VALUES (?, 'admin_code', 0, CURRENT_TIMESTAMP)
        `)
        .bind(String(chatId))
        .run();
    } else {
      await updateTelegramSession(
        chatId,
        {
          step: "admin_code"
        },
        env
      );
    }

    await telegramSendMessage(
      env,
      chatId,
      "🔐 Enter the admin access code:"
    );

    return;
  }

  /*
   * LOCK ADMIN
   */

  if (text === "/lock") {
    const existing =
      await getTelegramSession(
        chatId,
        env
      );

    if (!existing) {
      await telegramSendMessage(
        env,
        chatId,
        "🔒 Admin access is already locked."
      );

      return;
    }

    await updateTelegramSession(
      chatId,
      {
        step: "idle",
        admin_unlocked: 0
      },
      env
    );

    await telegramSendMessage(
      env,
      chatId,
      "🔒 Admin access locked.\n\n" +
      "Use /admin to unlock it again.",
      removeKeyboard()
    );

    return;
  }

  /*
   * ADMIN CODE
   */

  let session =
    await getTelegramSession(
      chatId,
      env
    );

  if (
    session &&
    session.step === "admin_code"
  ) {
    if (
      env.TELEGRAM_ADMIN_CODE &&
      text === String(
        env.TELEGRAM_ADMIN_CODE
      )
    ) {
      await unlockTelegramAdmin(
        chatId,
        env
      );

      await telegramSendMessage(
        env,
        chatId,
        "✅ Access granted.\n\n" +
        "🔓 Product management is now unlocked.\n\n" +
        "Use /addproduct to create a product.",
        removeKeyboard()
      );

      return;
    }

    await telegramSendMessage(
      env,
      chatId,
      "❌ Incorrect access code.\n\n" +
      "Try again:"
    );

    return;
  }

  /*
   * CANCEL
   */

  if (text === "/cancel") {
    if (
      !(await telegramIsUnlocked(
        chatId,
        env
      ))
    ) {
      await telegramSendMessage(
        env,
        chatId,
        "🔒 Product management is locked.\n\n" +
        "Use /admin first."
      );

      return;
    }

    await clearTelegramSession(
      chatId,
      env
    );

    await telegramSendMessage(
      env,
      chatId,
      "Product creation cancelled.\n\n" +
      "🔒 Admin access has also been locked.\n" +
      "Use /admin to unlock again.",
      removeKeyboard()
    );

    return;
  }

  /*
   * ADD PRODUCT
   */

  if (text === "/addproduct") {
    if (
      !(await telegramIsUnlocked(
        chatId,
        env
      ))
    ) {
      await telegramSendMessage(
        env,
        chatId,
        "🔒 Access denied.\n\n" +
        "Use /admin and enter the admin code first."
      );

      return;
    }

    await createTelegramSession(
      chatId,
      env
    );

    await telegramSendMessage(
      env,
      chatId,
      "Let's create a real product.\n\n" +
      "Send the product title:"
    );

    return;
  }

  /*
   * NO SESSION
   */

  if (!session) {
    await telegramSendMessage(
      env,
      chatId,
      "🔒 Product management is locked.\n\n" +
      "Use /admin to unlock it."
    );

    return;
  }

  /*
   * TITLE
   */

  if (session.step === "title") {
    if (!text) {
      await telegramSendMessage(
        env,
        chatId,
        "Please send a product title."
      );

      return;
    }

    await updateTelegramSession(
      chatId,
      {
        step: "description",
        title: text
      },
      env
    );

    await telegramSendMessage(
      env,
      chatId,
      "Now send the full product description:"
    );

    return;
  }

  /*
   * DESCRIPTION
   */

  if (session.step === "description") {
    if (!text) {
      await telegramSendMessage(
        env,
        chatId,
        "Please send the product description."
      );

      return;
    }

    await updateTelegramSession(
      chatId,
      {
        step: "affiliate_url",
        description: text
      },
      env
    );

    await telegramSendMessage(
      env,
      chatId,
      "Now send the affiliate product URL:"
    );

    return;
  }

  /*
   * AFFILIATE URL
   */

  if (session.step === "affiliate_url") {
    let affiliateUrl;

    try {
      affiliateUrl =
        new URL(text).toString();
    } catch {
      await telegramSendMessage(
        env,
        chatId,
        "That doesn't look like a valid URL.\n\n" +
        "Please send the complete affiliate URL."
      );

      return;
    }

    await updateTelegramSession(
      chatId,
      {
        step: "category",
        affiliate_url:
          affiliateUrl
      },
      env
    );

    await telegramSendMessage(
      env,
      chatId,
      "Choose the product category:",
      categoryKeyboard()
    );

    return;
  }

  /*
   * CATEGORY
   */

  if (session.step === "category") {
    if (!CATEGORIES.includes(text)) {
      await telegramSendMessage(
        env,
        chatId,
        "Please choose one of the available categories.",
        categoryKeyboard()
      );

      return;
    }

    await updateTelegramSession(
      chatId,
      {
        step: "images",
        category: text
      },
      env
    );

    await telegramSendMessage(
      env,
      chatId,
      "Now send the product image(s).\n\n" +
      "You can send up to 5 photos.\n" +
      "Send /done when you're finished.\n\n" +
      "You can also send /skip if you don't want to add images.",
      removeKeyboard()
    );

    return;
  }

  /*
   * IMAGES
   */

  if (session.step === "images") {

    if (text === "/skip") {
      await updateTelegramSession(
        chatId,
        {
          step: "video"
        },
        env
      );

      await telegramSendMessage(
        env,
        chatId,
        "No images added.\n\n" +
        "Send a product video, or /skip:"
      );

      return;
    }

    if (text === "/done") {
      await updateTelegramSession(
        chatId,
        {
          step: "video"
        },
        env
      );

      await telegramSendMessage(
        env,
        chatId,
        "Images saved.\n\n" +
        "Send a product video, or /skip:"
      );

      return;
    }

    if (message.photo?.length) {
      const largestPhoto =
        message.photo[
          message.photo.length - 1
        ];

      try {
        const imageUrl =
          await saveTelegramMedia(
            largestPhoto.file_id,
            env,
            "image"
          );

        session =
          await getTelegramSession(
            chatId,
            env
          );

        const imageFields = [
          "image1_url",
          "image2_url",
          "image3_url",
          "image4_url",
          "image5_url"
        ];

        let targetField = null;

        for (
          const field of imageFields
        ) {
          if (!session[field]) {
            targetField = field;
            break;
          }
        }

        if (!targetField) {
          await telegramSendMessage(
            env,
            chatId,
            "You've already added 5 images.\n\n" +
            "Send /done to continue."
          );

          return;
        }

        await updateTelegramSession(
          chatId,
          {
            [targetField]:
              imageUrl
          },
          env
        );

        const currentCount =
          imageFields.filter(
            field =>
              field === targetField ||
              session[field]
          ).length;

        await telegramSendMessage(
          env,
          chatId,
          `Image ${currentCount}/5 saved.\n\n` +
          "Send another image, /done, or /skip."
        );

      } catch (error) {
        await telegramSendMessage(
          env,
          chatId,
          `Image upload failed: ${error.message}`
        );
      }

      return;
    }

    await telegramSendMessage(
      env,
      chatId,
      "Please send a photo, /done, or /skip."
    );

    return;
  }

  /*
   * VIDEO
   */

  if (session.step === "video") {

    if (text === "/skip") {
      await updateTelegramSession(
        chatId,
        {
          step: "confirm"
        },
        env
      );

      await sendTelegramProductConfirmation(
        chatId,
        env
      );

      return;
    }

    if (message.video?.file_id) {
      try {
        const videoUrl =
          await saveTelegramMedia(
            message.video.file_id,
            env,
            "video"
          );

        await updateTelegramSession(
          chatId,
          {
            step: "confirm",
            video_url:
              videoUrl
          },
          env
        );

        await sendTelegramProductConfirmation(
          chatId,
          env
        );

      } catch (error) {
        await telegramSendMessage(
          env,
          chatId,
          `Video upload failed: ${error.message}\n\n` +
          "You can send /skip to continue without a video."
        );
      }

      return;
    }

    await telegramSendMessage(
      env,
      chatId,
      "Please send a video or /skip."
    );

    return;
  }

  /*
   * CONFIRM
   */

  if (session.step === "confirm") {

    if (text === "/publish") {

      if (
        !(await telegramIsUnlocked(
          chatId,
          env
        ))
      ) {
        await telegramSendMessage(
          env,
          chatId,
          "🔒 Admin access is locked.\n\n" +
          "Use /admin to unlock it."
        );

        return;
      }

      try {
        const productId =
          await createProductFromTelegramSession(
            chatId,
            env
          );

        const productUrl =
          `https://shopperssuggestions.online/?product=${productId}`;

        await telegramSendMessage(
          env,
          chatId,
          "✅ Product published successfully.\n\n" +
          `Product ID: ${productId}\n\n` +
          `Website link:\n${productUrl}\n\n` +
          "🔒 Admin access has been locked.\n" +
          "Use /admin to add another product.",
          removeKeyboard()
        );

      } catch (error) {
        await telegramSendMessage(
          env,
          chatId,
          `Product creation failed: ${error.message}`
        );
      }

      return;
    }

    await telegramSendMessage(
      env,
      chatId,
      "Send /publish to publish this product, or /cancel to cancel."
    );

    return;
  }

  await telegramSendMessage(
    env,
    chatId,
    "Use /addproduct to start a new product."
  );
}

async function sendTelegramProductConfirmation(
  chatId,
  env
) {
  const session =
    await getTelegramSession(
      chatId,
      env
    );

  if (!session) {
    await telegramSendMessage(
      env,
      chatId,
      "Product session expired. Use /addproduct again."
    );

    return;
  }

  const imageCount = [
    session.image1_url,
    session.image2_url,
    session.image3_url,
    session.image4_url,
    session.image5_url
  ].filter(Boolean).length;

  await telegramSendMessage(
    env,
    chatId,
    "Product information ready.\n\n" +
    `Title: ${session.title}\n` +
    `Category: ${session.category}\n` +
    `Images: ${imageCount}\n` +
    `Video: ${session.video_url ? "Yes" : "No"}\n\n` +
    "Send /publish to create the real product on Shopper's Suggestions.\n" +
    "Send /cancel to cancel."
  );
}

async function handleTelegramWebhook(
  request,
  env
) {
  const secret =
    request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );

  if (
    env.TELEGRAM_WEBHOOK_SECRET &&
    secret !== env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return json({
      ok: false,
      error: "Unauthorized"
    }, 401);
  }

  const update =
    await request.json();

  await handleTelegramUpdate(
    update,
    env
  );

  return json({
    ok: true
  });
}

async function setupTelegramWebhook(env) {
  if (!telegramConfigured(env)) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not configured."
    );
  }

  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET is not configured."
    );
  }

  const webhookUrl =
    "https://shopper-s-suggestions.zilnetmain.workers.dev/api/telegram/webhook";

  return telegramCall(
    env,
    "setWebhook",
    {
      url: webhookUrl,
      secret_token:
        env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: [
        "message"
      ]
    }
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
            "Access-Control-Allow-Headers":
              "Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token",
            "Access-Control-Allow-Methods":
              "GET, POST, PUT, PATCH, DELETE, OPTIONS"
          }
        });
      }

      const url =
        new URL(request.url);

      const path =
        url.pathname;

      if (path.startsWith("/api/")) {
        await ensureSchema(env);
      }

      // TELEGRAM WEBHOOK
      if (
        path === "/api/telegram/webhook" &&
        request.method === "POST"
      ) {
        return handleTelegramWebhook(
          request,
          env
        );
      }

      // TELEGRAM WEBHOOK SETUP
      if (
        path === "/api/telegram/setup" &&
        request.method === "GET"
      ) {
        const setupKey =
          url.searchParams.get("key") || "";

        if (
          !env.TELEGRAM_SETUP_SECRET ||
          setupKey !==
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
          telegram:
            result.result
        });
      }

      // HEALTH
      if (
        path === "/api/health" &&
        request.method === "GET"
      ) {
        return json({
          ok: true,
          service:
            "shopper-s-suggestions"
        });
      }

      // CATEGORIES
      if (
        path === "/api/categories" &&
        request.method === "GET"
      ) {
        return json({
          categories:
            CATEGORIES
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
          request.headers.get(
            "Content-Type"
          ) || "";

        if (
          !contentType
            .toLowerCase()
            .includes(
              "multipart/form-data"
            )
        ) {
          return json({
            error:
              "Use multipart/form-data."
          }, 400);
        }

        const form =
          await request.formData();

        const file =
          form.get("file");

        if (!(file instanceof File)) {
          return json({
            error:
              "No file was received."
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

        const maxBytes =
          25 * 1024 * 1024;

        if (file.size > maxBytes) {
          return json({
            error:
              "This file is larger than 25 MB. Please use a smaller image or video."
          }, 413);
        }

        const uploaded =
          await uploadToGitHub(
            file,
            env
          );

        return json({
          ok: true,
          url:
            uploaded.url,
          path:
            uploaded.path,
          type:
            file.type,
          size:
            file.size
        });
      }

      // PUBLIC PRODUCTS
      if (
        path === "/api/products" &&
        request.method === "GET"
      ) {
        const search =
          (
            url.searchParams.get(
              "search"
            ) || ""
          ).trim();

        const category =
          (
            url.searchParams.get(
              "category"
            ) || ""
          ).trim();

        const featuredParam =
          (
            url.searchParams.get(
              "featured"
            ) || ""
          ).trim();

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
            featured,
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
          query +=
            " AND category = ?";

          params.push(category);
        }

        if (search) {
          query +=
            " AND (title LIKE ? OR description LIKE ?)";

          const term =
            `%${search}%`;

          params.push(
            term,
            term
          );
        }

        if (
          featuredParam === "1" ||
          featuredParam === "true"
        ) {
          query +=
            " AND featured = 1";
        }

        query +=
          " ORDER BY id DESC";

        const result =
          await env.DB
            .prepare(query)
            .bind(...params)
            .all();

        return json({
          products:
            result.results || []
        });
      }

      // SINGLE PRODUCT
      const singleMatch =
        path.match(
          /^\/api\/products\/(\d+)$/
        );

      if (
        singleMatch &&
        request.method === "GET"
      ) {
        const id =
          Number(
            singleMatch[1]
          );

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
                featured,
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
            error:
              "Product not found."
          }, 404);
        }

        return json({
          product:
            result
        });
      }

      // ADMIN PRODUCT LIST
      if (
        path === "/api/admin/products" &&
        request.method === "GET"
      ) {
        if (!isAdmin(request, env)) {
          return json({
            error:
              "Unauthorized"
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
          products:
            result.results || []
        });
      }

      // CREATE PRODUCT
      if (
        path === "/api/products" &&
        request.method === "POST"
      ) {
        if (!isAdmin(request, env)) {
          return json({
            error:
              "Unauthorized"
          }, 401);
        }

        const body =
          await request.json();

        const title =
          String(
            body.title || ""
          ).trim();

        const description =
          String(
            body.description || ""
          ).trim();

        const affiliateUrl =
          String(
            body.affiliate_url || ""
          ).trim();

        const category =
          cleanCategory(
            body.category
          );

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
          new URL(
            affiliateUrl
          );
        } catch {
          return json({
            error:
              "Affiliate URL is invalid."
          }, 400);
        }

        const images =
          Array.isArray(
            body.images
          )
            ? body.images
                .slice(0, 5)
                .map(v =>
                  String(
                    v || ""
                  ).trim()
                )
            : [
                body.image1_url,
                body.image2_url,
                body.image3_url,
                body.image4_url,
                body.image5_url
              ].map(v =>
                String(
                  v || ""
                ).trim()
              );

        while (
          images.length < 5
        ) {
          images.push("");
        }

        const videoUrl =
          String(
            body.video_url || ""
          ).trim();

        const featured =
          body.featured
            ? 1
            : 0;

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
                featured,
                published
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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
            .run();

        return json({
          ok: true,
          id:
            result.meta?.last_row_id
        }, 201);
      }

      // UPDATE PRODUCT
      if (
        singleMatch &&
        [
          "PUT",
          "PATCH"
        ].includes(
          request.method
        )
      ) {
        if (!isAdmin(request, env)) {
          return json({
            error:
              "Unauthorized"
          }, 401);
        }

        const id =
          Number(
            singleMatch[1]
          );

        const existing =
          await env.DB
            .prepare(
              "SELECT * FROM products WHERE id = ?"
            )
            .bind(id)
            .first();

        if (!existing) {
          return json({
            error:
              "Product not found."
          }, 404);
        }

        const body =
          await request.json();

        const title =
          String(
            body.title ??
            existing.title
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
          Array.isArray(
            body.images
          )
            ? body.images
                .slice(0, 5)
                .map(v =>
                  String(
                    v || ""
                  ).trim()
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
                String(
                  v || ""
                ).trim()
              );

        while (
          images.length < 5
        ) {
          images.push("");
        }

        const videoUrl =
          String(
            body.video_url ??
            existing.video_url ??
            ""
          ).trim();

        const featured =
          body.featured ===
          undefined
            ? Number(
                existing.featured || 0
              )
            : (
                body.featured
                  ? 1
                  : 0
              );

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
              featured = ?,
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
            featured,
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
            error:
              "Unauthorized"
          }, 401);
        }

        const id =
          Number(
            singleMatch[1]
          );

        const existing =
          await env.DB
            .prepare(
              "SELECT * FROM products WHERE id = ?"
            )
            .bind(id)
            .first();

        if (!existing) {
          return json({
            error:
              "Product not found."
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

        for (
          const mediaUrl
          of mediaUrls
        ) {
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

      return json({
        error:
          error?.message ||
          "Server error."
      }, 500);
    }
  }
};
