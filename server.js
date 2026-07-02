// MORGENBRIEF server - null avhengigheter, ren node:http. Kjør: npm run dev
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/env.js";
import {
  ensureDirs, getSettings, saveSettings,
  getTodayFocus, saveTodayFocus,
  saveBriefing, readTodayBriefing, todayKey, nowCET,
  getChatHistory, saveChatHistory,
  getUsage, bumpUsage,
} from "./lib/store.js";
import { getAllQuotes, quotesForPrompt } from "./lib/quotes.js";
import { streamCompletion, modelName, chatModelName, hasKey } from "./lib/anthropic.js";
import { briefingSystem, briefingUser, chatSystem } from "./lib/prompts.js";

loadEnv();
ensureDirs();

// Kostnadsknapper (kan overstyres i .env)
const BRIEF_MAX_TOKENS = Number(process.env.BRIEF_MAX_TOKENS || 3500);
const BRIEF_MAX_SEARCHES = Number(process.env.BRIEF_MAX_SEARCHES || 8);
const CHAT_MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS || 1200);
const CHAT_MAX_SEARCHES = Number(process.env.CHAT_MAX_SEARCHES || 3);

// Dagstak (kredittvern når siden deles) + valgfri tilgangskode
const MAX_BRIEFS_PER_DAY = Number(process.env.MAX_BRIEFS_PER_DAY || 6);
const MAX_CHATS_PER_DAY = Number(process.env.MAX_CHATS_PER_DAY || 60);
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const AUTH_TOKEN = SITE_PASSWORD
  ? crypto.createHash("sha256").update(SITE_PASSWORD).digest("hex")
  : "";

function isAuthed(req) {
  if (!SITE_PASSWORD) return true;
  const c = req.headers.cookie || "";
  return c.split(";").some((kv) => kv.trim() === `mb_auth=${AUTH_TOKEN}`);
}

const LOGIN_HTML = `<!DOCTYPE html><html lang="nb"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>MORGENBRIEF</title><style>body{background:#06080b;color:#c7d3dd;font-family:Consolas,ui-monospace,Menlo,monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}form{border:1px solid #1c2733;background:#0b0f15;padding:26px;text-align:center}h1{font-size:15px;letter-spacing:2px;font-weight:normal;margin:0 0 14px}h1 b{color:#ffb300}input{background:#06080b;color:#c7d3dd;border:1px solid #1c2733;padding:8px 10px;font-family:inherit;font-size:13px;outline:none;width:220px}input:focus{border-color:#8a6a1a}button{margin-top:10px;background:none;border:1px solid #8a6a1a;color:#ffb300;padding:7px 14px;font-family:inherit;font-size:12px;letter-spacing:1px;cursor:pointer;display:block;width:100%}button:hover{background:#ffb300;color:#000}.err{color:#ff4d4d;font-size:12px;margin-top:8px;min-height:1em}</style></head><body><form id="f"><h1>MORGEN<b>BRIEF</b></h1><input id="p" type="password" placeholder="tilgangskode" autofocus /><button>LOGG INN</button><div class="err" id="e"></div></form><script>document.getElementById("f").addEventListener("submit",async(ev)=>{ev.preventDefault();const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("p").value})});if(r.ok)location.reload();else document.getElementById("e").textContent="Feil kode."});</script></body></html>`;

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

// ---- hjelpere ---------------------------------------------------------------

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error("Body for stor")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("Ugyldig JSON-body")); }
    });
    req.on("error", reject);
  });
}

