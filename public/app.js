/* MORGENBRIEF frontend (norsk) */
"use strict";

const $ = (id) => document.getElementById(id);
const led = $("led");

let META = null;
let GENERATING = false;

/* ---------------- boot ---------------- */
const BOOT_LINES = [
  "MORGENBRIEF v1.3",
  "KLOKKESYNK ......... CET OK",
  "KURSFEEDER ......... INIT",
  "ANTHROPIC-LENKE .... INIT",
  "KLAR.",
];
(function boot() {
  const el = $("bootLines");
  let i = 0;
  const t = setInterval(() => {
    if (i < BOOT_LINES.length) el.textContent += BOOT_LINES[i++] + "\n";
    else clearInterval(t);
  }, 130);
  setTimeout(() => {
    $("boot").classList.add("fade");
    setTimeout(() => $("boot").remove(), 300);
  }, 900);
})();

/* ---------------- klokke ---------------- */
function tickClock() {
  const now = new Date();
  $("hClock").textContent = new Intl.DateTimeFormat("nb-NO", {
    timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(now);
  $("hDate").textContent = new Intl.DateTimeFormat("nb-NO", {
    timeZone: "Europe/Oslo", weekday: "short", day: "2-digit", month: "short", year: "numeric",
  }).format(now).toUpperCase();
}
tickClock();
setInterval(tickClock, 1000);

/* ---------------- hjelpere ---------------- */
function banner(text, isErr = false) {
  const b = $("banner");
  if (!text) return b.classList.add("hidden");
  b.textContent = text;
  b.classList.toggle("err", isErr);
  b.classList.remove("hidden");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---------------- kilder + tidstagger + verifisering ---------------- */
let USED_SRC = new Set(); // kilder brukt i inneværende seksjon (styres av renderSection)
let CLAIMS = [];          // dagens claims (konfidens + bull/bear) fra backend
let SRCS = [];            // dagens berikede kilder (tier/score/begrunnelser)

const scoreCls = (s) => (s >= 61 ? "s-bull" : s <= 39 ? "s-bear" : "s-neut");
const scoreWord = (s) => (s >= 81 ? "STRONG BULL" : s >= 61 ? "BULL" : s > 39 ? "NØYTRAL" : s > 19 ? "BEAR" : "STRONG BEAR");

let SECTIONS = {}; // dagens seksjonsscorer (for gauges/aksjekort)
let LAST_SECS = []; // rå seksjoner fra siste render (for kilder per aksje)
let DATA = null;    // siste /api/data-pakke
let HIST = [];      // bull/bear-historikk (30 d)

/* halvsirkel-måler: Strong Bear -> Bear -> Nøytral -> Bull -> Strong Bull */
function gaugeSVG(score, w = 120, claimId = "") {
  const cx = 50, cy = 46, r = 38;
  const P = (a) => [cx + r * Math.cos(Math.PI * (1 - a)), cy - r * Math.sin(Math.PI * (1 - a))];
  const arc = (a0, a1, color, op) => {
    const [x0, y0] = P(a0), [x1, y1] = P(a1);
    return `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" stroke="${color}" stroke-opacity="${op}" stroke-width="7" fill="none" stroke-linecap="butt"/>`;
  };
  const a = Math.max(0, Math.min(100, score)) / 100;
  const [nx, ny] = [cx + (r - 11) * Math.cos(Math.PI * (1 - a)), cy - (r - 11) * Math.sin(Math.PI * (1 - a))];
  return `<svg class="gauge" width="${w}" viewBox="0 0 100 60" role="img" aria-label="bull/bear ${score} av 100"${claimId ? ` data-sec="${escapeHtml(claimId)}"` : ""}>` +
    arc(0, 0.2, "var(--red)", 1) + arc(0.2, 0.4, "var(--red)", 0.4) +
    arc(0.4, 0.6, "var(--amber)", 0.75) + arc(0.6, 0.8, "var(--green)", 0.4) + arc(0.8, 1, "var(--green)", 1) +
    `<line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="var(--text)" stroke-width="2.5"/>` +
    `<circle cx="${cx}" cy="${cy}" r="3.2" fill="var(--text)"/>` +
    `<text x="${cx}" y="58" text-anchor="middle" font-size="13" fill="var(--text)" font-family="inherit">${score}</text></svg>`;
}

/* mini-sparkline av score-historikk */
function sparkSVG(values, w = 72, h = 20) {
  const v = (values || []).filter((n) => typeof n === "number");
  if (v.length < 2) return "";
  const min = Math.min(...v, 40), max = Math.max(...v, 60);
  const pts = v.map((n, i) => `${(i / (v.length - 1)) * (w - 2) + 1},${h - 2 - ((n - min) / (max - min || 1)) * (h - 4)}`).join(" ");
  const last = v[v.length - 1];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="30 dagers scoretrend">` +
    `<line x1="1" y1="${h - 2 - ((50 - min) / (max - min || 1)) * (h - 4)}" x2="${w - 1}" y2="${h - 2 - ((50 - min) / (max - min || 1)) * (h - 4)}" stroke="var(--line)" stroke-width="1"/>` +
    `<polyline points="${pts}" fill="none" stroke="${last >= 61 ? "var(--green)" : last <= 39 ? "var(--red)" : "var(--amber)"}" stroke-width="1.5"/></svg>`;
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "kilde"; }
}

function tagClass(t) {
  if (t.startsWith("I DAG")) return "tag-idag";
  if (t.startsWith("DENNE UKEN")) return "tag-uke";
  if (t.startsWith("DENNE MÅNEDEN")) return "tag-mnd";
  if (t.startsWith("RYKTE") || t.startsWith("UBEKREFTET")) return "tag-rykte";
  return "tag-eldre";
}

/* markdown-lett: punkter, fet, `kode`, %-farging, "Poenget:", tidstagger, kildemarkører */
function inlineMd(s, sources = []) {
  let h = escapeHtml(s);
  h = h.replace(/`([^`]+)`/g, '<span class="code">$1</span>');
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  // Sikkerhetsnett: skulle en faktortagg overleve backend-strippingen,
  // oversettes den til klartekst-chip - rå koder skal ALDRI vises.
  h = h
    .replace(/\[BB:HARD\+\]/gi, '<span class="tag tag-idag">BULLISH</span>')
    .replace(/\[BB:HARD-\]/gi, '<span class="tag tag-rykte">BEARISH</span>')
    .replace(/\[BB:MYK\+\]/gi, '<span class="tag tag-idag">MILD BULL</span>')
    .replace(/\[BB:MYK-\]/gi, '<span class="tag tag-rykte">MILD BEAR</span>')
    .replace(/\[BB:N[ØO]YTRAL\]/gi, '<span class="tag tag-uke">NØYTRAL</span>')
    .replace(/\[MAT:H[ØO]Y\]/gi, '<span class="tag tag-eldre">Høy betydning</span>')
    .replace(/\[MAT:MED\]/gi, '<span class="tag tag-eldre">Middels betydning</span>')
    .replace(/\[MAT:LAV\]/gi, '<span class="tag tag-eldre">Lav betydning</span>')
    .replace(/\[INSIDER:SALG\]/gi, '<span class="tag tag-rykte">Innsidesalg</span>')
    .replace(/\[INSIDER:KJ[ØO]P\]/gi, '<span class="tag tag-idag">Innsidekjøp</span>')
    .replace(/\[KONFLIKT\]/gi, '<span class="tag tag-uke">SPRIKER</span>');
  // tidstagger -> chips: [I DAG 03.07], [DENNE UKEN], [ELDRE], [RYKTE], [UBEKREFTET]
  h = h.replace(
    /\[(I DAG|DENNE UKEN|DENNE MÅNEDEN|ELDRE(?: KONTEKST)?|RYKTE|UBEKREFTET)((?:\s[^\]\[C][^\]\[]*)?)\]/g,
    (m, t, extra) => `<span class="tag ${tagClass(t)}">${t}${extra || ""}</span>`
  );
  // kildemarkører -> klikkbare [domene]-lenker (ny fane)
  h = h.replace(/\[\[C:(\d+)\]\]/g, (m, n) => {
    const src = sources[Number(n)];
    if (!src || !src.url) return "";
    USED_SRC.add(Number(n));
    return `<a class="srcRef" href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(src.title || src.url)}">[${escapeHtml(domainOf(src.url))}]</a>`;
  });
  // verifiseringsmerker -> konfidens-badge + score-chip (klikk = detaljer)
  h = h.replace(/\[\[V:(\d+)\]\]/g, (m, id) => {
    const c = CLAIMS[Number(id)];
    if (!c) return "";
    const sym = c.level === "ok" ? "✓" : c.level === "single" ? "◐" : "✗";
    const lbl = c.level === "ok" ? "BEKREFTET" : c.level === "single" ? "ENKELTKILDE" : "UBEKREFTET";
    const spr = c.conflict ? '<span class="tag tag-uke" title="kildene motsier hverandre - begge versjoner vist">SPRIKER</span>' : "";
    return `<button type="button" class="vBadge v-${c.level}" data-claim="${id}" title="${lbl} - klikk for kilder og faktorer">${sym}</button>` +
           `<button type="button" class="scoreChip ${scoreCls(c.bb.score)}" data-claim="${id}" title="bull/bear ${c.bb.score}/100 - klikk for faktorer">${c.bb.score}</button>${spr}`;
  });
  h = h.replace(/(^|[\s(>])([+]\d+(?:[.,]\d+)?\s?%)/g, '$1<span class="up">$2</span>');
  h = h.replace(/(^|[\s(>])([-−]\d+(?:[.,]\d+)?\s?%)/g, '$1<span class="down">$2</span>');
  return h;
}

function renderMd(text, { firstLineQuote = false, sources = [] } = {}) {
  const lines = text.split("\n");
  let html = "", inList = false, first = true;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (let raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    // ### underoverskrifter = tidslag (I DAG / SISTE UKE / SISTE MÅNED / RYKTER)
    if (/^###\s+/.test(line.trim())) {
      closeList();
      const t = line.trim().replace(/^###\s+/, "");
      const cls = /RYKTER|UBEKREFTET/i.test(t) ? " rykter" : "";
      html += `<div class="subHead${cls}">${inlineMd(t, sources)}</div>`;
      first = false;
      continue;
    }
    if (/^`?TL;DR:/i.test(line.trim())) {
      closeList();
      html += `<div class="tldr">${inlineMd(line.trim().replace(/^`?TL;DR:\s*/i, "").replace(/`$/, ""), sources)}</div>`;
      first = false;
      continue;
    }
    const stripped = line.replace(/^[-*]\s+/, "");
    const isBullet = /^[-*]\s+/.test(line.trim());
    const isPoint = /^\*{0,2}`?(poenget|so what):?/i.test(stripped.trim());
    if (isPoint) {
      closeList();
      html += `<div class="sowhat">${inlineMd(stripped.replace(/[`*]/g, ""), sources)}</div>`;
    } else if (isBullet) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inlineMd(line.trim().replace(/^[-*]\s+/, ""), sources)}</li>`;
    } else {
      closeList();
      const cls = first && firstLineQuote ? "qline" : "";
      html += `<p class="${cls}">${inlineMd(line.replace(/^#+\s*/, ""), sources)}</p>`;
    }
    first = false;
  }
  closeList();
  return html;
}

/* seksjon = innhold + KILDER-liste nederst med alle URL-er brukt i seksjonen */
function renderSection(text, sources = [], opts = {}) {
  USED_SRC = new Set();
  let html = renderMd(text, { ...opts, sources });
  if (USED_SRC.size) {
    const items = [...USED_SRC].map((n) => {
      const s = sources[n];
      return `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(s.title || s.url)}">${escapeHtml(domainOf(s.url))}</a>`;
    }).join(" · ");
    html += `<div class="srcList">KILDER: ${items}</div>`;
  }
  return html;
}

/* ---------------- brief-rendering ---------------- */
function parseSections(markdown) {
  const sections = [];
  const parts = markdown.split(/^##\s+/m).filter((p) => p.trim());
  for (const p of parts) {
    const nl = p.indexOf("\n");
    const heading = (nl === -1 ? p : p.slice(0, nl)).trim();
    const body = nl === -1 ? "" : p.slice(nl + 1).trim();
    sections.push({ heading, body });
  }
  return sections;
}

function renderBriefing(markdown, metaLine, sources = [], stamp = "", extra = {}) {
  CLAIMS = extra.claims || [];
  SRCS = sources;
  SECTIONS = extra.sections || {};
  document.querySelectorAll(".claimDetail").forEach((d) => d.remove());
  const secs = parseSections(markdown);
  LAST_SECS = secs;
  // Tolerant seksjonsmatch: "DAGENS KALENDER", "OPPSUMMERING" osv. treffer også.
  // FOKUS-seksjoner holdes utenfor så f.eks. "USA" aldri matcher en fokus-boks.
  const fixed = secs.filter((s) => !/^FOKUS/i.test(s.heading));
  const get = (...names) => {
    for (const n of names) {
      const hit = fixed.find((s) => s.heading.toUpperCase().includes(n));
      if (hit) return hit.body;
    }
    return null; // aldri rå placeholder - håndteres ærlig under
  };
  const fill = (id, body) => {
    $(id).innerHTML = body != null
      ? renderSection(body, sources)
      : '<p class="dim">Ingen data for denne seksjonen i dagens brief.</p>';
  };

  fill("b-sitrep", get("SITREP"));
  fill("b-usa", get("USA", "AMERICA"));
  fill("b-europa", get("EUROPA", "EUROPE"));
  fill("b-norge", get("NORGE", "NORWAY"));
  fill("b-asia", get("ASIA"));
  fill("b-kalender", get("KALENDER", "CALENDAR"));
  fill("b-oppsummert", get("OPPSUMMER", "ONE-LINER", "SUMMARY"));

  const focus = secs.filter((s) => s.heading.toUpperCase().startsWith("FOKUS") || s.heading.toUpperCase().startsWith("FOCUS"));
  const wrap = $("focusWrap");
  wrap.innerHTML = "";
  focus.forEach((s, i) => {
    const panel = document.createElement("section");
    panel.className = "panel";
    const sec = extra.sections?.[s.heading.toUpperCase()];
    const tick = s.heading.replace(/^FOKUS:\s*/i, "").trim();
    const d = extra.deltas?.focus?.[tick];
    let head = `<span>${escapeHtml(s.heading)}${i === 0 ? " // PRIMÆR" : ""}</span>`;
    let driversHtml = "";
    if (sec) {
      const dTxt = typeof d === "number" && d !== 0 ? ` <span class="${d > 0 ? "up" : "down"}">${d > 0 ? "▲+" : "▼"}${d}</span>` : "";
      head += `<span class="bbHead"><span class="gaugeMini" data-sec="${escapeHtml(s.heading.toUpperCase())}" title="klikk for faktorene bak scoren">${gaugeSVG(sec.score, 58)}</span>` +
        `<span class="gaugeLbl ${scoreCls(sec.score)}">${scoreWord(sec.score)}</span>${dTxt}` +
        `<span class="sparkSlot" data-tick="${escapeHtml(tick)}"></span>` +
        `${sec.lowConf ? '<span class="tag tag-eldre" title="tynt datagrunnlag - få eller ubekreftede punkter">LAV KONFIDENS</span>' : ""}</span>`;
      const allDrivers = [
        ...(sec.drivers || []).map((dr) => `<span class="${scoreCls(dr.score)}">[${dr.score}]</span> ${escapeHtml(dr.text)}`),
        ...(sec.structFactors || []).map((f) => `<span class="dim">[data]</span> ${escapeHtml(f)}`),
      ];
      if (allDrivers.length) driversHtml = `<div class="drivers">DRIVERE: ${allDrivers.join(" · ")}</div>`;
    }
    panel.innerHTML =
      `<div class="pHead"><span class="fokusTitle" data-tick="${escapeHtml(tick)}" title="klikk for aksjekort">${escapeHtml(s.heading)}${i === 0 ? " // PRIMÆR" : ""}</span>${head.replace(/^<span>.*?<\/span>/, "")}</div>` + driversHtml +
      `<div class="pBody">${renderSection(s.body, sources, { firstLineQuote: true })}</div>`;
    if (i === 0) {
      wrap.appendChild(panel);
    } else {
      let grid = wrap.querySelector(".focusGrid");
      if (!grid) { grid = document.createElement("div"); grid.className = "focusGrid"; wrap.appendChild(grid); }
      grid.appendChild(panel);
    }
  });

  // Overall marked-sentiment øverst: stor gauge + drivere (vektet av SITREP + regionene)
  const strip = $("bbStrip");
  if (extra.overall && typeof extra.overall.score === "number") {
    const o = extra.overall;
    const dTot = typeof extra.deltas?.overall === "number" && extra.deltas.overall !== 0
      ? ` <span class="${extra.deltas.overall > 0 ? "up" : "down"}">${extra.deltas.overall > 0 ? "▲+" : "▼"}${extra.deltas.overall}</span> <span class="dim">vs i går</span>`
      : "";
    strip.innerHTML =
      `<span class="gaugeWrap big" data-sec="__OVERALL__" title="klikk for faktorene bak">${gaugeSVG(o.score, 120)}</span>` +
      `<span class="stripInfo"><span class="dim">MARKED-SENTIMENT</span> <span class="gaugeLbl ${scoreCls(o.score)}">${scoreWord(o.score)}</span>` +
      (o.lowConf ? ' <span class="tag tag-eldre" title="tynt datagrunnlag">LAV KONFIDENS</span>' : "") + dTot +
      `<span class="sparkSlot" data-tick="__OVERALL__"></span>` +
      (o.drivers?.length ? `<div class="drivers strip">DRIVERE: ${o.drivers.map((dr) =>
        `<span class="${scoreCls(dr.score)}">[${dr.score}]</span> ${escapeHtml(dr.text.slice(0, 55))}`).join(" · ")}</div>` : "") +
      `</span>`;
    strip.classList.remove("hidden");
  } else {
    strip.classList.add("hidden");
  }

  renderDelta(extra.delta || null);
  injectSparks();
  clampPass();

  // ALLE KILDER-panelet: hver kilde med tier, score og begrunnelse
  const asBody = $("allSources");
  if (sources.length) {
    asBody.innerHTML = sources.map((s) => {
      const r = s.rating || {};
      const inv = s.valid === false ? ' <span class="tag tag-rykte">UGYLDIG - STRIPPET</span>' : "";
      return `<div class="srcRow"><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(domainOf(s.url))}</a>` +
        ` <span class="scoreChip ${scoreCls(r.score ?? 40)}">${r.score ?? "?"}</span>` +
        ` <span class="dim">${escapeHtml(r.label || "")}</span>${inv}` +
        `<div class="srcReasons dim">${escapeHtml((r.reasons || []).join(" · "))}${s.title ? " — «" + escapeHtml(s.title.slice(0, 80)) + "»" : ""}</div></div>`;
    }).join("");
    $("allSourcesPanel").classList.remove("hidden");
  } else {
    $("allSourcesPanel").classList.add("hidden");
  }

  // «hentet HH:MM CET» øverst i hver boks
  if (stamp) {
    document.querySelectorAll("#briefing .panel .pHead").forEach((h) => {
      let el = h.querySelector(".fetchStamp");
      if (!el) { el = document.createElement("span"); el.className = "fetchStamp"; h.appendChild(el); }
      el.textContent = `hentet ${stamp}`;
    });
  }

  $("briefMeta").textContent = metaLine || "";
  $("empty").classList.add("hidden");
  $("stream").classList.add("hidden");
  $("briefing").classList.remove("hidden");
}

/* ---------------- delta-brief («nytt siden i morges») ---------------- */
function renderDelta(d) {
  const p = $("deltaPanel");
  if (!d || !d.markdown) { p.classList.add("hidden"); return; }
  $("deltaBody").innerHTML = renderSection(d.markdown, d.sources || []);
  $("deltaStamp").textContent = `hentet ${d.generatedAtCET || ""} · ${d.searches ?? "?"} søk`;
  p.classList.remove("hidden");
}

$("btnDelta").addEventListener("click", async () => {
  const p = $("deltaPanel"), b = $("deltaBody");
  p.classList.remove("hidden");
  b.innerHTML = '<p class="dim">▪ starter intradag-oppdatering…</p>';
  try {
    await streamPost("/api/briefing/delta", {}, {
      onStatus: (s) => { b.innerHTML = `<p class="dim">▪ ${escapeHtml(s)}</p>`; },
      onText: () => {},
      onDone: (evt) => renderDelta(evt.delta),
      onError: (m) => { b.innerHTML = `<p class="down">${escapeHtml(m)}</p>`; },
    });
  } catch (e) {
    b.innerHTML = `<p class="down">${escapeHtml(String(e.message || e))}</p>`;
  }
});

/* ---------------- historikk + sparklines ---------------- */
async function loadHistory() {
  try {
    const r = await fetch("/api/history");
    if (r.ok) { HIST = (await r.json()).series || []; injectSparks(); }
  } catch { /* pynt */ }
}

function injectSparks() {
  document.querySelectorAll(".sparkSlot").forEach((slot) => {
    const t = slot.dataset.tick;
    const vals = HIST.map((h) => (t === "__OVERALL__" ? h.overall : h.focus?.[t])).filter((v) => typeof v === "number");
    slot.innerHTML = vals.length >= 2 ? sparkSVG(vals) : "";
  });
}

/* ---------------- seksjonsfaktorer (klikk på gauge) ---------------- */
function showSecFactors(secKey, anchorEl) {
  const host = anchorEl.closest(".pHead") || anchorEl.closest(".bbStrip");
  if (!host) return;
  const next = host.nextElementSibling;
  if (next && next.classList?.contains("claimDetail")) { next.remove(); return; }
  document.querySelectorAll(".claimDetail").forEach((x) => x.remove());
  let html = "";
  if (secKey === "__OVERALL__") {
    const rows = Object.entries(SECTIONS)
      .filter(([k]) => /^(SITREP|USA|EUROPA|NORGE|ASIA)/.test(k))
      .map(([k, s]) => `<div>· ${escapeHtml(k)}: <span class="${scoreCls(s.score)}">${s.score}</span> (${s.n} punkter)</div>`).join("");
    html = `<div><b>MARKED-SENTIMENT</b> <span class="dim">= dominans-vektet netto av seksjonene (SITREP teller 1,5x)</span></div>${rows}`;
  } else {
    const s = SECTIONS[secKey];
    if (!s) return;
    html = `<div><b>${escapeHtml(secKey)}</b> <span class="dim">score ${s.score} = nyhetssignaler (dominans-vektet) + datafaktorer${s.lowConf ? " · LAV KONFIDENS" : ""}</span></div>` +
      (s.drivers || []).map((dr) => `<div>· <span class="${scoreCls(dr.score)}">[${dr.score}]</span> ${escapeHtml(dr.text)}</div>`).join("") +
      (s.structFactors || []).map((f) => `<div>· <span class="dim">[data]</span> ${escapeHtml(f)}</div>`).join("");
  }
  const el = document.createElement("div");
  el.className = "claimDetail";
  el.innerHTML = html;
  host.after(el);
}

/* ---------------- kommandopalett (Ctrl+K) ---------------- */
const PAL_CMDS = [
  ["gen", "Generer morgenbrief (velg fokus)", () => openFocusPicker()],
  ["delta", "Intradag: nytt siden i morges", () => $("btnDelta").click()],
  ["kilder", "Vis/skjul ALLE KILDER-panelet", () => { $("btnAllSources").click(); $("allSourcesPanel").scrollIntoView({ behavior: "smooth" }); }],
  ["chat", "Vis/skjul desk-chat", () => $("btnChat").click()],
  ["lesbar", "Bytt Kompakt/Lesbar", () => toggleDensity()],
  ["profil", "Bytt profil (egen watchlist)", () => pickProfile(true)],
  ["innstillinger", "Rediger watchlist/favoritter", () => $("btnSettings").click()],
];

function paletteEntries(q) {
  q = q.trim().toLowerCase();
  const out = [];
  for (const [cmd, desc, fn] of PAL_CMDS) {
    if (!q || cmd.startsWith(q)) out.push({ label: cmd.toUpperCase(), desc, fn });
  }
  for (const k of Object.keys(SECTIONS)) {
    const m = k.match(/^FOKUS:\s*(.+)/);
    if (!m) continue;
    const t = m[1].trim();
    if (!q || t.toLowerCase().includes(q)) out.push({ label: t, desc: "Åpne aksjekort", fn: () => openStock(t) });
  }
  return out.slice(0, 7);
}

function togglePalette(show) {
  const pal = $("palette");
  const on = show ?? pal.classList.contains("hidden");
  pal.classList.toggle("hidden", !on);
  if (on) { $("palInput").value = ""; renderPalList(); $("palInput").focus(); }
}

function renderPalList() {
  const entries = paletteEntries($("palInput").value);
  $("palList").innerHTML = entries.map((e, i) =>
    `<div class="palRow${i === 0 ? " sel" : ""}" data-i="${i}"><b>${escapeHtml(e.label)}</b> <span class="dim">${escapeHtml(e.desc)}</span></div>`).join("") ||
    '<div class="palRow dim">ingen treff</div>';
  $("palList")._entries = entries;
}

$("palInput").addEventListener("input", renderPalList);
$("palInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const entries = $("palList")._entries || [];
    if (entries[0]) { togglePalette(false); entries[0].fn(); }
  }
});
$("palList").addEventListener("click", (e) => {
  const row = e.target.closest(".palRow");
  const entries = $("palList")._entries || [];
  if (row && entries[Number(row.dataset.i)]) { togglePalette(false); entries[Number(row.dataset.i)].fn(); }
});
$("palette").addEventListener("click", (e) => { if (e.target === $("palette")) togglePalette(false); });

/* ---------------- tetthetsmodus: Kompakt vs Lesbar ---------------- */
function toggleDensity(force) {
  const on = force ?? !document.body.classList.contains("lesbar");
  document.body.classList.toggle("lesbar", on);
  try { localStorage.setItem("mbDensity", on ? "lesbar" : "kompakt"); } catch { /* ok */ }
  clampPass();
}

function clampPass() {
  const lesbar = document.body.classList.contains("lesbar");
  document.querySelectorAll("#briefing .pBody li").forEach((li) => {
    if (li.classList.contains("claimDetail")) return;
    li.classList.remove("clamp", "open");
    if (lesbar && (li.textContent || "").length > 230) li.classList.add("clamp");
  });
}

$("btnDensity").addEventListener("click", () => toggleDensity());

document.addEventListener("keydown", (e) => {
  const typing = /input|textarea/i.test(document.activeElement?.tagName || "");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); togglePalette(); }
  else if (e.key === "Escape") { $("palette").classList.add("hidden"); $("stockModal").classList.add("hidden"); }
  else if (!typing && e.key.toLowerCase() === "t") toggleDensity();
});

/* ---------------- aksjekort ---------------- */
function openStock(tick) {
  const key = Object.keys(SECTIONS).find((k) => k.toUpperCase() === `FOKUS: ${tick}`.toUpperCase()) || "";
  const s = key ? SECTIONS[key] : null;
  const secBody = (LAST_SECS.find((x) => x.heading.toUpperCase() === key) || {}).body || "";
  const srcIdx = [...new Set([...secBody.matchAll(/\[\[C:(\d+)\]\]/g)].map((m) => Number(m[1])))];
  const vals = HIST.map((h) => h.focus?.[tick]).filter((v) => typeof v === "number");
  const ins = DATA?.insider?.ok ? DATA.insider.byTicker?.[tick] : null;
  const ob = tick.toUpperCase().endsWith(".OL") && DATA?.oslo?.ok ? DATA.oslo.byIssuer?.[tick.slice(0, -3)] : null;
  const events = (DATA?.calendar?.ok ? DATA.calendar.events || [] : []).filter((e) => e.label.toUpperCase().includes(tick.split(".")[0]));

  let h = `<div class="pHead"><span>${escapeHtml(tick)} // AKSJEKORT</span><button class="btnMini" id="stockClose">&times;</button></div><div class="pBody">`;
  if (s) {
    h += `<div class="stockTop">${gaugeSVG(s.score, 110)}<div><div class="gaugeLbl ${scoreCls(s.score)}">${scoreWord(s.score)}</div>` +
      `${s.lowConf ? '<span class="tag tag-eldre">LAV KONFIDENS</span>' : ""}` +
      `${vals.length >= 2 ? `<div class="dim" style="margin-top:4px">30 d: ${sparkSVG(vals, 160, 28)}</div>` : ""}</div></div>`;
    const fac = [...(s.drivers || []).map((d) => `<span class="${scoreCls(d.score)}">[${d.score}]</span> ${escapeHtml(d.text)}`),
      ...(s.structFactors || []).map((f) => `<span class="dim">[data]</span> ${escapeHtml(f)}`)];
    if (fac.length) h += `<div class="wSub">DRIVERE & FAKTORER</div>${fac.map((f) => `<div class="cntRow">${f}</div>`).join("")}`;
  } else {
    h += `<p class="dim">Ingen score i dagens brief for ${escapeHtml(tick)}.</p>`;
  }
  if (events.length) h += `<div class="wSub">KOMMENDE</div>` + events.map((e) => `<div class="cntRow"><span class="tag tag-uke">om ${e.days} d</span> ${escapeHtml(e.label)} (${e.date.slice(5)})</div>`).join("");
  if (ins?.form4?.length) {
    h += `<div class="wSub">INNSIDEHANDEL (SEC)</div>` + ins.form4.map((f) =>
      `<div class="cntRow"><span class="tag ${f.side === "SALG" ? "tag-rykte" : f.side === "KJØP" ? "tag-idag" : "tag-eldre"}">${escapeHtml(f.side || "?")}</span> ${escapeHtml(f.owner || "")} <span class="dim">${f.date}</span> ${f.url ? `<a class="srcRef" href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer">[SEC]</a>` : ""}</div>`).join("");
  }
  if (ob?.length) {
    h += `<div class="wSub">BØRSMELDINGER</div>` + ob.slice(0, 5).map((m) =>
      `<div class="cntRow">${m.meldepliktig ? '<span class="tag tag-rykte">MELDEPLIKTIG</span> ' : ""}<a class="obLink" href="${escapeHtml(m.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(m.title.slice(0, 60))}</a> <span class="dim">(${m.date.slice(5)})</span></div>`).join("");
  }
  if (srcIdx.length) {
    h += `<div class="wSub">KILDER I DAGENS OMTALE</div><div class="srcList">` + srcIdx.map((n) => {
      const src = SRCS[n];
      return src ? `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(domainOf(src.url))}</a>` : "";
    }).filter(Boolean).join(" · ") + `</div>`;
  }
  h += `</div>`;
  $("stockBox").innerHTML = h;
  $("stockModal").classList.remove("hidden");
  $("stockClose").addEventListener("click", () => $("stockModal").classList.add("hidden"));
}
$("stockModal").addEventListener("click", (e) => { if (e.target === $("stockModal")) $("stockModal").classList.add("hidden"); });

/* ---------------- profiler (egen watchlist per venn, felles brief) ---------------- */
const PROFILE = () => { try { return localStorage.getItem("mbProfile") || ""; } catch { return ""; } };
const pSuf = () => (PROFILE() ? `?profile=${encodeURIComponent(PROFILE())}` : "");

async function pickProfile(force = false) {
  if (!force && PROFILE()) return;
  let profiles = [];
  try { profiles = (await (await fetch("/api/profiles")).json()).profiles || []; } catch { /* ok */ }
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML =
    `<div class="modalBox" style="max-width:380px"><div class="pHead"><span>HVEM SER PÅ?</span></div><div class="pBody">` +
    `<p class="dim" style="margin-bottom:8px">Egen watchlist for kurser og widgets. Briefen er felles for alle.</p>` +
    `<div>${profiles.map((p) => `<button class="btnMini profBtn" data-p="${escapeHtml(p)}">${escapeHtml(p).toUpperCase()}</button>`).join(" ")} ` +
    `<button class="btnMini profBtn" data-p="">FELLES</button></div>` +
    `<form id="profForm" style="margin-top:10px;display:flex;gap:6px">` +
    `<input id="profName" placeholder="ny profil (a-z, 0-9)" maxlength="16" style="flex:1;background:var(--bg);color:var(--text);border:1px solid var(--line);padding:6px 8px;font-family:var(--mono);font-size:12px;outline:none"/>` +
    `<button class="btnMini" type="submit">OPPRETT</button></form></div></div>`;
  document.body.appendChild(m);
  m.addEventListener("click", (e) => {
    const b = e.target.closest(".profBtn");
    if (b) { try { localStorage.setItem("mbProfile", b.dataset.p); } catch { } m.remove(); location.reload(); }
    else if (e.target === m && PROFILE() !== null) m.remove();
  });
  m.querySelector("#profForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = m.querySelector("#profName").value.trim();
    if (!name) return;
    const r = await fetch("/api/profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (r.ok) {
      const j = await r.json();
      try { localStorage.setItem("mbProfile", j.added); } catch { }
      m.remove();
      location.reload();
    }
  });
}

/* ---------------- claim-detaljer (klikk på badge/score) ---------------- */
$("main").addEventListener("click", (e) => {
  const g = e.target.closest(".gaugeMini, .gaugeWrap");
  if (g && g.dataset.sec) { showSecFactors(g.dataset.sec, g); return; }
  const ft = e.target.closest(".fokusTitle");
  if (ft && ft.dataset.tick) { openStock(ft.dataset.tick); return; }
  const cl = e.target.closest("li.clamp");
  if (cl && !e.target.closest("a, button")) { cl.classList.toggle("open"); return; }
  const btn = e.target.closest(".vBadge, .scoreChip[data-claim]");
  if (!btn || !btn.dataset.claim) return;
  const c = CLAIMS[Number(btn.dataset.claim)];
  if (!c) return;
  const host = btn.closest("li, p, .sowhat") || btn.parentElement;
  const next = host.nextElementSibling;
  if (next && next.classList?.contains("claimDetail")) {
    const same = next.dataset.claim === btn.dataset.claim;
    next.remove();
    if (same) return;
  }
  document.querySelectorAll(".claimDetail").forEach((d) => d.remove());
  const lbl = c.level === "ok" ? "✓ BEKREFTET" : c.level === "single" ? "◐ ENKELTKILDE" : "✗ RYKTE/UBEKREFTET";
  const srcRows = (c.srcIdx || []).map((n) => {
    const s = SRCS[n];
    if (!s) return "";
    const r = s.rating || {};
    return `<div>· <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(domainOf(s.url))}</a>` +
      ` <span class="scoreChip ${scoreCls(r.score ?? 40)}">${r.score ?? "?"}</span> <span class="dim">${escapeHtml((r.reasons || []).join(" · "))}</span></div>`;
  }).join("");
  const el = document.createElement(host.tagName === "LI" ? "li" : "div");
  el.className = "claimDetail";
  el.dataset.claim = btn.dataset.claim;
  el.innerHTML =
    `<div><b>${lbl}</b> <span class="dim">${escapeHtml((c.why || []).join(" · "))}</span></div>` +
    (srcRows ? `<div class="dim" style="margin-top:3px">KILDER:</div>${srcRows}` : `<div class="dim">Ingen gyldige kilder.</div>`) +
    `<div class="dim" style="margin-top:3px">BULL/BEAR ${c.bb.score}/100:</div><div>${escapeHtml((c.bb.factors || []).join(" · "))}</div>`;
  host.after(el);
});

/* ---------------- SSE-over-fetch ---------------- */
async function streamPost(url, body, handlers) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        let evt;
        try { evt = JSON.parse(line.slice(6)); } catch { continue; }
        if (evt.type === "status") handlers.onStatus?.(evt.text);
        else if (evt.type === "text") handlers.onText?.(evt.text);
        else if (evt.type === "done") handlers.onDone?.(evt);
        else if (evt.type === "error") handlers.onError?.(evt.message);
      }
    }
  }
}

