#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadCatalog, normalizeModelId } from "./src/catalog.mjs";
import { CONFIG_DIR, resolveToken, storeToken } from "./src/token.mjs";

const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  upstream: "http://127.0.0.1:55587",
  defaultSystemPrompt: "You are a helpful assistant.",
  rewriteModel: true,
  allowPremier: true,
  verbose: false,
  apiKeys: [],
};

function loadConfig() {
  const config = { ...DEFAULTS };
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
  } catch {
    /* no config file yet */
  }
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--port") config.port = Number(next());
    else if (arg === "--host") config.host = next();
    else if (arg === "--upstream") config.upstream = next();
    else if (arg === "--token") {
      storeToken(next());
      console.log("[bridge] token stored in", path.join(CONFIG_DIR, "token.json"));
      process.exit(0);
    } else if (arg === "--verbose") config.verbose = true;
  }
  return config;
}

const config = loadConfig();
const catalog = loadCatalog();
let tokenState = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function debug(...args) {
  if (config.verbose) log(...args);
}

function token() {
  if (!tokenState) tokenState = resolveToken();
  return tokenState;
}

function refreshToken() {
  tokenState = resolveToken({ refresh: true });
  return tokenState;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, type = "invalid_request_error", code = undefined) {
  sendJson(res, status, { error: { message, type, code: code ?? type } });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(new Error(`Invalid JSON body: ${error.message}`), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function authorized(req) {
  if (!Array.isArray(config.apiKeys) || config.apiKeys.length === 0) return true;
  const header = req.headers.authorization ?? "";
  const key = header.replace(/^Bearer\s+/i, "").trim() || req.headers["x-api-key"];
  return config.apiKeys.includes(key);
}

// ---------------------------------------------------------------- normalising

function normalizeContentPart(part) {
  if (!part || typeof part !== "object") return part;
  if (part.type === "image_url" && typeof part.image_url === "string") {
    return { ...part, image_url: { url: part.image_url } };
  }
  if (part.type === "text" && typeof part.text !== "string") {
    return { ...part, text: String(part.text ?? "") };
  }
  return part;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    const out = { ...message };
    if (Array.isArray(out.content)) out.content = out.content.map(normalizeContentPart);
    if (out.content === undefined || out.content === null) {
      out.content = Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? "" : "";
    }
    return out;
  });
}

/**
 * The local transport rejects requests whose first message is not a system
 * (or developer) message, and rejects empty message arrays. Mirror that here so
 * callers get a normal OpenAI-shaped error instead of a cryptic 400.
 */
function normalizeChatBody(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw Object.assign(new Error("'messages' must be a non-empty array."), { status: 400 });
  }
  const out = { ...body };
  out.model = normalizeModelId(body.model);
  out.messages = normalizeMessages(body.messages);
  const first = out.messages[0];
  if (!first || (first.role !== "system" && first.role !== "developer")) {
    out.messages.unshift({ role: "system", content: config.defaultSystemPrompt });
  }
  // Always send an explicit boolean: the transport defaults to SSE and callers
  // that omit `stream` still expect a single JSON response.
  out.stream = body.stream === true;
  if (!out.stream) {
    delete out.stream_options;
  }
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

function theosFor(model) {
  const entry = catalog.byId.get(model);
  return entry ? { premier: entry.premier, theos: entry.theosPerRequest } : { premier: false, theos: 0 };
}

// ------------------------------------------------------------------- upstream

async function callUpstream(body, { retryOnAuthError = true } = {}) {
  const { token: bearer, source } = token();
  const url = `${config.upstream}${catalog.upstreamPath}`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        "user-agent": "deepai-api-bridge/1.0",
        accept: body.stream === true ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw Object.assign(
      new Error(`DeepAI Code transport unreachable at ${config.upstream}: ${error.message}`),
      { status: 502 },
    );
  }

  if (response.status === 403 && retryOnAuthError) {
    debug("upstream 403 with token from", source, "- refreshing token");
    refreshToken();
    return callUpstream(body, { retryOnAuthError: false });
  }
  return response;
}

