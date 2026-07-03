// auth.js - valgfri tilgangskode (SITE_PASSWORD) med cookie. Delt av server.js og api/.
import crypto from "node:crypto";
import { loadEnv } from "./env.js";
import { json } from "./http.js";
loadEnv();

const pw = () => process.env.SITE_PASSWORD || "";

export function authToken() {
  const p = pw();
  return p ? crypto.createHash("sha256").update(p).digest("hex") : "";
}

export function isAuthed(req) {
  if (!pw()) return true; // ingen kode satt = åpen (lokal bruk)
  const c = req.headers.cookie || "";
  const t = authToken();
  return c.split(";").some((kv) => kv.trim() === `mb_auth=${t}`);
}

// For API-endepunkter: svarer 401 selv og returnerer false hvis ikke innlogget.
export function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  json(res, 401, { error: "Ikke innlogget" });
  return false;
}

// POST /api/login-body -> setter cookie (30 dager).
// Lockout: 5 feilforsøk per IP => 15 minutter stengt (også for riktig kode).
export async function handleLoginPost(req, res, body, ip = "ukjent") {
  const { allowRate, checkRate } = await import("./ratelimit.js");

  if (!(await checkRate("loginfail", ip, 5))) {
    return json(res, 429, { error: "For mange feilforsøk - låst i 15 minutter." });
  }

  if (pw() && body && body.password === pw()) {
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.writeHead(200, {
      "Set-Cookie": `mb_auth=${authToken()}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secure}`,
      "Content-Type": "application/json; charset=utf-8",
    });
    return res.end('{"ok":true}');
  }

  await allowRate("loginfail", ip, 5, 900); // tell feilforsøket
  return json(res, 401, { error: "Feil kode" });
}

export const LOGIN_HTML = `<!DOCTYPE html><html lang="nb"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>MORGENBRIEF</title><style>body{background:#06080b;color:#c7d3dd;font-family:Consolas,ui-monospace,Menlo,monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}form{border:1px solid #1c2733;background:#0b0f15;padding:26px;text-align:center}h1{font-size:15px;letter-spacing:2px;font-weight:normal;margin:0 0 14px}h1 b{color:#ffb300}input{background:#06080b;color:#c7d3dd;border:1px solid #1c2733;padding:8px 10px;font-family:inherit;font-size:13px;outline:none;width:220px}input:focus{border-color:#8a6a1a}button{margin-top:10px;background:none;border:1px solid #8a6a1a;color:#ffb300;padding:7px 14px;font-family:inherit;font-size:12px;letter-spacing:1px;cursor:pointer;display:block;width:100%}button:hover{background:#ffb300;color:#000}.err{color:#ff4d4d;font-size:12px;margin-top:8px;min-height:1em}</style></head><body><form id="f"><h1>MORGEN<b>BRIEF</b></h1><input id="p" type="password" placeholder="tilgangskode" autofocus /><button>LOGG INN</button><div class="err" id="e"></div></form><script>document.getElementById("f").addEventListener("submit",async(ev)=>{ev.preventDefault();const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("p").value})});if(r.ok)location.replace("/");else document.getElementById("e").textContent="Feil kode."});</script></body></html>`;
