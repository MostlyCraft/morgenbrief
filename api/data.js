// GET /api/data -> strukturert datapakke: innsidehandel (EDGAR), børsmeldinger
// (NewsWeb), makrotall (FRED), neste 7 dager (Finnhub/FRED). Per-del cache.
import { json } from "../lib/http.js";
import { requireAuth } from "../lib/auth.js";
import { getSettings } from "../lib/store.js";
import { getStructuredData } from "../lib/marketdata.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  const profile = (req.query?.profile ?? new URL(req.url, "http://x").searchParams.get("profile")) || "";
  try {
    json(res, 200, await getStructuredData((await getSettings(profile)).favorites));
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}
