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

const SESSION_TTL = 24 * 60 * 60;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function clean(value, max = 10000) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, max);
}

function randomId() {
  return crypto.randomUUID();
}

function productShareUrl(id) {
  return `https://shopperssuggestions.online/?product=${encodeURIComponent(id)}`;
}

function telegramApi(env, method) {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function telegramCall(env, method, body) {
  const response = await fetch(telegramApi(env, method), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      ok: false,
      description: text
    };
  }

  if (!data.ok) {
    console.error("Telegram API error:", method, data);
  }

  return data;
}

async function sendMessage(
  env,
  chatId,
  text,
  extra = {}
) {
  return telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra
  });
}

async function answerCallback(env, callbackId) {
  return telegramCall(env, "answerCallbackQuery", {
    callback_query_id: callbackId
  });
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
    CREATE TABLE IF NOT EXISTS telegram_sessions (
      chat_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      step TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    )
  `).run();

  try {
    await env.DB.prepare(
      `ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0`
    ).run();
  } catch (_) {
    // Already exists.
  }
}

async function getSession(env, chatId) {
  const row = await env.DB.prepare(`
    SELECT *
    FROM telegram_sessions
    WHERE chat_id = ?
    LIMIT 1
  `)
    .bind(String(chatId))
    .first();

  if (!row) return null;

  if (
    Date.now() / 1000 - Number(row.updated_at || 0) >
    SESSION_TTL
  ) {
    await deleteSession(env, chatId);
    return null;
  }

  let data = {};

  try {
    data = JSON.parse(row.data || "{}");
  } catch {
    data = {};
  }

  return {
    ...row,
    data
  };
}

async function saveSession(
  env,
  chatId,
  userId,
  step,
  data
) {
  await env.DB.prepare(`
    INSERT INTO telegram_sessions
      (chat_id, user_id, step, data, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id)
    DO UPDATE SET
      user_id = excluded.user_id,
      step = excluded.step,
      data = excluded.data,
      updated_at = excluded.updated_at
  `)
    .bind(
      String(chatId),
      String(userId || ""),
      step,
      JSON.stringify(data || {}),
      Math.floor(Date.now() / 1000)
    )
    .run();
}

async function deleteSession(env, chatId) {
  await env.DB.prepare(`
    DELETE FROM telegram_sessions
    WHERE chat_id = ?
  `)
    .bind(String(chatId))
    .run();
}

function categoriesKeyboard() {
  const rows = [];

  for (let i = 0; i < CATEGORIES.length; i += 2) {
    const row = [];

    row.push({
      text: CATEGORIES[i],
      callback_data: `category:${CATEGORIES[i]}`
    });

    if (CATEGORIES[i + 1]) {
      row.push({
        text: CATEGORIES[i + 1],
        callback_data: `category:${CATEGORIES[i + 1]}`
      });
    }

    rows.push(row);
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
        { text: "/cancel" }
      ],
      [
        { text: "/lock" },
        { text: "/getid" }
      ]
    ],
    resize_keyboard: true
  };
}

function removeKeyboard() {
  return {
    remove_keyboard: true
  };
}

function extractMessage(update) {
  if (update.message) {
    return update.message;
  }

  if (update.edited_message) {
    return update.edited_message;
  }

  return null;
}

function extractText(message) {
  return clean(message?.text || "", 10000);
}

function getChatId(update) {
  if (update.message?.chat?.id !== undefined) {
    return update.message.chat.id;
  }

  if (update.callback_query?.message?.chat?.id !== undefined) {
    return update.callback_query.message.chat.id;
  }

  return null;
}

function getUserId(update) {
  if (update.message?.from?.id !== undefined) {
    return update.message.from.id;
  }

  if (update.callback_query?.from?.id !== undefined) {
    return update.callback_query.from.id;
  }

  return null;
}

function telegramGroupIds(env) {
  const raw = clean(env.TELEGRAM_GROUP_IDS, 5000);

  if (!raw) return [];

  return raw
    .split(/[,\s]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

function productCaption(product) {
  const title = escapeHtml(product.title);
  const description = escapeHtml(product.description);
  const category = escapeHtml(product.category);
  const link = productShareUrl(product.id);

  return (
    `<b>${title}</b>\n\n` +
    `${description}\n\n` +
    `🏷 ${category}\n\n` +
    `🛍 <a href="${link}">MAKE IT YOURS!</a>`
  );
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function postProductToGroups(
  product,
  env
) {
  const groups = telegramGroupIds(env);

  if (!groups.length) {
    console.log(
      "No TELEGRAM_GROUP_IDS configured."
    );
    return;
  }

  const images = [
    product.image1_url,
    product.image2_url,
    product.image3_url,
    product.image4_url,
    product.image5_url
  ].filter(Boolean);

  const caption = productCaption(product);

  for (const chatId of groups) {
    try {
      if (images.length) {
        await telegramCall(env, "sendPhoto", {
          chat_id: chatId,
          photo: images[0],
          caption,
          parse_mode: "HTML"
        });

        for (let i = 1; i < images.length; i++) {
          await telegramCall(env, "sendPhoto", {
            chat_id: chatId,
            photo: images[i]
          });
        }

        if (product.video_url) {
          await telegramCall(env, "sendVideo", {
            chat_id: chatId,
            video: product.video_url
          });
        }
      } else if (product.video_url) {
        await telegramCall(env, "sendVideo", {
          chat_id: chatId,
          video: product.video_url,
          caption,
          parse_mode: "HTML"
        });
      } else {
        await sendMessage(
          env,
          chatId,
          caption
        );
      }

      console.log(
        `Product ${product.id} posted to ${chatId}`
      );

    } catch (error) {
      console.error(
        `Failed posting product ${product.id} to ${chatId}`,
        error
      );
    }
  }
}

async function downloadTelegramFile(
  env,
  fileId
) {
  const fileInfo = await telegramCall(
    env,
    "getFile",
    {
      file_id: fileId
    }
  );

  if (!fileInfo.ok || !fileInfo.result?.file_path) {
    throw new Error(
      `Telegram getFile failed: ${JSON.stringify(fileInfo)}`
    );
  }

  const filePath =
    fileInfo.result.file_path;

  const url =
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Telegram file download failed: ${response.status}`
    );
  }

  const bytes =
    new Uint8Array(
      await response.arrayBuffer()
    );

  const contentType =
    response.headers.get("content-type") ||
    "";

  return {
    bytes,
    filePath,
    contentType
  };
}

