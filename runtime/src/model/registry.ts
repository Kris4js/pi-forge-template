import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentManifest, ThinkingLevel } from "../agents/manifest.ts";

const CUSTOM_PROVIDER = "custom";
const CUSTOM_PROTOCOLS = new Set(["openai-completions", "anthropic-messages"]);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export type ModelDefaults = { provider: string; modelId: string; thinkingLevel?: ThinkingLevel };

/**
 * Process-wide pi auth + model registry, configured once from env (PI_MODEL_*). A model must be
 * configured: either a custom OpenAI/Anthropic-compatible endpoint (PI_MODEL_BASE_URL) or a pi
 * built-in provider (PI_MODEL_PROVIDER), always with PI_MODEL_ID. Built-in providers pick up their
 * usual env keys through pi's AuthStorage.
 */
export class Models {
  readonly authStorage = AuthStorage.inMemory();
  readonly registry = ModelRegistry.inMemory(this.authStorage);
  readonly defaults: ModelDefaults;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const provider = read(env.PI_MODEL_PROVIDER)?.toLowerCase();
    const baseUrl = read(env.PI_MODEL_BASE_URL);
    const modelId = read(env.PI_MODEL_ID);
    const apiKey = read(env.PI_MODEL_API_KEY);
    const level = read(env.PI_MODEL_THINKING_LEVEL) as ThinkingLevel | undefined;
    const thinkingLevel = level && THINKING_LEVELS.has(level) ? level : undefined;

    if (!modelId || (!provider && !baseUrl)) {
      throw new Error(
        "no model configured: set PI_MODEL_ID plus either PI_MODEL_BASE_URL (custom endpoint) or PI_MODEL_PROVIDER (pi built-in provider) in .env",
      );
    }

    if (baseUrl || provider === CUSTOM_PROVIDER) {
      if (!baseUrl) throw new Error("PI_MODEL_PROVIDER=custom requires PI_MODEL_BASE_URL");
      const protocol = read(env.PI_MODEL_PROTOCOL) ?? "openai-completions";
      if (!CUSTOM_PROTOCOLS.has(protocol)) throw new Error(`unsupported PI_MODEL_PROTOCOL: ${protocol}`);
      this.registry.registerProvider(CUSTOM_PROVIDER, {
        baseUrl,
        apiKey: "PI_MODEL_API_KEY",
        api: protocol as Api,
        models: [
          {
            id: modelId,
            name: modelId,
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: Number(env.PI_MODEL_CONTEXT_WINDOW ?? 262144),
            maxTokens: Number(env.PI_MODEL_MAX_TOKENS ?? 32768),
          },
        ],
      });
      if (apiKey) this.authStorage.setRuntimeApiKey(CUSTOM_PROVIDER, apiKey);
      this.defaults = { provider: CUSTOM_PROVIDER, modelId, thinkingLevel };
      return;
    }

    if (!this.registry.find(provider!, modelId)) throw new Error(`model not found: ${provider}/${modelId}`);
    if (apiKey) this.authStorage.setRuntimeApiKey(provider!, apiKey);
    this.defaults = { provider: provider!, modelId, thinkingLevel };
  }

  /** Display name: built-in models keep their provider prefix; custom endpoints show the bare id. */
  static label(model: Pick<Model<any>, "provider" | "id">): string {
    return model.provider === CUSTOM_PROVIDER ? model.id : `${model.provider}/${model.id}`;
  }

  describeDefault(): string {
    return Models.label({ provider: this.defaults.provider, id: this.defaults.modelId });
  }

  /** Agent-level model overrides win over env defaults. */
  resolve(manifest: AgentManifest): { model: Model<any>; thinkingLevel?: ThinkingLevel } {
    const provider = manifest.model?.provider ?? this.defaults.provider;
    const modelId = manifest.model?.id ?? (manifest.model?.provider ? undefined : this.defaults.modelId);
    const thinkingLevel = manifest.model?.thinkingLevel ?? this.defaults.thinkingLevel;
    if (!modelId) throw new Error(`agent ${manifest.id}: model.id is required when model.provider is set`);
    const model = this.registry.find(provider, modelId);
    if (!model) throw new Error(`model not found: ${provider}/${modelId}`);
    return { model, thinkingLevel };
  }
}

function read(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
