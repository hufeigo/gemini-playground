//Author: PublicAffairs
//Project: https://github.com/PublicAffairs/openai-gemini
//MIT License : https://github.com/PublicAffairs/openai-gemini/blob/main/LICENSE

import { Buffer } from "node:buffer";

export default {
  async fetch (request) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }
    const errHandler = (err) => {
      console.error(err);
      return new Response(err.message, fixCors({ status: err.status ?? 500 }));
    };
    try {
      // Accept "Authorization: Bearer <key>" (OpenAI standard), a raw
      // "Authorization: <key>" (some clients omit the Bearer prefix) and
      // "x-api-key: <key>" (another common convention). Trailing
      // whitespace is trimmed — copy-paste artifacts otherwise silently
      // become "API key not valid" upstream.
      const auth = request.headers.get("Authorization")
        ?? request.headers.get("x-api-key");
      const apiKey = auth?.replace(/^\s*Bearer\s+/i, "").trim() || undefined;
      const assert = (success) => {
        if (!success) {
          throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
        }
      };
      const { pathname } = new URL(request.url);
      switch (true) {
        case pathname.endsWith("/chat/completions"):
          assert(request.method === "POST");
          return handleCompletions(await request.json(), apiKey)
            .catch(errHandler);
        case pathname.endsWith("/embeddings"):
          assert(request.method === "POST");
          return handleEmbeddings(await request.json(), apiKey)
            .catch(errHandler);
        case pathname.endsWith("/models"):
          assert(request.method === "GET");
          return handleModels(apiKey)
            .catch(errHandler);
        default:
          throw new HttpError("404 Not Found", 404);
      }
    } catch (err) {
      return errHandler(err);
    }
  }
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

// Forwarded responses get REBUILT headers. Copying the upstream header
// set (content-length, content-encoding, ...) onto a re-read or
// re-encoded body crashes Deno Deploy at the platform level
// (INTERNAL_SERVER_ERROR / connection resets) — observed on every
// non-2xx upstream response, while 2xx responses only survived because
// their upstream headers happened to be harmless. Keep it deterministic:
// preserve upstream status + content-type, add CORS, drop everything else.
const fixCors = ({ headers, status, statusText }) => {
  const upstreamType = headers?.get?.("content-type");
  const rebuilt = new Headers({
    "content-type": upstreamType || "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  return { headers: rebuilt, status, statusText };
};

const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    }
  });
};

const BASE_URL = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";

// https://github.com/google-gemini/generative-ai-js/blob/cf223ff4a1ee5a2d944c53cddb8976136382bee6/src/requests/request.ts#L71
const API_CLIENT = "genai-js/0.21.0"; // npm view @google/generative-ai version
const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "x-goog-api-key": apiKey }),
  ...more
});

// Outbound requests to Google carry a hard timeout. Without it, a host that
// cannot reach generativelanguage.googleapis.com (network-restricted
// environments) leaves the request pending forever — the browser eventually
// reports "signal timed out" with no hint about the real cause. 10s is well
// under the frontend's 15s timeout so the proxy surfaces the reason first.
// handleCompletions deliberately has no timeout: streamed generations may
// legitimately take minutes.
const UPSTREAM_TIMEOUT_MS = 10_000;

// Manual AbortController instead of AbortSignal.timeout(): the latter
// crashes the Deno Deploy isolate with a platform-level INTERNAL_SERVER_-
// ERROR (and is missing in some older runtimes). The timer is always
// cleared so it never delays the end of the request lifecycle.
async function fetchUpstream (url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new HttpError(
        `Upstream request to ${new URL(url).host} timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s — ` +
        "this host cannot reach the Gemini API directly. " +
        "If your network blocks Google, deploy the Cloudflare Worker proxy and point clients at that domain.",
        504,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function handleModels (apiKey) {
  const response = await fetchUpstream(`${BASE_URL}/${API_VERSION}/models`, {
    headers: makeHeaders(apiKey),
  });
  let { body } = response;
  if (response.ok) {
    const { models } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: models.map(({ name, supportedGenerationMethods }) => ({
        id: name.replace("models/", ""),
        object: "model",
        created: 0,
        owned_by: "",
        // Non-OpenAI extension: lets the web UI detect which models are
        // usable with the Live API (bidiGenerateContent). OpenAI clients
        // ignore unknown fields, so exposing this is safe.
        ...(supportedGenerationMethods && {
          supported_generation_methods: supportedGenerationMethods,
        }),
      })),
    }, null, "  ");
  } else {
    // Read eagerly: forwarding the upstream ReadableStream directly into
    // the response is unstable on some runtimes (Deno Deploy isolate
    // errors); plain text is safe everywhere.
    body = await response.text();
  }
  return new Response(body, fixCors(response));
}

