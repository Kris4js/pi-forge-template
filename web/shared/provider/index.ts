import bytedance from "./bytedance-color.svg";
import claude from "./claude-color.svg";
import deepseek from "./deepseek-color.svg";
import gemini from "./gemini-color.svg";
import grok from "./grok.svg";
import minimax from "./minimax-color.svg";
import openai from "./openai.svg";
import openrouter from "./openrouter.svg";
import qwen from "./qwen-color.svg";

/** 跨前端复用的模型供应商图标 URL。 */
export const providerIcons = {
  anthropic: claude,
  bytedance,
  claude,
  deepseek,
  gemini,
  grok,
  minimax,
  openai,
  openrouter,
  qwen,
} as const;
