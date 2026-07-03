# MORGENBRIEF — Arkitektur

Sist oppdatert: fase 0 (v3-herding). Null npm-avhengigheter — ren Node 18+, vanilla frontend.

## Oversikt

```
Nettleser (public/: index.html, app.js, style.css — statisk, mørk terminal-UI)
   │  relative /api/*-kall, SSE-over-fetch for streaming
   ▼
Backend, to likeverdige innganger mot samme kjerne:
   • server.js        → lokal utvikling (npm run dev, node:http)
   • api/*.js         → Vercel serverless functions (samme handlere, tynne wrappere)
   ▼
lib/core.js           → all endepunkt-logikk (generering, chat, kurser, meta)
   ├─ lib/anthropic.js  → Messages API m/web_search, SSE-parsing, citations→[[C:n]], søk-telling
   ├─ lib/verify.js     → KODE-håndhevet kildekritikk + deterministisk bull/bear (se under)
   ├─ lib/sources.js    → kilderating (tiers), syndikering/uavhengighet
   ├─ lib/prompts.js    → redaksjonen: tone, seksjonsskjelett, tidstagger, faktortagger
   ├─ lib/quotes.js     → Finnhub (US, hvis nøkkel) + Yahoo chart-API (indekser/Oslo Børs/FX)
   ├─ lib/store.js      → lagring, dual backend (Redis/fil)
   ├─ lib/ratelimit.js  → IP-tellere (Upstash INCR / in-memory)
   ├─ lib/auth.js       → SITE_PASSWORD-cookie + login-lockout
   └─ lib/http.js       → json/SSE/body/IP/feillogg/sikkerhetsheadere
```

## Dataflyt: brief-generering

1. `POST /api/briefing/generate` (auth + IP-ratelimit 10/t) — cache-først: finnes `mb:brief:{dato}` og `force!=true` → cachet svar, 0 API-kall.
2. Ellers: KV-lås (`SET NX EX 180`) → dagstak (`INCR mb:usage:briefs:{dato}`, maks `MAX_BRIEFS_PER_DAY`).
3. Kurser hentes (KV-cache 5 min) og injiseres som fasit — modellen søker aldri etter tall.
4. ETT Anthropic-kall (Haiku default) med `web_search` (maks `BRIEF_MAX_SEARCHES`=12). Streamen gir: tekst, citations (→ `[[C:n]]`-markører), ALLE søkeresultater (pool), søk-antall. 0 søk ⇒ briefen AVVISES.
5. `verify.js` etterbehandler i kode: hver kilde-URL valideres mot søkeresultat-poolen (hallusinerte strippes), kilder grupperes i uavhengige opphav (domene/byrå-kreditt/tittel-containment ≥0.7), hvert nyhetspunkt får konfidensnivå (✓ 2+ uavhengige eller primærdokument / ◐ enkeltkilde / ✗ ubekreftet) og bull/bear-score = 50 + (retning×betydning + innsider) × konfidensdemping (rykte ×0.25 — kan aldri gi ekstremscore). Faktorer lagres synlig per påstand.
6. Lagres som helhetlig record; BB-snapshot til historikk (90 d) for ▲/▼-delta mot i går.

Chat: samme kjerne, briefen som cachet systemblokk (Anthropic prompt-caching, 90 % rabatt), maks 3 søk, `MAX_CHATS_PER_DAY` + IP-limit 30/t.

## Lagringsmodell (Redis-nøkler, `mb:`-prefiks; filmodus speiler i `data/`)

| Nøkkel | Innhold | TTL |
|---|---|---|
| `mb:settings` | favoritter (label/ticker/vinkel) | ∞ |
| `mb:focus:{dato}` | dagens fokusvalg | 3 d |
| `mb:brief:{dato}` | {markdown, meta, sources, claims, sections, overall, deltas} | 3 d |
| `mb:chat:{dato}` | historikk (siste 20, m/kilder) | 3 d |
| `mb:usage:briefs/chats:{dato}` | dagstellere (atomisk INCR) | 3 d |
| `mb:lock:gen` | genererings-lås | 180 s |
| `mb:quotes:{tickere}` | kurs-cache | 5 min |
| `mb:bb:{dato}` | bull/bear-snapshot (overall + per aksje) | 90 d |
| `mb:rl:{bucket}:{ip}` | ratelimit-tellere (loginfail/gen/chat) | 15 min–1 t |
| `mb:errlog` | siste 50 strukturerte feil | 14 d |