function extensionFromTelegram(
  filePath,
  contentType,
  isVideo = false
) {
  const match =
    String(filePath || "")
      .toLowerCase()
      .match(/\.([a-z0-9]{1,8})$/);

  if (match) {
    const ext = match[1];

    const allowed = [
      "jpg",
      "jpeg",
      "png",
      "webp",
      "gif",
      "mp4",
      "webm",
      "mov"
    ];

    if (allowed.includes(ext)) {
      return ext;
    }
  }

  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("quicktime")) return "mov";
  if (contentType.includes("mp4")) return "mp4";

  return isVideo ? "mp4" : "jpg";
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunk
  ) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunk)
    );
  }

  return btoa(binary);
}

async function githubGet(
  env,
  path
) {
  const branch =
    env.GITHUB_BRANCH || "main";

  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`;

  const response =
    await fetch(url, {
      headers: {
        Authorization:
          `Bearer ${env.GITHUB_TOKEN}`,
        Accept:
          "application/vnd.github+json",
        "User-Agent":
          "Shopper-Suggestions-Telegram"
      }
    });

  if (!response.ok) {
    throw new Error(
      `GitHub GET failed ${response.status}`
    );
  }

  return response.json();
}

async function githubUpload(
  env,
  path,
  bytes
) {
  const branch =
    env.GITHUB_BRANCH || "main";

  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;

  const body = {
    message:
      `Telegram product media ${path}`,
    content:
      bytesToBase64(bytes),
    branch
  };

  try {
    const existing =
      await githubGet(env, path);

    if (existing.sha) {
      body.sha = existing.sha;
    }
  } catch (_) {
    // New file.
  }

  const response =
    await fetch(url, {
      method: "PUT",
      headers: {
        Authorization:
          `Bearer ${env.GITHUB_TOKEN}`,
        Accept:
          "application/vnd.github+json",
        "Content-Type":
          "application/json",
        "User-Agent":
          "Shopper-Suggestions-Telegram"
      },
      body:
        JSON.stringify(body)
    });

  if (!response.ok) {
    const error =
      await response.text();

    throw new Error(
      `GitHub upload failed ${response.status}: ${error}`
    );
  }

  return {
    url:
      `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${branch}/${path}`,
    path
  };
}

async function saveTelegramMedia(
  env,
  fileId,
  isVideo
) {
  const downloaded =
    await downloadTelegramFile(
      env,
      fileId
    );

  const extension =
    extensionFromTelegram(
      downloaded.filePath,
      downloaded.contentType,
      isVideo
    );

  const filename =
    `${Date.now()}-${crypto.randomUUID()}.${extension}`;

  const path =
    `media/${filename}`;

  return githubUpload(
    env,
    path,
    downloaded.bytes
  );
}

async function createProductFromSession(
  env,
  chatId
) {
  const session =
    await getSession(
      env,
      chatId
    );

  if (!session) {
    throw new Error(
      "Product session expired."
    );
  }

  const data =
    session.data || {};

  const images =
    Array.isArray(data.images)
      ? data.images
      : [];

  while (images.length < 5) {
    images.push("");
  }

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
        featured
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
      RETURNING *
    `)
      .bind(
        clean(data.title, 300),
        clean(data.description, 10000),
        clean(data.affiliate_url, 2000),
        clean(data.category, 100),
        images[0] || "",
        images[1] || "",
        images[2] || "",
        images[3] || "",
        images[4] || "",
        clean(data.video_url, 3000)
      )
      .first();

  await deleteSession(
    env,
    chatId
  );

  return result;
}

