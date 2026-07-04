export type TenantIdentity = {
  workspace: string;
  userId: string;
  sessionId?: string;
  agentName?: string;
};

export type TenantIdentityInput = {
  workspace?: string;
  userId?: string;
  sessionId?: string;
  agentName?: string;
};

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

export type RetentionInfo = {
  compacted: boolean;
  reason?: "tokens" | "age";
  estimatedTokens: number;
  contextWindow?: number;
};

export type ToolStreamEvent =
  | {
      type: "tool_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };

export type ChatOptions = {
  sessionId?: string;
  userId?: string;
  agentName?: string;
  stream?: boolean;
  onTextDelta?: (delta: string) => void;
  onToolEvent?: (event: ToolStreamEvent) => void;
};

export type ChatInput = ChatOptions & {
  prompt: string;
};

export type ChatResult = {
  sessionId: string;
  text: string;
  workspace: string;
  userId: string;
  retention?: RetentionInfo;
};
