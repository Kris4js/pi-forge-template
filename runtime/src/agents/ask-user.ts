import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AskQuestion, UserAskResult } from "../protocol.ts";

export const ASK_USER = "ask_user";

/** Puts the questions to the user through the gateway and resolves with their answers. */
export type AskUser = (toolCallId: string, questions: AskQuestion[], signal?: AbortSignal) => Promise<UserAskResult>;

const MAX_QUESTIONS = 4;

/**
 * ask_user: one to four multiple-choice questions for the user, shown together as tabs. A question
 * may allow several choices; the user can always add their own words or skip. A default tool of every
 * agent (DEFAULT_TOOLS); its usage rules live in the description because agents use custom system
 * prompts. The call stays open while the gateway waits for the answers (24h by default); they become
 * the tool result and the agent carries on in the same run.
 */
export function askUserTool(ask: AskUser) {
  return defineTool({
    name: ASK_USER,
    label: "Ask the user",
    description:
      "Ask the user and wait for the answers. Use it only when the next step genuinely depends on the user's " +
      "preference or on information you cannot find yourself (several reasonable ways to proceed, an ambiguous " +
      "request, a choice with cost or side effects); otherwise just proceed. Write one or two sentences of context " +
      "before the call. Ask everything you need in this one call: 1-4 questions, each shown as a tab with a short " +
      "header. Give each question 2-6 short options in the user's language and mark the one you recommend with " +
      "（推荐）. Options are mutually exclusive unless the question sets multiSelect, for choices that combine " +
      "(features, channels, sections). The user may also answer in their own words or skip. Call it on its own, " +
      "not alongside other tools. The result lists each answer, or tells you the user skipped or did not answer " +
      "in time; then continue with your recommendation and say which you chose.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          header: Type.String({ minLength: 1, maxLength: 12, description: "Tab label, 2-6 words, e.g. 风格 / 渠道" }),
          question: Type.String({ minLength: 1, maxLength: 120, description: "The question, e.g. 页面用哪种风格？" }),
          options: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), {
            minItems: 2,
            maxItems: 6,
            description: "Short choices shown as a numbered list",
          }),
          multiSelect: Type.Optional(Type.Boolean({ description: "Allow choosing several options (default false)" })),
        }),
        { minItems: 1, maxItems: MAX_QUESTIONS },
      ),
    }),
    // Questions are put to the user one call at a time.
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const questions: AskQuestion[] = params.questions.map((q, i) => {
        const options = [...new Set(q.options.map((o) => o.trim()).filter(Boolean))];
        const question = q.question.trim();
        if (!question || options.length < 2) throw new Error(`ask_user question ${i + 1} needs text and at least 2 distinct options`);
        return { header: q.header.trim() || `问题 ${i + 1}`, question, options, multiSelect: q.multiSelect === true };
      });
      const result = await ask(toolCallId, questions, signal);
      return { content: [{ type: "text" as const, text: describe(questions, result) }], details: { questions, ...result } };
    },
  });
}

/** The tool result the model reads: one line per question, or why there are no answers. */
function describe(questions: AskQuestion[], result: UserAskResult): string {
  if (result.status === "skipped") return "用户跳过了这些问题，请按你推荐的方式继续，并在回复中说明你的选择。";
  if (result.status === "expired") return "用户在时限内没有回答，请按你推荐的方式继续，并在回复中说明你的选择。";
  if (result.status !== "answered") return "问题已取消。";
  const lines = questions.map((q, i) => {
    const a = result.answers?.[i];
    const parts = [...(a?.selected ?? [])];
    if (a?.other) parts.push(`补充：${a.other}`);
    return `- ${q.question}${q.multiSelect ? "（多选）" : ""} → ${parts.length ? parts.join("；") : "未回答"}`;
  });
  return `用户的回答：\n${lines.join("\n")}`;
}
