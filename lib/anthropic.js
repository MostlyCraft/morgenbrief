// anthropic.js - streaming-klient for Anthropic Messages API med web_search
// ALLTID aktivert. Null SDK: ren fetch + SSE-parsing.
//
// v1.4: fanger citations fra streamen som [[C:n]]-markører i teksten, med en
// kildeliste per svar. Stripper rå citation-tags modellen kan lekke, teller
// faktiske websøk (så en brief uten søk kan avvises), og blokkerer pump-sider.
import { loadEnv } from "./env.js";
loadEnv();

const API_URL = () => process.env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5";

// Lavkvalitets-/pump-sider som aldri skal brukes som kilde.
// Overstyres med BLOCKED_DOMAINS=domene1,domene2 i env.
const DEFAULT_BLOCKED = ["stockstotrade.com", "timothysykes.com", "investorplace.com"];

export function blockedDomains() {
  const env = (process.env.BLOCKED_DOMAINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return env.length ? env : DEFAULT_BLOCKED;
}

export function modelName() { return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL; }
export function chatModelName() { return process.env.ANTHROPIC_CHAT_MODEL || modelName(); }
export function hasKey() { return Boolean(process.env.ANTHROPIC_API_KEY); }

// Rå citation-/ant-tags som enkelte modeller kan lekke i teksten.
const JUNK_TAG_RE = /<\/?(?:ant[\w:.-]*|cite)(?:\s[^>]*)?>/gi;
export function stripJunkTags(s) { return s.replace(JUNK_TAG_RE, ""); }

/**
 * Strøm en generering. web_search er alltid på.
 * @returns {Promise<{text: string, searches: number, sources: Array<{url:string,title:string}>}>}
 *   text inneholder [[C:n]]-markører der n er indeks i sources.
 */
export async function streamCompletion({
  model,
  system,
  messages,
  maxTokens = 3000,
  maxSearches = 8,
  onStatus = () => {},
  onText = () => {},
}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY mangler. Legg den i .env og restart.");

  const body = {
    model: model || modelName(),
    max_tokens: maxTokens,
    system,
    messages,
    stream: true,
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: maxSearches,
        blocked_domains: blockedDomains(),
        user_location: { type: "approximate", country: "NO", timezone: "Europe/Oslo" },
      },
    ],
  };

  const res = await fetch(API_URL(), {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      detail = j?.error?.message || detail;
    } catch { /* ignorer */ }
    throw new Error(`Anthropic API-feil: ${detail}`);
  }

  // ---- SSE-parsing med citation-fangst ----
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  let fullText = "";
  let searches = 0;
  let stopReason = "";
  const sources = [];         // [{url, title}] - siterte kilder
  const searchResults = [];   // ALLE faktiske søkeresultater (for URL-validering i verify.js)
  const srcIndex = new Map(); // url -> n
  const toolInputs = new Map();
  let pendingTail = "";       // holder tilbake mulig påbegynt tag i slutten av en chunk

  const emitText = (raw) => {
    let s = pendingTail + raw;
    pendingTail = "";
    s = stripJunkTags(s);
    const tail = s.match(/<[^>]*$/); // påbegynt tag? vent på resten
    if (tail) {
      pendingTail = tail[0];
      s = s.slice(0, -tail[0].length);
    }
    if (s) { fullText += s; onText(s); }
  };

  const flushTail = () => {
    if (!pendingTail) return;
    const s = stripJunkTags(pendingTail);
    pendingTail = "";
    if (s) { fullText += s; onText(s); }
  };

  const addCitation = (cit) => {
    const url = cit?.url;
    if (!url) return;
    let n = srcIndex.get(url);
    if (n === undefined) {
      n = sources.length;
      sources.push({ url, title: cit.title || "" });
      srcIndex.set(url, n);
    }
    const marker = `[[C:${n}]]`;
    if (!fullText.endsWith(marker)) { // ikke dublér samme kilde rett etter seg selv
      fullText += marker;
      onText(marker);
    }
  };

  const handleEvent = (evt) => {
    switch (evt.type) {
      case "content_block_start": {
        const b = evt.content_block;
        if (b?.type === "server_tool_use" && b.name === "web_search") {
          searches += 1;
          toolInputs.set(evt.index, "");
        } else if (b?.type === "web_search_tool_result") {
          const items = Array.isArray(b.content) ? b.content : [];
          for (const it of items) {
            if (it?.url) searchResults.push({ url: it.url, title: it.title || "", page_age: it.page_age || "" });
          }
          onStatus(items.length ? `TREFF: ${items.length} kilder` : "TREFF MOTTATT");
        }
        break;
      }
      case "content_block_delta": {
        const d = evt.delta;
        if (d?.type === "text_delta" && d.text) {
          emitText(d.text);
        } else if (d?.type === "citations_delta" && d.citation) {
          flushTail();
          addCitation(d.citation);
        } else if (d?.type === "input_json_delta" && toolInputs.has(evt.index)) {
          toolInputs.set(evt.index, toolInputs.get(evt.index) + (d.partial_json || ""));
        }
        break;
      }
      case "content_block_stop": {
        flushTail();
        if (toolInputs.has(evt.index)) {
          try {
            const q = JSON.parse(toolInputs.get(evt.index) || "{}").query;
            if (q) onStatus(`SØK ${searches}: ${q}`);
          } catch { onStatus(`SØK ${searches}: (venter)`); }
          toolInputs.delete(evt.index);
        }
        break;
      }
      case "message_delta": {
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        break;
      }
      case "error": {
        throw new Error(`Strømfeil: ${evt.error?.message || "ukjent"}`);
      }
      default:
        break; // message_start, message_stop, ping
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          const payload = line.slice(6).trim();
          if (!payload) continue;
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }
          handleEvent(evt);
        }
      }
    }
  }

  flushTail();
  return { text: stripJunkTags(fullText).trim(), searches, sources, searchResults, stopReason };
}