async function handleStart(
  env,
  chatId
) {
  await deleteSession(
    env,
    chatId
  );

  await sendMessage(
    env,
    chatId,
    `<b>Shopper's Suggestions</b>\n\n` +
    `Bot is online.\n\n` +
    `Use /admin to unlock product management.\n` +
    `Use /getid to see this chat ID.`
  );
}

async function handleGetId(
  env,
  chatId
) {
  await sendMessage(
    env,
    chatId,
    `<b>Chat ID</b>\n\n<code>${escapeHtml(chatId)}</code>`
  );
}

async function handleAdmin(
  env,
  chatId,
  userId
) {
  await saveSession(
    env,
    chatId,
    userId,
    "admin_code",
    {}
  );

  await sendMessage(
    env,
    chatId,
    `<b>Admin unlock</b>\n\n` +
    `Send the 4-digit admin code.`
  );
}

async function unlockAdmin(
  env,
  chatId,
  userId,
  code
) {
  if (
    String(code) !==
    String(env.TELEGRAM_ADMIN_CODE || "")
  ) {
    await sendMessage(
      env,
      chatId,
      `❌ Incorrect code.`
    );

    return;
  }

  await saveSession(
    env,
    chatId,
    userId,
    "unlocked",
    {
      unlocked: true
    }
  );

  await sendMessage(
    env,
    chatId,
    `<b>Admin unlocked.</b>\n\n` +
    `You can now use /addproduct.`,
    {
      reply_markup:
        adminKeyboard()
    }
  );
}

async function handleLock(
  env,
  chatId
) {
  await deleteSession(
    env,
    chatId
  );

  await sendMessage(
    env,
    chatId,
    `🔒 Admin locked.`,
    {
      reply_markup:
        removeKeyboard()
    }
  );
}

async function handleCancel(
  env,
  chatId
) {
  const session =
    await getSession(
      env,
      chatId
    );

  const unlocked =
    session?.data?.unlocked === true;

  await saveSession(
    env,
    chatId,
    session?.user_id || "",
    unlocked
      ? "unlocked"
      : "",
    unlocked
      ? { unlocked: true }
      : {}
  );

  await sendMessage(
    env,
    chatId,
    `Cancelled.\n\n` +
    (unlocked
      ? `Admin remains unlocked.`
      : `Use /admin to unlock.`)
  );
}

