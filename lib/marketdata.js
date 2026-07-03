// marketdata.js - strukturert datalag (fase 1): SEC EDGAR, FRED, Oslo Børs
// NewsWeb og Finnhub-resultatkalender. Null avhengigheter.
//
// Prinsipper:
//  - Best effort med per-del cache: én død kilde blokkerer aldri resten,
//    og hver del rapporterer ærlig {ok, error, at}.
//  - Base-URL-er kan overstyres i env (brukes av testene og ev. proxyer).
//  - SEC krever identifiserende User-Agent (fair access policy) -> EDGAR_CONTACT.
import { loadEnv } from "./env.js";
loadEnv();
import { kvAvailable, kvGetJSON, kvSetJSON } from "./kv.js";

const EDGAR_BASE = () => process.env.EDGAR_BASE || "https://data.sec.gov";
const EDGAR_WWW = () => process.env.EDGAR_WWW || "https://www.sec.gov";
const FRED_BASE = () => process.env.FRED_BASE || "https://api.stlouisfed.org";
const NEWSWEB_BASE = () => process.env.NEWSWEB_BASE || "https://api3.oslo.oslobors.no";
const FINNHUB_BASE = () => process.env.FINNHUB_BASE || "https://finnhub.io";

const UA = () => `morgenbrief/1.5 (privat markedsbrief; kontakt: ${process.env.EDGAR_CONTACT || "EDGAR_CONTACT ikke satt"})`;

async function get(url, { accept = "application/json", timeout = 9000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA(), Accept: accept }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    return ct.includes("json") ? res.json() : res.text();
  } finally {
    clearTimeout(t);
  }
}

// ---- per-del cache (KV eller minne) --------------------------------------------

const memCache = new Map();

async function cached(key, ttlSec, fn) {
  const k = `mb:md:${key}`;
  if (kvAvailable()) {
    const hit = await kvGetJSON(k).catch(() => null);
    if (hit && hit._t && (Date.now() - hit._t) / 1000 < ttlSec) return hit.v;
  } else {
    const hit = memCache.get(k);
    if (hit && (Date.now() - hit._t) / 1000 < ttlSec) return hit.v;
  }
  const v = await fn();
  if (kvAvailable()) await kvSetJSON(k, { _t: Date.now(), v }, { ex: ttlSec * 2 }).catch(() => {});
  else memCache.set(k, { _t: Date.now(), v });
  return v;
}

// ---- SEC EDGAR -------------------------------------------------------------------

async function cikFor(ticker) {
  return cached(`cik:${ticker}`, 7 * 86400, async () => {
    const map = await get(`${EDGAR_WWW()}/files/company_tickers.json`);
    for (const e of Object.values(map)) {
      if (String(e.ticker).toUpperCase() === ticker.toUpperCase()) {
        return String(e.cik_str).padStart(10, "0");
      }
    }
    throw new Error(`fant ikke CIK for ${ticker}`);
  });
}

// Kjøp/salg fra Form 4-transaksjonskoder: P=kjøp, S=salg, A=tildeling.
export function classifyForm4(xml) {
  const codes = [...String(xml).matchAll(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/g)].map((m) => m[1]);
  const hasS = codes.includes("S");
  const hasP = codes.includes("P");
  if (hasP && hasS) return "BLANDET";
  if (hasS) return "SALG";
  if (hasP) return "KJØP";
  if (codes.includes("A")) return "TILDELING";
  return codes.length ? "ANNET" : "UKJENT";
}

