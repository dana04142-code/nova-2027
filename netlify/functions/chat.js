
// NOVA 2027 - Netlify Gemini Backend
// API key must remain in Netlify environment variables.
// Required: GEMINI_API_KEY
// Optional: MODEL, RATE_PER_MIN, RATE_PER_DAY, ALLOWED_ORIGIN

const MODEL = () => process.env.MODEL || "gemini-3.8-flash";
const PER_MIN = () => Number(process.env.RATE_PER_MIN) || 10;
const PER_DAY = () => Number(process.env.RATE_PER_DAY) || 120;

const hits = new Map();

const out = (status, reply) => ({
  statusCode: status,
  headers: {
    "content-type": "application/json",
    "cache-control": "no-store"
  },
  body: JSON.stringify({ reply })
});

function limited(ip) {
  const now = Date.now();
  const h = hits.get(ip) || { m: [], d: [] };

  h.m = h.m.filter(t => now - t < 60000);
  h.d = h.d.filter(t => now - t < 86400000);

  if (h.m.length >= PER_MIN()) return "Too many requests. Wait a minute.";
  if (h.d.length >= PER_DAY()) return "Daily message limit reached.";

  h.m.push(now);
  h.d.push(now);
  hits.set(ip, h);

  return null;
}

async function callGemini(model, body, signal) {
  return fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) + ":generateContent",
    {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify(body)
    }
  );
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return out(405, "Method not allowed.");
  }

  const headers = event.headers || {};
  const allowed = process.env.ALLOWED_ORIGIN;

  if (allowed && headers.origin && headers.origin !== allowed) {
    return out(403, "This website origin is not allowed.");
  }

  if (!process.env.GEMINI_API_KEY) {
    return out(500, "GEMINI_API_KEY is missing in Netlify.");
  }

  if ((event.body || "").length > 60000) {
    return out(413, "Message is too large.");
  }

  let data;

  try {
    data = JSON.parse(event.body || "{}");
  } catch {
    return out(400, "Invalid request format.");
  }

  let messages = (Array.isArray(data.messages) ? data.messages : [])
    .filter(x => x && typeof x.content === "string" && x.content.trim())
    .slice(-20)
    .map(x => ({
      role: x.role === "user" ? "user" : "model",
      parts: [{ text: x.content.slice(0, 4000) }]
    }));

  while (messages.length && messages[0].role !== "user") {
    messages.shift();
  }

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return out(400, "Send a message first.");
  }

  const ip =
    headers["x-nf-client-connection-ip"] ||
    (headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown";

  const limit = limited(ip);
  if (limit) return out(429, limit);

  const model = MODEL();

  const body = {
    contents: messages,
    generationConfig: {
      maxOutputTokens: 2048
    }
  };

  if (typeof data.system === "string" && data.system.trim()) {
    body.systemInstruction = {
      parts: [{ text: data.system.slice(0, 500) }]
    };
  }

  if (/^gemini-3/.test(model)) {
    body.generationConfig.thinkingConfig = {
      thinkingLevel: "low"
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 24000);

  try {
    let response = await callGemini(model, body, controller.signal);
    let result = await response.json().catch(() => ({}));

    if (
      response.status === 400 &&
      body.generationConfig.thinkingConfig &&
      /think/i.test(result.error?.message || "")
    ) {
      delete body.generationConfig.thinkingConfig;
      response = await callGemini(model, body, controller.signal);
      result = await response.json().catch(() => ({}));
    }

    if (!response.ok) {
      const message = String(result.error?.message || "No details provided")
        .slice(0, 250);

      return out(
        response.status,
        "Gemini error " + response.status + ": " + message
      );
    }

    if (result.promptFeedback?.blockReason) {
      return out(200, "Gemini blocked this request. Try rephrasing.");
    }

    const candidate = result.candidates?.[0] || {};

    const reply = (candidate.content?.parts || [])
      .map(part => part.text || "")
      .join("")
      .trim();

    if (!reply) {
      return out(
        200,
        candidate.finishReason === "SAFETY"
          ? "Gemini declined this request. Try rephrasing."
          : "Gemini returned an empty reply. Try again."
      );
    }

    return out(
      200,
      candidate.finishReason === "MAX_TOKENS"
        ? reply + "\n\n(Reply was cut short.)"
        : reply
    );

  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "Gemini request timed out."
        : String(error?.message || "Network request failed").slice(0, 200);

    console.error("NOVA Gemini error:", message);

    return out(504, message);

  } finally {
    clearTimeout(timer);
  }
};