async function startAddProduct(
  env,
  chatId,
  userId
) {
  const session =
    await getSession(
      env,
      chatId
    );

  if (
    session?.data?.unlocked !== true
  ) {
    await sendMessage(
      env,
      chatId,
      `🔒 Admin is locked.\n\nUse /admin first.`
    );

    return;
  }

  await saveSession(
    env,
    chatId,
    userId,
    "title",
    {
      unlocked: true
    }
  );

  await sendMessage(
    env,
    chatId,
    `<b>New product</b>\n\n` +
    `Send the product title.`
  );
}

async function handleTextFlow(
  env,
  update,
  message
) {
  const chatId =
    message.chat.id;

  const userId =
    message.from?.id || "";

  const text =
    extractText(message);

  const session =
    await getSession(
      env,
      chatId
    );

  if (!session) {
    return false;
  }

  const step =
    session.step;

  const data =
    session.data || {};

  if (step === "admin_code") {
    await unlockAdmin(
      env,
      chatId,
      userId,
      text
    );

    return true;
  }

  if (data.unlocked !== true) {
    return false;
  }

  if (step === "title") {
    data.title =
      clean(text, 300);

    await saveSession(
      env,
      chatId,
      userId,
      "description",
      data
    );

    await sendMessage(
      env,
      chatId,
      `Now send the product description.`
    );

    return true;
  }

  if (step === "description") {
    data.description =
      clean(text, 10000);

    await saveSession(
      env,
      chatId,
      userId,
      "affiliate",
      data
    );

    await sendMessage(
      env,
      chatId,
      `Now send the affiliate/product link.`
    );

    return true;
  }

  if (step === "affiliate") {
    data.affiliate_url =
      clean(text, 2000);

    await saveSession(
      env,
      chatId,
      userId,
      "category",
      data
    );

    await sendMessage(
      env,
      chatId,
      `Choose a category:`,
      {
        reply_markup:
          categoriesKeyboard()
      }
    );

    return true;
  }

  if (step === "images") {
    if (!data.images) {
      data.images = [];
    }

    if (
      data.images.length >= 5
    ) {
      await saveSession(
        env,
        chatId,
        userId,
        "video",
        data
      );

      await sendMessage(
        env,
        chatId,
        `You already added 5 images.\n\n` +
        `Send a video, or type <b>skip</b>.`
      );

      return true;
    }

    return true;
  }

  if (step === "video") {
    if (
      text.toLowerCase() ===
      "skip"
    ) {
      data.video_url = "";

      await saveSession(
        env,
        chatId,
        userId,
        "publish",
        data
      );

      await sendPublishPreview(
        env,
        chatId,
        data
      );

      return true;
    }

    data.video_url =
      text;

    await saveSession(
      env,
      chatId,
      userId,
      "publish",
      data
    );

    await sendPublishPreview(
      env,
      chatId,
      data
    );

    return true;
  }

  if (step === "publish") {
    if (
      text.toLowerCase() ===
      "/publish"
    ) {
      const product =
        await createProductFromSession(
          env,
          chatId
        );

      await sendMessage(
        env,
        chatId,
        `<b>Product published.</b>\n\n` +
        `ID: <code>${product.id}</code>\n` +
        `${escapeHtml(product.title)}\n\n` +
        `🔗 ${productShareUrl(product.id)}`
      );

      await postProductToGroups(
        product,
        env
      );

      await saveSession(
        env,
        chatId,
        userId,
        "unlocked",
        {
          unlocked: true
        }
      );

      await sendMessage(
        env,
        chatId,
        `Admin remains unlocked.\n\n` +
        `Use /addproduct for another product.`
      );

      return true;
    }

    await sendPublishPreview(
      env,
      chatId,
      data
    );

    return true;
  }

  return false;
}

async function sendPublishPreview(
  env,
  chatId,
  data
) {
  const images =
    Array.isArray(data.images)
      ? data.images
      : [];

  const imageText =
    images.length
      ? `${images.length} image(s)`
      : "No images";

  await sendMessage(
    env,
    chatId,
    `<b>Ready to publish</b>\n\n` +
    `<b>Title:</b> ${escapeHtml(data.title)}\n\n` +
    `<b>Description:</b> ${escapeHtml(data.description)}\n\n` +
    `<b>Category:</b> ${escapeHtml(data.category)}\n\n` +
    `<b>Images:</b> ${imageText}\n` +
    `<b>Video:</b> ${data.video_url ? "Yes" : "No"}\n\n` +
    `Send <code>/publish</code> to publish.`
  );
}

