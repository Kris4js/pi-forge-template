import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const);
const PROVIDER_API_KEY_ENV_MAP = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
} as const;
const CUSTOM_PROVIDER_ID = "custom";
const CUSTOM_PROTOCOLS = new Set([
  "openai-completions",
  "anthropic-messages",
] as const);
const DEFAULT_CUSTOM_PROTOCOL = "openai-completions";
const DEFAULT_OPENAI_COMPAT_CONTEXT_WINDOW = 262144;
const DEFAULT_OPENAI_COMPAT_MAX_TOKENS = 32768;

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type CustomProtocol = "openai-completions" | "anthropic-messages";

type RuntimeModelConfig = {
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  protocol?: CustomProtocol;
  baseUrl?: string;
  providerApiKeys: Partial<Record<string, string>>;
};

export type AgentRuntimeConfigOptions = {
  envFilePath?: string;
  watch?: boolean;
  debounceMs?: number;
};

export class AgentRuntimeConfig {
  private readonly envFilePath: string;
  private readonly watchEnabled: boolean;
  private readonly debounceMs: number;
  private watcher?: FSWatcher;
  private reloadTimer?: NodeJS.Timeout;
  private lastSignature = "";
  private current?: RuntimeModelConfig;
  private applying?: Promise<void>;

  constructor(options: AgentRuntimeConfigOptions = {}) {
    this.envFilePath = resolve(options.envFilePath ?? ".env");
    this.watchEnabled = options.watch ?? true;
    this.debounceMs = options.debounceMs ?? 150;
  }

  // 加载配置文件、合并环境变量
  async load(): Promise<RuntimeModelConfig> {
    const mergedEnv = {
      ...(await this.readEnvFile()),
      ...process.env,
    };

    const providerApiKeys = Object.fromEntries(
      Object.entries(PROVIDER_API_KEY_ENV_MAP)
        .map(([provider, envName]) => [
          provider,
          readEnvValue(mergedEnv[envName]),
        ])
        .filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
    );

    const rawProvider = readEnvValue(mergedEnv.MINIPI_MODEL_PROVIDER);
    const modelId = readEnvValue(mergedEnv.MINIPI_MODEL_ID);
    const thinkingLevel = normalizeThinkingLevel(
      readEnvValue(mergedEnv.MINIPI_MODEL_THINKING_LEVEL),
    );
    const genericApiKey = readEnvValue(mergedEnv.MINIPI_MODEL_API_KEY);
    const explicitBaseUrl = readEnvValue(mergedEnv.MINIPI_MODEL_BASE_URL);
    const protocol = normalizeProtocol(
      readEnvValue(mergedEnv.MINIPI_MODEL_PROTOCOL),
    );
    const legacyBaseUrl = isUrlLike(rawProvider) ? rawProvider : undefined;
    const baseUrl = explicitBaseUrl ?? legacyBaseUrl;
    const provider = baseUrl
      ? CUSTOM_PROVIDER_ID
      : normalizeProvider(rawProvider);
    if (provider && genericApiKey) {
      providerApiKeys[provider] = genericApiKey;
    } else if (baseUrl && providerApiKeys.openai) {
      providerApiKeys[CUSTOM_PROVIDER_ID] = providerApiKeys.openai;
    }

    const next: RuntimeModelConfig = {
      provider,
      modelId,
      thinkingLevel,
      protocol: baseUrl ? (protocol ?? DEFAULT_CUSTOM_PROTOCOL) : undefined,
      baseUrl,
      providerApiKeys,
    };

    this.current = next;
    this.lastSignature = JSON.stringify(next);
    return next;
  }

  getSnapshot(): RuntimeModelConfig | undefined {
    return this.current;
  }