const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-004";
async function handleEmbeddings (req, apiKey) {
  if (typeof req.model !== "string") {
    throw new HttpError("model is not specified", 400);
  }
  if (!Array.isArray(req.input)) {
    req.input = [ req.input ];
  }
  let model;
  if (req.model.startsWith("models/")) {
    model = req.model;
  } else {
    req.model = DEFAULT_EMBEDDINGS_MODEL;
    model = "models/" + req.model;
  }
  const response = await fetchUpstream(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      "requests": req.input.map(text => ({
        model,
        content: { parts: { text } },
        outputDimensionality: req.dimensions,
      }))
    })
  });
  let { body } = response;
  if (response.ok) {
    const { embeddings } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: embeddings.map(({ values }, index) => ({
        object: "embedding",
        index,
        embedding: values,
      })),
      model: req.model,
    }, null, "  ");
  } else {
    // Same Deploy-compat rule as handleModels: never forward the upstream
    // ReadableStream straight into the response — read it eagerly.
    body = await response.text();
  }
  return new Response(body, fixCors(response));
}

// Fallback for requests whose model is not a gemini-*/learnlm-* name (e.g.
// a client hardcoding "gpt-4o"). The previous value, gemini-1.5-pro-latest,
// has been retired by Google — such requests silently fell through to a 404.
const DEFAULT_MODEL = "gemini-3.6-flash";
async function handleCompletions (req, apiKey) {
  let model = DEFAULT_MODEL;
  switch(true) {
    case typeof req.model !== "string":
      break;
    case req.model.startsWith("models/"):
      model = req.model.substring(7);
      break;
    case req.model.startsWith("gemini-"):
    case req.model.startsWith("learnlm-"):
      model = req.model;
  }
  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) { url += "?alt=sse"; }
  const response = await fetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(await transformRequest(req)), // try
  });

  let body = response.body;
  if (response.ok) {
    let id = generateChatcmplId(); //"chatcmpl-8pMMaqXMK68B3nyDBrapTDrhkHBQK";
    if (req.stream) {
      body = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "",
        }))
        .pipeThrough(new TransformStream({
          transform: toOpenAiStream,
          flush: toOpenAiStreamFlush,
          streamIncludeUsage: req.stream_options?.include_usage,
          model, id, last: [],
        }))
        .pipeThrough(new TextEncoderStream());
    } else {
      body = await response.text();
      body = processCompletionsResponse(JSON.parse(body), model, id);
    }
  } else {
    // Error responses are read eagerly (Deploy-compat: never forward the
    // upstream ReadableStream straight into the response).
    body = await response.text();
  }
  return new Response(body, fixCors(response));
}

const harmCategory = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
];
const safetySettings = harmCategory.map(category => ({
  category,
  threshold: "BLOCK_NONE",
}));
const fieldsMap = {
  stop: "stopSequences",
  n: "candidateCount", // not for streaming
  max_tokens: "maxOutputTokens",
  max_completion_tokens: "maxOutputTokens",
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK", // non-standard
  frequency_penalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
};
const transformConfig = (req) => {
  let cfg = {};
  //if (typeof req.stop === "string") { req.stop = [req.stop]; } // no need
  for (let key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) {
      cfg[matchedKey] = req[key];
    }
  }
  if (req.response_format) {
    switch(req.response_format.type) {
      case "json_schema":
        cfg.responseSchema = req.response_format.json_schema?.schema;
        if (cfg.responseSchema && "enum" in cfg.responseSchema) {
          cfg.responseMimeType = "text/x.enum";
          break;
        }
        // eslint-disable-next-line no-fallthrough
      case "json_object":
        cfg.responseMimeType = "application/json";
        break;
      case "text":
        cfg.responseMimeType = "text/plain";
        break;
      default:
        throw new HttpError("Unsupported response_format.type", 400);
    }
  }
  return cfg;
};

