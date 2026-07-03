// core.js - all endepunkt-logikk, delt mellom lokal server (server.js) og
// Vercel serverless functions (api/). Ingen HTTP her - bare ren logikk.
import { loadEnv } from "./env.js";
loadEnv();

import {
  storageMode, getSettings, getTodayFocus, saveTodayFocus,
  saveBriefing, readTodayBriefing, todayKey, nowCET,
  getChatHistory, saveChatHistory, getUsage, bumpUsage,
  acquireGenLock, releaseGenLock, saveBriefDelta,
} from "./store.js";
import { kvAvailable, kvGetJSON, kvSetJSON } from "./kv.js";
import { yesterdayKey, getBbHistory, saveBbHistory } from "./store.js";
import { annotate } from "./verify.js";
import { getAllQuotes, quotesForPrompt } from "./quotes.js";
import { getStructuredData } from "./marketdata.js";
import { streamCompletion, modelName, chatModelName, summaryModelName, hasKey } from "./anthropic.js";
import { briefingSystem, briefingUser, chatSystem, deltaSystem, deltaUser } from "./prompts.js";

// Kostnadsknapper (overstyres med miljøvariabler)
export const BRIEF_MAX_TOKENS = Number(process.env.BRIEF_MAX_TOKENS || 5000);
export const BRIEF_MAX_SEARCHES = Number(process.env.BRIEF_MAX_SEARCHES || 12);
export const CHAT_MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS || 1200);
export const CHAT_MAX_SEARCHES = Number(process.env.CHAT_MAX_SEARCHES || 3);
export const MAX_BRIEFS_PER_DAY = Number(process.env.MAX_BRIEFS_PER_DAY || 2);
export const MAX_CHATS_PER_DAY = Number(process.env.MAX_CHATS_PER_DAY || 60);

export function dateLine() {
  const { time, date } = nowCET();
  return `${date}, kl. ${time} CET`;
}

// ---- fase 2: strukturerte fakta som prompt-fasit + kodefaktorer i scoren --------

function structuredForPrompt(d) {
  if (!d) return null;
  const lines = [];
  if (d.macro?.ok && d.macro.macro) {
    const m = d.macro.macro;
    const parts = [];
    if (m.rate) parts.push(`Fed funds-rente ${m.rate.value} % (per ${m.rate.date})`);
    if (m.cpiYoY) parts.push(`USA KPI år/år ${m.cpiYoY.value} % (per ${m.cpiYoY.date})`);
    if (m.unemployment) parts.push(`USA-ledighet ${m.unemployment.value} % (per ${m.unemployment.date})`);
    if (parts.length) lines.push(`MAKRO (FRED): ${parts.join(" · ")}`);
  }
  if (d.insider?.ok && d.insider.byTicker) {
    for (const [t, x] of Object.entries(d.insider.byTicker)) {
      const s = x.summary || {};
      const last = (x.form4 || [])[0];
      lines.push(`INNSIDEHANDEL ${t} (SEC Form 4, siste ${s.sampled || 0}): ${s.sells || 0} salg / ${s.buys || 0} kjøp${last ? `; siste: ${last.side} ${last.shares ? Math.round(last.shares).toLocaleString("en-US") + " aksjer " : ""}${last.date} (${last.owner || "ukjent"})` : ""}`);
    }
  }
  if (d.oslo?.ok && d.oslo.byIssuer) {
    for (const [t, msgs] of Object.entries(d.oslo.byIssuer)) {
      const mp = (msgs || []).filter((m) => m.meldepliktig);
      if ((msgs || []).length) lines.push(`BØRSMELDINGER ${t} (NewsWeb, 14 d): ${msgs.length} meldinger${mp.length ? `, ${mp.length} meldepliktig(e): ${mp.map((m) => `"${m.title.slice(0, 50)}" ${m.date}`).join("; ")}` : ""}`);
    }
  }
  if (d.calendar?.ok && d.calendar.events?.length) {
    lines.push(`KALENDER NESTE 7 D: ${d.calendar.events.map((e) => `${e.date} ${e.label}`).join(" · ")}`);
  }
  return lines.length ? lines.join("\n") : null;
}

