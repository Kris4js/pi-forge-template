import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { UserAskResult } from "../protocol.ts";

export const ASK_USER = "ask_user";

/** Puts the question to the user through the gateway and resolves with their answer. */
export type AskUser = (
  toolCallId: string,
  question: string,
  options: string[],
  signal?: AbortSignal,
) => Promise<UserAskResult>;

/**
 * ask_user: a multiple-choice question for the user. A default tool of every agent (DEFAULT_TOOLS);
 * its usage rules live in the description because agents use custom system prompts. The tool call stays open while the gateway
 * waits for the answer (up to its question timeout, 24h by default); the answer becomes the tool
 * result and the agent carries on in the same run.
 */
export function askUserTool(ask: AskUser) {
  return defineTool({
    name: ASK_USER,
    label: "Ask the user",
    description:
      "Ask the user a multiple-choice question and wait for the answer. Use it only when the next step " +
      "genuinely depends on the user's preference or missing information you cannot find yourself (e.g. several " +
      "reasonable ways to proceed, an ambiguous request, a choice with cost or side effects); otherwise just " +
      "proceed. Write one or two sentences of context before the call. Give 2-6 short, mutually exclusive " +
      "options in the user's language and mark the one you recommend with （推荐）. Call it on its own, not " +
      "alongside other tools. The result is the user's choice or their own words, or tells you they skipped or " +
      "did not answer in time; then continue with your recommendation and say which you chose.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 120, description: "One short question, e.g. 接下来你想怎么处理？" }),
      options: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), {
        minItems: 2,
        maxItems: 6,
        description: "Short choices shown as a numbered list",
      }),
    }),
    // Questions are put to the user one at a time.
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const question = params.question.trim();
      const options = params.options.map((option) => option.trim()).filter(Boolean);
      if (!question || options.length < 2) throw new Error("ask_user needs a question and at least 2 options");
      const result = await ask(toolCallId, question, options, signal);
      const text =
        result.status === "answered"
          ? `用户的回答：${result.answer}`
          : result.status === "skipped"
            ? "用户跳过了这个问题，请按你推荐的方式继续。"
            : result.status === "expired"
              ? "用户在时限内没有回答，请按你推荐的方式继续，并在回复中说明你的选择。"
              : "问题已取消。";
      return { content: [{ type: "text" as const, text }], details: { question, options, ...result } };
    },
  });
}
