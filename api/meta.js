// GET /api/meta -> dato/klokke, modeller, nøkkelstatus, finnes brief/fokus i dag.
import { json } from "../lib/http.js";
import { requireAuth } from "../lib/auth.js";
import { metaInfo } from "../lib/core.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  try {
    json(res, 200, await metaInfo());
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}