/* ---------------- generering ---------------- */
async function generateBriefing(focusItems) {
  if (GENERATING) return;
  GENERATING = true;
  banner("");
  led.className = "led busy";
  const btn = $("btnGenerate");
  btn.disabled = true;

  const body = $("streamBody");
  body.innerHTML = "";
  $("briefing").classList.add("hidden");
  $("empty").classList.add("hidden");
  $("stream").classList.remove("hidden");

  const t0 = Date.now();
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    $("streamTimer").textContent = `${s}s`;
    btn.textContent = `GENERERER… ${s}s`;
  }, 500);

  const append = (html) => {
    body.insertAdjacentHTML("beforeend", html);
    body.scrollTop = body.scrollHeight;
  };

  try {
    await streamPost("/api/briefing/generate", { focus: focusItems, force: true }, {
      onStatus: (s) => append(`<span class="status">▪ ${escapeHtml(s)}</span>\n`),
      onText: (t) => append(escapeHtml(t)),
      onDone: (evt) => {
        const cacheTag = evt.cached ? " • FRA CACHE (allerede generert i dag)" : "";
        const searchTag = evt.searches != null ? ` • ${evt.searches} WEBSØK` : "";
        renderBriefing(
          evt.markdown,
          `GENERERT ${evt.generatedAtCET}${cacheTag}${searchTag} • LAGRET ${evt.savedTo}`,
          evt.sources || [],
          evt.generatedAtCET || "",
          { claims: evt.claims, sections: evt.sections, overall: evt.overall, deltas: evt.deltas }
        );
        $("briefFoot").innerHTML =
          `Lagret i <span class="code">${escapeHtml(evt.savedTo)}</span> — åpne briefings-mappen med Claude Desktop/Code for å gå dypere.`;
        led.className = "led on";
      },
      onError: (m) => {
        banner(`GENERERING FEILET: ${m}`, true);
        led.className = "led err";
      },
    });
  } catch (e) {
    banner(`GENERERING FEILET: ${e.message || e}`, true);
    led.className = "led err";
  } finally {
    clearInterval(timer);
    GENERATING = false;
    btn.disabled = false;
    btn.textContent = "GENERER BRIEF";
  }
}

