// store.js - persistens med to backender:
//   - KV (Upstash/Vercel KV) når KV-miljøvariabler er satt -> funker serverless
//   - lokale filer (data/, briefings/) ellers -> funker for npm run dev
// Alt er async slik at begge backender har samme API.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kvAvailable, kvGetJSON, kvSetJSON, kvIncr, kvDel } from "./kv.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = path.join(ROOT, "data");
export const BRIEFINGS_DIR = path.join(ROOT, "briefings");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const K = (s) => `mb:${s}`;
const DAY_TTL = 3 * 86400; // datonøklede KV-nøkler rydder seg selv

export function storageMode() {
  return kvAvailable() ? "kv" : "fil";
}

// Favoritter = hurtigvalg i fokus-velgeren. Ingenting er "alltid i fokus";
// dagens fokus velges eksplisitt hver dag.
const DEFAULT_SETTINGS = {
  favorites: [
    {
      label: "Ondas Holdings",
      ticker: "ONDS",
      angle:
        "Droner, counter-UAS, amerikanske forsvarsbudsjetter, FAA/BVLOS-regulering, datterselskapene American Robotics & Airobotics, militær-/grensekontrakter, utvanningsrisiko og emisjoner, konkurrenter (AeroVironment, Red Cat, DroneShield).",
    },
    {
      label: "Kongsberg Gruppen",
      ticker: "KOG.OL",
      angle:
        "Europeisk/NATO-forsvarsopptrapping, missil- og luftvernkontrakter (NSM/JSM, NASAMS), maritime og undervannssystemer, norsk forsvarsbudsjett, ordrereserve, NOK-effekter, konkurrenter (Rheinmetall, Saab, BAE Systems).",
    },
    { label: "Teknologi / halvledere", ticker: "", angle: "AI-infrastruktur, halvledere, datasentre, store tech-selskaper, chip-eksportkontroller." },
    { label: "Forsvarssektoren", ticker: "", angle: "Europeisk opprustning, NATO-budsjetter, forsvarsaksjer i Norden og Europa, Ukraina-relatert materiell." },
  ],
  timezone: "Europe/Oslo",
};