async function handlePhoto(
  env,
  message
) {
  const chatId =
    message.chat.id;

  const userId =
    message.from?.id || "";

  const session =
    await getSession(
      env,
      chatId
    );

  if (
    !session ||
    session.data?.unlocked !== true
  ) {
    await sendMessage(
      env,
      chatId,
      `🔒 Unlock admin first with /admin.`
    );

    return;
  }

  if (
    session.step !== "images"
  ) {
    await sendMessage(
      env,
      chatId,
      `I am not waiting for an image right now.`
    );

    return;
  }

  const photos =
    message.photo || [];

  const largest =
    photos[photos.length - 1];

  if (!largest?.file_id) {
    return;
  }

  const data =
    session.data || {};

  if (!Array.isArray(data.images)) {
    data.images = [];
  }

  if (data.images.length >= 5) {
    await sendMessage(
      env,
      chatId,
      `You already have 5 images.`
    );

    return;
  }

  await sendMessage(
    env,
    chatId,
    `Uploading image ${data.images.length + 1}/5...`
  );

  const uploaded =
    await saveTelegramMedia(
      env,
      largest.file_id,
      false
    );

  data.images.push(
    uploaded.url
  );

  await saveSession(
    env,
    chatId,
    userId,
    "images",
    data
  );

  if (
    data.images.length >= 5
  ) {
    await saveSession(
      env,
      chatId,
      userId,
      "video",
      data
    );

    await sendMessage(
      env,
      chatId,
      `5 images uploaded.\n\n` +
      `Send a video or type <b>skip</b>.`
    );
  } else {
    await sendMessage(
      env,
      chatId,
      `Image uploaded.\n\n` +
      `Send another image, or type <b>done</b> when finished.`
    );
  }
}

async function handleVideo(
  env,
  message
) {
  const chatId =
    message.chat.id;

  const userId =
    message.from?.id || "";

  const session =
    await getSession(
      env,
      chatId
    );

  if (
    !session ||
    session.data?.unlocked !== true
  ) {
    await sendMessage(
      env,
      chatId,
      `🔒 Unlock admin first with /admin.`
    );

    return;
  }

  if (
    session.step !== "video"
  ) {
    await sendMessage(
      env,
      chatId,
      `I am not waiting for a video right now.`
    );

    return;
  }

  const fileId =
    message.video?.file_id ||
    message.document?.file_id;

  if (!fileId) return;

  await sendMessage(
    env,
    chatId,
    `Uploading video...`
  );

  const uploaded =
    await saveTelegramMedia(
      env,
      fileId,
      true
    );

  const data =
    session.data || {};

  data.video_url =
    uploaded.url;

  await saveSession(
    env,
    chatId,
    userId,
    "publish",
    data
  );

  await sendPublishPreview(
    env,
    chatId,
    data
  );
}

async function handleCallback(
  env,
  update
) {
  const callback =
    update.callback_query;

  if (!callback) return;

  await answerCallback(
    env,
    callback.id
  );

  const chatId =
    callback.message?.chat?.id;

  const userId =
    callback.from?.id;

  if (!chatId) return;

  const data =
    callback.data || "";

  if (
    !data.startsWith("category:")
  ) {
    return;
  }

  const category =
    data.slice("category:".length);

  if (!CATEGORIES.includes(category)) {
    return;
  }

  const session =
    await getSession(
      env,
      chatId
    );

  if (
    !session ||
    session.data?.unlocked !== true
  ) {
    await sendMessage(
      env,
      chatId,
      `🔒 Unlock admin first with /admin.`
    );

    return;
  }

  const sessionData =
    session.data || {};

  sessionData.category =
    category;

  sessionData.images =
    Array.isArray(sessionData.images)
      ? sessionData.images
      : [];

  await saveSession(
    env,
    chatId,
    userId,
    "images",
    sessionData
  );

  await sendMessage(
    env,
    chatId,
    `<b>Category:</b> ${escapeHtml(category)}\n\n` +
    `Now send up to 5 product images.\n\n` +
    `When finished, type <b>done</b>.`
  );
}