## API-ruter

| Rute | Metode | Auth | Beskrivelse |
|---|---|---|---|
| /api/health | GET | nei | driftsstatus (ingen hemmeligheter) |
| /api/login | POST | – | cookie-login; lockout 5 feil/IP → 15 min |
| /api/meta | GET | ja | dato, modeller, status |
| /api/settings | GET/PUT | ja | favoritter |
| /api/focus/today | GET/PUT | ja | dagens fokus |
| /api/quotes | GET | ja | kurs-tape |
| /api/briefing/today | GET | ja | cachet brief m/claims+scorer |
| /api/briefing/generate | POST | ja | SSE; cache-først; ratelimit |
| /api/chat, /api/chat/today | POST, GET/DELETE | ja | desk-chat |

## Sikkerhet

- Cookie: `mb_auth` = sha256(SITE_PASSWORD); HttpOnly, SameSite=Lax, Secure bak HTTPS. Passord/API-nøkler finnes KUN server-side (env) — klienten mottar aldri secrets.
- Login-lockout og IP-ratelimits (se over) via Upstash INCR (fungerer på tvers av serverless-instanser); in-memory lokalt.
- Headere (vercel.json for prod, lib/http.js lokalt): CSP (self + inline styles; inline script tillatt kun pga. login-siden), HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy.
- Statisk forside er offentlig på Vercel; all data/handling ligger bak 401-gaten (login-overlay i appen).
- Kjent svakhet (akseptert, venne-skala): delt instans — felles brief/chat; samtidige chattere kan miste en melding (les-endre-skriv).

## Cache-/kostnadsstrategi

Visninger koster aldri API-kall. Maks per dag (default): 2 brief-genereringer + 60 chat-svar = 62 Claude-kall, uansett trafikk; websøk er verktøybruk INNI kallet (≤12 à $0.01). Haiku ≈ 10–15 cent per brief. Modell byttes med `ANTHROPIC_MODEL`/`ANTHROPIC_CHAT_MODEL` (ingen kodeendring).

## Ytelse

Ingen build-steg, ingen rammeverk: app.js ≈ 35 kB, style.css ≈ 15 kB, ukomprimert. Serverless cold start er liten (ren Node, null deps, ingen bundler); tyngste operasjon er selve modellkallet (30–120 s, streames). Statiske filer får Cache-Control via vercel.json.

## Datakilder & vilkår

- Anthropic web_search: betalt verktøy, brukes kun ved generering; siteringer vises med lenke (kravet i vilkårene).
- Yahoo Finance chart-endepunkt: uoffisielt, gratis, kan rate-limites — best effort med host-fallback, aldri sanntidsgaranti. Kurs-chips viser kilde + alder («oppdatert X min siden»).
- Finnhub free tier: kun US-tickere; nøkkel valgfri. Vilkår: personlig/ikke-kommersiell bruk på free tier; resultatkalender brukes med nøkkel.
- **SEC EDGAR** (fase 1): offisiell og gratis. Fair access-policy krever identifiserende User-Agent med kontaktinfo (`EDGAR_CONTACT` i env) og ≤10 req/s — vi gjør ≤6 småkall per ticker hver 6. time (cachet). Form 4 klassifiseres kjøp/salg fra transaksjonskoder i kode (`lib/marketdata.js`).
- **FRED / St. Louis Fed** (fase 1): offisiell, gratis nøkkel (`FRED_API_KEY`). Vilkår krever kildeangivelse — UI merker tallene «FRED». Serier: DFF (styringsrente), CPIAUCSL (KPI å/å regnes i kode), UNRATE.
- **NewsWeb/Oslo Børs** (fase 1): uoffisiell JSON-lesing av offentlige børsmeldinger; endepunktet kan endres uten varsel (`NEWSWEB_BASE` overstyrbar). UI viser ærlig «kilde utilgjengelig» ved feil. Meldepliktige handler detekteres på tittel/kategori i kode.
- Alle fase 1-kilder er ratet i `lib/sources.js` (EDGAR/FRED/NewsWeb = Tier 1-domener).

## Kjente begrensninger / roadmap

Fase 1 (datalag: EDGAR, FRED, NewsWeb, kalender-widget), fase 2 (flertrinns generering, delta-brief, BB på strukturert data), fase 3 (kommandopalett, charts, gauges, aksjesider, profiler) — se sluttrapport i README/commits.