// BB v2: kodefaktorer på strukturert data justerer aksje-scoren synlig.
export function structFactorsFor(ticker, sdata, quotesData) {
  const factors = [];
  let adj = 0;
  const ins = sdata?.insider?.ok ? sdata.insider.byTicker?.[ticker] : null;
  if (ins?.summary?.sampled) {
    const { sells = 0, buys = 0 } = ins.summary;
    if (sells > buys) {
      const a = Math.min(10, 4 + 2 * (sells - buys));
      adj -= a;
      factors.push(`Innsidesalg dominerer (${sells} salg/${buys} kjøp) (-${a})`);
    } else if (buys > sells) {
      const a = Math.min(10, 4 + 2 * (buys - sells));
      adj += a;
      factors.push(`Innsidekjøp dominerer (${buys} kjøp/${sells} salg) (+${a})`);
    }
  }
  const q = quotesData?.quotes?.find((x) => x.symbol === ticker && x.ok);
  if (q && Math.abs(q.changePct) >= 3) {
    const a = Math.min(8, Math.round(Math.abs(q.changePct)));
    adj += q.changePct > 0 ? a : -a;
    factors.push(`Kursmomentum ${q.changePct > 0 ? "+" : ""}${q.changePct.toFixed(1)} % (${q.changePct > 0 ? "+" : "-"}${a})`);
  }
  return { adj: Math.max(-15, Math.min(15, adj)), factors };
}

// ---- kurser med delt KV-cache (5 min TTL) -------------------------------------

async function focusTickers(profile) {
  const focus = await getTodayFocus();
  const src = focus || (await getSettings(profile)).favorites;
  return src.filter((f) => f.ticker).map((f) => ({ symbol: f.ticker, label: f.ticker }));
}

const QUOTES_TTL = 300; // sekunder - finansdata oppdateres langt oftere enn briefen

export async function getQuotesCached({ fresh = false, profile } = {}) {
  const tickers = await focusTickers(profile);
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
      sources: existing.sources || [],
      claims: existing.claims || [],
      sections: existing.sections || {},
      overall: existing.overall || null,
      deltas: existing.deltas || null,
      searches: Number(existing.meta?.searches) || undefined,
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

    // Fase 2 trinn 1: strukturerte fakta hentes i KODE før modellen kobles inn
    onStatus("HENTER STRUKTURERTE FAKTA (EDGAR/FRED/NEWSWEB)");
    let sdata = null;
    try { sdata = await getStructuredData(focusItems); } catch { /* briefen tåler det */ }
    const structuredBlock = structuredForPrompt(sdata);

    const dl = dateLine();
    onStatus(`KOBLER TIL ${modelName().toUpperCase()} + WEBSØK (maks ${BRIEF_MAX_SEARCHES})`);

    const result = await streamCompletion({
      model: modelName(),
      system: briefingSystem(),
      messages: [{
        role: "user",
        content: briefingUser({
          dateLine: dl,
          quotesBlock: quotesForPrompt(quotesData),
          focusItems,
          structuredBlock,
        }),
      }],
      maxTokens: BRIEF_MAX_TOKENS,
      maxSearches: BRIEF_MAX_SEARCHES,
      onStatus,
      onText,
    });

    if (!result.text) throw new Error("Tomt svar fra modellen.");
    // Hard garanti: en brief uten faktiske websøk er treningsdata - avvis den.
    if (!result.searches)
      throw new Error("Modellen gjorde 0 websøk - briefen ble avvist for å hindre utdatert innhold. Prøv å generere på nytt.");

    if (result.stopReason === "max_tokens")
      onStatus("ADVARSEL: SVARET BLE AVKORTET AV TOKEN-TAKET - SISTE SEKSJONER KAN MANGLE");

    onStatus("VERIFISERER KILDER + REGNER BULL/BEAR");
    // Kode-håndhevet: URL-validering mot faktiske søkeresultater, uavhengighet,
    // konfidensnivå per påstand og deterministisk score. Modellen bestemmer ikke dette.
    const ann = annotate({
      markdown: result.text,
      sources: result.sources,
      searchResults: result.searchResults || [],
    });

    // BB v2: kodefaktorer på strukturert data justerer aksje-scorene (synlig)
    for (const [name, s] of Object.entries(ann.sections)) {
      const m = name.match(/^FOKUS:\s*(.+)/);
      if (!m) continue;
      const tick = m[1].trim();
      const sf = structFactorsFor(tick, sdata, quotesData);
      if (sf.factors.length) {
        s.score = Math.max(2, Math.min(98, s.score + sf.adj));
        s.structFactors = sf.factors;
      }
    }

    // BB-historikk + delta mot i går
    const focusScores = {};
    for (const [name, s] of Object.entries(ann.sections)) {
      const m = name.match(/^FOKUS:\s*(.+)/);
      if (m) focusScores[m[1].trim()] = s.score;
    }
    const prev = await getBbHistory(yesterdayKey()).catch(() => null);
    const deltas = prev && typeof prev.overall === "number"
      ? {
          overall: (ann.overall?.score ?? 50) - prev.overall,
          focus: Object.fromEntries(Object.entries(focusScores).map(([k, v]) =>
            [k, prev.focus && typeof prev.focus[k] === "number" ? v - prev.focus[k] : null])),
        }
      : null;
    await saveBbHistory(todayKey(), { overall: ann.overall?.score ?? 50, focus: focusScores }).catch(() => {});

    const { time } = nowCET();
    const savedTo = await saveBriefing(ann.markdown, {
      generatedAt: new Date().toISOString(),
      generatedAtCET: `${time} CET`,
      model: modelName(),
      focus: focusItems.map((f) => f.ticker || f.label).join(", "),
      searches: result.searches,
    }, ann.sources, { claims: ann.claims, sections: ann.sections, overall: ann.overall, deltas });

    return {
      markdown: ann.markdown,
      sources: ann.sources,
      claims: ann.claims,
      sections: ann.sections,
      overall: ann.overall,
      deltas,
      searches: result.searches,
      generatedAtCET: `${time} CET`,
      savedTo,
      cached: false,
    };
  } finally {
    await releaseGenLock();
  }
}

