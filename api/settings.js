// GET /api/settings -> favoritter. PUT -> lagre favoritter.
import { json, readBody } from "../lib/http.js";
import { requireAuth } from "../lib/auth.js";
import { getSettings, saveSettings } from "../lib/store.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === "GET") return json(res, 200, await getSettings());
    if (req.method === "PUT") {
      try { return json(res, 200, await saveSettings(await readBody(req))); }
      catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }
    res.writeHead(405);
    res.end();
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}
