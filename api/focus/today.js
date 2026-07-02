// GET /api/focus/today -> dagens fokus + favoritter. PUT -> lagre dagens fokus.
import { json, readBody } from "../../lib/http.js";
import { requireAuth } from "../../lib/auth.js";
import { getSettings, getTodayFocus, saveTodayFocus } from "../../lib/store.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === "GET") {
      return json(res, 200, { items: await getTodayFocus(), favorites: (await getSettings()).favorites });
    }
    if (req.method === "PUT") {
      try { return json(res, 200, { items: await saveTodayFocus((await readBody(req)).items) }); }
      catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }
    res.writeHead(405);
    res.end();
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}
