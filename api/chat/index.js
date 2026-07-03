// POST /api/chat -> desk-chat med dagens brief som kontekst (SSE-strøm).
export const maxDuration = 300;

import { readBody, sseInit, sse } from "../../lib/http.js";
import { requireAuth } from "../../lib/auth.js";
import { chatReply } from "../../lib/core.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }
  let body = {};
  try { body = await readBody(req); } catch { /* håndteres under */ }
  const message = String(body?.message || "").trim();

  sseInit(res);
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
    sse(res, { type: "error", message: String(e.message || e) });
  } finally {
    res.end();
  }
}
