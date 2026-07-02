// quotes.js - markedsdata. Finnhub (hvis nøkkel) for US-tickere, Yahoo Finance
// (uoffisielt chart-endepunkt) for alt annet: indekser, futures, Oslo Børs, FX.
// Alt er best-effort: en død feed blokkerer aldri briefen.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export const INDICES = [
  { symbol: "^GSPC", label: "S&P 500", region: "USA" },
  { symbol: "ES=F", label: "S&P FUT", region: "USA" },
  { symbol: "^IXIC", label: "NASDAQ", region: "USA" },
  { symbol: "NQ=F", label: "NQ FUT", region: "USA" },
  { symbol: "^DJI", label: "DOW", region: "USA" },
  { symbol: "^STOXX", label: "STOXX 600", region: "EUROPA" },
  { symbol: "^GDAXI", label: "DAX", region: "EUROPA" },
  { symbol: "OSEBX.OL", label: "OSEBX", region: "NORGE" },
  { symbol: "NOK=X", label: "USD/NOK", region: "NORGE" },
  { symbol: "EURNOK=X", label: "EUR/NOK", region: "NORGE" },
  { symbol: "BZ=F", label: "BRENT", region: "NORGE" },
  { symbol: "^N225", label: "NIKKEI", region: "ASIA" },
  { symbol: "^HSI", label: "HANG SENG", region: "ASIA" },
  { symbol: "000001.SS", label: "SHANGHAI", region: "ASIA" },
  { symbol: "^KS11", label: "KOSPI", region: "ASIA" },
];

const isUSTicker = (s) => !/[.^=]/.test(s);

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchYahoo(symbol) {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  let lastErr;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(
        symbol
      )}?range=1d&interval=5m&includePrePost=true`;
      const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (res.status === 429) { lastErr = new Error("Yahoo rate limit (429)"); continue; }
      if (!res.ok) { lastErr = new Error(`Yahoo HTTP ${res.status}`); continue; }
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta) throw new Error(json?.chart?.error?.description || "Yahoo: tomt resultat");
      const price = meta.regularMarketPrice;
      const prevClose = meta.previousClose ?? meta.chartPreviousClose;
      if (typeof price !== "number" || typeof prevClose !== "number" || prevClose === 0)
        throw new Error("Yahoo: mangler prisfelt");
      const q = {
        symbol,
        price,
        prevClose,
        change: price - prevClose,
        changePct: ((price - prevClose) / prevClose) * 100,
        currency: meta.currency || "",
        marketState: meta.marketState || "",
        source: "yahoo",
      };
      if (typeof meta.preMarketPrice === "number") {
        q.preMarket = meta.preMarketPrice;
        q.preMarketPct = ((meta.preMarketPrice - price) / price) * 100;
      }
      if (typeof meta.postMarketPrice === "number") {
        q.postMarket = meta.postMarketPrice;
        q.postMarketPct = ((meta.postMarketPrice - price) / price) * 100;
      }
      return q;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Yahoo feilet");
}

async function fetchFinnhub(symbol, key) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  const j = await res.json();
  if (!j || typeof j.c !== "number" || j.c === 0) throw new Error("Finnhub: ingen data for symbol");
  return {
    symbol,
    price: j.c,
    prevClose: j.pc,
    change: j.d ?? j.c - j.pc,
    changePct: j.dp ?? ((j.c - j.pc) / j.pc) * 100,
    currency: "USD",
    marketState: "",
    source: "finnhub",
  };
}

export async function getQuote(symbol) {
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (finnhubKey && isUSTicker(symbol)) {
    try {
      return await fetchFinnhub(symbol, finnhubKey);
    } catch {
      /* faller videre til Yahoo */
    }
  }
  return fetchYahoo(symbol);
}

// ---- batch + cache -----------------------------------------------------------

let cache = { at: 0, key: "", data: null };
const CACHE_MS = 60_000;

/**
 * @param {Array<{symbol:string,label?:string,region?:string}>} focusTickers dagens fokus-tickere
 */
export async function getAllQuotes(focusTickers = [], { fresh = false } = {}) {
  const focus = focusTickers
    .filter((f) => f.symbol)
    .map((f) => ({ symbol: f.symbol, label: f.label || f.symbol, region: "FOKUS" }));
  const wanted = [...INDICES, ...focus];
  const cacheKey = wanted.map((w) => w.symbol).join(",");

  if (!fresh && cache.data && cache.key === cacheKey && Date.now() - cache.at < CACHE_MS)
    return cache.data;

  const results = await Promise.allSettled(wanted.map((w) => getQuote(w.symbol)));
  const quotes = wanted.map((w, i) => {
    const r = results[i];
    if (r.status === "fulfilled") return { ...w, ...r.value, ok: true };
    return { ...w, ok: false, error: String(r.reason?.message || r.reason || "feilet") };
  });

  const data = { at: new Date().toISOString(), quotes };
  cache = { at: Date.now(), key: cacheKey, data };
  return data;
}

// Kompakt, prompt-vennlig. Claude får disse tallene som fasit.
export function quotesForPrompt(quotesData) {
  if (!quotesData?.quotes?.length)
    return "Ingen live-kurser tilgjengelig (feed-feil). Skriv 'n/a' for priser.";
  const lines = quotesData.quotes.map((q) => {
    if (!q.ok) return `${q.label} (${q.symbol}): n/a (feed-feil)`;
    const pct = `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(1)}%`;
    let line = `${q.label} (${q.symbol}): ${fmtNum(q.price)} ${pct} vs forrige stenging ${fmtNum(q.prevClose)}`;
    if (q.currency) line += ` ${q.currency}`;
    if (q.marketState) line += ` [${q.marketState}]`;
    if (typeof q.preMarket === "number")
      line += ` | pre-market ${fmtNum(q.preMarket)} (${q.preMarketPct >= 0 ? "+" : ""}${q.preMarketPct.toFixed(1)}%)`;
    return line;
  });
  return lines.join("\n");
}

function fmtNum(n) {
  if (typeof n !== "number") return "n/a";
  const digits = Math.abs(n) >= 1000 ? 1 : Math.abs(n) >= 10 ? 2 : 3;
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}