export function ensureDirs() {
  if (kvAvailable()) return; // ingen filer i KV-modus (Vercel har read-only filsystem)
  for (const d of [DATA_DIR, BRIEFINGS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function atomicWrite(file, content) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

function sanitizeItems(items, { requireOne = true } = {}) {
  const out = (items || [])
    .map((c) => ({
      label: String(c.label || c.name || c.ticker || "").trim(),
      ticker: String(c.ticker || "").trim().toUpperCase(),
      angle: String(c.angle || "").trim(),
    }))
    .filter((c) => c.label.length > 0)
    .slice(0, 8);
  if (requireOne && out.length === 0) throw new Error("Minst ett element kreves.");
  return out;
}

function migrate(raw) {
  if (!Array.isArray(raw.favorites) && Array.isArray(raw.focusCompanies)) {
    raw.favorites = raw.focusCompanies.map((c) => ({
      label: c.name || c.ticker, ticker: c.ticker || "", angle: c.angle || "",
    }));
    delete raw.focusCompanies;
  }
  return raw;
}

// ---- datoer (alt nøklet til Europe/Oslo) ---------------------------------

export function todayKey(tz = "Europe/Oslo") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

export function nowCET(tz = "Europe/Oslo") {
  const d = new Date();
  const time = new Intl.DateTimeFormat("nb-NO", {
    timeZone: tz, hour: "2-digit", minute: "2-digit",
  }).format(d);
  const date = new Intl.DateTimeFormat("nb-NO", {
    timeZone: tz, weekday: "long", day: "2-digit", month: "long", year: "numeric",
  }).format(d);
  return { time, date, iso: d.toISOString() };
}

// ---- innstillinger / favoritter -----------------------------------------

export async function getSettings(profile) {
  const kkey = K(profileSettingsKey(profile));
  const file = profile
    ? path.join(DATA_DIR, `${profileSettingsKey(profile).replaceAll(":", "-")}.json`)
    : SETTINGS_FILE;
  if (kvAvailable()) {
    const raw = await kvGetJSON(kkey).catch(() => null);
    if (raw && Array.isArray(migrate(raw).favorites)) return { ...DEFAULT_SETTINGS, ...raw };
    // ny profil arver felles-lista som utgangspunkt
    if (profile) {
      const base = await getSettings();
      await kvSetJSON(kkey, base).catch(() => {});
      return base;
    }
    await kvSetJSON(kkey, DEFAULT_SETTINGS).catch(() => {});
    return structuredClone(DEFAULT_SETTINGS);
  }
  ensureDirs();
  try {
    const raw = migrate(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!Array.isArray(raw.favorites)) throw new Error("bad settings");
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    const base = profile ? await getSettings() : structuredClone(DEFAULT_SETTINGS);
    atomicWrite(file, JSON.stringify(base, null, 2));
    return base;
  }
}

export async function saveSettings(next, profile) {
  const favorites = sanitizeItems(next.favorites);
  const settings = { ...(await getSettings(profile)), favorites };
  const kkey = K(profileSettingsKey(profile));
  if (kvAvailable()) {
    await kvSetJSON(kkey, settings);
  } else {
    ensureDirs();
    const file = profile
      ? path.join(DATA_DIR, `${profileSettingsKey(profile).replaceAll(":", "-")}.json`)
      : SETTINGS_FILE;
    atomicWrite(file, JSON.stringify(settings, null, 2));
  }
  return settings;
}

// ---- dagens fokus ----------------------------------------------------------

const focusFile = () => path.join(DATA_DIR, `focus-${todayKey()}.json`);

export async function getTodayFocus() {
  if (kvAvailable()) {
    const j = await kvGetJSON(K(`focus:${todayKey()}`)).catch(() => null);
    return Array.isArray(j?.items) && j.items.length ? j.items : null;
  }
  ensureDirs();
  try {
    const j = JSON.parse(fs.readFileSync(focusFile(), "utf8"));
    return Array.isArray(j.items) && j.items.length ? j.items : null;
  } catch {
    return null;
  }
}

export async function saveTodayFocus(items) {
  const clean = sanitizeItems(items);
  const payload = { date: todayKey(), items: clean };
  if (kvAvailable()) {
    await kvSetJSON(K(`focus:${todayKey()}`), payload, { ex: DAY_TTL });
  } else {
    ensureDirs();
    atomicWrite(focusFile(), JSON.stringify(payload, null, 2));
  }
  return clean;
}

// ---- briefs (datobasert cache-nøkkel: mb:brief:ÅÅÅÅ-MM-DD) -------------------

export async function saveBriefing(markdown, meta = {}, sources = [], extra = {}) {
  const key = todayKey();
  const record = { markdown: markdown.trim(), meta, sources, ...extra, date: key };
  if (kvAvailable()) {
    await kvSetJSON(K(`brief:${key}`), record, { ex: DAY_TTL });
    return `KV brief:${key}`;
  }
  ensureDirs();
  // App-lesbar fasit (med kildemarkører, claims og scorer) i data/
  atomicWrite(path.join(DATA_DIR, `brief-${key}.json`), JSON.stringify(record, null, 2));
  // Menneske-/Claude Desktop-lesbar markdown i briefings/: markører -> [kilde n] + KILDER-liste
  const file = path.join(BRIEFINGS_DIR, `${key}.md`);
  const header = [
    "---",
    `date: ${key}`,
    `generatedAt: ${meta.generatedAt || new Date().toISOString()}`,
    `generatedAtCET: ${meta.generatedAtCET || ""}`,
    `model: ${meta.model || ""}`,
    `focus: ${meta.focus || ""}`,
    `searches: ${meta.searches || 0}`,
    "---",
    "",
  ].join("\n");
  const readable = markdown.trim().replace(/\[\[C:(\d+)\]\]/g, (m, n) => ` [kilde ${Number(n) + 1}]`);
  const srcAppendix = sources.length
    ? "\n\n## KILDER\n" + sources.map((s, i) => `${i + 1}. ${s.title ? s.title + " - " : ""}${s.url}`).join("\n")
    : "";
  atomicWrite(file, header + readable + srcAppendix + "\n");
  return path.relative(ROOT, file).replaceAll("\\", "/");
}

export async function readTodayBriefing() {
  const key = todayKey();
  const shape = (j) => ({
    markdown: j.markdown, meta: j.meta || {}, sources: j.sources || [],
    claims: j.claims || [], sections: j.sections || {}, overall: j.overall || null,
    deltas: j.deltas || null, delta: j.delta || null, date: key,
  });
  if (kvAvailable()) {
    const j = await kvGetJSON(K(`brief:${key}`)).catch(() => null);
    return j && j.markdown ? shape(j) : null;
  }
  // Filmodus: JSON-fasiten (med markører + kilder + claims) foretrekkes
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `brief-${key}.json`), "utf8"));
    if (j && j.markdown) return shape(j);
  } catch { /* fall tilbake til md-fil (eldre briefer) */ }
  const file = path.join(BRIEFINGS_DIR, `${key}.md`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  let meta = {};
  let markdown = raw;
  if (m) {
    markdown = raw.slice(m[0].length).trim();
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return { markdown, meta, sources: [], claims: [], sections: {}, overall: null, deltas: null, date: key };
}

// Intradag-delta lagres inn i dagens brief-record (gjenbruker cachen, fase 2)
export async function saveBriefDelta(delta) {
  const key = todayKey();
  if (kvAvailable()) {
    const j = await kvGetJSON(K(`brief:${key}`)).catch(() => null);
    if (!j || !j.markdown) throw new Error("Ingen morgenbrief å oppdatere.");
    j.delta = delta;
    await kvSetJSON(K(`brief:${key}`), j, { ex: DAY_TTL });
    return;
  }
  const p = path.join(DATA_DIR, `brief-${key}.json`);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.delta = delta;
  atomicWrite(p, JSON.stringify(j, null, 2));
}

// ---- bull/bear-historikk (for delta mot i går + fremtidig graf) ---------------

export function yesterdayKey(tz = "Europe/Oslo") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now() - 86400_000));
}