  async applyToRuntime(runtime: AgentSessionRuntime): Promise<void> {
    const next = await this.load();
    const session = runtime.session;

    session.modelRegistry.unregisterProvider(CUSTOM_PROVIDER_ID);
    if (next.baseUrl && next.modelId) {
      session.modelRegistry.registerProvider(CUSTOM_PROVIDER_ID, {
        baseUrl: next.baseUrl,
        apiKey: "MINIPI_MODEL_API_KEY",
        api: next.protocol ?? DEFAULT_CUSTOM_PROTOCOL,
        models: [
          {
            id: next.modelId,
            name: `Custom / ${next.modelId}`,
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: DEFAULT_OPENAI_COMPAT_CONTEXT_WINDOW,
            maxTokens: DEFAULT_OPENAI_COMPAT_MAX_TOKENS,
          },
        ],
      });
    }

    for (const [provider, apiKey] of Object.entries(next.providerApiKeys)) {
      if (!apiKey) continue;
      session.modelRegistry.authStorage.setRuntimeApiKey(provider, apiKey);
    }

    if (next.provider && next.modelId) {
      const currentModel = session.model;
      const modelChanged =
        currentModel?.provider !== next.provider ||
        currentModel?.id !== next.modelId;
      if (modelChanged) {
        const model = session.modelRegistry.find(next.provider, next.modelId);
        if (!model)
          throw new Error(
            `Model not found from config: ${next.provider}/${next.modelId}`,
          );
        await session.setModel(model);
      }
    }

    if (next.thinkingLevel && session.thinkingLevel !== next.thinkingLevel) {
      session.setThinkingLevel(next.thinkingLevel);
    }
  }

  async reloadIfChanged(runtime?: AgentSessionRuntime): Promise<boolean> {
    const previous = this.lastSignature;
    const next = await this.load();
    const changed = JSON.stringify(next) !== previous;
    if (changed && runtime) {
      await this.applyToRuntime(runtime);
    }
    return changed;
  }

  async startWatching(
    onChange: (config: RuntimeModelConfig) => Promise<void> | void,
  ): Promise<void> {
    await this.load();
    if (!this.watchEnabled || this.watcher) return;

    const watchTarget = existsSync(this.envFilePath)
      ? this.envFilePath
      : resolve(this.envFilePath, "..");
    this.watcher = watch(watchTarget, () => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        void this.scheduleApply(onChange);
      }, this.debounceMs);
    });
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }

  private async scheduleApply(
    onChange: (config: RuntimeModelConfig) => Promise<void> | void,
  ): Promise<void> {
    this.applying = (this.applying ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const previous = this.lastSignature;
        const next = await this.load();
        if (JSON.stringify(next) === previous) return;
        await onChange(next);
      });

    await this.applying;
  }

  private async readEnvFile(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(this.envFilePath, "utf8");
      return parseDotEnv(raw);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return {};
      throw error;
    }
  }
}

function parseDotEnv(input: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const normalized = trimmed.startsWith("export ")
      ? trimmed.slice(7).trim()
      : trimmed;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    const rawValue = normalized.slice(separatorIndex + 1).trim();
    values[key] = stripQuotes(stripInlineComment(rawValue));
  }
  return values;
}

function stripInlineComment(value: string): string {
  if (!value.includes("#")) return value;
  let quotedBy: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quotedBy = quotedBy === char ? undefined : (quotedBy ?? char);
      continue;
    }
    if (
      char === "#" &&
      !quotedBy &&
      (index === 0 || /\s/.test(value[index - 1]!))
    ) {
      return value.slice(0, index).trim();
    }
  }
  return value;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeProvider(value: string | undefined): string | undefined {
  const normalized = readEnvValue(value);
  if (!normalized) return undefined;
  if (isUrlLike(normalized)) return undefined;
  return normalized.toLowerCase();
}

function normalizeProtocol(
  value: string | undefined,
): CustomProtocol | undefined {
  if (!value) return undefined;
  return CUSTOM_PROTOCOLS.has(value as CustomProtocol)
    ? (value as CustomProtocol)
    : undefined;
}

function isUrlLike(value: string | undefined): boolean {
  return !!value && /^https?:\/\//i.test(value);
}

function normalizeThinkingLevel(
  value: string | undefined,
): ThinkingLevel | undefined {
  if (!value) return undefined;
  return THINKING_LEVELS.has(value as ThinkingLevel)
    ? (value as ThinkingLevel)
    : undefined;
}
