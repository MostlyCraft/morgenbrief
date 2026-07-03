// GET /api/quotes -> kurs-tape (indekser + fokus-tickere), KV-cachet 5 min.
import { json } from "../lib/http.js";
import { requireAuth } from "../lib/auth.js";
import { getQuotesCached } from "../lib/core.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  try {
    const q = new URL(req.url, "http://x").searchParams;
    const fresh = (req.query?.fresh ?? q.get("fresh")) === "1";
    const profile = (req.query?.profile ?? q.get("profile")) || "";
    json(res, 200, await getQuotesCached({ fresh, profile }));
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}