export async function edgarFilings(ticker) {
  return cached(`edgar:${ticker}`, 6 * 3600, async () => {
    const cik = await cikFor(ticker);
    const sub = await get(`${EDGAR_BASE()}/submissions/CIK${cik}.json`);
    const r = sub?.filings?.recent || {};
    const filings = [];
    const form4 = [];
    const n = (r.form || []).length;
    for (let i = 0; i < n && (filings.length < 8 || form4.length < 5); i++) {
      const item = {
        form: r.form[i],
        date: r.filingDate[i],
        url: `${EDGAR_WWW()}/Archives/edgar/data/${Number(cik)}/${String(r.accessionNumber[i]).replaceAll("-", "")}/${r.primaryDocument[i]}`,
      };
      if (["8-K", "10-Q", "10-K"].includes(item.form) && filings.length < 8) filings.push(item);
      if (item.form === "4" && form4.length < 5) form4.push(item);
    }
    // Klassifiser de siste Form 4 (maks 5 ekstra kall, cachet 6t via denne delen)
    for (const f of form4) {
      try {
        const xml = String(await get(f.url, { accept: "*/*" }));
        f.side = classifyForm4(xml);
        f.owner = (xml.match(/<rptOwnerName>\s*([^<]+?)\s*</) || [])[1] || "";
        f.shares = Number((xml.match(/<transactionShares>\s*<value>\s*([\d.]+)/) || [])[1] || 0);
      } catch {
        f.side = "UKJENT";
      }
    }
    const sells = form4.filter((f) => f.side === "SALG").length;
    const buys = form4.filter((f) => f.side === "KJØP").length;
    return { filings, form4, summary: { sells, buys, sampled: form4.length } };
  });
}

// ---- FRED (makrotall) --------------------------------------------------------------

async function fredLatest(series, n = 1) {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error("FRED_API_KEY ikke satt (gratis på fred.stlouisfed.org)");
  const j = await get(`${FRED_BASE()}/fred/series/observations?series_id=${series}&api_key=${key}&file_type=json&sort_order=desc&limit=${n}`);
  return (j.observations || []).filter((o) => o.value !== ".");
}

export function yrAgoMonth(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 7);
}

export async function fredMacro() {
  return cached("fred", 12 * 3600, async () => {
    const [ff, un, cpi] = await Promise.all([
      fredLatest("DFF", 1),
      fredLatest("UNRATE", 1),
      fredLatest("CPIAUCSL", 15),
    ]);
    const cpiNow = cpi[0];
    const ref = cpiNow ? cpi.find((o) => o.date.slice(0, 7) === yrAgoMonth(cpiNow.date)) : null;
    const cpiYoY = cpiNow && ref ? Math.round((Number(cpiNow.value) / Number(ref.value) - 1) * 1000) / 10 : null;
    return {
      rate: ff[0] ? { value: Number(ff[0].value), date: ff[0].date, label: "Fed funds-rente" } : null,
      unemployment: un[0] ? { value: Number(un[0].value), date: un[0].date, label: "USA-ledighet" } : null,
      cpiYoY: cpiYoY == null ? null : { value: cpiYoY, date: cpiNow.date, label: "USA KPI år/år" },
      source: "FRED (St. Louis Fed)",
    };
  });
}

export async function fredReleaseDates() {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error("FRED_API_KEY ikke satt");
  return cached("freddates", 12 * 3600, async () => {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 7 * 86400e3).toISOString().slice(0, 10);
    const releases = [[10, "USA KPI slippes"], [50, "USA jobbtall slippes"]];
    const out = [];
    for (const [id, label] of releases) {
      try {
        const j = await get(`${FRED_BASE()}/fred/release/dates?release_id=${id}&api_key=${key}&file_type=json&include_release_dates_with_no_data=true&realtime_start=${from}&realtime_end=${to}`);
        for (const d of j.release_dates || []) {
          if (d.date >= from && d.date <= to) out.push({ date: d.date, label });
        }
      } catch { /* enkeltslipp kan feile uten å velte kalenderen */ }
    }
    return out;
  });
}

// ---- Oslo Børs NewsWeb (uoffisiell JSON - kan endres; ærlig feiltilstand i UI) ------