/* ---------------- fokus-velger ---------------- */
let FAVORITES = [];
let SELECTED = [];

const sameItem = (a, b) => (a.ticker && b.ticker ? a.ticker === b.ticker : a.label === b.label);

function renderFocusPicker() {
  const chips = $("favChips");
  chips.innerHTML = "";
  FAVORITES.forEach((f) => {
    const on = SELECTED.some((s) => sameItem(s, f));
    const c = document.createElement("button");
    c.type = "button";
    c.className = "fChip" + (on ? " on" : "");
    c.textContent = f.ticker ? `${f.ticker} · ${f.label}` : f.label;
    c.addEventListener("click", () => {
      if (on) SELECTED = SELECTED.filter((s) => !sameItem(s, f));
      else SELECTED.push({ ...f });
      renderFocusPicker();
    });
    chips.appendChild(c);
  });

  const list = $("todayList");
  list.innerHTML = "";
  SELECTED.forEach((s, i) => {
    const li = document.createElement("li");
    li.innerHTML =
      `<span>${escapeHtml(s.ticker ? `${s.ticker} · ${s.label}` : s.label)}${i === 0 ? ' <span class="dim">(primær)</span>' : ""}</span>`;
    const del = document.createElement("button");
    del.className = "btnMini";
    del.textContent = "×";
    del.addEventListener("click", () => { SELECTED.splice(i, 1); renderFocusPicker(); });
    li.appendChild(del);
    list.appendChild(li);
  });
  $("focusMsg").textContent = SELECTED.length ? "" : "Velg minst ett element.";
}

