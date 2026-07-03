// POST /api/chat -> desk-chat med dagens brief som kontekst (SSE-strøm).
export const maxDuration = 300;

import { readBody, sseInit, sse, clientIp, logError } from "../../lib/http.js";
import { allowRate } from "../../lib/ratelimit.js";
import { requireAuth } from "../../lib/auth.js";
import { chatReply } from "../../lib/core.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }
  let body = {};
  try { body = await readBody(req); } catch { /* håndteres under */ }
  const message = String(body?.message || "").trim();

  sseInit(res);
  if (!(await allowRate("chat", clientIp(req), 30, 3600))) {
    sse(res, { type: "error", message: "For mange chat-meldinger fra denne IP-en - prøv igjen om en time." });
    return res.end();
  }
  if (!message) {
    sse(res, { type: "error", message: "Tom melding." });
    return res.end();
  }
  try {
    const r = await chatReply({
      message,
      onStatus: (text) => sse(res, { type: "status", text }),
      onText: (text) => sse(res, { type: "text", text }),
    });
    sse(res, { type: "done", sources: r.sources || [] });
  } catch (e) {
    logError("chat", e).catch(() => {});
    sse(res, { type: "error", message: String(e.message || e) });
  } finally {
    res.end();
  }
}
