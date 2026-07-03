// GET /api/health -> driftsstatus (offentlig, ingen hemmeligheter).
import { json } from "../lib/http.js";
import { storageMode, nowCET, todayKey } from "../lib/store.js";
import { kvAvailable, kvGetJSON } from "../lib/kv.js";
import { hasKey, modelName } from "../lib/anthropic.js";

export default async function handler(req, res) {
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  let kv = null;
  let errors = null;
  if (kvAvailable()) {
    try {
      const log = await kvGetJSON("mb:errlog");
      kv = true;
      errors = Array.isArray(log) ? log.length : 0;
    } catch {
      kv = false;
    }
  }
  json(res, 200, {
    ok: true,
    today: todayKey(),
    time: nowCET().time + " CET",
    storage: storageMode(),
    kvReachable: kv,
    anthropicKey: hasKey(),
    model: modelName(),
    recentErrors: errors,
  });
}