async function openFocusPicker() {
  try {
    const r = await fetch("/api/focus/today");
    const j = await r.json();
    FAVORITES = j.favorites || [];
    SELECTED = (j.items || []).map((x) => ({ ...x }));
  } catch { FAVORITES = []; SELECTED = []; }
  renderFocusPicker();
  $("focusModal").classList.remove("hidden");
  $("freeLabel").focus();
}

function addFreeItem() {
  const label = $("freeLabel").value.trim();
  const ticker = $("freeTicker").value.trim().toUpperCase();
  if (!label && !ticker) return;
  const item = { label: label || ticker, ticker, angle: "" };
  // gjenbruk favoritt-vinkel hvis den matcher
  const fav = FAVORITES.find((f) => sameItem(f, item));
  if (fav) item.angle = fav.angle;
  if (!SELECTED.some((s) => sameItem(s, item))) SELECTED.push(item);
  $("freeLabel").value = "";
  $("freeTicker").value = "";
  renderFocusPicker();
  $("freeLabel").focus();
}

$("btnFreeAdd").addEventListener("click", addFreeItem);
$("freeLabel").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addFreeItem(); } });
$("freeTicker").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addFreeItem(); } });

$("btnFocusClose").addEventListener("click", () => $("focusModal").classList.add("hidden"));
$("focusModal").addEventListener("click", (e) => {
  if (e.target === $("focusModal")) $("focusModal").classList.add("hidden");
});
$("btnFocusGenerate").addEventListener("click", () => {
  if (!SELECTED.length) { $("focusMsg").textContent = "Velg minst ett element."; return; }
  $("focusModal").classList.add("hidden");
  generateBriefing(SELECTED);
});

