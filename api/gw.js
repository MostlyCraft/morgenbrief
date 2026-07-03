// api/gw.js - samle-gateway: ALLE JSON-endepunkter i ÉN Vercel-function.
// Hobby-planen tillater maks 12 functions; rewrites i vercel.json peker de
// gamle URL-ene hit med ?fn=..., så frontend og lokal server er uendret.
// Streaming-endepunktene (generate/delta/chat) beholder egne filer pga.
// SSE + maxDuration=300.
export const maxDuration = 60;

import { json, readBody, clientIp } from "../lib/http.js";
import { requireAuth, handleLoginPost, LOGIN_HTML } from "../lib/auth.js";
import { metaInfo, getQuotesCached } from "../lib/core.js";
import {
  getSettings, saveSettings, getTodayFocus, saveTodayFocus,
  readTodayBriefing, getChatHistory, saveChatHistory,
  getBbHistoryRange, getProfiles, addProfile, storageMode, nowCET, todayKey,
} from "../lib/store.js";
import { kvAvailable, kvGetJSON } from "../lib/kv.js";
import { hasKey, modelName } from "../lib/anthropic.js";
import { getStructuredData } from "../lib/marketdata.js";

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const q = url.searchParams;
  const fn = (req.query?.fn ?? q.get("fn")) || "";
  const profile = (req.query?.profile ?? q.get("profile")) || "";
  const m = req.method;

  try {
    // ---- åpne endepunkter (ingen auth) ----
    if (fn === "health") {
      if (m !== "GET") { res.writeHead(405); return res.end(); }
      let kv = null;
      let errors = null;
      if (kvAvailable()) {
        try {
          const log = await kvGetJSON("mb:errlog");
          kv = true;
          errors = Array.isArray(log) ? log.length : 0;
        } catch { kv = false; }
      }
      return json(res, 200, {
        ok: true, today: todayKey(), time: nowCET().time + " CET",
        storage: storageMode(), kvReachable: kv, anthropicKey: hasKey(),
        model: modelName(), recentErrors: errors,
      });
    }
    if (fn === "login") {
      if (m === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(LOGIN_HTML);
      }
      if (m !== "POST") { res.writeHead(405); return res.end(); }
      return handleLoginPost(req, res, await readBody(req).catch(() => ({})), clientIp(req));
    }

    // ---- alt annet krever innlogging ----
    if (!requireAuth(req, res)) return;

    switch (fn) {
      case "meta": {
        if (m !== "GET") break;
        return json(res, 200, await metaInfo());
      }
      case "settings": {
        if (m === "GET") return json(res, 200, await getSettings(profile));
        if (m === "PUT") {
          try { return json(res, 200, await saveSettings(await readBody(req), profile)); }
          catch (e) { return json(res, 400, { error: String(e.message || e) }); }
        }
        break;
      }
      case "quotes": {
        if (m !== "GET") break;
        const fresh = (req.query?.fresh ?? q.get("fresh")) === "1";
        return json(res, 200, await getQuotesCached({ fresh, profile }));
      }
      case "data": {
        if (m !== "GET") break;
        return json(res, 200, await getStructuredData((await getSettings(profile)).favorites));
      }
      case "focus": {
        if (m === "GET") return json(res, 200, { items: await getTodayFocus(), favorites: (await getSettings()).favorites });
        if (m === "PUT") {
          try { return json(res, 200, { items: await saveTodayFocus((await readBody(req)).items) }); }
          catch (e) { return json(res, 400, { error: String(e.message || e) }); }
        }
        break;
      }
      case "brieftoday": {
        if (m !== "GET") break;
        const b = await readTodayBriefing();
        return b ? json(res, 200, { exists: true, ...b }) : json(res, 200, { exists: false });
      }
      case "chatlog": {
        if (m === "GET") return json(res, 200, { messages: await getChatHistory() });
        if (m === "DELETE") { await saveChatHistory([]); return json(res, 200, { ok: true }); }
        break;
      }
      case "history": {
        if (m !== "GET") break;
        return json(res, 200, { series: await getBbHistoryRange(30) });
      }
      case "profiles": {
        if (m === "GET") return json(res, 200, { profiles: await getProfiles() });
        if (m === "POST") {
          try { return json(res, 200, { added: await addProfile((await readBody(req)).name) }); }
          catch (e) { return json(res, 400, { error: String(e.message || e) }); }
        }
        break;
      }
      default:
        return json(res, 404, { error: `ukjent fn: ${fn}` });
    }
    res.writeHead(405);
    res.end();
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}