function sseInit(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

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

function dateLine() {
  const { time, date } = nowCET();
  return `${date}, kl. ${time} CET`;
}

// Dagens fokus-tickere (fallback: favoritter med ticker) til kurs-tapen.
function focusTickers() {
  const focus = getTodayFocus();
  const src = focus || getSettings().favorites;
  return src
    .filter((f) => f.ticker)
    .map((f) => ({ symbol: f.ticker, label: f.ticker }));
}

let generating = false;

// ---- generering ----------------------------------------------------------------

async function handleGenerate(req, res) {
  let body = {};
  try { body = await readBody(req); } catch { /* tom body er ok */ }

  sseInit(res);
  if (generating) {
    sse(res, { type: "error", message: "En brief genereres allerede." });
    return res.end();
  }
  generating = true;

  try {
    if (getUsage().briefs >= MAX_BRIEFS_PER_DAY)
      throw new Error(`Dagens brief-tak nådd (${MAX_BRIEFS_PER_DAY}). Øk MAX_BRIEFS_PER_DAY i .env ved behov.`);
    bumpUsage("briefs");

    let focus;
    if (Array.isArray(body.focus) && body.focus.length) {
      focus = saveTodayFocus(body.focus);
    } else {
      focus = getTodayFocus();
    }
    if (!focus || !focus.length) throw new Error("Ingen fokus valgt for i dag. Velg fokus først.");

    sse(res, { type: "status", text: "HENTER SANNTIDSKURSER" });
    let quotesData = null;
    try {
      quotesData = await getAllQuotes(focusTickers(), { fresh: true });
      const ok = quotesData.quotes.filter((q) => q.ok).length;
      sse(res, { type: "status", text: `KURSER: ${ok}/${quotesData.quotes.length} feeder OK` });
    } catch {
      sse(res, { type: "status", text: "KURSFEED NEDE - FORTSETTER UTEN" });
    }

    const dl = dateLine();
    sse(res, { type: "status", text: `KOBLER TIL ${modelName().toUpperCase()} + WEBSØK (maks ${BRIEF_MAX_SEARCHES})` });

    const markdown = await streamCompletion({
      model: modelName(),
      system: briefingSystem(),
      messages: [{
        role: "user",
        content: briefingUser({
          dateLine: dl,
          quotesBlock: quotesForPrompt(quotesData),
          focusItems: focus,
        }),
      }],
      maxTokens: BRIEF_MAX_TOKENS,
      maxSearches: BRIEF_MAX_SEARCHES,
      onStatus: (text) => sse(res, { type: "status", text }),
      onText: (text) => sse(res, { type: "text", text }),
    });

    if (!markdown) throw new Error("Tomt svar fra modellen.");

    const { time } = nowCET();
    const file = saveBriefing(markdown, {
      generatedAt: new Date().toISOString(),
      generatedAtCET: `${time} CET`,
      model: modelName(),
      focus: focus.map((f) => f.ticker || f.label).join(", "),
    });

    sse(res, {
      type: "done",
      markdown,
      generatedAtCET: `${time} CET`,
      savedTo: path.relative(__dirname, file).replaceAll("\\", "/"),
    });
  } catch (e) {
    sse(res, { type: "error", message: String(e.message || e) });
  } finally {
    generating = false;
    res.end();
  }
}

async function handleChat(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, 400, { error: String(e.message) }); }

  const userMsg = String(body?.message || "").trim();
  sseInit(res);
  if (!userMsg) {
    sse(res, { type: "error", message: "Tom melding." });
    return res.end();
  }

  try {
    if (getUsage().chats >= MAX_CHATS_PER_DAY)
      throw new Error(`Dagens chat-tak nådd (${MAX_CHATS_PER_DAY}). Øk MAX_CHATS_PER_DAY i .env ved behov.`);
    bumpUsage("chats");

    const briefing = readTodayBriefing();
    let quotesBlock = "n/a";
    try { quotesBlock = quotesForPrompt(await getAllQuotes(focusTickers())); }
    catch { /* kurser er valgfritt i chat */ }

    const history = getChatHistory();
    const messages = [...history, { role: "user", content: userMsg }];

    // To systemblokker: stor stabil blokk caches (90 % rabatt på gjenbruk
    // innen 5 min), liten volatil kursblokk holdes utenfor cachen.
    const system = [
      {
        type: "text",
        text: chatSystem({ briefingMarkdown: briefing?.markdown, dateLine: dateLine() }),
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: `=== LIVE KURSER ===\n${quotesBlock}` },
    ];

    const reply = await streamCompletion({
      model: chatModelName(),
      system,
      messages,
      maxTokens: CHAT_MAX_TOKENS,
      maxSearches: CHAT_MAX_SEARCHES,
      onStatus: (text) => sse(res, { type: "status", text }),
      onText: (text) => sse(res, { type: "text", text }),
    });

    saveChatHistory([...messages, { role: "assistant", content: reply }]);
    sse(res, { type: "done" });
  } catch (e) {
    sse(res, { type: "error", message: String(e.message || e) });
  } finally {
    res.end();
  }
}

