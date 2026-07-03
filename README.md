# MORGENBRIEF

Personlig morgenbrief i Bloomberg-terminal-stil. Åpne kl. 06:45, velg dagens fokus, og få hele det globale markedsbildet — vinklet mot det DU bryr deg om i dag — på under 5 minutter. Tett, mørkt, null fyll. Alt generert på norsk.

Alt kjører lokalt. Ingen kontoer, ingen sky. API-nøklene ligger i `.env` på din maskin.

## Oppsett (5 min)

Krav: Node.js 18.17+ (https://nodejs.org, LTS holder).

```bash
cd morgenbrief
npm run setup        # lager .env fra .env.example
```

(Ingen `npm install` nødvendig — appen har **null avhengigheter**, ren Node.)

Åpne `.env` og legg inn nøkler:

| Nøkkel | Påkrevd | Hvor |
|---|---|---|
| `ANTHROPIC_API_KEY` | Ja | https://console.anthropic.com → API Keys. Driver brief + chat, med live websøk. |
| `FINNHUB_API_KEY` | Nei | https://finnhub.io/register (gratis, kun US-tickere). Tom = Yahoo Finance dekker alt (Oslo Børs, indekser, futures, valuta). |

Deretter:

```bash
npm run dev
```

Åpne http://localhost:3000.

## Slik funker det

**Første åpning hver dag spør appen: «Hva er i fokus i dag?»** Velg fra favoritt-chips eller skriv inn hva som helst — et selskap (med ticker for kurs), en sektor («laksesektoren»), et fond («DNB Teknologi»), et tema («bitcoin»). #1 = primærfokus og får mest dybde. Ingenting er hardkodet — fokus velges hver dag.

Briefen har faste seksjoner:

- **SITREP** — geopolitikk/makro over natten som faktisk flytter markeder
- **USA / EUROPA / NORGE / ASIA** — indekser, sentralbanker; NORGE-seksjonen dekker OSEBX, Norges Bank, NOK, olje/gass, sjømat, forsvar
- **FOKUS-paneler** — ett per valgt fokuselement: kurs (hvis ticker), nyheter siste 48t, makro vinklet gjennom din «vinkel»-tekst, og «Poenget:» på én linje
- **KALENDER** — dagens makrotall og resultater, CET
- **OPPSUMMERT** — dagens markedsholdning i én setning
- **DESK-CHAT** (høyre panel) — still oppfølgingsspørsmål; den kjenner dagens brief og kan websøke live. Historikk per dag, nullstilles i morgen.

Alt genereres av Claude (`claude-haiku-4-5` som standard — billig og rask; vil du ha mer analytisk dybde, sett `ANTHROPIC_MODEL=claude-sonnet-4-6` i `.env`, ca. 3–5x dyrere) med **obligatorisk websøk**: prompten krever søk per seksjon, hver påstand får klikkbar kilde (inline + KILDER-liste per boks), alt nyhetsinnhold tidsmerkes ([I DAG] / [DENNE UKEN] / [DENNE MÅNEDEN] / [ELDRE]), og en brief der modellen gjorde 0 søk **avvises automatisk** i stedet for å serveres. Fokus-bokser deles i lag: I DAG / SISTE UKE / SISTE MÅNED / RYKTER (ubekreftet, tydelig merket). Pump-sider (StocksToTrade, Timothy Sykes o.l.) er blokkert som kilder — juster med `BLOCKED_DOMAINS=domene1,domene2` i env. Kurser hentes fra Finnhub/Yahoo og mates inn som fasit, så modellen aldri gjetter tall.

## Favoritter

Tannhjulet → administrer favoritter (navn + valgfri ticker + **vinkel**). Favoritter dukker opp som hurtigvalg i fokus-velgeren. Vinkelteksten mates inn i prompten, så skriv den slik du tenker om posisjonen. Leveres med ONDS, KOG.OL, «Teknologi/halvledere» og «Forsvarssektoren» som eksempler.

## Briefings-mappen + Claude Desktop / Claude Code

Hver brief lagres som markdown: `briefings/ÅÅÅÅ-MM-DD.md` (med metadata-header). Pek Claude Desktop (Cowork) eller Claude Code på `briefings/`-mappen for å diskutere dagens brief, sammenligne med tidligere dager, eller bygge videre.

## Kostnad

Én brief = ett Anthropic-kall med inntil 8 websøk (søk faktureres $10/1000 + vanlige tokens) — med haiku typisk under 10 cent per brief. Chat bruker inntil 3 søk per melding og cacher briefen (90 % rabatt på gjenbrukt kontekst). Dagstak i `.env` (`MAX_BRIEFS_PER_DAY=6`, `MAX_CHATS_PER_DAY=60`) setter et hardt kostnadstak. Kurser koster ingenting.

## Del med venner / bruk på mobil

**Mobil på samme nett:** kjør `npm run dev` — terminalen viser en adresse à la `http://192.168.x.x:3000`. Åpne den på mobilen og velg «Legg til på Hjem-skjerm» for app-følelse (PWA).

**Deploy på Vercel (del med venner):**

Backend ligger som serverless functions i `api/`, frontend som statiske filer i `public/`. Lagring skjer i Redis (Upstash) siden serverless functions ikke har varig filsystem. Lokalt (`npm run dev`) brukes filer automatisk — KV trengs kun på Vercel.

1. **Redis:** Vercel-dashboard → *Storage* (eller *Marketplace*) → **Upstash for Redis** → koble til prosjektet. Da settes `KV_REST_API_URL` og `KV_REST_API_TOKEN` automatisk. Gratis-tier holder lenge.
2. **Miljøvariabler:** *Settings → Environment Variables*: legg inn `ANTHROPIC_API_KEY` og `SITE_PASSWORD` (påkrevd før deling — uten kode kan hvem som helst brenne kreditten din). Valgfritt: `FINNHUB_API_KEY`, `ANTHROPIC_MODEL`, `MAX_BRIEFS_PER_DAY`, `MAX_CHATS_PER_DAY`.
3. **Innstillinger:** *Settings → Build & Development*: Framework Preset = **Other**, ingen build command. Fluid compute skal være på (standard) — det gir functions inntil 300 s kjøretid, som lange genereringer trenger.
4. `git add -A && git commit -m "vercel" && git push` → Vercel redeployer automatisk.
5. Del lenken + tilgangskoden.

Kostnadsmodellen på Vercel: **visninger koster aldri API-kall.** Briefen genereres maks én gang per dag (cache-nøkkel `brief:ÅÅÅÅ-MM-DD` i Redis, fornyes automatisk ved midnatt); alle besøkende får samme cachede resultat. Eksplisitt re-generering er mulig, men stoppes av `MAX_BRIEFS_PER_DAY` (standard 2). Kurser caches separat i 5 min (de endres oftere enn briefen) og er gratis uansett. Absolutt tak per dag med standardverdier: 2 brief-genereringer + 60 chat-svar = 62 Claude-kall, uansett hvor mange som besøker siden.

Verdt å vite ved deling: appen er én felles instans — alle ser samme brief, samme fokusvalg og samme desk-chat. Ingen brukerkontoer. På Vercel er den statiske forsiden teknisk sett offentlig, men alt av data og handlinger ligger bak tilgangskoden (login-overlay). `briefings/`-mappen (Claude Desktop-interop) gjelder kun lokal kjøring; på Vercel bor briefen i Redis.

## Feilsøking

- **«ANTHROPIC_API_KEY mangler»** — rediger `.env`, restart (`npm run dev`).
- **Kurs-chips viser n/a** — Yahoo rate-limiter av og til (429); den prøver host nr. 2 og henter seg inn på neste 60s-refresh. Brief genereres uansett.
- **Generering tar 30–90s** — normalt; den kjører inntil 14 live websøk. Følg med i live-panelet.

## Ikke-mål

Kun lesing/etterretning. Ingen handel, ingen varsler, ingen kontoer.
