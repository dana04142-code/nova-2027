// NOVA backend: Netlify Function -> Google Gemini API.
// Secrets live ONLY in Netlify environment variables. Never put a key in this file.
// Env: GEMINI_API_KEY (required) | MODEL (default gemini-3.8-flash) | RATE_PER_MIN (10) | RATE_PER_DAY (120) | ALLOWED_ORIGIN (optional)

const MODEL = () => process.env.MODEL || "gemini-3.8-flash";
const PER_MIN = () => Number(process.env.RATE_PER_MIN) || 10;
const PER_DAY = () => Number(process.env.RATE_PER_DAY) || 120;
const hits = new Map(); // best-effort, per warm function instance (see README)

const out = (status, reply) => ({
  statusCode: status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify({ reply })
});

function limited(ip) {
  const n = Date.now();
  const h = hits.get(ip) || { m: [], d: [] };
  h.m = h.m.filter(t => n - t < 60000);
  h.d = h.d.filter(t => n - t < 86400000);
  hits.set(ip, h);
  if (h.m.length >= PER_MIN()) return "Too many requests. Please wait a minute and try again.";
  if (h.d.length >= PER_DAY()) return "Daily message limit reached for this device. Try again tomorrow.";
  h.m.push(n); h.d.push(n);
  if (hits.size > 2000) for (const [k, v] of hits) if (!v.d.length || n - v.d[v.d.length - 1] > 86400000) hits.delete(k);
  return null;
}

function explain(status, msg, model) {
  const m = String(msg || "").slice(0, 200);
  if (status === 400) return "Gemini rejected the request: " + (m || "bad request") + ".";
  if (status === 401 || status === 403) return "Gemini refused the key or the model \"" + model + "\" isn't available to it. Check GEMINI_API_KEY and MODEL in Netlify.";
  if (status === 404) return "Model \"" + model + "\" was not found. Set MODEL in Netlify to a model your account can use (see Google AI Studio).";
  if (status === 429) return "Gemini's free-tier limit was reached. Wait a minute and try again.";
  if (status >= 500) return "Gemini is temporarily unavailable. Try again shortly.";
  return "Gemini returned an unexpected error (" + status + ").";
}

async function callGemini(model, body, signal) {
  return fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify(body)
  });
}

exports.handler = async (e) => {
  if (e.httpMethod !== "POST") return out(405, "Method not allowed.");
  const h = e.headers || {};
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && h.origin && h.origin !== allowed) return out(403, "This origin is not allowed.");
  if (!process.env.GEMINI_API_KEY) return out(500, "The server has no GEMINI_API_KEY. Add it in Netlify > Site configuration > Environment variables, then redeploy.");
  if ((e.body || "").length > 60000) return out(413, "Message too large.");

  let data;
  try { data = JSON.parse(e.body || "{}"); } catch (x) { return out(400, "Invalid request."); }
  let msgs = (Array.isArray(data.messages) ? data.messages : [])
    .filter(x => x && typeof x.content === "string" && x.content.trim())
    .slice(-20)
    .map(x => ({ role: x.role === "user" ? "user" : "model", parts: [{ text: x.content.slice(0, 4000) }] }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return out(400, "Send a message first.");

  const ip = h["x-nf-client-connection-ip"] || (h["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const lim = limited(ip);
  if (lim) return out(429, lim);

  const model = MODEL();
  const body = {
    contents: msgs,
    generationConfig: { maxOutputTokens: 4096 }
  };
  if (typeof data.system === "string" && data.system.trim()) body.systemInstruction = { parts: [{ text: data.system.slice(0, 500) }] };
  if (/^gemini-3/.test(model)) body.generationConfig.thinkingConfig = { thinkingLevel: "low" };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 24000);
  try {
    let r = await callGemini(model, body, ctl.signal);
    let j = await r.json().catch(() => ({}));
    if (r.status === 400 && body.generationConfig.thinkingConfig && /think/i.test((j.error && j.error.message) || "")) {
      delete body.generationConfig.thinkingConfig; // retry without the optional setting
      r = await callGemini(model, body, ctl.signal);
      j = await r.json().catch(() => ({}));
    }
    if (!r.ok) return out(r.status === 429 ? 429 : 502, explain(r.status, j.error && j.error.message, model));
    if (j.promptFeedback && j.promptFeedback.blockReason) return out(200, "Gemini blocked that request (" + j.promptFeedback.blockReason + "). Try rephrasing.");
    const c = (j.candidates || [])[0] || {};
    const text = ((c.content && c.content.parts) || []).map(p => p.text || "").join("").trim();
    if (!text) return out(200, c.finishReason === "SAFETY" ? "Gemini declined to answer that. Try rephrasing." : "Gemini returned an empty reply. Try again.");
    return out(200, c.finishReason === "MAX_TOKENS" ? text + "\n\n(Reply was cut short.)" : text);
  } catch (x) {
    return out(504, x && x.name === "AbortError" ? "Gemini took too long to answer. Try a shorter message." : "Could not reach Gemini. Try again.");
  } finally { clearTimeout(timer); }
};
