import {
  Brain,
  Clock,
  Database,
  FileText,
  Layers,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Ticket,
  Wrench,
  X,
} from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { Item } from "../conversation";
import { Button, formatDuration } from "../ui";
import { CodeView, guessLanguage } from "./CodeView";
import { Markdown } from "./Markdown";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "./ui/trace";

type Assistant = Extract<Item, { kind: "assistant" }>;
type Tool = Extract<Item, { kind: "tool" }>;
type Decide = (toolCallId: string, decision: "approve" | "reject") => Promise<void>;

type Segment =
  | { kind: "thinking"; key: string; item: Assistant }
  | { kind: "tool"; key: string; item: Tool }
  | { kind: "compaction"; key: string; text: string }
  | { kind: "text"; key: string; item: Assistant };

type Props = {
  /** Assistant / tool / summary items of one turn, in order. */
  body: Item[];
  live: boolean;
  startedAt?: number;
  durationMs?: number;
  finalStatus?: string;
  onDecide?: Decide;
};

/**
 * One assistant turn as a Trace (shadcn "Whole Turn" pattern): a summary line that expands into the
 * steps (thinking, tool calls, compaction) and the text written between them; the final answer stays
 * outside the summary. While the turn runs (or waits for approval) the summary is open; afterwards it
 * folds away unless the reader opened it.
 */
