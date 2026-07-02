// store.js - lokal persistens: innstillinger (favoritter), dagens fokus,
// brief-markdownfiler og chat-historikk per dag.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = path.join(ROOT, "data");
export const BRIEFINGS_DIR = path.join(ROOT, "briefings");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

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

// ---- innstillinger / favoritter -----------------------------------------

export function getSettings() {
  ensureDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    // migrasjon fra v1.0-format (focusCompanies -> favorites)
    if (!Array.isArray(raw.favorites) && Array.isArray(raw.focusCompanies)) {
      raw.favorites = raw.focusCompanies.map((c) => ({
        label: c.name || c.ticker, ticker: c.ticker || "", angle: c.angle || "",
      }));
      delete raw.focusCompanies;
    }
    if (!Array.isArray(raw.favorites)) throw new Error("bad settings");
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    atomicWrite(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(next) {
  ensureDirs();
  const favorites = sanitizeItems(next.favorites);
  const settings = { ...getSettings(), favorites };
  atomicWrite(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings;
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

// ---- dagens fokus ----------------------------------------------------------

function focusFile() {
  return path.join(DATA_DIR, `focus-${todayKey()}.json`);
}

export function getTodayFocus() {
  ensureDirs();
  try {
    const j = JSON.parse(fs.readFileSync(focusFile(), "utf8"));
    return Array.isArray(j.items) && j.items.length ? j.items : null;
  } catch {
    return null;
  }
}

export function saveTodayFocus(items) {
  ensureDirs();
  const clean = sanitizeItems(items);
  atomicWrite(focusFile(), JSON.stringify({ date: todayKey(), items: clean }, null, 2));
  return clean;
}

// ---- briefs -----------------------------------------------------------------

export function saveBriefing(markdown, meta = {}) {
  ensureDirs();
  const key = todayKey();
  const file = path.join(BRIEFINGS_DIR, `${key}.md`);
  const header = [
    "---",
    `date: ${key}`,
    `generatedAt: ${meta.generatedAt || new Date().toISOString()}`,
    `generatedAtCET: ${meta.generatedAtCET || ""}`,
    `model: ${meta.model || ""}`,
    `focus: ${meta.focus || ""}`,
    "---",
    "",
  ].join("\n");
  atomicWrite(file, header + markdown.trim() + "\n");
  return file;
}

export function readTodayBriefing() {
  const key = todayKey();
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
  return { markdown, meta, date: key };
}

// ---- chat (per dag, nullstilles naturlig ved datoskifte) --------------------

function chatFile() {
  return path.join(DATA_DIR, `chat-${todayKey()}.json`);
}

export function getChatHistory() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(chatFile(), "utf8"));
  } catch {
    return [];
  }
}

export function saveChatHistory(messages) {
  ensureDirs();
  // 20 meldinger er nok kontekst - og halverer input-kost på lange økter
  atomicWrite(chatFile(), JSON.stringify(messages.slice(-20), null, 2));
}

// ---- dagsforbruk (kredittvern ved deling) -----------------------------------

function usageFile() {
  return path.join(DATA_DIR, `usage-${todayKey()}.json`);
}

export function getUsage() {
  try {
    return { briefs: 0, chats: 0, ...JSON.parse(fs.readFileSync(usageFile(), "utf8")) };
  } catch {
    return { briefs: 0, chats: 0 };
  }
}

export function bumpUsage(kind) {
  ensureDirs();
  const u = getUsage();
  u[kind] = (u[kind] || 0) + 1;
  atomicWrite(usageFile(), JSON.stringify(u));
  return u;
}