const parseImg = async (url) => {
  let mimeType, data;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} (${url})`);
      }
      mimeType = response.headers.get("content-type");
      data = Buffer.from(await response.arrayBuffer()).toString("base64");
    } catch (err) {
      throw new Error("Error fetching image: " + err.toString());
    }
  } else {
    const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
    if (!match) {
      throw new Error("Invalid image data: " + url);
    }
    ({ mimeType, data } = match.groups);
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

// Maps tool_call_id → function name across a history so that "tool" role
// messages (which only carry tool_call_id) can be translated into Gemini
// functionResponse parts (which carry the function name).
const transformMsg = async ({ role, content, tool_calls }, toolNameById) => {
  const parts = [];
  // assistant tool_calls → model functionCall parts.
  // content is legitimately null on such turns (OpenAI: "Required unless
  // tool_calls is specified") — the part itself stays well-formed.
  if (Array.isArray(tool_calls)) {
    for (const tc of tool_calls) {
      const fn = tc?.function;
      if (!fn || typeof fn.name !== "string") { continue; }
      let args = {};
      if (typeof fn.arguments === "string" && fn.arguments) {
        try {
          args = JSON.parse(fn.arguments);
        } catch (err) {
          console.error("Invalid tool_call arguments JSON:", err);
        }
      } else if (fn.arguments && typeof fn.arguments === "object") {
        args = fn.arguments;
      }
      parts.push({
        functionCall: { name: fn.name, args },
        // Round-trip the Gemini thoughtSignature (see extractParts) — without
        // it Google rejects replayed function calls on 3.x thinking models.
        ...((tc.thought_signature ?? fn.thought_signature) && {
          thoughtSignature: tc.thought_signature ?? fn.thought_signature,
        }),
      });
      if (tc.id) { toolNameById.set(tc.id, fn.name); }
    }
  }
  if (!Array.isArray(content)) {
    // system, user: string
    // assistant: string or null (Required unless tool_calls is specified.)
    // OpenAI allows null content — e.g. tool_calls-only turns or
    // reasoning-only turns replayed from history. Google rejects a part
    // with no initialized field ("required oneof field 'data' must have
    // one initialized field"), so text-less turns fall back to whatever
    // parts were built above, or the message is dropped entirely.
    if (content === null || content === undefined) {
      return parts.length ? { role, parts } : null;
    }
    parts.push({ text: content });
    return { role, parts };
  }
  // user:
  // An array of content parts with a defined type.
  // Supported options differ based on the model being used to generate the response.
  // Can contain text, image, or audio inputs.
  for (const item of content) {
    switch (item.type) {
      case "text":
        if (typeof item.text === "string") {
          parts.push({ text: item.text });
        }
        break;
      case "image_url":
        parts.push(await parseImg(item.image_url.url));
        break;
      case "input_audio":
        parts.push({
          inlineData: {
            mimeType: "audio/" + item.input_audio.format,
            data: item.input_audio.data,
          }
        });
        break;
      default:
        throw new TypeError(`Unknown "content" item type: "${item.type}"`);
    }
  }
  if (content.every(item => item.type === "image_url")) {
    parts.push({ text: "" }); // to avoid "Unable to submit request because it must have a text parameter"
  }
  return { role, parts };
};

const transformMessages = async (messages) => {
  if (!messages) { return; }
  const contents = [];
  const toolNameById = new Map();
  let system_instruction;
  // Consecutive "tool" messages (one assistant turn with parallel tool_calls)
  // must be merged into ONE Gemini content — function responses belonging to
  // the same call batch may not be split across turns.
  const pushToolResponse = (entry) => {
    const prev = contents[contents.length - 1];
    if (prev && prev.role === "user" && prev.parts.length
        && prev.parts.every(p => p.functionResponse)) {
      prev.parts.push(...entry.parts);
    } else {
      contents.push(entry);
    }
  };
  for (const item of messages) {
    if (item.role === "system") {
      const { role, ...rest } = item; // role is not part of system_instruction
      const sys = await transformMsg(rest, toolNameById);
      if (sys) { system_instruction = sys; }
    } else if (item.role === "tool") {
      // OpenAI tool result (tool_call_id + content) → Gemini functionResponse
      // (role "user" per the Gemini function-calling convention).
      const name = item.tool_call_id && toolNameById.get(item.tool_call_id);
      if (name) {
        let result = item.content;
        if (typeof item.content === "string" && item.content) {
          try {
            result = JSON.parse(item.content);
          } catch { /* keep as plain string */ }
        }
        pushToolResponse({
          role: "user",
          parts: [{ functionResponse: { name, response: { result } } }],
        });
      } else if (item.content != null && item.content !== "") {
        // Cannot correlate with a tool_call (missing/foreign id) — degrade
        // to plain text so the tool output still reaches the model.
        contents.push({ role: "user", parts: [{ text: String(item.content) }] });
      }
    } else {
      const msg = await transformMsg({
        ...item,
        role: item.role === "assistant" ? "model" : "user",
      }, toolNameById);
      if (msg) { contents.push(msg); }
    }
  }
  if (contents.length === 0) {
    // Google rejects empty contents (all messages were dropped or none
    // were sent) — keep a minimal placeholder turn.
    contents.push({ role: system_instruction ? "model" : "user", parts: { text: " " } });
  }
  return { system_instruction, contents };
};

// ── JSON Schema sanitisation ────────────────────────────────────────────────
// Google's `parameters` accepts only a subset of JSON Schema (OpenAPI-3.0
// style, proto-validated). Full JSON Schema from real clients (LangChain,
// MCP, agent frameworks) gets rejected with 400 "Unknown name
// \"additionalProperties\" at 'tools[0].function_declarations[...]':
// Cannot find field". Everything below rewrites such schemas into the
// accepted subset:
//   • whitelisted keys only (additionalProperties/$schema/allOf/… dropped)
//   • local $ref/$defs inlined (dropping $ref alone would leave LangChain
//     schemas empty)
//   • allOf members merged into one object
//   • oneOf → anyOf (proto has anyOf; exact-one is not enforced anyway)
//   • type unions (["string","null"]) flattened + nullable=true
//   • enum values coerced to strings (proto takes repeated string)
const SCHEMA_KEYS = new Set([
  "type", "format", "title", "description", "nullable", "default",
  "maxItems", "minItems", "enum", "maxLength", "minLength", "pattern",
  "minimum", "maximum", "properties", "required", "items", "anyOf",
]);
const pointerGet = (root, pointer) => {
  let node = root;
  for (const raw of pointer.split("/")) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node == null || !(seg in Object(node))) { return undefined; }
    node = node[seg];
  }
  return node;
};
const normalizeSchema = (node, root, depth = 0) => {
  if (Array.isArray(node)) { return node.map(n => normalizeSchema(n, root, depth)); }
  if (!node || typeof node !== "object") { return node; }
  if (depth > 12) { return {}; } // $ref cycles / pathological nesting
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    const target = pointerGet(root, node.$ref.slice(2));
    if (target && typeof target === "object") {
      const { $ref, ...siblings } = node;
      return normalizeSchema({ ...target, ...siblings }, root, depth + 1);
    }
    console.error("Unresolvable $ref:", node.$ref);
    return {};
  }
  if (Array.isArray(node.allOf)) {
    const { allOf, ...self } = node;
    const merged = { ...self };
    for (const sub of allOf) {
      const norm = normalizeSchema(sub, root, depth + 1);
      if (!norm || typeof norm !== "object") { continue; }
      for (const [k, v] of Object.entries(norm)) {
        if (k === "properties" && merged.properties && typeof v === "object") {
          merged.properties = { ...merged.properties, ...v };
        } else if (k === "required" && merged.required) {
          merged.required = [...new Set([...merged.required, ...v])];
        } else if (!(k in merged)) {
          merged[k] = v;
        }
      }
    }
    return normalizeSchema(merged, root, depth + 1);
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    switch (key) {
      case "properties":
        out.properties = Object.fromEntries(
          Object.entries(value || {}).map(([pk, pv]) => [pk, normalizeSchema(pv, root, depth + 1)]),
        );
        break;
      case "items":
        out.items = normalizeSchema(value, root, depth + 1);
        break;
      case "anyOf":
      case "oneOf":
        out.anyOf = (Array.isArray(value) ? value : [value])
          .map(s => normalizeSchema(s, root, depth + 1));
        break;
      case "enum":
        out.enum = value.map(e => (typeof e === "string" ? e : JSON.stringify(e)));
        break;
      case "type":
        if (Array.isArray(value)) {
          const primary = value.find(t => t !== "null");
          out.type = primary || "string";
          if (value.includes("null")) { out.nullable = true; }
        } else if (value === "null") {
          out.type = "string";
          out.nullable = true;
        } else {
          out.type = value;
        }
        break;
      default:
        if (SCHEMA_KEYS.has(key)) { out[key] = value; }
        // else: additionalProperties / $schema / exclusiveMinimum / ... —
        // not representable in Google's schema subset, dropped deliberately.
    }
  }
  return out;
};

// OpenAI tools → Gemini function declarations.
//   [{type:"function", function:{name, description, parameters}}]
//     → [{functionDeclarations:[{name, description, parameters}]}]
// parameters is JSON Schema on both sides and passes through unchanged.
// tool_choice ("auto"|"none"|"required"|{function:{name}}) maps onto
// toolConfig.functionCallingConfig (AUTO|NONE|ANY + allowedFunctionNames).
const transformTools = (req) => {
  if (!Array.isArray(req.tools)) { return {}; }
  const functionDeclarations = [];
  for (const t of req.tools) {
    const fn = t?.type === "function" ? t.function
      : (t && typeof t.name === "string") ? t  // tolerate raw declarations
      : null;
    if (!fn || typeof fn.name !== "string") { continue; }
    functionDeclarations.push({
      name: fn.name,
      ...(fn.description && { description: fn.description }),
      ...(fn.parameters && { parameters: normalizeSchema(fn.parameters, fn.parameters) }),
    });
  }
  if (!functionDeclarations.length) { return {}; }
  const out = { tools: [{ functionDeclarations }] };
  const tc = req.tool_choice;
  if (tc === "auto" || tc === undefined || tc === null) {
    // explicit AUTO (also the Gemini default) for determinism
    out.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  } else if (tc === "none") {
    out.toolConfig = { functionCallingConfig: { mode: "NONE" } };
  } else if (tc === "required") {
    out.toolConfig = { functionCallingConfig: { mode: "ANY" } };
  } else if (tc && typeof tc === "object" && tc.function?.name) {
    out.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tc.function.name] } };
  }
  return out;
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  ...transformTools(req),
  safetySettings,
  generationConfig: transformConfig(req),
});

const randomId = (length) => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return Array.from({ length }, randomChar).join("");
};
const generateChatcmplId = () => "chatcmpl-" + randomId(29);

const reasonsMap = { //https://ai.google.dev/api/rest/v1/GenerateContentResponse#finishreason
  //"FINISH_REASON_UNSPECIFIED": // Default value. This value is unused.
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
  // The model attempted a function call that did not validate — surfaced
  // (mainly) when tools were dropped from the request by older proxies.
  // OpenAI clients see a clean finish instead of an empty turn.
  "MALFORMED_FUNCTION_CALL": "stop",
  //"OTHER": "OTHER",
  // :"function_call",
};
// Gemini 3.x "thinking" models may return several kinds of parts:
//   {text, thought: true}          — chain-of-thought, must not pollute content
//   {text}                         — the actual answer
//   {functionCall}                 — tool invocation → OpenAI tool_calls
//   {thoughtSignature}, ...        — parts with no text at all
// The old implementation joined every part's .text (stringifying missing
// fields as "undefined") with a "\n\n|>" separator. Now thought text goes to
// a separate DeepSeek-style reasoning_content field (widely understood by
// OpenAI-compatible clients); function calls become tool_calls; answer parts
// concatenate seamlessly and remaining text-less parts are skipped.
const extractParts = (cand) => {
  let content = "";
  let reasoning = "";
  const toolCalls = [];
  for (const part of cand.content?.parts || []) {
    if (part?.functionCall) {
      toolCalls.push({
        id: "call_" + randomId(24),
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
        // Gemini 3.x attaches a thoughtSignature to functionCall parts which
        // MUST be replayed back on the next turn, or Google rejects the
        // request with 400 "Function call is missing a thought_signature".
        // The OpenAI schema has no such field — carrying it as an extension
        // on the tool_call lets spec-tolerant clients (which echo unknown
        // fields back in history) round-trip it transparently.
        ...(part.thoughtSignature && { thought_signature: part.thoughtSignature }),
      });
      continue;
    }
    if (typeof part?.text !== "string") { continue; }
    if (part.thought) { reasoning += part.text; } else { content += part.text; }
  }
  return { content, reasoning, toolCalls };
};
const transformCandidates = (key, cand) => {
  const { content, reasoning, toolCalls } = extractParts(cand);
  return {
    index: cand.index || 0, // 0-index is absent in new -002 models response
    [key]: {
      role: "assistant",
      // OpenAI contract: content is null when the turn is tool_calls-only.
      content: toolCalls.length ? (content || null) : content,
      ...(reasoning && { reasoning_content: reasoning }),
      ...(toolCalls.length && { tool_calls: toolCalls }),
    },
    logprobs: null,
    finish_reason: toolCalls.length ? "tool_calls" : reasonsMap[cand.finishReason] || cand.finishReason,
  };
};
const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");

const transformUsage = (data) => {
  const { candidatesTokenCount, promptTokenCount, totalTokenCount } = data || {};
  return {
    completion_tokens: candidatesTokenCount,
    prompt_tokens: promptTokenCount,
    total_tokens: totalTokenCount
  };
};

const processCompletionsResponse = (data, model, id) => {
  if (!Array.isArray(data.candidates) || data.candidates.length === 0) {
    // Blocked/empty upstream answer (e.g. safety promptFeedback) — surface
    // the actual reason instead of crashing on .map(undefined).
    throw new HttpError(
      `Gemini returned no candidates: ${JSON.stringify(data.promptFeedback ?? data)}`,
      502,
    );
  }
  return JSON.stringify({
    id,
    choices: data.candidates.map(transformCandidatesMessage),
    created: Math.floor(Date.now()/1000),
    model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion",
    usage: transformUsage(data.usageMetadata),
  });
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
async function parseStream (chunk, controller) {
  chunk = await chunk;
  if (!chunk) { return; }
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true); // eslint-disable-line no-constant-condition
}
async function parseStreamFlush (controller) {
  if (this.buffer) {
    console.error("Invalid data:", this.buffer);
    controller.enqueue(this.buffer);
  }
}

function transformResponseStream (data, stop, first) {
  const item = transformCandidatesDelta(data.candidates[0]);
  if (stop) { item.delta = {}; } else { item.finish_reason = null; }
  if (first) {
    // The "first" chunk only announces the role; the same data is emitted
    // again as a regular chunk right after, which carries the content — so
    // neutralize both fields here or they would be duplicated.
    item.delta.content = "";
    delete item.delta.reasoning_content;
    delete item.delta.tool_calls;
  } else { delete item.delta.role; }
  const output = {
    id: this.id,
    choices: [item],
    created: Math.floor(Date.now()/1000),
    model: this.model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion.chunk",
  };
  if (data.usageMetadata && this.streamIncludeUsage) {
    output.usage = stop ? transformUsage(data.usageMetadata) : null;
  }
  return "data: " + JSON.stringify(output) + delimiter;
}
const delimiter = "\n\n";
async function toOpenAiStream (chunk, controller) {
  const transform = transformResponseStream.bind(this);
  const line = await chunk;
  if (!line) { return; }
  let data;
  try {
    data = JSON.parse(line);
  } catch (err) {
    console.error(line);
    console.error(err);
    const length = this.last.length || 1; // at least 1 error msg
    const candidates = Array.from({ length }, (_, index) => ({
      finishReason: "error",
      content: { parts: [{ text: err }] },
      index,
    }));
    data = { candidates };
  }
  const cand = data.candidates[0];
  console.assert(data.candidates.length === 1, "Unexpected candidates count: %d", data.candidates.length);
  cand.index = cand.index || 0; // absent in new -002 models response
  if (!this.last[cand.index]) {
    controller.enqueue(transform(data, false, "first"));
  }
  this.last[cand.index] = data;
  if (cand.content) { // prevent empty data (e.g. when MAX_TOKENS)
    controller.enqueue(transform(data));
  }
}
async function toOpenAiStreamFlush (controller) {
  const transform = transformResponseStream.bind(this);
  if (this.last.length > 0) {
    for (const data of this.last) {
      controller.enqueue(transform(data, "stop"));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}