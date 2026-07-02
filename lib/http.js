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
