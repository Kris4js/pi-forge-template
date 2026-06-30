export type TenantIdentity = {
  workspace: string;
  userId: string;
  sessionId?: string;
};

export type TenantIdentityInput = {
  workspace?: string;
  userId?: string;
  sessionId?: string;
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
  stream?: boolean;
  onTextDelta?: (delta: string) => void;
  onToolEvent?: (event: ToolStreamEvent) => void;
};

export type ChatOnceInput = ChatOptions & {
  prompt: string;
};

export type ChatResult = {
  sessionId: string;
  text: string;
  workspace: string;
  userId: string;
  retention?: RetentionInfo;
};

export type MemoryKind = "fact" | "preference" | "task";
export type MemoryVisibility = "session" | "user" | "workspace";
export type MemorySource = "agent" | "user" | "summary" | "system" | "skill";

export type MemoryRecord = {
  id: string;
  workspace: string;
  userId: string;
  sessionId: string;
  visibility: MemoryVisibility;
  kind: MemoryKind;
  text: string;
  keywords: string[];
  createdAt: number;
  lastUsedAt: number;
  source: MemorySource;
  confidence: number;
};
