// sources.js - kilderating og uavhengighetsanalyse. Ren kode, ingen LLM.
//
// Lag A: base-rating per domene (vedlikeholdbar liste under).
// Lag B: justering per artikkel ut fra metadata søket gir oss (tittel, page_age, URL).
// NB: vi henter ikke fulle artikler, så Lag B bruker kun søke-metadata - det er en
// bevisst avveining (0 ekstra API-kall). Begrunnelser følger alltid med ratingen.

const TIERS = {
  1: {
    score: 95,
    label: "Tier 1: primærkilde/dokument",
    domains: [
      "sec.gov", "newsweb.oslobors.no", "oslobors.no", "euronext.com",
      "norges-bank.no", "ssb.no", "federalreserve.gov", "ecb.europa.eu",
      "regjeringen.no", "bls.gov", "bea.gov", "imf.org", "stlouisfed.org",
    ],
  },
  2: {
    score: 82,
    label: "Tier 2: etablert nyhetsredaksjon",
    domains: [
      "reuters.com", "apnews.com", "bloomberg.com", "ft.com", "wsj.com",
      "ntb.no", "dn.no", "e24.no", "nrk.no", "cnbc.com", "marketwatch.com",
      "finansavisen.no", "aftenposten.no", "bbc.com", "bbc.co.uk",
    ],
  },
  3: {
    score: 65,
    label: "Tier 3: etablert, mer meningsbasert",
    domains: [
      "economist.com", "axios.com", "barrons.com", "defensenews.com",
      "janes.com", "thestreet.com", "forbes.com", "politico.com",
      "politico.eu", "breakingdefense.com", "techcrunch.com", "morningbrew.com",
    ],
  },
  4: {
    score: 42,
    label: "Tier 4: aggregator/blandet kvalitet",
    domains: [
      "yahoo.com", "finance.yahoo.com", "investing.com", "benzinga.com",
      "seekingalpha.com", "fool.com", "tipranks.com", "marketbeat.com",
      "stocktitan.net", "msn.com", "wallstreetzen.com",
    ],
  },
  5: {
    score: 15,
    label: "Tier 5: skal ikke brukes som kilde",
    domains: ["stockstotrade.com", "timothysykes.com", "investorplace.com"],
  },
};

// Pressemelding-distributører: selskapets egne ord via wire. Regnes som
// primær-EKVIVALENT for faktapåstander om selskapet selv.
const WIRES = ["globenewswire.com", "prnewswire.com", "businesswire.com", "accesswire.com", "newsfilecorp.com"];

// Sosiale medier/forum: alltid RYKTE-klasse som eneste kilde.
const SOCIAL = ["twitter.com", "x.com", "linkedin.com", "reddit.com", "facebook.com", "tiktok.com", "youtube.com", "discord.com", "4chan.org", "stocktwits.com"];

const UNKNOWN_SCORE = 40;

// Byråer som ofte syndikeres - krediteres de i tittelen, er byrået opphavet.
const AGENCY_RE = /\b(reuters|associated press|ap news|\bap\b|ntb|afp|bloomberg)\b/i;

const SPECULATIVE_RE = /\b(could soar|skyrocket|to the moon|insiders say|this is why|you won'?t believe|explode|10x|kan eksplodere|rakett)\b/i;

export function domainOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

// Registrerbart domene, grovt: siste to ledd (holder for listene våre; .co.uk håndteres)
export function baseDomain(host) {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  const two = parts.slice(-2).join(".");
  if (/^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(two)) return parts.slice(-3).join(".");
  return two;
}

function matchesList(host, list) {
  const b = baseDomain(host);
  return list.some((d) => b === d || host === d || host.endsWith("." + d));
}

export function isSocial(url) { return matchesList(domainOf(url), SOCIAL); }
export function isWire(url) { return matchesList(domainOf(url), WIRES); }

// Selskaps-IR-heuristikk: ir.-subdomene eller typiske IR-/pressemeldings-stier
export function isCompanyIR(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (/^(ir|investors?|investor)\./.test(host)) return true;
    return /\/(investor(s|-relations)?|ir|press-releases?|news-releases?|newsroom|boersmeldinger|borsmeldinger)\//i.test(u.pathname + "/");
  } catch { return false; }
}

// Primær-ekvivalent: kan ALENE bekrefte faktapåstander (om egen institusjon/eget selskap)
export function isPrimaryLike(url) {
  const host = domainOf(url);
  return matchesList(host, TIERS[1].domains) || isWire(url) || isCompanyIR(url);
}

