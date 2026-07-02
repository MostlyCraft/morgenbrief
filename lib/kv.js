// kv.js - Redis via Upstash/Vercel KV REST API. Null dependencies (ren fetch).
// Brukes når KV_REST_API_URL/TOKEN (Vercel Marketplace) eller
// UPSTASH_REDIS_REST_URL/TOKEN er satt. Ellers faller store.js tilbake til filer.
import { loadEnv } from "./env.js";
loadEnv();

const kvUrl = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const kvToken = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export function kvAvailable() {
  return Boolean(kvUrl() && kvToken());
}

// Én Redis-kommando som JSON-array, f.eks. ["SET","k","v","EX","600","NX"]
async function cmd(...args) {
  const res = await fetch(kvUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${kvToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(args.map(String)),
  });
  if (!res.ok) throw new Error(`KV HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`KV: ${j.error}`);
  return j.result;
}

export async function kvGetJSON(key) {
  const r = await cmd("GET", key);
  if (r == null) return null;
  try { return JSON.parse(r); } catch { return null; }
}

// opts: { ex: sekunder TTL, nx: true = kun hvis nøkkelen ikke finnes }
// Returnerer "OK" ved suksess, null hvis NX feilet (nøkkel fantes).
export async function kvSetJSON(key, value, { ex, nx } = {}) {
  const args = ["SET", key, JSON.stringify(value)];
  if (ex) args.push("EX", ex);
  if (nx) args.push("NX");
  return cmd(...args);
}

// Atomisk teller (for dagstak). Setter TTL ved første inkrement.
export async function kvIncr(key, { ex } = {}) {
  const n = await cmd("INCR", key);
  if (ex && Number(n) === 1) await cmd("EXPIRE", key, ex);
  return Number(n);
}

export async function kvDel(key) {
  return cmd("DEL", key);
}
