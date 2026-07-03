// ratelimit.js - enkel teller-basert rate limiting per IP.
// KV-modus: atomisk INCR med TTL (fungerer på tvers av serverless-instanser).
// Filmodus: in-memory (holder lokalt; én prosess).
import { kvAvailable, kvIncr, kvGetJSON } from "./kv.js";

const mem = new Map();

function memEntry(key, windowSec) {
  const now = Date.now();
  let e = mem.get(key);
  if (!e || now > e.reset) {
    e = { n: 0, reset: now + windowSec * 1000 };
    mem.set(key, e);
  }
  if (mem.size > 5000) mem.clear(); // grov minne-sikring
  return e;
}

/** Teller ETT forsøk og returnerer true hvis fortsatt innenfor taket. */
export async function allowRate(bucket, ip, max, windowSec) {
  const key = `mb:rl:${bucket}:${ip}`;
  if (kvAvailable()) {
    const n = await kvIncr(key, { ex: windowSec }).catch(() => 1);
    return n <= max;
  }
  const e = memEntry(key, windowSec);
  e.n += 1;
  return e.n <= max;
}

/** Sjekker uten å telle (for lockout-porten før passordvurdering). */
export async function checkRate(bucket, ip, max) {
  const key = `mb:rl:${bucket}:${ip}`;
  if (kvAvailable()) {
    const n = Number(await kvGetJSON(key).catch(() => 0)) || 0;
    return n < max;
  }
  const e = mem.get(key);
  return !e || Date.now() > e.reset || e.n < max;
}