async function handleTelegramUpdate(
  env,
  update
) {
  if (
    update.callback_query
  ) {
    await handleCallback(
      env,
      update
    );

    return;
  }

  const message =
    extractMessage(update);

  if (!message) {
    return;
  }

  const chatId =
    message.chat?.id;

  if (
    chatId === undefined ||
    chatId === null
  ) {
    return;
  }

  const userId =
    message.from?.id || "";

  if (message.photo) {
    await handlePhoto(
      env,
      message
    );

    return;
  }

  if (
    message.video ||
    (
      message.document &&
      String(
        message.document.mime_type || ""
      ).startsWith("video/")
    )
  ) {
    await handleVideo(
      env,
      message
    );

    return;
  }

  const text =
    extractText(message);

  if (!text) {
    return;
  }

  const command =
    text.split(/\s+/)[0]
      .toLowerCase();

  if (command === "/start") {
    await handleStart(
      env,
      chatId
    );

    return;
  }

  if (command === "/getid") {
    await handleGetId(
      env,
      chatId
    );

    return;
  }

  if (command === "/admin") {
    await handleAdmin(
      env,
      chatId,
      userId
    );

    return;
  }

  if (command === "/lock") {
    await handleLock(
      env,
      chatId
    );

    return;
  }

  if (command === "/cancel") {
    await handleCancel(
      env,
      chatId
    );

    return;
  }

  if (command === "/addproduct") {
    await startAddProduct(
      env,
      chatId,
      userId
    );

    return;
  }

  if (command === "/publish") {
    const session =
      await getSession(
        env,
        chatId
      );

    if (
      session?.data?.unlocked !== true
    ) {
      await sendMessage(
        env,
        chatId,
        `🔒 Unlock admin first with /admin.`
      );

      return;
    }

    if (
      session.step !== "publish"
    ) {
      await sendMessage(
        env,
        chatId,
        `There isn't a finished product ready to publish.`
      );

      return;
    }

    const product =
      await createProductFromSession(
        env,
        chatId
      );

    await sendMessage(
      env,
      chatId,
      `<b>Product published.</b>\n\n` +
      `ID: <code>${product.id}</code>\n` +
      `${escapeHtml(product.title)}\n\n` +
      `🔗 ${productShareUrl(product.id)}`
    );

    await postProductToGroups(
      product,
      env
    );

    await saveSession(
      env,
      chatId,
      userId,
      "unlocked",
      {
        unlocked: true
      }
    );

    return;
  }

  const handled =
    await handleTextFlow(
      env,
      update,
      message
    );

  if (handled) {
    return;
  }

  /*
   * "done" while collecting images
   */
  if (
    text.toLowerCase() === "done"
  ) {
    const session =
      await getSession(
        env,
        chatId
      );

    if (
      session?.step === "images" &&
      session.data?.unlocked === true
    ) {
      const data =
        session.data || {};

      if (
        !Array.isArray(data.images) ||
        data.images.length === 0
      ) {
        await sendMessage(
          env,
          chatId,
          `Please send at least one image, or use /cancel.`
        );

        return;
      }

      await saveSession(
        env,
        chatId,
        userId,
        "video",
        data
      );

      await sendMessage(
        env,
        chatId,
        `Images finished.\n\n` +
        `Send a video or type <b>skip</b>.`
      );

      return;
    }
  }

  await sendMessage(
    env,
    chatId,
    `I don't recognize that command.\n\n` +
    `Use /start, /admin, /getid or /addproduct.`
  );
}

async function setupWebhook(
  request,
  env
) {
  const url =
    new URL(request.url);

  const webhookUrl =
    `${url.origin}/api/telegram/webhook`;

  const result =
    await telegramCall(
      env,
      "setWebhook",
      {
        url: webhookUrl,
        secret_token:
          env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: [
          "message",
          "edited_message",
          "callback_query"
        ]
      }
    );

  return json({
    ok: result.ok === true,
    telegram: result.ok === true,
    webhook: webhookUrl,
    telegram_response: result
  });
}