function modelRewriteTransform(modelId) {
  let buffer = "";
  return new Transform({
    transform(chunk, _enc, done) {
      if (!config.rewriteModel) {
        buffer = "";
        done(null, chunk);
        return;
      }
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      const out = [];
      while (index !== -1) {
        const line = buffer.slice(0, index + 1);
        buffer = buffer.slice(index + 1);
        out.push(rewriteSseLine(line, modelId));
        index = buffer.indexOf("\n");
      }
      done(null, out.join(""));
    },
    flush(done) {
      done(null, buffer ? rewriteSseLine(buffer, modelId) : undefined);
    },
  });
}

function rewriteSseLine(line, modelId) {
  const trailing = line.match(/\n*$/)?.[0] ?? "";
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:") || trimmed === "data: [DONE]") return line;
  const json = trimmed.slice(5).trim();
  if (!json.startsWith("{")) return line;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && "model" in parsed) {
      parsed.model = modelId;
      return `data: ${JSON.stringify(parsed)}${trailing}`;
    }
  } catch {
    /* not JSON, pass through */
  }
  return line;
}

async function pipeUpstream(response, res, requestedModel) {
  const { premier, theos } = theosFor(requestedModel);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-deepai-model": requestedModel,
    "x-deepai-premier": String(premier),
    "x-deepai-theos-per-request": String(theos),
  });
  try {
    await pipeline(Readable.fromWeb(response.body), modelRewriteTransform(requestedModel), res);
  } catch (error) {
    debug("stream aborted:", error.message);
  }
}

async function completionResponse(response, res, requestedModel) {
  const text = await response.text();
  const { premier, theos } = theosFor(requestedModel);
  res.setHeader("x-deepai-model", requestedModel);
  res.setHeader("x-deepai-premier", String(premier));
  res.setHeader("x-deepai-theos-per-request", String(theos));
  if (!response.ok) {
    res.writeHead(response.status, { "content-type": "application/json; charset=utf-8" });
    res.end(text);
    return;
  }
  try {
    const parsed = JSON.parse(text);
    if (config.rewriteModel && parsed && typeof parsed === "object" && "model" in parsed) {
      parsed.model = requestedModel;
    }
    sendJson(res, 200, parsed);
  } catch {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(text);
  }
}

// -------------------------------------------------------------------- routing

function modelPayload(model) {
  return {
    id: model.id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "deepai",
    name: model.name,
    context_window: model.contextWindow,
    max_output_tokens: model.maxTokens,
    capabilities: {
      reasoning: model.reasoning,
      vision: model.input.includes("image"),
      tools: true,
    },
    deepai: {
      premier: model.premier,
      theos_per_request: model.theosPerRequest,
      api: model.api,
    },
  };
}

async function handleChatCompletions(req, res) {
  const body = await readJson(req);
  const normalized = normalizeChatBody(body);
  const { premier, theos } = theosFor(normalized.model);
  if (premier && !config.allowPremier) {
    return sendError(res, 403, `Model '${normalized.model}' is premier and blocked by bridge config.`, "permission_error");
  }
  log(
    `chat.completions model=${normalized.model} stream=${normalized.stream === true} messages=${normalized.messages.length}` +
      (premier ? ` premier=true theos=${theos}` : ""),
  );
  const upstream = await callUpstream(normalized);
  if (normalized.stream === true && upstream.ok && upstream.body) {
    return pipeUpstream(upstream, res, normalized.model);
  }
  return completionResponse(upstream, res, normalized.model);
}

async function handleLegacyCompletions(req, res) {
  const body = await readJson(req);
  const prompt = Array.isArray(body.prompt) ? body.prompt.join("\n") : String(body.prompt ?? "");
  const translated = {
    ...body,
    messages: [
      { role: "system", content: config.defaultSystemPrompt },
      { role: "user", content: prompt },
    ],
  };
  delete translated.prompt;
  if (translated.max_tokens !== undefined && translated.max_completion_tokens === undefined) {
    translated.max_completion_tokens = translated.max_tokens;
  }
  const normalized = normalizeChatBody(translated);
  const upstream = await callUpstream(normalized);
  const text = await upstream.text();
  if (!upstream.ok) {
    res.writeHead(upstream.status, { "content-type": "application/json" });
    return res.end(text);
  }
  const parsed = JSON.parse(text);
  const choice = parsed.choices?.[0] ?? {};
  return sendJson(res, 200, {
    id: parsed.id ?? `cmpl-${Date.now()}`,
    object: "text_completion",
    created: parsed.created ?? Math.floor(Date.now() / 1000),
    model: normalized.model,
    choices: [
      {
        index: 0,
        text: choice.message?.content ?? "",
        logprobs: null,
        finish_reason: choice.finish_reason ?? "stop",
      },
    ],
    usage: parsed.usage,
  });
}

