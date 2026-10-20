import { BarChart3, LifeBuoy, MessageCircle, Sparkles } from "lucide-react";
import { providerIcons } from "../../shared/provider";

/** The assistant's mark (Claude icon from web/shared). Breathes while the agent is working. */
export function ClaudeMark({ size = 20, live = false }: { size?: number; live?: boolean }) {
  return (
    <img
      src={providerIcons.claude}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className={`claude-mark ${live ? "live" : ""}`}
      draggable={false}
    />
  );
}

// Most specific first: e.g. "workbuddy-ai/deepseek-v4.1-flash" is a DeepSeek model.
const PROVIDER_PATTERNS: Array<[RegExp, keyof typeof providerIcons]> = [
  [/deepseek/i, "deepseek"],
  [/claude|anthropic|sonnet|opus|haiku/i, "claude"],
  [/gemini|gemma/i, "gemini"],
  [/qwen|qwq/i, "qwen"],
  [/grok|xai/i, "grok"],
  [/minimax|abab/i, "minimax"],
  [/doubao|bytedance|seed/i, "bytedance"],
  [/gpt|openai|o[1-9]-|codex/i, "openai"],
  [/openrouter/i, "openrouter"],
];

export function providerIconFor(model?: string): string | undefined {
  if (!model) return undefined;
  const hit = PROVIDER_PATTERNS.find(([pattern]) => pattern.test(model));
  return hit ? providerIcons[hit[1]] : undefined;
}

export function ProviderIcon({ model, size = 14 }: { model?: string; size?: number }) {
  const src = providerIconFor(model);
  if (!src) return null;
  return <img src={src} width={size} height={size} alt="" aria-hidden="true" className="provider-icon" draggable={false} />;
}

const AGENT_ICONS: Record<string, JSX.Element> = {
  assistant: <MessageCircle />,
  "support-desk": <LifeBuoy />,
  "data-analyst": <BarChart3 />,
};

export function agentIcon(id: string, size = 14) {
  return (
    <span className="agent-icon" style={{ width: size, height: size }}>
      {AGENT_ICONS[id] ?? <Sparkles />}
    </span>
  );
}
