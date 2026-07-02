// anthropic.js - minimal streaming-klient for Anthropic Messages API med
// web_search-verktøyet aktivert. Ingen SDK: ren fetch + SSE-parsing.

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5"; // billig og god nok med websøk-fakta

export function modelName() {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

export function chatModelName() {
  return process.env.ANTHROPIC_CHAT_MODEL || modelName();
}

export function hasKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Strøm en generering. web_search er alltid på.
 * @param {object} p
 * @param {string} [p.model]      modell-id (default: modelName())
 * @param {string|Array} p.system streng eller content-block-array (for cache_control)
 * @param {Array}  p.messages     [{role, content}]
 * @param {number} p.maxTokens
 * @param {number} p.maxSearches
 * @param {(s:string)=>void} p.onStatus  live statuslinjer ("SØK: ...")
 * @param {(t:string)=>void} p.onText    tekst-deltaer
 * @returns {Promise<string>} full tekst
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
        user_location: { type: "approximate", country: "NO", timezone: "Europe/Oslo" },
      },
    ],
  };

  const res = await fetch(API_URL, {
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

  // ---- SSE-parsing ----
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  let fullText = "";
  const toolInputs = new Map(); // blokkindeks -> akkumulert partial JSON

  const handleEvent = (evt) => {
    switch (evt.type) {
      case "content_block_start": {
        const b = evt.content_block;
        if (b?.type === "server_tool_use" && b.name === "web_search") {
          toolInputs.set(evt.index, "");
        } else if (b?.type === "web_search_tool_result") {
          const n = Array.isArray(b.content) ? b.content.length : 0;
          onStatus(n ? `TREFF: ${n} kilder` : "TREFF MOTTATT");
        }
        break;
      }
      case "content_block_delta": {
        const d = evt.delta;
        if (d?.type === "text_delta" && d.text) {
          fullText += d.text;
          onText(d.text);
        } else if (d?.type === "input_json_delta" && toolInputs.has(evt.index)) {
          toolInputs.set(evt.index, toolInputs.get(evt.index) + (d.partial_json || ""));
        }
        break;
      }
      case "content_block_stop": {
        if (toolInputs.has(evt.index)) {
          try {
            const q = JSON.parse(toolInputs.get(evt.index) || "{}").query;
            if (q) onStatus(`SØK: ${q}`);
          } catch { onStatus("SØK: (venter)"); }
          toolInputs.delete(evt.index);
        }
        break;
      }
      case "error": {
        throw new Error(`Strømfeil: ${evt.error?.message || "ukjent"}`);
      }
      default:
        break; // message_start, message_delta, message_stop, ping
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

  return fullText.trim();
}