async function webhookStatus(
  env
) {
  const result =
    await telegramCall(
      env,
      "getWebhookInfo",
      {}
    );

  return json({
    ok: result.ok === true,
    telegram: result
  });
}

async function testGroups(
  env
) {
  const groups =
    telegramGroupIds(env);

  const results = [];

  for (const chatId of groups) {
    const result =
      await sendMessage(
        env,
        chatId,
        `<b>Shopper's Suggestions</b>\n\n` +
        `Telegram group connection test successful.`
      );

    results.push({
      chatId,
      ok: result.ok === true,
      description:
        result.description || null
    });
  }

  return json({
    ok: true,
    groups: results
  });
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      /*
       * Basic environment check.
       */
      if (!env.DB) {
        return json(
          {
            ok: false,
            error: "D1 binding DB is missing."
          },
          500
        );
      }

      await ensureSchema(env);

      const url =
        new URL(request.url);

      const path =
        url.pathname;

      /*
       * Telegram webhook.
       *
       * Always return 200 after processing/error logging,
       * so Telegram doesn't endlessly retry a broken update.
       */
      if (
        path === "/api/telegram/webhook"
      ) {
        const secret =
          request.headers.get(
            "X-Telegram-Bot-Api-Secret-Token"
          );

        if (
          !env.TELEGRAM_WEBHOOK_SECRET ||
          secret !==
            env.TELEGRAM_WEBHOOK_SECRET
        ) {
          console.error(
            "Telegram webhook secret mismatch."
          );

          return new Response(
            "OK",
            { status: 200 }
          );
        }

        let update;

        try {
          update =
            await request.json();
        } catch (error) {
          console.error(
            "Telegram webhook JSON error:",
            error
          );

          return new Response(
            "OK",
            { status: 200 }
          );
        }

        try {
          console.log(
            "Telegram update received:",
            JSON.stringify(update)
          );

          await handleTelegramUpdate(
            env,
            update
          );

        } catch (error) {
          console.error(
            "Telegram update handling error:",
            error
          );
        }

        return new Response(
          "OK",
          { status: 200 }
        );
      }

      /*
       * Webhook setup.
       *
       * Use:
       * /api/telegram/setup?key=YOUR_SETUP_SECRET
       */
      if (
        path === "/api/telegram/setup"
      ) {
        const key =
          url.searchParams.get("key");

        if (
          !key ||
          key !==
            env.TELEGRAM_SETUP_SECRET
        ) {
          return json(
            {
              ok: false,
              error: "Unauthorized"
            },
            401
          );
        }

        return setupWebhook(
          request,
          env
        );
      }

      /*
       * Webhook status.
       *
       * Use:
       * /api/telegram/status?key=YOUR_SETUP_SECRET
       */
      if (
        path === "/api/telegram/status"
      ) {
        const key =
          url.searchParams.get("key");

        if (
          !key ||
          key !==
            env.TELEGRAM_SETUP_SECRET
        ) {
          return json(
            {
              ok: false,
              error: "Unauthorized"
            },
            401
          );
        }

        return webhookStatus(
          env
        );
      }

      /*
       * Test configured groups.
       */
      if (
        path === "/api/telegram/test-groups"
      ) {
        const key =
          url.searchParams.get("key");

        if (
          !key ||
          key !==
            env.TELEGRAM_SETUP_SECRET
        ) {
          return json(
            {
              ok: false,
              error: "Unauthorized"
            },
            401
          );
        }

        return testGroups(
          env
        );
      }

      /*
       * Simple health endpoint.
       */
      if (
        path === "/api/telegram/health"
      ) {
        return json({
          ok: true,
          service:
            "shopper-s-suggestions-telegram"
        });
      }

      return json(
        {
          ok: false,
          error:
            "Telegram Worker route not found."
        },
        404
      );

    } catch (error) {
      console.error(
        "TELEGRAM WORKER ERROR:",
        error
      );

      return json(
        {
          ok: false,
          error:
            "Internal Telegram Worker error."
        },
        500
      );
    }
  }
};
