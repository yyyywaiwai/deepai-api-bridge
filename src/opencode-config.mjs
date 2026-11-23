#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCatalog } from "./catalog.mjs";

const OPENCODE_CONFIG = path.join(os.homedir(), ".config", "opencode", "opencode.json");

function buildProvider(baseUrl) {
  const catalog = loadCatalog();
  const models = {};
  for (const model of catalog.models) {
    models[model.id] = {
      name: model.premier ? `${model.name} · premier ${model.theosPerRequest} theos` : model.name,
      reasoning: model.reasoning,
      attachment: model.input.includes("image"),
      modalities: { input: model.input, output: ["text"] },
      limit: {
        context: model.contextWindow ?? 200000,
        output: model.maxTokens ?? 32000,
      },
    };
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "DeepAI Code (local bridge)",
    options: {
      baseURL: `${baseUrl}/v1`,
      apiKey: "deepai-local-bridge",
    },
    models,
  };
}

const args = process.argv.slice(2);
const baseUrl = (() => {
  const index = args.indexOf("--base-url");
  return index === -1 ? "http://127.0.0.1:8787" : args[index + 1];
})();

const provider = buildProvider(baseUrl);

if (args.includes("--install")) {
  let existing = {};
  if (fs.existsSync(OPENCODE_CONFIG)) {
    const raw = fs.readFileSync(OPENCODE_CONFIG, "utf8");
    existing = JSON.parse(raw);
    const backup = `${OPENCODE_CONFIG}.bak-deepaibridge-${new Date()
      .toISOString()
      .replace(/[:.]/g, "")
      .slice(0, 15)}`;
    fs.writeFileSync(backup, raw, { mode: 0o600 });
    console.log(`[opencode-config] backup written to ${backup}`);
  } else {
    existing = { $schema: "https://opencode.ai/config.json" };
    fs.mkdirSync(path.dirname(OPENCODE_CONFIG), { recursive: true });
  }
  existing.provider = { ...(existing.provider ?? {}), deepai: provider };
  fs.writeFileSync(OPENCODE_CONFIG, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  console.log(`[opencode-config] provider "deepai" installed into ${OPENCODE_CONFIG}`);
  console.log(`[opencode-config] ${Object.keys(provider.models).length} models available`);
  console.log(`[opencode-config] try: opencode run -m deepai/glm-5.3-flash "hi"`);
} else {
  console.log(JSON.stringify({ provider: { deepai: provider } }, null, 2));
}