// ---- server ----------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const m = req.method;

  try {
    if (m === "POST" && p === "/api/login") {
      const body = await readBody(req).catch(() => ({}));
      if (SITE_PASSWORD && body.password === SITE_PASSWORD) {
        const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        res.writeHead(200, {
          "Set-Cookie": `mb_auth=${AUTH_TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secure}`,
          "Content-Type": "application/json; charset=utf-8",
        });
        return res.end('{"ok":true}');
      }
      return json(res, 401, { error: "Feil kode" });
    }
    if (!isAuthed(req)) {
      if (p.startsWith("/api/")) return json(res, 401, { error: "Ikke innlogget" });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(LOGIN_HTML);
    }
    if (m === "GET" && p === "/api/meta") {
      const briefing = readTodayBriefing();
      return json(res, 200, {
        today: todayKey(),
        now: nowCET(),
        model: modelName(),
        chatModel: chatModelName(),
        hasAnthropicKey: hasKey(),
        hasFinnhubKey: Boolean(process.env.FINNHUB_API_KEY),
        hasBriefing: Boolean(briefing),
        hasFocusToday: Boolean(getTodayFocus()),
        generatedAtCET: briefing?.meta?.generatedAtCET || null,
        generating,
      });
    }
    if (m === "GET" && p === "/api/settings") return json(res, 200, getSettings());
    if (m === "PUT" && p === "/api/settings") {
      try { return json(res, 200, saveSettings(await readBody(req))); }
      catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }
    if (m === "GET" && p === "/api/focus/today") {
      return json(res, 200, { items: getTodayFocus(), favorites: getSettings().favorites });
    }
    if (m === "PUT" && p === "/api/focus/today") {
      try { return json(res, 200, { items: saveTodayFocus((await readBody(req)).items) }); }
      catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }
    if (m === "GET" && p === "/api/quotes") {
      try {
        return json(res, 200, await getAllQuotes(focusTickers(), { fresh: url.searchParams.get("fresh") === "1" }));
      } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
    }
    if (m === "GET" && p === "/api/briefing/today") {
      const b = readTodayBriefing();
      return b ? json(res, 200, { exists: true, ...b }) : json(res, 200, { exists: false });
    }
    if (m === "POST" && p === "/api/briefing/generate") return handleGenerate(req, res);
    if (m === "GET" && p === "/api/chat/today") return json(res, 200, { messages: getChatHistory() });
    if (m === "DELETE" && p === "/api/chat/today") { saveChatHistory([]); return json(res, 200, { ok: true }); }
    if (m === "POST" && p === "/api/chat") return handleChat(req, res);

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
  console.log(`  ${date} kl. ${time} CET  |  brief: ${modelName()}  |  chat: ${chatModelName()}`);
  console.log(`  anthropic-nøkkel: ${hasKey() ? "OK" : "MANGLER (.env)"}  |  finnhub: ${process.env.FINNHUB_API_KEY ? "OK" : "ikke satt (Yahoo dekker alt)"}`);
  console.log(`  tilgangskode: ${SITE_PASSWORD ? "PÅ" : "AV - sett SITE_PASSWORD i .env før du deler lenken"}  |  tak: ${MAX_BRIEFS_PER_DAY} briefer / ${MAX_CHATS_PER_DAY} chat per dag\n`);
});
