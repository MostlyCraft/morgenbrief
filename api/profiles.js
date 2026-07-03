// GET /api/profiles -> liste. POST {name} -> legg til (lett profilsystem, fase 3).
// Profiler styrer egen watchlist for tape/widgets; briefen er felles (bevisst,
// for å bevare 1-brief/dag-cachen).
import { json, readBody } from "../lib/http.js";
import { requireAuth } from "../lib/auth.js";
import { getProfiles, addProfile } from "../lib/store.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === "GET") return json(res, 200, { profiles: await getProfiles() });
    if (req.method === "POST") {
      try { return json(res, 200, { added: await addProfile((await readBody(req)).name) }); }
      catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }
    res.writeHead(405);
    res.end();
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}
