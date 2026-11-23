import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_MODELS_JSON = path.join(
  os.homedir(),
  ".deepai-code",
  "userdata",
  "deepai",
  "pi",
  "deepai",
  "models.json",
);

/**
 * DeepAI Code writes its pi provider config here. The model list holds the
 * catalogue the local transport accepts (premier flag + theos cost included).
 */
export function loadCatalog(modelsPath = process.env.DEEPAI_MODELS_JSON || DEFAULT_MODELS_JSON) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read DeepAI model catalogue at ${modelsPath}: ${error.message}`);
  }
  const provider =
    raw?.providers?.deepai ?? Object.values(raw?.providers ?? {})[0] ?? null;
  if (!provider || !Array.isArray(provider.models)) {
    throw new Error(`No DeepAI models found in ${modelsPath}`);
  }
  const models = provider.models.map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    reasoning: Boolean(model.reasoning),
    input: Array.isArray(model.input) ? model.input : ["text"],
    contextWindow: Number(model.contextWindow ?? 0) || null,
    maxTokens: Number(model.maxTokens ?? 0) || null,
    premier: Boolean(model.premier),
    theosPerRequest: Number(model.theosPerRequest ?? 0) || 0,
    api: model.api ?? "openai-completions",
    thinkingLevelMap: model.thinkingLevelMap ?? null,
  }));
  return {
    modelsPath,
    baseUrl: provider.baseUrl,
    upstreamPath: "/chat/completions",
    models,
    byId: new Map(models.map((model) => [model.id, model])),
  };
}

/** Accepts "glm-5.3-flash", "deepai/glm-5.3-flash" and "deepai:glm-5.3-flash". */
export function normalizeModelId(id) {
  if (typeof id !== "string") return id;
  return id.replace(/^deepai[/:]/, "").trim();
}
