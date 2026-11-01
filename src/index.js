const CONFIG = {
  name: "Sennin AI API",
  version: "1.0.0",
  provider: "UserLocal",
  botUuid: "399bfdc8",
  baseUrl: "https://gpt-bot.userlocal.jp",
  maxMessageLength: 2000,
  maxHistoryMessages: 5
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (path === "/") {
      return json({
        name: CONFIG.name,
        version: CONFIG.version,
        status: "online",
        provider: CONFIG.provider,
        endpoints: {
          info: "/api",
          health: "/api/health",
          chat: "/api/chat?message=こんにちは"
        },
        usage: {
          method: "GET",
          example: "/api/chat?message=" + encodeURIComponent("こんにちは")
        }
      });
    }

    if (path === "/api") {
      return json({
        name: CONFIG.name,
        version: CONFIG.version,
        description: "UserLocalを利用するチャットAPI",
        authentication: "none",
        endpoints: [
          {
            path: "/",
            method: "GET",
            description: "APIのトップページ"
          },
          {
            path: "/api",
            method: "GET",
            description: "APIの情報"
          },
          {
            path: "/api/health",
            method: "GET",
            description: "稼働状態の確認"
          },
          {
            path: "/api/chat?message=こんにちは",
            method: "GET",
            description: "メッセージを送信して回答を取得"
          },
          {
            path: "/api/chat",
            method: "POST",
            description: "JSON形式でメッセージを送信"
          }
        ]
      });
    }

    if (path === "/api/health") {
      return json({
        status: "ok",
        service: CONFIG.name,
        timestamp: new Date().toISOString()
      });
    }

    if (path === "/api/chat" && request.method === "GET") {
      const message = url.searchParams.get("message");

      if (!message || !message.trim()) {
        return json({
          error: {
            message: "message パラメータが必要です。",
            example: "/api/chat?message=" +
              encodeURIComponent("こんにちは")
          }
        }, 400);
      }

      return handleChat(message, []);
    }

    if (path === "/api/chat" && request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({
          error: {
            message: "リクエスト本文は有効なJSONである必要があります。"
          }
        }, 400);
      }

      let message = "";
      let history = [];

      if (typeof body.message === "string") {
        message = body.message;
      } else if (Array.isArray(body.messages)) {
        const messages = body.messages
          .filter(item =>
            item &&
            typeof item.content === "string" &&
            ["user", "assistant"].includes(item.role)
          )
          .slice(-CONFIG.maxHistoryMessages);

        const lastUserIndex = messages.findLastIndex(
          item => item.role === "user"
        );

        if (lastUserIndex === -1) {
          return json({
            error: {
              message: "messages に user メッセージが必要です。"
            }
          }, 400);
        }

        message = messages[lastUserIndex].content;

        history = messages
          .slice(0, lastUserIndex)
          .map(item => ({
            role: item.role,
            content: item.content
          }));
      }

      if (!message.trim()) {
        return json({
          error: {
            message: "message または messages を指定してください。"
          }
        }, 400);
      }

      return handleChat(message, history);
    }

    return json({
      error: {
        message: "エンドポイントが見つかりません。",
        path
      }
    }, 404);
  }
};

async function handleChat(message, history) {
  message = String(message).trim();

  if (message.length > CONFIG.maxMessageLength) {
    return json({
      error: {
        message: `メッセージは${CONFIG.maxMessageLength}文字以内にしてください。`
      }
    }, 400);
  }

  const messages = [
    ...history,
    {
      role: "user",
      content: message
    }
  ].slice(-CONFIG.maxHistoryMessages);

  const upstreamUrl =
    `${CONFIG.baseUrl}/api/web/${CONFIG.botUuid}`;

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        messages
      }),
      signal: AbortSignal.timeout(25000)
    });

    const responseText = await upstreamResponse.text();

    let upstreamData;

    try {
      upstreamData = JSON.parse(responseText);
    } catch {
      upstreamData = {
        raw: responseText
      };
    }

    if (!upstreamResponse.ok) {
      return json({
        error: {
          message: "UserLocalからエラーが返されました。",
          upstreamStatus: upstreamResponse.status,
          details: upstreamData
        }
      }, 502);
    }

    const answer = extractAnswer(upstreamData);

    if (!answer) {
      return json({
        error: {
          message: "回答を取得できませんでした。",
          details: upstreamData
        }
      }, 502);
    }

    return json({
      id: crypto.randomUUID(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      provider: CONFIG.provider,
      model: "userlocal-bot",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: answer
          },
          finish_reason: "stop"
        }
      ],
      answer
    });
  } catch (error) {
    return json({
      error: {
        message: "AIサービスへの接続に失敗しました。",
        details: error?.name === "TimeoutError"
          ? "UserLocalの応答がタイムアウトしました。"
          : String(error?.message || error)
      }
    }, 502);
  }
}

function extractAnswer(data) {
  if (typeof data === "string") {
    return data.trim();
  }

  if (!data || typeof data !== "object") {
    return "";
  }

  const candidates = [
    data.answer,
    data.response,
    data.reply,
    data.message,
    data.content,
    data.text,
    data.result,
    data.output,
    data.choices?.[0]?.message?.content,
    data.choices?.[0]?.text,
    data.data?.answer,
    data.data?.response,
    data.data?.message,
    data.data?.content,
    data.data?.text
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
