// POST /api/login -> setter auth-cookie. GET -> innloggingsside.
import { readBody } from "../lib/http.js";
import { handleLoginPost, LOGIN_HTML } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(LOGIN_HTML);
  }
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }
  const body = await readBody(req).catch(() => ({}));
  return handleLoginPost(req, res, body);
}
