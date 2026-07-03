// POST /api/briefing/delta -> intradag-oppdatering «nytt siden i morges» (SSE).
// Gjenbruker morgenbriefens cache; maks MAX_DELTAS_PER_DAY (default 2).
export const maxDuration = 300;

import { sseInit, sse, clientIp, logError } from "../../lib/http.js";
import { allowRate } from "../../lib/ratelimit.js";
import { requireAuth } from "../../lib/auth.js";
import { generateDelta } from "../../lib/core.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }
  sseInit(res);
  if (!(await allowRate("delta", clientIp(req), 6, 3600))) {
    sse(res, { type: "error", message: "For mange delta-forsøk fra denne IP-en - prøv igjen om en time." });
    return res.end();
  }
  try {
    const delta = await generateDelta({
      onStatus: (text) => sse(res, { type: "status", text }),
      onText: (text) => sse(res, { type: "text", text }),
    });
    sse(res, { type: "done", delta });
  } catch (e) {
    logError("delta", e).catch(() => {});
    sse(res, { type: "error", message: String(e.message || e) });
  } finally {
    res.end();
  }
}
