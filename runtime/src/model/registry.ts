import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentManifest, ThinkingLevel } from "../agents/manifest.ts";
import { RpcError } from "../ipc/peer.ts";
import { ErrorCodes, type ModelChoice, type ModelsResult } from "../protocol.ts";

const CUSTOM_PROVIDER = "custom";
const CUSTOM_PROTOCOLS = new Set(["openai-completions", "anthropic-messages"]);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
/** The levels the console offers; pi clamps them to what each model supports. */
const OFFERED_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];
const DEFAULT_LEVEL: ThinkingLevel = "medium";

export type ModelDefaults = { provider: string; modelId: string; thinkingLevel?: ThinkingLevel };

/**
 * Process-wide pi auth + model registry, configured once from env. The console may pick any model
 * registered here (and nothing else):
 *   PI_MODEL_ID       the default model (required)
 *   PI_MODEL_IDS      more models on the same endpoint / provider, comma-separated (optional)
 *   PI_MODEL_BASE_URL a custom OpenAI/Anthropic-compatible endpoint, or
 *   PI_MODEL_PROVIDER a pi built-in provider (keys from its usual env vars)
 */
export class Models {
  readonly authStorage = AuthStorage.inMemory();
  readonly registry = ModelRegistry.inMemory(this.authStorage);
  readonly defaults: ModelDefaults;
  /** Allowed models, by key "<provider>/<id>". */
  private readonly allowed = new Map<string, Model<any>>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const provider = read(env.PI_MODEL_PROVIDER)?.toLowerCase();
    const baseUrl = read(env.PI_MODEL_BASE_URL);
    const modelId = read(env.PI_MODEL_ID);
    const extraIds = (read(env.PI_MODEL_IDS) ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const modelIds = [...new Set([modelId, ...extraIds].filter((id): id is string => !!id))];
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
        models: modelIds.map((id) => ({
          id,
          name: id,
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: Number(env.PI_MODEL_CONTEXT_WINDOW ?? 262144),
          maxTokens: Number(env.PI_MODEL_MAX_TOKENS ?? 32768),
        })),
      });
      if (apiKey) this.authStorage.setRuntimeApiKey(CUSTOM_PROVIDER, apiKey);
      this.defaults = { provider: CUSTOM_PROVIDER, modelId, thinkingLevel };
    } else {
      if (apiKey) this.authStorage.setRuntimeApiKey(provider!, apiKey);
      this.defaults = { provider: provider!, modelId, thinkingLevel };
    }

    for (const id of modelIds) {
      const model = this.registry.find(this.defaults.provider, id);
      if (!model) throw new Error(`model not found: ${this.defaults.provider}/${id}`);
      this.allowed.set(Models.key(model), model);
    }
  }

  static key(model: Pick<Model<any>, "provider" | "id">): string {
    return `${model.provider}/${model.id}`;
  }

  /** Display name: built-in models keep their provider prefix; custom endpoints show the bare id. */
  static label(model: Pick<Model<any>, "provider" | "id">): string {
    return model.provider === CUSTOM_PROVIDER ? model.id : `${model.provider}/${model.id}`;
  }

  describeDefault(): string {
    return Models.label({ provider: this.defaults.provider, id: this.defaults.modelId });
  }

  /** What the console's model selector offers. */
  list(): ModelsResult {
    const models: ModelChoice[] = [...this.allowed.values()].map((model) => {
      // Gateway-style ids ("vendor/model") group by vendor; built-in models group by provider.
      const slash = model.id.indexOf("/");
      const custom = model.provider === CUSTOM_PROVIDER;
      return {
        key: Models.key(model),
        label: Models.label(model),
        group: custom ? (slash > 0 ? model.id.slice(0, slash) : "Custom") : model.provider,
        name: custom && slash > 0 ? model.id.slice(slash + 1) : model.name || model.id,
        reasoning: Boolean(model.reasoning),
      };
    });
    return {
      models,
      defaultModel: Models.key({ provider: this.defaults.provider, id: this.defaults.modelId }),
      thinkingLevels: OFFERED_LEVELS,
      defaultThinkingLevel: this.defaults.thinkingLevel ?? DEFAULT_LEVEL,
    };
  }

  /**
   * The model for a run: the console's choice if it names an allowed model, otherwise the agent's
   * own model, otherwise the env default. Choices outside the registered list are refused.
   */
  resolve(
    manifest: AgentManifest,
    choice: { model?: unknown; thinkingLevel?: unknown } = {},
  ): { model: Model<any>; thinkingLevel?: ThinkingLevel } {
    let thinkingLevel = manifest.model?.thinkingLevel ?? this.defaults.thinkingLevel;
    if (choice.thinkingLevel !== undefined) {
      if (typeof choice.thinkingLevel !== "string" || !THINKING_LEVELS.has(choice.thinkingLevel as ThinkingLevel)) {
        throw new RpcError(ErrorCodes.invalidParams, "invalid thinkingLevel");
      }
      thinkingLevel = choice.thinkingLevel as ThinkingLevel;
    }
    if (choice.model !== undefined) {
      const model = typeof choice.model === "string" ? this.allowed.get(choice.model) : undefined;
      if (!model) throw new RpcError(ErrorCodes.invalidParams, `model not available: ${String(choice.model)}`);
      return { model, thinkingLevel };
    }
    const provider = manifest.model?.provider ?? this.defaults.provider;
    const modelId = manifest.model?.id ?? (manifest.model?.provider ? undefined : this.defaults.modelId);
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