const bbHistFile = () => path.join(DATA_DIR, "bb-hist.json");

export async function getBbHistory(dateKey) {
  if (kvAvailable()) {
    return kvGetJSON(K(`bb:${dateKey}`)).catch(() => null);
  }
  try {
    return JSON.parse(fs.readFileSync(bbHistFile(), "utf8"))[dateKey] || null;
  } catch {
    return null;
  }
}

// Serie for sparklines/aksjekort (fase 3)
export async function getBbHistoryRange(days = 30) {
  if (!kvAvailable()) {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(bbHistFile(), "utf8")); } catch { /* tom */ }
    return Object.entries(all).sort().slice(-days).map(([date, v]) => ({ date, ...v }));
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(new Date(Date.now() - i * 86400e3));
    const v = await kvGetJSON(K(`bb:${d}`)).catch(() => null);
    if (v) out.push({ date: d, ...v });
  }
  return out;
}

// ---- profiler (fase 3): egen watchlist per venn, felles brief ------------------

const safeProfile = (p) => String(p || "").toLowerCase().replace(/[^a-z0-9æøå_-]/g, "").slice(0, 16);
const profilesFile = () => path.join(DATA_DIR, "profiles.json");

export async function getProfiles() {
  if (kvAvailable()) return (await kvGetJSON(K("profiles")).catch(() => null)) || [];
  try { return JSON.parse(fs.readFileSync(profilesFile(), "utf8")); } catch { return []; }
}