function tierOf(url) {
  const host = domainOf(url);
  if (!host) return { tier: 0, score: 10, label: "ugyldig URL" };
  if (isCompanyIR(url) && !matchesList(host, TIERS[5].domains)) {
    return { tier: 1, score: 90, label: "Tier 1: selskapets egen IR/pressemelding (selskapets egne ord)" };
  }
  if (isWire(url)) {
    return { tier: 1, score: 88, label: "Tier 1-ekvivalent: pressemelding via wire (selskapets egne ord)" };
  }
  for (const t of [1, 2, 3, 4, 5]) {
    if (matchesList(host, TIERS[t].domains)) return { tier: t, score: TIERS[t].score, label: TIERS[t].label };
  }
  if (matchesList(host, SOCIAL)) {
    return { tier: 5, score: 20, label: "Tier 5: sosiale medier/forum - kun rykte-verdi" };
  }
  return { tier: 0, score: UNKNOWN_SCORE, label: "uklassifisert kilde (ukjent domene, start 40)" };
}

function freshnessAdj(pageAge) {
  if (!pageAge) return null;
  const s = String(pageAge).toLowerCase();
  if (/(minute|hour|minutt|time)/.test(s)) return { adj: +5, why: `+5: fersk (${pageAge})` };
  if (/^([1-2]) day/.test(s) || /i går/.test(s)) return { adj: +3, why: `+3: nylig (${pageAge})` };
  if (/(month|year|måned|år)/.test(s)) return { adj: -8, why: `-8: gammel artikkel (${pageAge})` };
  return null;
}

/**
 * Rating for én kilde. Returnerer alltid begrunnelser.
 * @param {{url:string, title?:string, page_age?:string}} src
 */
export function rateSource(src) {
  const t = tierOf(src.url);
  const reasons = [`${t.label} (base ${t.score})`];
  let adj = 0;

  const fresh = freshnessAdj(src.page_age);
  if (fresh) { adj += fresh.adj; reasons.push(fresh.why); }

  const title = src.title || "";
  if (SPECULATIVE_RE.test(title)) { adj -= 10; reasons.push("-10: spekulativ/clickbait-tittel"); }
  if (title.length > 15 && !SPECULATIVE_RE.test(title)) { adj += 2; reasons.push("+2: beskrivende tittel"); }
  try {
    const path = new URL(src.url).pathname;
    if (path.length > 15) { adj += 2; reasons.push("+2: artikkel-URL (ikke forside)"); }
  } catch { /* dekket av tierOf */ }

  adj = Math.max(-15, Math.min(15, adj));
  const score = Math.max(0, Math.min(100, t.score + adj));
  return { tier: t.tier, base: t.score, adj, score, label: t.label, reasons };
}

// ---- uavhengighet / syndikering -------------------------------------------------

function normTitle(title) {
  return String(title || "").toLowerCase().replace(/[^a-zæøå0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
}

export function titleSimilarity(a, b) {
  const A = new Set(normTitle(a));
  const B = new Set(normTitle(b));
  if (A.size < 4 || B.size < 4) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  // Containment (andel av den KORTESTE tittelen som gjenfinnes i den andre):
  // fanger det vanligste syndikeringsmønsteret "samme tittel + suffiks (- Reuters)".
  return inter / Math.min(A.size, B.size);
}

// Opphavsnøkkel: krediterer tittelen et byrå, er byrået opphavet - ellers domenet.
export function originKey(src) {
  const m = (src.title || "").match(AGENCY_RE);
  if (m) return "byrå:" + m[1].toLowerCase().replace(/\s+/g, "");
  return "domene:" + baseDomain(domainOf(src.url));
}

/**
 * Grupperer kilder i UAVHENGIGE opphav: samme domene, samme krediterte byrå,
 * eller nesten identisk tittel (syndikering) = samme gruppe.
 * @param {Array} srcs beriket med .title/.url
 * @returns {Array<Array<number>>} grupper av indekser inn i srcs
 */
export function independentGroups(srcs) {
  const n = srcs.length;
  const parent = [...Array(n).keys()];
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (originKey(srcs[i]) === originKey(srcs[j])) union(i, j);
      else if (titleSimilarity(srcs[i].title, srcs[j].title) >= 0.7) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()];
}
