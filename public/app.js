/* MORGENBRIEF frontend (norsk) */
"use strict";

const $ = (id) => document.getElementById(id);
const led = $("led");

let META = null;
let GENERATING = false;

/* ---------------- boot ---------------- */
const BOOT_LINES = [
  "MORGENBRIEF v1.1",
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

/* markdown-lett: punkter, fet, `kode`, %-farging, "Poenget:"-utheving */
function inlineMd(s) {
  let h = escapeHtml(s);
  h = h.replace(/`([^`]+)`/g, '<span class="code">$1</span>');
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/(^|[\s(>])([+]\d+(?:[.,]\d+)?\s?%)/g, '$1<span class="up">$2</span>');
  h = h.replace(/(^|[\s(>])([-−]\d+(?:[.,]\d+)?\s?%)/g, '$1<span class="down">$2</span>');
  return h;
}

function renderMd(text, { firstLineQuote = false } = {}) {
  const lines = text.split("\n");
  let html = "", inList = false, first = true;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (let raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    const stripped = line.replace(/^[-*]\s+/, "");
    const isBullet = /^[-*]\s+/.test(line.trim());
    const isPoint = /^\*{0,2}`?(poenget|so what):?/i.test(stripped.trim());
    if (isPoint) {
      closeList();
      html += `<div class="sowhat">${inlineMd(stripped.replace(/[`*]/g, ""))}</div>`;
    } else if (isBullet) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inlineMd(line.trim().replace(/^[-*]\s+/, ""))}</li>`;
    } else {
      closeList();
      const cls = first && firstLineQuote ? "qline" : "";
      html += `<p class="${cls}">${inlineMd(line.replace(/^#+\s*/, ""))}</p>`;
    }
    first = false;
  }
  closeList();
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

function renderBriefing(markdown, metaLine) {
  const secs = parseSections(markdown);
  const get = (...names) => {
    for (const n of names) {
      const hit = secs.find((s) => s.heading.toUpperCase().startsWith(n));
      if (hit) return hit.body;
    }
    return "_seksjon mangler_";
  };

  $("b-sitrep").innerHTML = renderMd(get("SITREP"));
  $("b-usa").innerHTML = renderMd(get("USA", "AMERICA"));
  $("b-europa").innerHTML = renderMd(get("EUROPA", "EUROPE"));
  $("b-norge").innerHTML = renderMd(get("NORGE", "NORWAY"));
  $("b-asia").innerHTML = renderMd(get("ASIA"));
  $("b-kalender").innerHTML = renderMd(get("KALENDER", "CALENDAR"));
  $("b-oppsummert").innerHTML = renderMd(get("OPPSUMMERT", "ONE-LINER"));

  const focus = secs.filter((s) => s.heading.toUpperCase().startsWith("FOKUS") || s.heading.toUpperCase().startsWith("FOCUS"));
  const wrap = $("focusWrap");
  wrap.innerHTML = "";
  focus.forEach((s, i) => {
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.innerHTML =
      `<div class="pHead"><span>${escapeHtml(s.heading)}${i === 0 ? " // PRIMÆR" : ""}</span></div>` +
      `<div class="pBody">${renderMd(s.body, { firstLineQuote: true })}</div>`;
    if (i === 0) {
      wrap.appendChild(panel);
    } else {
      let grid = wrap.querySelector(".focusGrid");
      if (!grid) { grid = document.createElement("div"); grid.className = "focusGrid"; wrap.appendChild(grid); }
      grid.appendChild(panel);
    }
  });

  $("briefMeta").textContent = metaLine || "";
  $("empty").classList.add("hidden");
  $("stream").classList.add("hidden");
  $("briefing").classList.remove("hidden");
}

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
    await streamPost("/api/briefing/generate", { focus: focusItems }, {
      onStatus: (s) => append(`<span class="status">▪ ${escapeHtml(s)}</span>\n`),
      onText: (t) => append(escapeHtml(t)),
      onDone: (evt) => {
        renderBriefing(evt.markdown, `GENERERT ${evt.generatedAtCET} • LAGRET ${evt.savedTo}`);
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
    const r = await fetch("/api/quotes");
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
      chatMsg(m.role, m.role === "user" ? escapeHtml(m.content) : renderMd(m.content));
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
        replyEl.innerHTML = renderMd(raw);
        chatLog.scrollTop = chatLog.scrollHeight;
      },
      onDone: () => statusEl.remove(),
      onError: (m) => { statusEl.remove(); replyEl.innerHTML = `<span class="down">FEIL: ${escapeHtml(m)}</span>`; },
    });
  } catch (err) {
    statusEl.remove();
    replyEl.innerHTML = `<span class="down">FEIL: ${escapeHtml(String(err.message || err))}</span>`;
  }
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
  const r = await fetch("/api/settings");
  const s = await r.json();
  favEdit = s.favorites.map((c) => ({ ...c }));
  renderCompanyRows();
  $("settingsMsg").textContent = "";
  $("settingsModal").classList.remove("hidden");
});
$("btnSettingsClose").addEventListener("click", () => $("settingsModal").classList.add("hidden"));
$("btnAddCompany").addEventListener("click", () => { favEdit.push({ label: "", ticker: "", angle: "" }); renderCompanyRows(); });
$("btnSaveSettings").addEventListener("click", async () => {
  const r = await fetch("/api/settings", {
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

/* ---------------- init ---------------- */
(async function init() {
  loadTape();
  loadChat();
  try {
    const r = await fetch("/api/meta");
    META = await r.json();
    $("modelTag").textContent = META.model;
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
        renderBriefing(b.markdown, `GENERERT ${b.meta.generatedAtCET || b.meta.generatedAt || ""} • ${b.date} • FOKUS: ${b.meta.focus || ""}`);
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