// --- /v1/responses --------------------------------------------------------
// DeepAI Code exposes a native /responses endpoint but only for models flagged
// api:"openai-responses" (currently gpt-6-astra). Everything else is translated
// onto the chat-completions transport, which keeps Codex-style clients working.

function responsesInputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id ?? item.id, content: String(item.output ?? "") });
      continue;
    }
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: item.call_id ?? item.id,
            type: "function",
            function: { name: item.name, arguments: item.arguments ?? "{}" },
          },
        ],
      });
      continue;
    }
    if (item.role) {
      const content = item.content;
      if (typeof content === "string") {
        messages.push({ role: item.role, content });
      } else if (Array.isArray(content)) {
        const parts = [];
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
            parts.push({ type: "text", text: part.text ?? "" });
          } else if (part.type === "input_image") {
            const url = part.image_url ?? part.url;
            if (url) parts.push({ type: "image_url", image_url: { url } });
          }
        }
        messages.push({ role: item.role, content: parts.length > 0 ? parts : "" });
      } else {
        messages.push({ role: item.role, content: "" });
      }
    }
  }
  return messages;
}

function responsesToolsToChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools
    .filter((tool) => tool && tool.type === "function" && tool.name)
    .map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  return mapped.length > 0 ? mapped : undefined;
}

function buildChatFromResponses(body) {
  const messages = responsesInputToMessages(body.input ?? body.messages);
  if (typeof body.instructions === "string" && body.instructions.trim() !== "") {
    messages.unshift({ role: "system", content: body.instructions });
  }
  const chat = {
    model: body.model,
    messages,
    stream: body.stream === true,
  };
  if (body.max_output_tokens !== undefined) chat.max_completion_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = body.parallel_tool_calls;
  const tools = responsesToolsToChatTools(body.tools);
  if (tools) chat.tools = tools;
  if (body.reasoning?.effort) chat.reasoning_effort = body.reasoning.effort;
  return chat;
}

