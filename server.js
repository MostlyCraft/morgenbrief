// MORGENBRIEF lokal server (npm run dev) - null avhengigheter, ren node:http.
// All logikk bor i lib/core.js og deles med Vercel-functions i api/.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/env.js";
loadEnv();

import { json, readBody, sseInit, sse } from "./lib/http.js";
import { isAuthed, handleLoginPost, LOGIN_HTML } from "./lib/auth.js";
import {
  metaInfo, generateBrief, chatReply, getQuotesCached,
  MAX_BRIEFS_PER_DAY, MAX_CHATS_PER_DAY,
} from "./lib/core.js";
import {
  ensureDirs, getSettings, saveSettings, getTodayFocus, saveTodayFocus,
  readTodayBriefing, getChatHistory, saveChatHistory, nowCET, storageMode,
} from "./lib/store.js";
import { modelName, chatModelName, hasKey } from "./lib/anthropic.js";

ensureDirs();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(req, res, urlPath) {
  let p = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

async function streamHandler(res, fn) {
  sseInit(res);
  try {
    const done = await fn(
      (text) => sse(res, { type: "status", text }),
      (text) => sse(res, { type: "text", text })
    );
    sse(res, { type: "done", ...(done || {}) });
  } catch (e) {
    sse(res, { type: "error", message: String(e.message || e) });
  } finally {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const m = req.method;

  try {
    if (m === "POST" && p === "/api/login") {
      const body = await readBody(req).catch(() => ({}));
      return handleLoginPost(req, res, body);
    }
    if (!isAuthed(req)) {
      if (p.startsWith("/api/")) return json(res, 401, { error: "Ikke innlogget" });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(LOGIN_HTML);
    }

    if (m === "GET" && p === "/api/meta") return json(res, 200, await metaInfo());
    if (m === "GET" && p === "/api/settings") return json(res, 200, await getSettings());
    if (m === "PUT" && p === "/api/settings") {
      try { return json(res, 200, await saveSettings(await readBody(req))); }
      catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }
    if (m === "GET" && p === "/api/focus/today") {
      return json(res, 200, { items: await getTodayFocus(), favorites: (await getSettings()).favorites });
    }
    if (m === "PUT" && p === "/api/focus/today") {
      try { return json(res, 200, { items: await saveTodayFocus((await readBody(req)).items) }); }
      catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }
    if (m === "GET" && p === "/api/quotes") {
      try { return json(res, 200, await getQuotesCached({ fresh: url.searchParams.get("fresh") === "1" })); }
      catch (e) { return json(res, 500, { error: String(e.message || e) }); }
    }
    if (m === "GET" && p === "/api/briefing/today") {
      const b = await readTodayBriefing();
      return b ? json(res, 200, { exists: true, ...b }) : json(res, 200, { exists: false });
    }
    if (m === "POST" && p === "/api/briefing/generate") {
      const body = await readBody(req).catch(() => ({}));
      return streamHandler(res, (onStatus, onText) =>
        generateBrief({ focus: body.focus, force: Boolean(body.force), onStatus, onText }));
    }
    if (m === "GET" && p === "/api/chat/today") return json(res, 200, { messages: await getChatHistory() });
    if (m === "DELETE" && p === "/api/chat/today") { await saveChatHistory([]); return json(res, 200, { ok: true }); }
    if (m === "POST" && p === "/api/chat") {
      const body = await readBody(req).catch(() => ({}));
      const msg = String(body?.message || "").trim();
      if (!msg) { sseInit(res); sse(res, { type: "error", message: "Tom melding." }); return res.end(); }
      return streamHandler(res, async (onStatus, onText) => {
        const r = await chatReply({ message: msg, onStatus, onText });
        return { sources: r.sources || [] };
      });
    }

    if (m === "GET") return serveStatic(req, res, p);
    res.writeHead(405);
    res.end();
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  const { date, time } = nowCET();
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((n) => n && n.family === "IPv4" && !n.internal)?.address;
  console.log(`\n  MORGENBRIEF  //  http://localhost:${PORT}`);
  if (lan) console.log(`  på mobil (samme nett): http://${lan}:${PORT}`);
  console.log(`  ${date} kl. ${time} CET  |  brief: ${modelName()}  |  chat: ${chatModelName()}  |  lagring: ${storageMode()}`);
  console.log(`  anthropic-nøkkel: ${hasKey() ? "OK" : "MANGLER (.env)"}  |  finnhub: ${process.env.FINNHUB_API_KEY ? "OK" : "ikke satt (Yahoo dekker alt)"}`);
  console.log(`  tilgangskode: ${process.env.SITE_PASSWORD ? "PÅ" : "AV - sett SITE_PASSWORD i .env før du deler lenken"}  |  tak: ${MAX_BRIEFS_PER_DAY} briefer / ${MAX_CHATS_PER_DAY} chat per dag\n`);
});
