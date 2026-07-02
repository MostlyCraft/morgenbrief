// GET /api/chat/today -> dagens chat-historikk. DELETE -> tøm.
import { json } from "../../lib/http.js";
import { requireAuth } from "../../lib/auth.js";
import { getChatHistory, saveChatHistory } from "../../lib/store.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === "GET") return json(res, 200, { messages: await getChatHistory() });
    if (req.method === "DELETE") { await saveChatHistory([]); return json(res, 200, { ok: true }); }
    res.writeHead(405);
    res.end();
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}
