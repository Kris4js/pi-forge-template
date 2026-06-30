export const THINKING_LEVELS = new Set(["off", "low", "medium", "high", "xhigh"] as const);

export const PROVIDER_API_KEY_ENV_MAP = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;

export const CUSTOM_PROVIDER_ID = "custom";

export const CUSTOM_PROTOCOLS = new Set(["openai-completions", "anthropic-messages"] as const);

export const DEFAULT_CUSTOM_PROTOCOL = "openai-completions";
export const DEFAULT_OPENAI_COMPAT_CONTEXT_WINDOW = 262144;
export const DEFAULT_OPENAI_COMPAT_MAX_TOKENS = 32768;

export type ThinkingLevel = typeof THINKING_LEVELS extends Set<infer T> ? T : never;
export type CustomProtocol = typeof CUSTOM_PROTOCOLS extends Set<infer T> ? T : never;
