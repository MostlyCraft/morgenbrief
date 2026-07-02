// GET /api/quotes -> kurs-tape (indekser + fokus-tickere), KV-cachet 5 min.
import { json } from "../lib/http.js";
import { requireAuth } from "../lib/auth.js";
import { getQuotesCached } from "../lib/core.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  try {
    const fresh = (req.query?.fresh ?? new URL(req.url, "http://x").searchParams.get("fresh")) === "1";
    json(res, 200, await getQuotesCached({ fresh }));
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}
