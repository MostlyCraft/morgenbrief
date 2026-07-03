// GET /api/history -> bull/bear-serie siste 30 dager (for sparklines/aksjekort).
import { json } from "../lib/http.js";
import { requireAuth } from "../lib/auth.js";
import { getBbHistoryRange } from "../lib/store.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  try {
    json(res, 200, { series: await getBbHistoryRange(30) });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}
