import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ToolStreamEvent } from "../types.js";

export function toToolStreamEvent(event: AgentSessionEvent): ToolStreamEvent | undefined {
  if (event.type === "tool_execution_start") {
    return {
      type: "tool_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    };
  }

  if (event.type === "tool_execution_update") {
    return {
      type: "tool_update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      partialResult: event.partialResult,
    };
  }

  if (event.type === "tool_execution_end") {
    return {
      type: "tool_end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    };
  }

  return undefined;
}

export function collectAssistantText(event: AgentSessionEvent, current: string): string {
  if (event.type === "message_end" && event.message.role === "assistant") {
    return flattenText(event.message.content) || current;
  }

  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    return current + event.assistantMessageEvent.delta;
  }

  return current;
}

function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const block = item as { type?: string; text?: string };
      return block.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}