$("btnGenerate").addEventListener("click", openFocusPicker);

/* ---------------- kurs-tape ---------------- */
function fmtPx(n) {
  if (typeof n !== "number") return "n/a";
  const d = Math.abs(n) >= 1000 ? 1 : Math.abs(n) >= 10 ? 2 : 3;
  return n.toLocaleString("en-US", { maximumFractionDigits: d });
}
async function loadTape() {
  try {
    const r = await fetch("/api/quotes" + pSuf());
    const data = await r.json();
    if (!data.quotes) return;
    const tape = $("tape");
    tape.innerHTML = "";
    for (const q of data.quotes) {
      const chip = document.createElement("span");
      chip.className = "chip" + (q.region === "FOKUS" ? " focus" : "");
      if (!q.ok) {
        chip.innerHTML = `<span class="sym">${escapeHtml(q.label)}</span><span class="dim">n/a</span>`;
      } else {
        if (q.ts) {
          const min = Math.max(0, Math.round((Date.now() / 1000 - q.ts) / 60));
          chip.title = `${q.source || "kilde"} · oppdatert for ${min} min siden${min > 2 ? " (forsinket)" : ""}`;
        } else {
          chip.title = `${q.source || "kilde"} · ukjent alder på kursen`;
        }
        const dir = q.changePct >= 0 ? "up" : "down";
        const arrow = q.changePct >= 0 ? "▲" : "▼";
        let extra = "";
        if (typeof q.preMarket === "number") {
          const pdir = q.preMarketPct >= 0 ? "up" : "down";
          extra = ` <span class="${pdir}">pre ${fmtPx(q.preMarket)}</span>`;
        }
        chip.innerHTML =
          `<span class="sym">${escapeHtml(q.label)}</span>` +
          `<span class="px">${fmtPx(q.price)}</span>` +
          `<span class="${dir}">${arrow}${Math.abs(q.changePct).toFixed(1)}%</span>${extra}`;
      }
      tape.appendChild(chip);
    }
  } catch { /* tapen er kosmetisk */ }
}
setInterval(loadTape, 60_000);

