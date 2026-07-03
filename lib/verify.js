// verify.js - kode-håndhevet kildekritikk + deterministisk bull/bear-motor.
//
// Kjøres i backend ETTER generering. Modellen ekstraherer faktorer ([BB:..],
// [MAT:..], [INSIDER:..], [KONFLIKT]) - men konfidensnivå, URL-validering,
// uavhengighet og all scoring regnes HER, i kode. Modellen setter aldri score,
// og kan aldri "arve" troverdighet fra et kildenavn den selv har skrevet.
import { rateSource, independentGroups, isPrimaryLike, isSocial, domainOf, baseDomain } from "./sources.js";

// ---- konstanter (synlige og justerbare) -----------------------------------------

// Retning og konfidens er ADSKILT: konfidens vises som eget merke og demper
// IKKE retningen (unntak: rene rykter halveres). Tunge materielle signaler
// skal dominere aggregatet - mange nøytrale småsaker skal ikke utvanne dem.
const BB_DELTA = { "HARD+": 20, "HARD-": -20, "MYK+": 12, "MYK-": -12, "NØYTRAL": 0, "NOYTRAL": 0 };
const MAT_MULT = { "HØY": 1.4, "HOY": 1.4, "MED": 1.0, "LAV": 0.4 };
const INSIDER_DELTA = { "KJØP": 8, "KJOP": 8, "SALG": -8 };
const RUMOR_MULT = 0.5;    // uverifisert: halvert utslag, men beholder retning
const CONFLICT_MULT = 0.5; // spriker kildene: halvert utslag
const ATTENTION = 0.65;    // geometrisk fall i aggregatet: sterkeste signal dominerer

const FACTOR_TAG_RE = /\s*\[(?:BB|MAT|INSIDER):[^\]]*\]|\s*\[KONFLIKT\]/gi;
function stripFactorTags(s) { return s.replace(FACTOR_TAG_RE, ""); }

// Kjente redaksjoner modellen kan navngi i tekst - sjekkes mot faktiske siteringer
const OUTLET_NAMES = [
  ["reuters", "reuters.com"], ["bloomberg", "bloomberg.com"], ["financial times", "ft.com"],
  ["wall street journal", "wsj.com"], ["associated press", "apnews.com"],
  ["dn", "dn.no"], ["e24", "e24.no"], ["nrk", "nrk.no"], ["cnbc", "cnbc.com"], ["ntb", "ntb.no"],
];

const norm = (u) => {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase();
  } catch { return String(u).toLowerCase(); }
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ---- hovedfunksjon ---------------------------------------------------------------

/**
 * @param {object} p
 * @param {string} p.markdown   generert brief med [[C:n]]-markører og faktortagger
 * @param {Array}  p.sources    siterte kilder [{url,title}]
 * @param {Array}  p.searchResults alle faktiske søkeresultater [{url,title,page_age}]
 * @returns {{markdown, sources, claims, sections, overall}}
 */