// ---- delta-brief: «nytt siden i morges» (fase 2, maks MAX_DELTAS_PER_DAY) ----------

export const MAX_DELTAS_PER_DAY = Number(process.env.MAX_DELTAS_PER_DAY || 2);

export async function generateDelta({ onStatus = () => {}, onText = () => {} }) {
  const existing = await readTodayBriefing();
  if (!existing) throw new Error("Ingen morgenbrief i dag ennå - generer den først.");

  const n = await bumpUsage("deltas");
  if (n > MAX_DELTAS_PER_DAY)
    throw new Error(`Dagens delta-tak nådd (${MAX_DELTAS_PER_DAY}). Full brief-cache er urørt.`);

  let quotesBlock = "n/a";
  try { quotesBlock = quotesForPrompt(await getQuotesCached({ fresh: true })); } catch { /* ok */ }

  onStatus(`KOBLER TIL ${summaryModelName().toUpperCase()} (INTRADAG-DELTA, maks 4 SØK)`);
  const r = await streamCompletion({
    model: summaryModelName(),
    system: deltaSystem(),
    messages: [{
      role: "user",
      content: deltaUser({ dateLine: dateLine(), morningBrief: existing.markdown, quotesBlock }),
    }],
    maxTokens: 800,
    maxSearches: 4,
    onStatus,
    onText,
  });
  if (!r.text) throw new Error("Tomt svar fra modellen.");
  if (!r.searches) throw new Error("Modellen gjorde 0 websøk - delta avvist.");

  const { time } = nowCET();
  const delta = {
    markdown: r.text,
    sources: r.sources,
    searches: r.searches,
    generatedAtCET: `${time} CET`,
  };
  await saveBriefDelta(delta);
  return delta;
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
  // Historikken lagres med [[C:n]]-markører for rendering; stripp dem før de
  // sendes til modellen så den ikke begynner å etterligne dem.
  const messages = [...history, { role: "user", content: message }].map((m) => ({
    role: m.role,
    content: String(m.content).replace(/\[\[C:\d+\]\]/g, ""),
  }));

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

  const result = await streamCompletion({
    model: chatModelName(),
    system,
    messages,
    maxTokens: CHAT_MAX_TOKENS,
    maxSearches: CHAT_MAX_SEARCHES,
    onStatus,
    onText,
  });

  await saveChatHistory([
    ...history,
    { role: "user", content: message },
    { role: "assistant", content: result.text, sources: result.sources },
  ]);
  return { text: result.text, sources: result.sources, searches: result.searches };
}