/* ---------------- datalag-widgets (fase 1) ---------------- */
function ageMin(iso) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

function widgetPanel(title, ok, bodyHtml, meta) {
  return `<section class="panel"><div class="pHead"><span>${title}</span>` +
    (meta ? `<span class="fetchStamp">${escapeHtml(meta)}</span>` : "") + `</div>` +
    `<div class="pBody wBody">${ok ? bodyHtml : `<p class="dim">Kilde utilgjengelig: ${escapeHtml(bodyHtml)}</p>`}</div></section>`;
}

function renderDataRow(d) {
  const row = $("dataRow");
  let html = "";

  // MAKRO (FRED)
  if (d.macro?.ok && d.macro.macro) {
    const m = d.macro.macro;
    const num = (o, suffix) => o
      ? `<div class="macroNum"><span class="bigNum">${o.value}${suffix}</span><span class="dim"> ${escapeHtml(o.label)} <span title="per ${o.date}">(${o.date.slice(5)})</span></span></div>`
      : "";
    html += widgetPanel("MAKRO USA", true,
      num(m.rate, " %") + num(m.cpiYoY, " %") + num(m.unemployment, " %"),
      `FRED · ${ageMin(d.macro.at)} min`);
  } else if (d.macro) {
    html += widgetPanel("MAKRO USA", false, d.macro.error || "ukjent feil");
  }

  // NESTE 7 DAGER
  if (d.calendar?.ok) {
    const ev = d.calendar.events || [];
    html += widgetPanel("NESTE 7 DAGER", true,
      ev.length
        ? ev.map((e) => `<div class="cntRow"><span class="tag ${e.days <= 1 ? "tag-idag" : "tag-uke"}">${e.days === 0 ? "I DAG" : `om ${e.days} d`}</span> ${escapeHtml(e.label)} <span class="dim">(${e.date.slice(5)})</span></div>`).join("")
        : '<p class="dim">Ingen kjente hendelser neste 7 dager.</p>',
      `${ageMin(d.calendar.at)} min`);
  } else if (d.calendar) {
    html += widgetPanel("NESTE 7 DAGER", false, d.calendar.error || "ukjent feil");
  }

  // INNSIDEHANDEL (EDGAR)
  if (d.insider?.ok && d.insider.byTicker) {
    let b = "";
    for (const [t, x] of Object.entries(d.insider.byTicker)) {
      const s = x.summary || {};
      b += `<div class="wSub">${escapeHtml(t)} <span class="dim">· siste ${s.sampled || 0} Form 4: </span>` +
        `<span class="${s.sells > s.buys ? "down" : s.buys > s.sells ? "up" : "dim"}">${s.sells || 0} salg / ${s.buys || 0} kjøp</span></div>`;
      for (const f of x.form4 || []) {
        const cls = f.side === "SALG" ? "tag-rykte" : f.side === "KJØP" ? "tag-idag" : "tag-eldre";
        b += `<div class="cntRow"><span class="tag ${cls}">${escapeHtml(f.side || "?")}</span> ` +
          `${escapeHtml(f.owner || "ukjent")} <span class="dim">${f.shares ? Math.round(f.shares).toLocaleString("nb-NO") + " aksjer · " : ""}${f.date.slice(5)}</span>` +
          (f.url ? ` <a class="srcRef" href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer">[SEC]</a>` : "") + `</div>`;
      }
    }
    html += widgetPanel("INNSIDEHANDEL", true, b || '<p class="dim">Ingen Form 4 funnet.</p>', `SEC EDGAR · ${ageMin(d.insider.at)} min`);
  } else if (d.insider) {
    html += widgetPanel("INNSIDEHANDEL", false, d.insider.error || "ukjent feil");
  }

  // BØRSMELDINGER OSLO (NewsWeb)
  if (d.oslo?.ok && d.oslo.byIssuer) {
    let b = "";
    for (const [t, msgs] of Object.entries(d.oslo.byIssuer)) {
      b += `<div class="wSub">${escapeHtml(t)}</div>`;
      for (const m of (msgs || []).slice(0, 5)) {
        b += `<div class="cntRow">${m.meldepliktig ? '<span class="tag tag-rykte">MELDEPLIKTIG</span> ' : ""}` +
          (m.url ? `<a class="obLink" href="${escapeHtml(m.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(m.title.slice(0, 60))}</a>` : escapeHtml(m.title.slice(0, 60))) +
          ` <span class="dim">(${m.date.slice(5)})</span></div>`;
      }
      if (!(msgs || []).length) b += '<p class="dim">Ingen meldinger siste 14 dager.</p>';
    }
    html += widgetPanel("BØRSMELDINGER OSLO", true, b, `NewsWeb · ${ageMin(d.oslo.at)} min`);
  } else if (d.oslo) {
    html += widgetPanel("BØRSMELDINGER OSLO", false, d.oslo.error || "ukjent feil");
  }

  row.innerHTML = html;
  row.classList.toggle("hidden", !html);
}

