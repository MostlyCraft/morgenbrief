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

Alt genereres av Claude (`claude-haiku-4-5` som standard — billig og rask; vil du ha mer analytisk dybde, sett `ANTHROPIC_MODEL=claude-sonnet-4-6` i `.env`, ca. 3–5x dyrere) med **websøk på hvert kall** — ingenting kommer fra gammel treningsdata. Kurser hentes fra Finnhub/Yahoo og mates inn som fasit, så modellen aldri gjetter tall.

## Favoritter

Tannhjulet → administrer favoritter (navn + valgfri ticker + **vinkel**). Favoritter dukker opp som hurtigvalg i fokus-velgeren. Vinkelteksten mates inn i prompten, så skriv den slik du tenker om posisjonen. Leveres med ONDS, KOG.OL, «Teknologi/halvledere» og «Forsvarssektoren» som eksempler.

## Briefings-mappen + Claude Desktop / Claude Code

Hver brief lagres som markdown: `briefings/ÅÅÅÅ-MM-DD.md` (med metadata-header). Pek Claude Desktop (Cowork) eller Claude Code på `briefings/`-mappen for å diskutere dagens brief, sammenligne med tidligere dager, eller bygge videre.

## Kostnad

Én brief = ett Anthropic-kall med inntil 8 websøk (søk faktureres $10/1000 + vanlige tokens) — med haiku typisk under 10 cent per brief. Chat bruker inntil 3 søk per melding og cacher briefen (90 % rabatt på gjenbrukt kontekst). Dagstak i `.env` (`MAX_BRIEFS_PER_DAY=6`, `MAX_CHATS_PER_DAY=60`) setter et hardt kostnadstak. Kurser koster ingenting.

## Del med venner / bruk på mobil

**Mobil på samme nett:** kjør `npm run dev` — terminalen viser en adresse à la `http://192.168.x.x:3000`. Åpne den på mobilen og velg «Legg til på Hjem-skjerm» for app-følelse (PWA).

**Host på internett (del med venner):**

1. Sett `SITE_PASSWORD=en-valgfri-kode` i `.env` først — uten den kan hvem som helst som finner lenken brenne API-kreditten din. Alle uten koden møter en innloggingsside.
2. Legg prosjektet på en liten server: Railway, Render, Fly.io eller en VPS. Null avhengigheter — alt som trengs er Node 18+ og `npm start`. Sett miljøvariablene (`ANTHROPIC_API_KEY`, `SITE_PASSWORD`, osv.) i tjenestens dashboard i stedet for `.env`.
3. Del lenken + koden med vennene dine.

Verdt å vite ved deling: appen er én felles instans — alle ser samme brief, samme fokusvalg og samme desk-chat. Ingen brukerkontoer. Dagstakene beskytter kreditten din; regningen går på din nøkkel.

## Feilsøking

- **«ANTHROPIC_API_KEY mangler»** — rediger `.env`, restart (`npm run dev`).
- **Kurs-chips viser n/a** — Yahoo rate-limiter av og til (429); den prøver host nr. 2 og henter seg inn på neste 60s-refresh. Brief genereres uansett.
- **Generering tar 30–90s** — normalt; den kjører inntil 14 live websøk. Følg med i live-panelet.

## Ikke-mål

Kun lesing/etterretning. Ingen handel, ingen varsler, ingen kontoer.