export function isMeldepliktig(m) {
  const cat = Array.isArray(m.category) ? m.category.join(" ") : String(m.category || "");
  const s = `${m.title || ""} ${cat}`.toUpperCase();
  return /MELDEPLIKTIG|PRIMÆRINNSIDER|PRIMARY INSIDER|PDMR/.test(s);
}

export async function newswebMessages(issuer) {
  return cached(`ob:${issuer}`, 6 * 3600, async () => {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 14 * 86400e3).toISOString().slice(0, 10);
    const j = await get(`${NEWSWEB_BASE()}/v1/newsreader/list?issuer=${encodeURIComponent(issuer)}&fromDate=${from}&toDate=${to}`);
    const rows = j?.data?.messages || j?.messages || [];
    return rows.slice(0, 10).map((m) => ({
      date: String(m.publishedTime || m.time || "").slice(0, 10),
      title: m.title || "",
      url: m.id ? `https://newsweb.oslobors.no/message/${m.id}` : "",
      meldepliktig: isMeldepliktig(m),
    }));
  });
}

// ---- Finnhub resultatkalender --------------------------------------------------------

export async function earningsCalendar(symbols) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error("FINNHUB_API_KEY ikke satt");
  if (!symbols.length) return [];
  return cached(`earn:${symbols.join(",")}`, 12 * 3600, async () => {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 7 * 86400e3).toISOString().slice(0, 10);
    const out = [];
    for (const s of symbols) {
      const j = await get(`${FINNHUB_BASE()}/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(s)}&token=${key}`);
      for (const e of j.earningsCalendar || []) {
        out.push({ date: e.date, label: `${e.symbol} resultat${e.quarter ? ` Q${e.quarter}` : ""}` });
      }
    }
    return out;
  });
}

// ---- nedtelling («neste 7 dager») ----------------------------------------------------

export function buildCountdown(events, todayStr) {
  const today = new Date((todayStr || new Date().toISOString().slice(0, 10)) + "T00:00:00Z");
  return (events || [])
    .filter((e) => e && e.date)
    .map((e) => ({ ...e, days: Math.round((new Date(e.date + "T00:00:00Z") - today) / 86400e3) }))
    .filter((e) => e.days >= 0 && e.days <= 7)
    .sort((a, b) => a.days - b.days)
    .slice(0, 8);
}

// ---- samlet pakke ---------------------------------------------------------------------

export async function getStructuredData(favorites) {
  const tickers = (favorites || []).filter((f) => f.ticker).map((f) => f.ticker);
  const us = tickers.filter((t) => !/[.^=]/.test(t));
  const oslo = tickers.filter((t) => t.toUpperCase().endsWith(".OL")).map((t) => t.slice(0, -3));

  const part = async (fn) => {
    try {
      return { ok: true, at: new Date().toISOString(), ...(await fn()) };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  };

  const [insider, ob, macro, calendar] = await Promise.all([
    part(async () => {
      if (!us.length) throw new Error("ingen US-tickere i watchlist");
      const byTicker = {};
      for (const t of us) byTicker[t] = await edgarFilings(t);
      return { byTicker, source: "SEC EDGAR" };
    }),
    part(async () => {
      if (!oslo.length) throw new Error("ingen Oslo Børs-tickere i watchlist");
      const byIssuer = {};
      for (const t of oslo) byIssuer[t] = await newswebMessages(t);
      return { byIssuer, source: "NewsWeb/Oslo Børs (uoffisiell)" };
    }),
    part(async () => ({ macro: await fredMacro() })),
    part(async () => {
      const ev = [];
      let err = [];
      try { ev.push(...(await earningsCalendar(us))); } catch (e) { err.push(String(e.message)); }
      try { ev.push(...(await fredReleaseDates())); } catch (e) { err.push(String(e.message)); }
      const events = buildCountdown(ev);
      if (!ev.length && err.length) throw new Error(err.join(" / "));
      return { events };
    }),
  ]);

  return { insider, oslo: ob, macro, calendar, generatedAt: new Date().toISOString() };
}
