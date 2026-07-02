// core.js - all endepunkt-logikk, delt mellom lokal server (server.js) og
// Vercel serverless functions (api/). Ingen HTTP her - bare ren logikk.
import { loadEnv } from "./env.js";
loadEnv();

import {
  storageMode, getSettings, getTodayFocus, saveTodayFocus,
  saveBriefing, readTodayBriefing, todayKey, nowCET,
  getChatHistory, saveChatHistory, getUsage, bumpUsage,
  acquireGenLock, releaseGenLock,
} from "./store.js";
import { kvAvailable, kvGetJSON, kvSetJSON } from "./kv.js";
import { getAllQuotes, quotesForPrompt } from "./quotes.js";
import { streamCompletion, modelName, chatModelName, hasKey } from "./anthropic.js";
import { briefingSystem, briefingUser, chatSystem } from "./prompts.js";

// Kostnadsknapper (overstyres med miljøvariabler)
export const BRIEF_MAX_TOKENS = Number(process.env.BRIEF_MAX_TOKENS || 3500);
export const BRIEF_MAX_SEARCHES = Number(process.env.BRIEF_MAX_SEARCHES || 8);
export const CHAT_MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS || 1200);
export const CHAT_MAX_SEARCHES = Number(process.env.CHAT_MAX_SEARCHES || 3);
export const MAX_BRIEFS_PER_DAY = Number(process.env.MAX_BRIEFS_PER_DAY || 2);
export const MAX_CHATS_PER_DAY = Number(process.env.MAX_CHATS_PER_DAY || 60);

export function dateLine() {
  const { time, date } = nowCET();
  return `${date}, kl. ${time} CET`;
}

// ---- kurser med delt KV-cache (5 min TTL) -------------------------------------

async function focusTickers() {
  const focus = await getTodayFocus();
  const src = focus || (await getSettings()).favorites;
  return src.filter((f) => f.ticker).map((f) => ({ symbol: f.ticker, label: f.ticker }));
}

const QUOTES_TTL = 300; // sekunder - finansdata oppdateres langt oftere enn briefen

export async function getQuotesCached({ fresh = false } = {}) {
  const tickers = await focusTickers();
  const ck = `mb:quotes:${tickers.map((t) => t.symbol).join(",") || "none"}`;
  if (!fresh && kvAvailable()) {
    const hit = await kvGetJSON(ck).catch(() => null);
    if (hit) return hit;
  }
  const data = await getAllQuotes(tickers, { fresh });
  if (kvAvailable() && data.quotes?.some((q) => q.ok)) {
    await kvSetJSON(ck, data, { ex: QUOTES_TTL }).catch(() => {});
  }
  return data;
}

// ---- meta ----------------------------------------------------------------------

export async function metaInfo() {
  const briefing = await readTodayBriefing();
  return {
    today: todayKey(),
    now: nowCET(),
    model: modelName(),
    chatModel: chatModelName(),
    hasAnthropicKey: hasKey(),
    hasFinnhubKey: Boolean(process.env.FINNHUB_API_KEY),
    hasBriefing: Boolean(briefing),
    hasFocusToday: Boolean(await getTodayFocus()),
    generatedAtCET: briefing?.meta?.generatedAtCET || null,
    storage: storageMode(),
  };
}

// ---- brief-generering -----------------------------------------------------------
// Cache-først: finnes dagens brief, returneres den uten API-kall (med mindre
// force=true fra et eksplisitt brukervalg). Lås hindrer doble Claude-kall.

export async function generateBrief({ focus, force = false, onStatus = () => {}, onText = () => {} }) {
  const existing = await readTodayBriefing();
  if (existing && !force) {
    return {
      markdown: existing.markdown,
      generatedAtCET: existing.meta?.generatedAtCET || "",
      savedTo: storageMode() === "kv" ? `KV brief:${existing.date}` : `briefings/${existing.date}.md`,
      cached: true,
    };
  }

  // Fokus avklares FØR teller/lås, så en tom forespørsel ikke brenner kvote
  let focusItems = Array.isArray(focus) && focus.length ? await saveTodayFocus(focus) : await getTodayFocus();
  if (!focusItems || !focusItems.length) throw new Error("Ingen fokus valgt for i dag. Velg fokus først.");

  if (!(await acquireGenLock()))
    throw new Error("En brief genereres allerede - vent litt og last siden på nytt.");

  try {
    const n = await bumpUsage("briefs");
    if (n > MAX_BRIEFS_PER_DAY)
      throw new Error(`Dagens brief-tak nådd (${MAX_BRIEFS_PER_DAY}). Øk MAX_BRIEFS_PER_DAY ved behov.`);

    onStatus("HENTER SANNTIDSKURSER");
    let quotesData = null;
    try {
      quotesData = await getQuotesCached({ fresh: true });
      onStatus(`KURSER: ${quotesData.quotes.filter((q) => q.ok).length}/${quotesData.quotes.length} feeder OK`);
    } catch {
      onStatus("KURSFEED NEDE - FORTSETTER UTEN");
    }

    const dl = dateLine();
    onStatus(`KOBLER TIL ${modelName().toUpperCase()} + WEBSØK (maks ${BRIEF_MAX_SEARCHES})`);

    const markdown = await streamCompletion({
      model: modelName(),
      system: briefingSystem(),
      messages: [{
        role: "user",
        content: briefingUser({
          dateLine: dl,
          quotesBlock: quotesForPrompt(quotesData),
          focusItems,
        }),
      }],
      maxTokens: BRIEF_MAX_TOKENS,
      maxSearches: BRIEF_MAX_SEARCHES,
      onStatus,
      onText,
    });

    if (!markdown) throw new Error("Tomt svar fra modellen.");

    const { time } = nowCET();
    const savedTo = await saveBriefing(markdown, {
      generatedAt: new Date().toISOString(),
      generatedAtCET: `${time} CET`,
      model: modelName(),
      focus: focusItems.map((f) => f.ticker || f.label).join(", "),
    });

    return { markdown, generatedAtCET: `${time} CET`, savedTo, cached: false };
  } finally {
    await releaseGenLock();
  }
}

// ---- chat -------------------------------------------------------------------------

export async function chatReply({ message, onStatus = () => {}, onText = () => {} }) {
  const n = await bumpUsage("chats");
  if (n > MAX_CHATS_PER_DAY)
    throw new Error(`Dagens chat-tak nådd (${MAX_CHATS_PER_DAY}). Øk MAX_CHATS_PER_DAY ved behov.`);

  const briefing = await readTodayBriefing();
  let quotesBlock = "n/a";
  try { quotesBlock = quotesForPrompt(await getQuotesCached()); }
  catch { /* kurser er valgfritt i chat */ }

  const history = await getChatHistory();
  const messages = [...history, { role: "user", content: message }];

  // To systemblokker: stor stabil blokk caches hos Anthropic (90 % rabatt på
  // gjenbruk innen 5 min), liten volatil kursblokk holdes utenfor cachen.
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
    onStatus,
    onText,
  });

  await saveChatHistory([...messages, { role: "assistant", content: reply }]);
  return reply;
}