export function annotate({ markdown, sources = [], searchResults = [] }) {
  // 1) Valider kilder mot faktiske søkeresultater (anti-hallusinering, håndhevet)
  const pool = new Map(); // norm(url) -> resultat (for page_age-berikelse)
  for (const r of searchResults) if (r?.url) pool.set(norm(r.url), r);

  const enriched = sources.map((s) => {
    const hit = pool.get(norm(s.url));
    const valid = Boolean(hit);
    const meta = { url: s.url, title: s.title || hit?.title || "", page_age: hit?.page_age || "" };
    const rating = rateSource(meta);
    if (!valid) rating.reasons.unshift("UGYLDIG: URL finnes ikke i søkeresultatene - strippet");
    return { ...meta, valid, rating };
  });
  const invalid = new Set(enriched.map((s, i) => (!s.valid ? i : -1)).filter((i) => i >= 0));

  // 2) Gå gjennom linjene: bygg claims, injiser [[V:id]]-markører, fjern faktortagger
  const lines = markdown.split("\n");
  const claims = [];
  const sectionOf = []; // claimId -> seksjonsnavn
  let curSection = "";
  let inRumorLayer = false;
  const out = [];

  for (let line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) { curSection = h2[1].trim().toUpperCase(); inRumorLayer = false; out.push(line); continue; }
    const h3 = line.match(/^###\s+(.+)/);
    if (h3) { inRumorLayer = /RYKTER|UBEKREFTET/i.test(h3[1]); out.push(line); continue; }

    const bulletM = line.match(/^(\s*[-*]\s+)(.*)$/);
    if (!bulletM) {
      // faktortagger og ugyldige siteringer skal ALDRI nå UI - heller ikke utenfor punkter
      out.push(stripInvalid(stripFactorTags(line), invalid));
      continue;
    }

    let body = bulletM[2];

    // faktortagger ut av teksten
    const bb = (body.match(/\[BB:([^\]]+)\]/i) || [])[1]?.toUpperCase().trim();
    const mat = (body.match(/\[MAT:([^\]]+)\]/i) || [])[1]?.toUpperCase().trim();
    const insider = (body.match(/\[INSIDER:([^\]]+)\]/i) || [])[1]?.toUpperCase().trim();
    const conflict = /\[KONFLIKT\]/i.test(body);
    body = stripFactorTags(body);

    body = stripInvalid(body, invalid);

    const cites = [...body.matchAll(/\[\[C:(\d+)\]\]/g)].map((m) => Number(m[1]))
      .filter((n) => enriched[n] && enriched[n].valid);
    const hasTimeTag = /\[(I DAG|DENNE UKEN|DENNE MÅNEDEN|ELDRE)/.test(body);
    const modelRumor = /\[(RYKTE|UBEKREFTET)\]/.test(body);
    const isCalendar = /^\s*`?\d{2}[:.]\d{2}\b/.test(body);
    const isEmptyNote = /^(ingen (ferske nyheter|rykter|vesentlige)|ingenting vesentlig)/i.test(body.trim());
    const isNewsClaim = !isCalendar && !isEmptyNote && (hasTimeTag || cites.length > 0 || bb || modelRumor || inRumorLayer);

    if (!isNewsClaim) { out.push(bulletM[1] + body); continue; }

    // 3) Konfidensnivå - beregnet i kode
    const why = [];
    const citedSrcs = cites.map((n) => enriched[n]);
    let level;
    if (inRumorLayer || modelRumor || (cites.length > 0 && citedSrcs.every((s) => isSocial(s.url) || s.rating.tier === 5))) {
      level = "rumor";
      why.push(inRumorLayer || modelRumor ? "merket som rykte/ubekreftet" : "kun sosiale medier/lavtier-kilder");
    } else if (cites.length === 0) {
      level = "rumor";
      why.push("ingen gyldige siteringer - kan ikke verifiseres (auto-nedgradert)");
    } else {
      const groups = independentGroups(citedSrcs);
      const primary = citedSrcs.some((s) => isPrimaryLike(s.url));
      if (primary) {
        level = "ok";
        why.push("primærkilde/selskapsmelding blant siteringene");
        if (groups.length >= 2) why.push(`${groups.length} uavhengige opphav`);
      } else if (groups.length >= 2) {
        level = "ok";
        why.push(`${groups.length} uavhengige opphav`);
      } else {
        level = "single";
        const s0 = citedSrcs[0];
        why.push(cites.length > 1
          ? `${cites.length} kilder, men samme opphav (syndikering) - telles som én`
          : `kun én kilde: ${domainOf(s0.url)} (${s0.rating.score}/100)`);
      }
    }

    // 4) Navngitt redaksjon i tekst uten tilsvarende sitering -> nedgrader
    const lowBody = body.toLowerCase();
    for (const [name, dom] of OUTLET_NAMES) {
      const nameRe = new RegExp(`(ifølge|iflg\\.?|melder|skriver|rapporterer)\\s+${name}\\b|\\b${name}\\s+(melder|skriver|rapporterer|bekrefter)`, "i");
      if (nameRe.test(lowBody) && !citedSrcs.some((s) => baseDomain(domainOf(s.url)) === dom)) {
        if (level === "ok") level = "single";
        why.push(`navngir ${name} uten ${name}-sitering - nedgradert`);
        break;
      }
    }
    if (conflict) why.push("kildene spriker - begge versjoner vist");

    // 5) Bull/bear - deterministisk av faktorene, dempet av konfidens
    const factors = [];
    let delta = 0;
    if (bb && BB_DELTA[bb] !== undefined) {
      delta = BB_DELTA[bb];
      const word = bb === "HARD+" ? "BULLISH - harde tall" : bb === "HARD-" ? "BEARISH - harde tall"
        : bb === "MYK+" ? "MILD BULL - mykt signal" : bb === "MYK-" ? "MILD BEAR - mykt signal" : "NØYTRAL";
      factors.push(`${word} (${delta >= 0 ? "+" : ""}${delta})`);
    } else {
      factors.push("Ingen retningsfaktor funnet (0)");
    }
    const matMult = MAT_MULT[mat] ?? 1.0;
    if (mat) factors.push(`${mat === "HØY" || mat === "HOY" ? "Høy" : mat === "LAV" ? "Lav" : "Middels"} betydning (x${matMult})`);
    let insiderDelta = 0;
    if (insider && INSIDER_DELTA[insider] !== undefined) {
      insiderDelta = INSIDER_DELTA[insider];
      factors.push(`${insider === "SALG" ? "Innsidesalg" : "Innsidekjøp"} (${insiderDelta > 0 ? "+" : ""}${insiderDelta})`);
    }
    // Konfidens vises som eget merke og demper IKKE retningen - kun rene rykter halveres.
    let dev = delta * matMult + insiderDelta;
    if (level === "rumor") { dev *= RUMOR_MULT; factors.push("Ubekreftet - halvert utslag (x0.5)"); }
    else factors.push(level === "ok" ? "Bekreftet kilde (full styrke)" : "Enkeltkilde (full styrke - egen konfidensmerking)");
    if (conflict) { dev *= CONFLICT_MULT; factors.push("Kildekonflikt (x0.5)"); }
    const score = clamp(Math.round(50 + dev), 5, 95);

    const id = claims.length;
    const text = body.replace(/\[\[C:\d+\]\]/g, "").replace(/\[[^\]]*\]/g, "").trim().slice(0, 110);
    claims.push({
      id, level, conflict, srcIdx: cites, why, text,
      bb: { score, factors, weight: matMult * (level === "rumor" ? 0.5 : 1) },
    });
    sectionOf[id] = curSection;
    out.push(`${bulletM[1]}[[V:${id}]]${body}`);
  }

  // 6) Seksjons- og totalscore
  const sections = {};
  for (const c of claims) {
    const name = sectionOf[c.id] || "UKJENT";
    (sections[name] = sections[name] || []).push(c);
  }
  const sectionScores = {};
  for (const [name, cs] of Object.entries(sections)) {
    sectionScores[name] = aggregate(cs);
  }
  const marketNames = Object.keys(sectionScores).filter((n) => /^(SITREP|USA|EUROPA|NORGE|ASIA)/.test(n));
  const marketClaims = marketNames.flatMap((n) => sections[n]);
  const overall = aggregate(marketClaims, { sitrepBoost: sections["SITREP"] || [] });

  return { markdown: out.join("\n"), sources: enriched, claims, sections: sectionScores, overall };
}

function stripInvalid(text, invalid) {
  if (!invalid.size) return text;
  return text.replace(/\[\[C:(\d+)\]\]/g, (m, n) => (invalid.has(Number(n)) ? "" : m));
}

// Dominans-vektet aggregat: sterkeste signal teller fullt, neste 65 %, osv.
// => tunge materielle saker styrer scoren; mange nøytrale småsaker utvanner ikke.
// Konfidens påvirker IKKE retningen her - den vises som LAV KONFIDENS-merke.
function aggregate(cs, { sitrepBoost = [] } = {}) {
  const scored = cs.filter((c) => c.bb);
  if (!scored.length) return { score: 50, lowConf: true, drivers: [], n: 0 };
  const ranked = [...scored].sort((a, b) =>
    Math.abs(b.bb.score - 50) * b.bb.weight - Math.abs(a.bb.score - 50) * a.bb.weight);
  // Dominans per RETNING, deretter nettes sidene: like sterke motsatte signaler
  // gir nøytral, mens tunge ensidige signaler dominerer uten å utvannes.
  const side = { pos: { num: 0, den: 0, att: 1 }, neg: { num: 0, den: 0, att: 1 } };
  for (const c of ranked) {
    const d = c.bb.score - 50;
    if (d === 0) continue;
    let w = c.bb.weight;
    if (sitrepBoost.includes(c)) w *= 1.5; // makro veier tyngre i totalen
    const s = d > 0 ? side.pos : side.neg;
    s.num += Math.abs(d) * w * s.att;
    s.den += w * s.att;
    s.att *= ATTENTION;
  }
  const avg = (s) => (s.den ? s.num / s.den : 0);
  const tot = side.pos.den + side.neg.den;
  const S = tot ? (avg(side.pos) * side.pos.den - avg(side.neg) * side.neg.den) / tot : 0;
  const score = clamp(Math.round(50 + S), 2, 98);
  const unverified = scored.filter((c) => c.level === "rumor").length;
  // Ærlighetsregel (adskilt fra retning): tynt grunnlag = få punkter,
  // halvparten+ ubekreftet, eller ingen bekreftet sak i seksjonen.
  const lowConf = scored.length < 2
    || unverified / scored.length >= 0.5
    || !scored.some((c) => c.level === "ok");
  const drivers = ranked.slice(0, 3)
    .map((c) => ({ id: c.id, score: c.bb.score, text: c.text.slice(0, 70) }));
  return { score, lowConf, drivers, n: scored.length };
}