export async function addProfile(name) {
  const p = safeProfile(name);
  if (!p) throw new Error("Ugyldig profilnavn (a-z, 0-9, maks 16 tegn).");
  const list = await getProfiles();
  if (!list.includes(p)) {
    list.push(p);
    if (kvAvailable()) await kvSetJSON(K("profiles"), list.slice(0, 20));
    else { ensureDirs(); atomicWrite(profilesFile(), JSON.stringify(list.slice(0, 20))); }
  }
  return p;
}

export function profileSettingsKey(profile) {
  const p = safeProfile(profile);
  return p ? `settings:p:${p}` : "settings";
}

export async function saveBbHistory(dateKey, snapshot) {
  if (kvAvailable()) {
    await kvSetJSON(K(`bb:${dateKey}`), snapshot, { ex: 90 * 86400 }).catch(() => {});
    return;
  }
  ensureDirs();
  let all = {};
  try { all = JSON.parse(fs.readFileSync(bbHistFile(), "utf8")); } catch { /* ny fil */ }
  all[dateKey] = snapshot;
  const keys = Object.keys(all).sort().slice(-90); // behold 90 dager
  atomicWrite(bbHistFile(), JSON.stringify(Object.fromEntries(keys.map((k) => [k, all[k]])), null, 2));
}

// ---- chat (per dag, nullstilles naturlig ved datoskifte) --------------------

const chatFile = () => path.join(DATA_DIR, `chat-${todayKey()}.json`);

export async function getChatHistory() {
  if (kvAvailable()) {
    return (await kvGetJSON(K(`chat:${todayKey()}`)).catch(() => null)) || [];
  }
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(chatFile(), "utf8"));
  } catch {
    return [];
  }
}

export async function saveChatHistory(messages) {
  const trimmed = messages.slice(-20); // 20 meldinger er nok kontekst, og bounder input-kost
  if (kvAvailable()) {
    await kvSetJSON(K(`chat:${todayKey()}`), trimmed, { ex: DAY_TTL });
  } else {
    ensureDirs();
    atomicWrite(chatFile(), JSON.stringify(trimmed, null, 2));
  }
}

// ---- dagsforbruk (kredittvern - atomisk i KV) --------------------------------

const usageFile = () => path.join(DATA_DIR, `usage-${todayKey()}.json`);

export async function getUsage() {
  if (kvAvailable()) {
    const [b, c] = await Promise.all([
      kvGetJSON(K(`usage:briefs:${todayKey()}`)).catch(() => 0),
      kvGetJSON(K(`usage:chats:${todayKey()}`)).catch(() => 0),
    ]);
    return { briefs: Number(b) || 0, chats: Number(c) || 0 };
  }
  try {
    return { briefs: 0, chats: 0, ...JSON.parse(fs.readFileSync(usageFile(), "utf8")) };
  } catch {
    return { briefs: 0, chats: 0 };
  }
}

// Teller opp og returnerer NY verdi. Atomisk (INCR) i KV-modus.
export async function bumpUsage(kind) {
  if (kvAvailable()) {
    return kvIncr(K(`usage:${kind}:${todayKey()}`), { ex: DAY_TTL });
  }
  ensureDirs();
  const u = await getUsage();
  u[kind] = (u[kind] || 0) + 1;
  atomicWrite(usageFile(), JSON.stringify(u));
  return u[kind];
}

// ---- genererings-lås (mot doble Claude-kall ved samtidige requests) ----------

let localLock = 0; // filmodus: enkel in-process-lås med 3 min staleness

export async function acquireGenLock() {
  if (kvAvailable()) {
    const r = await kvSetJSON(K("lock:gen"), Date.now(), { nx: true, ex: 180 }).catch(() => null);
    return r === "OK";
  }
  if (localLock && Date.now() - localLock < 180_000) return false;
  localLock = Date.now();
  return true;
}

export async function releaseGenLock() {
  if (kvAvailable()) {
    await kvDel(K("lock:gen")).catch(() => {});
    return;
  }
  localLock = 0;
}
