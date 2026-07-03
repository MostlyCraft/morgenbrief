// http.js - delte HTTP-hjelpere for lokal server (server.js) OG Vercel-functions (api/).
// Skrevet mot ren Node req/res, som funker begge steder.

export function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

export function readBody(req) {
  // Vercel Node-functions har ofte allerede parset body til req.body
  if (req.body !== undefined && req.body !== null) {
    try {
      return Promise.resolve(typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body);
    } catch {
      return Promise.resolve({});
    }
  }
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error("Body for stor")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("Ugyldig JSON-body")); }
    });
    req.on("error", reject);
  });
}

export function sseInit(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

export const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

export function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xf) ? xf[0] : String(xf || "")).split(",")[0].trim();
  return first || req.socket?.remoteAddress || "ukjent";
}

// Strukturert feillogg: siste 50 i Redis (14 dagers TTL), console lokalt.
export async function logError(scope, err) {
  const line = { t: new Date().toISOString(), scope, msg: String(err?.message || err).slice(0, 300) };
  try {
    const { kvAvailable, kvGetJSON, kvSetJSON } = await import("./kv.js");
    if (kvAvailable()) {
      const arr = (await kvGetJSON("mb:errlog").catch(() => null)) || [];
      arr.unshift(line);
      await kvSetJSON("mb:errlog", arr.slice(0, 50), { ex: 14 * 86400 });
      return;
    }
  } catch { /* fall til console */ }
  console.error("[MB-FEIL]", line.t, line.scope, line.msg);
}

// Sikkerhetsheadere for lokal server (på Vercel settes de i vercel.json).
export function securityHeaders(res, isHttps = false) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  if (isHttps) res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
}
