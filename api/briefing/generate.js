// POST /api/briefing/generate -> genererer dagens brief (SSE-strøm).
// Cache-først: finnes dagens brief og force!=true, returneres cachen uten API-kall.
export const maxDuration = 300; // websøk-generering kan ta 1-3 min

import { readBody, sseInit, sse } from "../../lib/http.js";
import { requireAuth } from "../../lib/auth.js";
import { generateBrief } from "../../lib/core.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }
  let body = {};
  try { body = await readBody(req); } catch { /* tom body er ok */ }

  sseInit(res);
  try {
    const done = await generateBrief({
      focus: body.focus,
      force: Boolean(body.force),
      onStatus: (text) => sse(res, { type: "status", text }),
      onText: (text) => sse(res, { type: "text", text }),
    });
    sse(res, { type: "done", ...done });
  } catch (e) {
    sse(res, { type: "error", message: String(e.message || e) });
  } finally {
    res.end();
  }
}