export function TurnTrace({ body, live, startedAt, durationMs, finalStatus, onDecide }: Props) {
  const segments = toSegments(body);
  let split = segments.length;
  while (split > 0 && segments[split - 1]!.kind === "text") split--;
  const process = segments.slice(0, split);
  const answer = segments.slice(split);

  const tools = process.filter((s): s is Extract<Segment, { kind: "tool" }> => s.kind === "tool").map((s) => s.item);
  const pending = tools.find((t) => t.status === "pending");
  const failed = tools.filter((t) => t.status === "error" || t.status === "denied").length;
  const last = segments.at(-1);
  const continuing = live && (!last || (last.kind === "tool" && last.item.status === "success") || last.kind === "compaction");

  const [open, setOpen] = useState<boolean>();
  const now = useNow(live);
  const elapsed = durationMs ?? (live && startedAt ? now - startedAt : undefined);

  // Nothing to trace yet (e.g. waiting for the first token): the breathing mark in the label says enough.
  if (process.length === 0) return <Answer segments={answer} live={live} />;

  const status = pending ? "approval" : live ? "running" : failed || finalStatus === "failed" || finalStatus === "timeout" ? "error" : undefined;
  const title = pending
    ? `等待审批：${pending.name}`
    : live
      ? "正在处理"
      : summaryTitle(finalStatus, tools.length, failed, process.some((s) => s.kind === "thinking"));

  return (
    <div className="turn-trace">
      <TraceCollapsible open={open ?? (live || !!pending)} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={status}>
            <TraceTitle>{title}</TraceTitle>
            {elapsed !== undefined && elapsed > 0 && <TraceDescription>{formatDuration(elapsed)}</TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="turn-trace-steps">
          <Steps segments={process} live={live} lastKey={last?.key} onDecide={onDecide} />
          {continuing && (
            <Trace>
              <TraceLine status="running">
                <TraceIcon>
                  <Sparkles />
                </TraceIcon>
                <TraceTitle>根据工具结果继续生成</TraceTitle>
              </TraceLine>
            </Trace>
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
      <Answer segments={answer} live={live} />
    </div>
  );
}

function summaryTitle(finalStatus: string | undefined, toolCount: number, failed: number, thought: boolean) {
  const head = finalStatus === "cancelled" ? "已停止" : finalStatus === "timeout" ? "超时" : finalStatus === "failed" ? "执行失败" : "已处理";
  const parts = [head];
  if (toolCount) parts.push(`调用 ${toolCount} 个工具`);
  else if (thought) parts.push("经过思考");
  if (failed) parts.push(`${failed} 个失败或被拒绝`);
  return parts.join("，");
}

/** Consecutive steps share one Trace list; text written between steps sits between lists. */
function Steps({ segments, live, lastKey, onDecide }: { segments: Segment[]; live: boolean; lastKey?: string; onDecide?: Decide }) {
  const groups: Segment[][] = [];
  for (const segment of segments) {
    const prev = groups.at(-1);
    const isText = segment.kind === "text";
    if (prev && (prev[0]!.kind === "text") === isText) prev.push(segment);
    else groups.push([segment]);
  }
  return (
    <>
      {groups.map((group) =>
        group[0]!.kind === "text" ? (
          <Fragment key={group[0]!.key}>
            {group.map((s) => s.kind === "text" && <IntermediateText key={s.key} item={s.item} />)}
          </Fragment>
        ) : (
          <Trace key={group[0]!.key}>
            {group.map((s) => {
              if (s.kind === "thinking") {
                return <ThinkingStep key={s.key} item={s.item} running={live && s.key === lastKey && s.item.open && !s.item.text} />;
              }
              if (s.kind === "tool") return <ToolStep key={s.key} tool={s.item} onDecide={onDecide} />;
              if (s.kind === "compaction") {
                return (
                  <TraceLine key={s.key}>
                    <TraceIcon>
                      <Layers />
                    </TraceIcon>
                    <TraceTitle>上下文已由 pi 自动压缩</TraceTitle>
                  </TraceLine>
                );
              }
              return null;
            })}
          </Trace>
        ),
      )}
    </>
  );
}

function IntermediateText({ item }: { item: Assistant }) {
  return (
    <div className="turn-trace-text">
      {item.text && <Markdown text={item.text} streaming={item.open} />}
      {item.error && <div className="inline-error">模型返回错误：{item.error}</div>}
    </div>
  );
}

function Answer({ segments, live }: { segments: Segment[]; live: boolean }) {
  if (!segments.length) return null;
  return (
    <div className="assistant-block">
      {segments.map(
        (s) =>
          s.kind === "text" && (
            <Fragment key={s.key}>
              {s.item.text && <Markdown text={s.item.text} streaming={live && s.item.open} />}
              {s.item.error && (
                <div className="inline-error" role="alert">
                  模型返回错误：{s.item.error}
                </div>
              )}
            </Fragment>
          ),
      )}
    </div>
  );
}

/** Reasoning row: a plain line until text arrives, then collapsible; open while it streams. */
function ThinkingStep({ item, running }: { item: Assistant; running: boolean }) {
  const [open, setOpen] = useState<boolean>();
  const now = useNow(running);
  const ms = item.thinkingMs ?? (running && item.thinkingStartedAt ? now - item.thinkingStartedAt : undefined);
  const line = (
    <TraceLine status={running ? "running" : undefined}>
      <TraceIcon>
        <Brain />
      </TraceIcon>
      <TraceTitle>{running ? "思考中" : ms ? `思考 ${formatDuration(ms)}` : "思考过程"}</TraceTitle>
    </TraceLine>
  );
  if (!item.thinking) return line;
  return (
    <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="trace-thinking">{item.thinking}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

const TOOL_ICONS: Array<[RegExp, ReactNode]> = [
  [/^(bash|shell|exec|run)/, <Terminal key="t" />],
  [/^(read|ls|find|grep)$/, <FileText key="f" />],
  [/search|kb|lookup/, <Search key="s" />],
  [/query|sql|sales|metric/, <Database key="d" />],
  [/ticket/, <Ticket key="k" />],
];

function toolIcon(name: string) {
  return TOOL_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? <Wrench />;
}

function toolTitle(tool: Tool) {
  switch (tool.status) {
    case "running":
      return `正在调用 ${tool.name}`;
    case "pending":
      return `等待审批：${tool.name}`;
    case "error":
      return `调用 ${tool.name} 失败`;
    case "denied":
      return `已拒绝 ${tool.name}`;
    default:
      return `调用 ${tool.name}`;
  }
}

/** Tool row: arguments and output as small CodeBlocks; approval controls inline while parked. */
function ToolStep({ tool, onDecide }: { tool: Tool; onDecide?: Decide }) {
  const [open, setOpen] = useState<boolean>();
  const pending = tool.status === "pending";
  const status = tool.status === "running" ? "running" : pending ? "approval" : tool.status === "success" ? undefined : "error";
  const args = JSON.stringify(tool.args ?? {}, null, 2);
  const summary = argSummary(tool.args);

  return (
    <TraceCollapsible open={open ?? pending} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={status}>
          <TraceIcon>{toolIcon(tool.name)}</TraceIcon>
          <TraceTitle>{toolTitle(tool)}</TraceTitle>
          {summary && <TraceDescription className="trace-args-summary">{summary}</TraceDescription>}
          {tool.durationMs !== undefined && <TraceDescription>{formatDuration(tool.durationMs)}</TraceDescription>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="trace-tool">
        <CodeView code={args} language="json" title="参数" size="sm" />
        {tool.result !== undefined && (
          <CodeView
            code={tool.result || "（无输出）"}
            language={guessLanguage(tool.result)}
            title={tool.status === "success" ? "输出" : "错误"}
            icon={<Terminal />}
            size="sm"
            variant={tool.status === "success" ? "default" : "destructive"}
            wrap
            maxLines={16}
          />
        )}
        {tool.approval && tool.approval.state !== "pending" && (
          <div className={`approval-note ${tool.approval.state}`}>
            {tool.approval.state === "approved" ? <ShieldCheck size={13} /> : <X size={13} />}
            {tool.approval.state === "approved" ? "已批准" : "已拒绝"}
            {tool.approval.by ? ` · ${tool.approval.by}` : ""}
            {tool.approval.reason ? ` · ${tool.approval.reason}` : ""}
          </div>
        )}
        {pending && <ApprovalBar tool={tool} onDecide={onDecide} />}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function ApprovalBar({ tool, onDecide }: { tool: Tool; onDecide?: Decide }) {
  const [deciding, setDeciding] = useState<"approve" | "reject">();
  const now = useNow(true, 500);
  const remaining = tool.approval?.expiresAt ? Math.max(0, Date.parse(tool.approval.expiresAt) - now) : undefined;
  const decide = async (decision: "approve" | "reject") => {
    if (!onDecide) return;
    setDeciding(decision);
    try {
      await onDecide(tool.id, decision);
    } finally {
      setDeciding(undefined);
    }
  };
  return (
    <div className="approval-bar">
      <span className="approval-text">
        <ShieldAlert size={15} />
        网关策略要求人工审批后才能执行
        {remaining !== undefined && (
          <span className="countdown">
            <Clock size={12} />
            {remaining > 0 ? `${Math.ceil(remaining / 1000)}s 后自动拒绝` : "即将超时"}
          </span>
        )}
      </span>
      {onDecide ? (
        <span className="approval-actions">
          <Button variant="outline" className="deny" disabled={!!deciding} onClick={() => void decide("reject")}>
            拒绝
          </Button>
          <Button variant="primary" disabled={!!deciding} onClick={() => void decide("approve")}>
            {deciding === "approve" ? "提交中…" : "批准执行"}
          </Button>
        </span>
      ) : (
        <span className="approval-text muted">当前连接无法审批</span>
      )}
    </div>
  );
}

function toSegments(body: Item[]): Segment[] {
  const out: Segment[] = [];
  for (const item of body) {
    if (item.kind === "assistant") {
      if (item.thinking) out.push({ kind: "thinking", key: `${item.key}:t`, item });
      if (item.text || item.error) out.push({ kind: "text", key: `${item.key}:x`, item });
      if (!item.thinking && !item.text && !item.error && item.open) out.push({ kind: "thinking", key: `${item.key}:t`, item });
    } else if (item.kind === "tool") out.push({ kind: "tool", key: item.key, item });
    else if (item.kind === "summary") out.push({ kind: "compaction", key: item.key, text: item.text });
  }
  return out;
}

function argSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  return Object.values(args as Record<string, unknown>)
    .slice(0, 2)
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" · ")
    .slice(0, 60);
}

function useNow(active: boolean, interval = 200) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [active, interval]);
  return now;
}