async function handleResponses(req, res) {
  const body = await readJson(req);
  const model = normalizeModelId(body.model);
  const entry = catalog.byId.get(model);

  // Native path for models served by /responses upstream.
  if (entry && entry.api === "openai-responses") {
    const upstream = await callUpstream(body);
    if (body.stream === true && upstream.ok && upstream.body) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
      await pipeline(Readable.fromWeb(upstream.body), res);
      return;
    }
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
    return res.end(text);
  }

  const chat = normalizeChatBody(buildChatFromResponses({ ...body, model }));
  log(`responses model=${chat.model} stream=${chat.stream === true} -> chat.completions`);
  const upstream = await callUpstream(chat);
  if (!upstream.ok) {
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
    return res.end(text);
  }
  if (chat.stream === true) return streamResponsesAsSse(upstream, res, chat.model);

  const payload = await upstream.json();
  const text = payload.choices?.[0]?.message?.content ?? "";
  const id = payload.id ?? `resp_${Date.now()}`;
  return sendJson(res, 200, {
    id,
    object: "response",
    created_at: payload.created ?? Math.floor(Date.now() / 1000),
    status: "completed",
    model: chat.model,
    output: [
      {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    output_text: text,
    usage: payload.usage && {
      input_tokens: payload.usage.prompt_tokens ?? 0,
      output_tokens: payload.usage.completion_tokens ?? 0,
      total_tokens: payload.usage.total_tokens ?? 0,
    },
  });
}

async function streamResponsesAsSse(upstream, res, modelId) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
  const responseId = `resp_${Date.now().toString(36)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;
  const emit = (type, payload) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
  };
  const base = { id: responseId, object: "response", created_at: createdAt, model: modelId };
  emit("response.created", { response: { ...base, status: "in_progress", output: [] } });
  const itemId = `msg_${responseId}`;
  emit("response.output_item.added", {
    output_index: 0,
    item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] },
  });
  emit("response.content_part.added", {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });

  let full = "";
  let buffer = "";
  const decoder = new ReadableStream({
    start(controller) {
      const reader = upstream.body.getReader();
      const pump = () =>
        reader.read().then(({ done, value }) => {
          if (done) return controller.close();
          controller.enqueue(value);
          return pump();
        });
      pump().catch((error) => controller.error(error));
    },
  });

  try {
    for await (const chunk of Readable.fromWeb(decoder)) {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.startsWith("data:") && line !== "data: [DONE]") {
          const json = line.slice(5).trim();
          if (json.startsWith("{")) {
            try {
              const parsed = JSON.parse(json);
              const delta = parsed.choices?.[0]?.delta ?? {};
              const piece = delta.content;
              if (typeof piece === "string" && piece.length > 0) {
                full += piece;
                emit("response.output_text.delta", {
                  item_id: itemId,
                  output_index: 0,
                  content_index: 0,
                  delta: piece,
                });
              }
            } catch {
              /* ignore malformed chunk */
            }
          }
        }
        index = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    debug("responses stream aborted:", error.message);
  }

  emit("response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text: full });
  emit("response.content_part.done", {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: full, annotations: [] },
  });
  emit("response.output_item.done", {
    output_index: 0,
    item: {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: full, annotations: [] }],
    },
  });
  emit("response.completed", {
    response: {
      ...base,
      status: "completed",
      output_text: full,
      output: [
        {
          id: itemId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: full, annotations: [] }],
        },
      ],
    },
  });
  res.end();
}

// ---------------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    return res.end();
  }

  if (pathname === "/healthz" || pathname === "/health") {
    let info;
    try {
      info = token();
    } catch (error) {
      return sendJson(res, 503, { ok: false, error: error.message });
    }
    return sendJson(res, 200, {
      ok: true,
      upstream: config.upstream,
      upstreamPath: catalog.upstreamPath,
      tokenSource: info.source,
      tokenSuffix: info.token.slice(-6),
      models: catalog.models.length,
      modelsJson: catalog.modelsPath,
    });
  }

  if (!authorized(req)) {
    return sendError(res, 401, "Invalid API key for this bridge.", "authentication_error");
  }

  try {
    if (req.method === "GET" && pathname === "/v1/models") {
      return sendJson(res, 200, { object: "list", data: catalog.models.map(modelPayload) });
    }
    if (req.method === "GET" && pathname.startsWith("/v1/models/")) {
      const id = normalizeModelId(decodeURIComponent(pathname.slice("/v1/models/".length)));
      const entry = catalog.byId.get(id);
      if (!entry) return sendError(res, 404, `Model '${id}' not found.`, "not_found_error");
      return sendJson(res, 200, modelPayload(entry));
    }
    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      return await handleChatCompletions(req, res);
    }
    if (req.method === "POST" && pathname === "/v1/completions") {
      return await handleLegacyCompletions(req, res);
    }
    if (req.method === "POST" && pathname === "/v1/responses") {
      return await handleResponses(req, res);
    }
    if (req.method === "POST" && pathname === "/v1/embeddings") {
      return sendError(res, 501, "DeepAI Code's transport does not expose embeddings.", "unsupported_error");
    }
    return sendError(res, 404, `Unknown route ${req.method} ${pathname}.`, "not_found_error");
  } catch (error) {
    const status = error.status ?? 500;
    log("error:", error.message);
    if (!res.headersSent) sendError(res, status, error.message, status === 400 ? "invalid_request_error" : "api_error");
    else res.end();
  }
});

server.listen(config.port, config.host, () => {
  log(`DeepAI bridge listening on http://${config.host}:${config.port}/v1`);
  log(`upstream ${config.upstream}${catalog.upstreamPath} (${catalog.models.length} models from ${catalog.modelsPath})`);
  try {
    const info = token();
    log(`transport token ready (${info.source}, …${info.token.slice(-6)})`);
  } catch (error) {
    log(`WARNING: ${error.message}`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