async function loadData() {
  try {
    const r = await fetch("/api/data" + pSuf());
    if (!r.ok) return;
    DATA = await r.json();
    renderDataRow(DATA);
  } catch { /* widgets er tillegg - aldri blokkerende */ }
}

/* ---------------- chat ---------------- */
const chatPanel = $("chatPanel");
const chatLog = $("chatLog");

function chatMsg(cls, html) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.innerHTML = html;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

async function loadChat() {
  try {
    const r = await fetch("/api/chat/today");
    const { messages } = await r.json();
    chatLog.innerHTML = "";
    for (const m of messages) {
      chatMsg(m.role, m.role === "user" ? escapeHtml(m.content) : renderSection(m.content, m.sources || []));
    }
  } catch { /* ignorer */ }
}

$("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  chatMsg("user", escapeHtml(text));
  const statusEl = chatMsg("status", "…");
  const replyEl = chatMsg("assistant", "");
  let raw = "";
  try {
    await streamPost("/api/chat", { message: text }, {
      onStatus: (s) => { statusEl.textContent = `▪ ${s}`; },
      onText: (t) => {
        raw += t;
        replyEl.innerHTML = renderMd(raw, { sources: [] }); // markører skjules til kildene kommer
        chatLog.scrollTop = chatLog.scrollHeight;
      },
      onDone: (evt) => {
        statusEl.remove();
        replyEl.innerHTML = renderSection(raw, (evt && evt.sources) || []);
        chatLog.scrollTop = chatLog.scrollHeight;
      },
      onError: (m) => { statusEl.remove(); replyEl.innerHTML = `<span class="down">FEIL: ${escapeHtml(m)}</span>`; },
    });
  } catch (err) {
    statusEl.remove();
    replyEl.innerHTML = `<span class="down">FEIL: ${escapeHtml(String(err.message || err))}</span>`;
  }
});

