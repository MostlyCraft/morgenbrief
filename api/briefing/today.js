// GET /api/briefing/today -> dagens cachede brief (markdown + meta), ingen API-kall.
import { json } from "../../lib/http.js";
import { requireAuth } from "../../lib/auth.js";
import { readTodayBriefing } from "../../lib/store.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  try {
    const b = await readTodayBriefing();
    return b ? json(res, 200, { exists: true, ...b }) : json(res, 200, { exists: false });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}
