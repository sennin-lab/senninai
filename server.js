import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const app = express();

const PORT = Number(process.env.PORT || 3000);
const BOT_UUID = process.env.BOT_UUID || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const UPSTREAM_BASE_URL = (
  process.env.UPSTREAM_BASE_URL ||
  "https://gpt-bot.userlocal.jp"
).replace(/\/+$/, "");

const DATA_DIR = process.env.DATA_DIR || ".data";
const KEYS_FILE = path.join(DATA_DIR, "keys.json");

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 5;
const MAX_MESSAGE_LENGTH = 4000;

const ALLOWED_ROLES = new Set([
  "user",
  "assistant"
]);

app.disable("x-powered-by");

app.use(
  express.json({
    limit: MAX_BODY_BYTES
  })
);

app.use((req, res, next) => {
  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "Referrer-Policy",
    "no-referrer"
  );

  next();
});

app.use(
  express.static("public", {
    index: "index.html"
  })
);

async function loadKeys() {
  await fs.mkdir(DATA_DIR, {
    recursive: true
  });

  try {
    const data = JSON.parse(
      await fs.readFile(KEYS_FILE, "utf8")
    );

    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function saveKeys(keys) {
  await fs.mkdir(DATA_DIR, {
    recursive: true
  });

  const temp = `${KEYS_FILE}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(keys, null, 2),
    {
      mode: 0o600
    }
  );

  await fs.rename(temp, KEYS_FILE);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));

  return (
    aa.length === bb.length &&
    crypto.timingSafeEqual(aa, bb)
  );
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      error: "ADMIN_PASSWORD is not configured"
    });
  }

  const provided =
    req.get("x-admin-password") || "";

  if (!safeEqual(provided, ADMIN_PASSWORD)) {
    return res.status(401).json({
      error: "管理者パスワードが正しくありません"
    });
  }

  next();
}

function normalizeMessages(body) {
  if (
    !body ||
    !Array.isArray(body.messages)
  ) {
    throw Object.assign(
      new Error("messages must be an array"),
      { status: 400 }
    );
  }

  const messages = body.messages
    .slice(-MAX_MESSAGES)
    .map((message) => ({
      role:
        message &&
        ALLOWED_ROLES.has(message.role)
          ? message.role
          : "user",

      content:
        typeof message?.content === "string"
          ? message.content
          : ""
    }));

  if (
    !messages.length ||
    messages.some(
      (message) => !message.content.trim()
    )
  ) {
    throw Object.assign(
      new Error("messages contains an empty item"),
      { status: 400 }
    );
  }

  if (
    messages.some(
      (message) =>
        message.content.length > MAX_MESSAGE_LENGTH
    )
  ) {
    throw Object.assign(
      new Error(
        `Each message must be ${MAX_MESSAGE_LENGTH} characters or fewer`
      ),
      { status: 400 }
    );
  }

  return messages;
}

async function callUserLocal(messages) {
  if (
    !BOT_UUID ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(BOT_UUID)
  ) {
    throw Object.assign(
      new Error(
        "サーバーの BOT_UUID が未設定、または不正です"
      ),
      { status: 503 }
    );
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 20000);

  try {
    const response = await fetch(
      `${UPSTREAM_BASE_URL}/api/web/${encodeURIComponent(BOT_UUID)}`,
      {
        method: "POST",

        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          messages
        }),

        signal: controller.signal
      }
    );

    const raw = await response.text();

    if (!response.ok) {
      throw Object.assign(
        new Error(
          `UserLocal upstream returned ${response.status}`
        ),
        { status: 502 }
      );
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(
        new Error(
          "UserLocal returned an unexpected response"
        ),
        { status: 502 }
      );
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw Object.assign(
        new Error(
          "AIサービスがタイムアウトしました"
        ),
        { status: 504 }
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function extractAnswer(payload) {
  if (typeof payload === "string") {
    return payload;
  }

  const candidates = [
    payload?.choices?.[0]?.message?.content,
    payload?.answer,
    payload?.message,
    payload?.content,
    payload?.response,
    payload?.text,
    payload?.data?.answer,
    payload?.data?.message,
    payload?.data?.content
  ];

  for (const value of candidates) {
    if (typeof value === "string") {
      return value;
    }
  }

  return JSON.stringify(payload);
}

function findApiKey(req) {
  const authorization =
    req.get("authorization") || "";

  if (authorization.startsWith("Bearer ")) {
    return authorization
      .slice(7)
      .trim();
  }

  return (
    req.get("x-api-key") || ""
  ).trim();
}

async function authenticateApiKey(
  req,
  res,
  next
) {
  const token = findApiKey(req);

  if (!token) {
    return res.status(401).json({
      error: {
        message:
          "API key required. Use Authorization: Bearer <key>.",
        type: "authentication_error"
      }
    });
  }

  try {
    const keys = await loadKeys();

    const key = keys.find(
      (item) =>
        item.active &&
        safeEqual(item.key, token)
    );

    if (!key) {
      return res.status(401).json({
        error: {
          message: "Invalid or revoked API key",
          type: "authentication_error"
        }
      });
    }

    key.lastUsedAt = new Date().toISOString();

    await saveKeys(keys);

    req.apiKey = key;

    next();
  } catch (error) {
    next(error);
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "UserLocal API Platform"
  });
});

app.post(
  "/api/admin/verify",
  requireAdmin,
  (_req, res) => {
    res.json({
      ok: true
    });
  }
);

app.get(
  "/api/admin/keys",
  requireAdmin,
  async (_req, res, next) => {
    try {
      const keys = await loadKeys();

      res.json({
        keys: keys.map(
          ({ key, ...safe }) => ({
            ...safe,
            keyPreview:
              key.slice(0, 12) + "..."
          })
        )
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/admin/keys",
  requireAdmin,
  async (req, res, next) => {
    try {
      const label =
        typeof req.body?.label === "string"
          ? req.body.label.trim().slice(0, 60)
          : "";

      if (!label) {
        return res.status(400).json({
          error: "キー名を入力してください"
        });
      }

      const keys = await loadKeys();

      const key =
        "ul_" +
        crypto.randomBytes(32).toString("hex");

      const item = {
        id: crypto.randomUUID(),
        label,
        key,
        active: true,
        createdAt: new Date().toISOString(),
        lastUsedAt: null
      };

      keys.unshift(item);

      await saveKeys(keys);

      res.status(201).json({
        key: item.key,
        id: item.id,
        label: item.label,
        createdAt: item.createdAt
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/admin/keys/:id/revoke",
  requireAdmin,
  async (req, res, next) => {
    try {
      const keys = await loadKeys();

      const item = keys.find(
        (key) => key.id === req.params.id
      );

      if (!item) {
        return res.status(404).json({
          error: "APIキーが見つかりません"
        });
      }

      item.active = false;
      item.revokedAt = new Date().toISOString();

      await saveKeys(keys);

      res.json({
        ok: true
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/v1/chat/completions",
  authenticateApiKey,
  async (req, res) => {
    try {
      const messages = normalizeMessages(
        req.body
      );

      const upstream = await callUserLocal(
        messages
      );

      const content = extractAnswer(
        upstream
      );

      res.json({
        id:
          "chatcmpl-" +
          crypto.randomBytes(12).toString("hex"),

        object: "chat.completion",

        created: Math.floor(
          Date.now() / 1000
        ),

        model: "userlocal-bot",

        choices: [
          {
            index: 0,

            message: {
              role: "assistant",
              content
            },

            finish_reason: "stop"
          }
        ],

        usage: {
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null
        }
      });
    } catch (error) {
      const status = error.status || 500;

      res.status(status).json({
        error: {
          message:
            status >= 500 &&
            status !== 503 &&
            status !== 504
              ? "AIサービスへの接続に失敗しました"
              : error.message,

          type: "api_error"
        }
      });
    }
  }
);

app.post(
  "/api/playground/chat",
  requireAdmin,
  async (req, res) => {
    try {
      const messages = normalizeMessages(
        req.body
      );

      const upstream = await callUserLocal(
        messages
      );

      res.json({
        content: extractAnswer(upstream)
      });
    } catch (error) {
      const status = error.status || 500;

      res.status(status).json({
        error:
          status >= 500
            ? "AIサービスへの接続に失敗しました。BOT_UUIDと外部サービスの応答を確認してください。"
            : error.message
      });
    }
  }
);

app.use((error, _req, res, _next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({
      error: "Request body too large"
    });
  }

  console.error(
    "Request failed:",
    error?.message || error
  );

  res.status(error.status || 500).json({
    error: "Internal server error"
  });
});

app.listen(PORT, () => {
  console.log(
    `UserLocal API Platform listening on port ${PORT}`
  );

  if (!BOT_UUID) {
    console.warn(
      "BOT_UUID is not configured."
    );
  }

  if (!ADMIN_PASSWORD) {
    console.warn(
      "ADMIN_PASSWORD is not configured."
    );
  }
});