$("btnShare").addEventListener("click", async () => {
  try {
    const b = await (await fetch("/api/briefing/today")).json();
    if (!b.exists) return banner("Ingen brief å dele ennå - generer først.", true);
    const w = (s) => (s >= 61 ? "BULLISH" : s <= 39 ? "BEARISH" : "NØYTRALT");
    let txt = `MORGENBRIEF ${b.date}`;
    if (b.overall) txt += ` — marked ${b.overall.score}/100 ${w(b.overall.score)}`;
    for (const [name, s] of Object.entries(b.sections || {})) {
      if (name.startsWith("FOKUS:")) txt += `\n${name.replace(/^FOKUS:\s*/, "")}: ${s.score}/100 ${w(s.score)}${s.lowConf ? " (lav konfidens)" : ""}`;
    }
    txt += `\n\nAI-generert med kildekritikk. Informasjon, ikke investeringsråd.\n${location.origin}`;
    await navigator.clipboard.writeText(txt);
    banner("Delbart sammendrag kopiert - lim inn hvor som helst.");
    setTimeout(() => banner(""), 4000);
  } catch {
    banner("Kunne ikke kopiere sammendraget.", true);
  }
});

$("btnAllSources").addEventListener("click", () => {
  const b = $("allSources");
  b.classList.toggle("hidden");
  $("btnAllSources").textContent = b.classList.contains("hidden") ? "VIS" : "SKJUL";
});

$("btnChat").addEventListener("click", () => chatPanel.classList.toggle("hidden"));
$("btnChatClose").addEventListener("click", () => chatPanel.classList.add("hidden"));
$("btnChatClear").addEventListener("click", async () => {
  await fetch("/api/chat/today", { method: "DELETE" });
  chatLog.innerHTML = "";
});
if (window.innerWidth < 1150) chatPanel.classList.add("hidden");

/* ---------------- favoritter (innstillinger) ---------------- */
let favEdit = [];

function renderCompanyRows() {
  const wrap = $("companyRows");
  wrap.innerHTML = "";
  favEdit.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "companyRow";
    row.innerHTML = `
      <div class="rowTop">
        <span class="idx">#${i + 1}</span>
        <input class="inName" placeholder="Navn (selskap, sektor, fond, tema)" value="${escapeHtml(c.label || "")}" />
        <input class="inTicker" placeholder="TICKER (valgfri)" value="${escapeHtml(c.ticker || "")}" />
        <button class="btnMini rUp" title="Flytt opp">▲</button>
        <button class="btnMini rDown" title="Flytt ned">▼</button>
        <button class="btnMini rDel" title="Fjern">×</button>
      </div>
      <textarea placeholder="Vinkel - slik du tenker om posisjonen (styrer nyhetsfilteret)">${escapeHtml(c.angle || "")}</textarea>`;
    const sync = () => {
      c.label = row.querySelector(".inName").value;
      c.ticker = row.querySelector(".inTicker").value;
      c.angle = row.querySelector("textarea").value;
    };
    row.querySelectorAll("input,textarea").forEach((el) => el.addEventListener("input", sync));
    row.querySelector(".rUp").addEventListener("click", () => {
      if (i > 0) { [favEdit[i - 1], favEdit[i]] = [favEdit[i], favEdit[i - 1]]; renderCompanyRows(); }
    });
    row.querySelector(".rDown").addEventListener("click", () => {
      if (i < favEdit.length - 1) { [favEdit[i + 1], favEdit[i]] = [favEdit[i], favEdit[i + 1]]; renderCompanyRows(); }
    });
    row.querySelector(".rDel").addEventListener("click", () => { favEdit.splice(i, 1); renderCompanyRows(); });
    wrap.appendChild(row);
  });
}

$("btnSettings").addEventListener("click", async () => {
  const r = await fetch("/api/settings" + pSuf());
  const s = await r.json();
  favEdit = s.favorites.map((c) => ({ ...c }));
  renderCompanyRows();
  $("settingsMsg").textContent = "";
  $("settingsModal").classList.remove("hidden");
});
$("btnSettingsClose").addEventListener("click", () => $("settingsModal").classList.add("hidden"));
$("btnAddCompany").addEventListener("click", () => { favEdit.push({ label: "", ticker: "", angle: "" }); renderCompanyRows(); });
$("btnSaveSettings").addEventListener("click", async () => {
  const r = await fetch("/api/settings" + pSuf(), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorites: favEdit }),
  });
  if (r.ok) {
    $("settingsModal").classList.add("hidden");
    loadTape();
  } else {
    const j = await r.json().catch(() => ({}));
    $("settingsMsg").textContent = j.error || "Lagring feilet";
  }
});
$("settingsModal").addEventListener("click", (e) => {
  if (e.target === $("settingsModal")) $("settingsModal").classList.add("hidden");
});

/* ---------------- login-overlay (Vercel: statisk side + passordbeskyttet API) ---------------- */
function showLoginOverlay() {
  led.className = "led err";
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML =
    `<div class="modalBox" style="max-width:340px"><div class="pHead"><span>TILGANGSKODE</span></div>` +
    `<form id="loginForm" style="padding:14px;display:flex;flex-direction:column;gap:8px">` +
    `<input id="loginPw" type="password" placeholder="tilgangskode" autocomplete="current-password" ` +
    `style="background:var(--bg);color:var(--text);border:1px solid var(--line);padding:8px 10px;font-family:var(--mono);font-size:13px;outline:none" />` +
    `<button class="btnGen" type="submit">LOGG INN</button>` +
    `<span id="loginErr" class="dim"></span></form></div>`;
  document.body.appendChild(m);
  m.querySelector("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: m.querySelector("#loginPw").value }),
    });
    if (r.ok) location.reload();
    else m.querySelector("#loginErr").textContent = "Feil kode.";
  });
  m.querySelector("#loginPw").focus();
}

/* ---------------- init ---------------- */
(async function init() {
  try { if (localStorage.getItem("mbDensity") === "lesbar") document.body.classList.add("lesbar"); } catch { /* ok */ }
  loadTape();
  loadChat();
  loadData();
  loadHistory();
  try {
    const r = await fetch("/api/meta");
    if (r.status === 401) return showLoginOverlay();
    META = await r.json();
    $("modelTag").textContent = META.model + (PROFILE() ? " · " + PROFILE().toUpperCase() : "");
    try {
      if (!localStorage.getItem("mbProfileAsked")) {
        localStorage.setItem("mbProfileAsked", "1");
        if (!PROFILE()) pickProfile(true);
      }
    } catch { /* ok */ }
    if (!META.hasAnthropicKey) {
      banner("ANTHROPIC_API_KEY mangler - legg den i .env og restart. Generering deaktivert.", true);
      led.className = "led err";
      $("empty").classList.remove("hidden");
      return;
    }
    led.className = "led on";
    if (META.hasBriefing) {
      const b = await (await fetch("/api/briefing/today")).json();
      if (b.exists) {
        const searchTag = b.meta.searches ? ` • ${b.meta.searches} WEBSØK` : "";
        renderBriefing(
          b.markdown,
          `GENERERT ${b.meta.generatedAtCET || b.meta.generatedAt || ""} • ${b.date}${searchTag} • FOKUS: ${b.meta.focus || ""}`,
          b.sources || [],
          b.meta.generatedAtCET || "",
          { claims: b.claims, sections: b.sections, overall: b.overall, deltas: b.deltas, delta: b.delta }
        );
        $("briefFoot").innerHTML =
          `Lagret i <span class="code">briefings/${b.date}.md</span> — åpne den mappen med Claude Desktop/Code for å gå dypere.`;
      }
    } else if (!META.generating) {
      // Første åpning i dag: spør hva som er i fokus.
      $("empty").classList.remove("hidden");
      openFocusPicker();
    }
  } catch {
    banner("Får ikke kontakt med backend. Kjører serveren?", true);
    led.className = "led err";
  }
})();
