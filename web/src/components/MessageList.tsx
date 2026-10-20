import { Api } from "../api";
import { ImageGallery } from "./ImageGallery";
import { motion } from "framer-motion";
import { useMemo } from "react";
import { CircleAlert, CircleCheck, CircleSlash, Clock3, Coins, RotateCcw, Timer } from "lucide-react";
import type { Item } from "../conversation";
import { ClaudeMark } from "../lib/icons";
import { Button, CopyButton, formatDuration, formatTokens } from "../ui";
import { TurnTrace } from "./TurnTrace";

type Props = {
  api: Api;
  sessionId?: string;
  items: Item[];
  agentName: string;
  busy: boolean;
  onDecide?: (toolCallId: string, decision: "approve" | "reject") => Promise<void>;
  /** Re-send a turn's question as a new message. */
  onRetry?: (text: string) => void;
};

type User = Extract<Item, { kind: "user" }>;
type Status = Extract<Item, { kind: "status" }>;
type Turn = { key: string; user?: User; body: Item[]; status?: Status };

const STATUS_META: Record<string, { label: string; icon: JSX.Element }> = {
  completed: { label: "完成", icon: <CircleCheck size={13} /> },
  failed: { label: "失败", icon: <CircleAlert size={13} /> },
  cancelled: { label: "已停止", icon: <CircleSlash size={13} /> },
  timeout: { label: "超时", icon: <Timer size={13} /> },
};

/** Items grouped into turns: a user message, what the agent did, and the run's terminal status. */
function toTurns(items: Item[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    const current = turns.at(-1);
    if (item.kind === "user" || !current) {
      turns.push(item.kind === "user" ? { key: item.key, user: item, body: [] } : { key: item.key, body: [item] });
    } else if (item.kind === "status") current.status = item;
    else current.body.push(item);
  }
  return turns;
}

export function MessageList({ api, sessionId, items, agentName, busy, onDecide, onRetry }: Props) {
  const turns = toTurns(items);
  return (
    <section className="messages" aria-label="消息列表">
      {turns.map((turn, index) => {
        const live = busy && index === turns.length - 1 && !turn.status;
        return (
          <article key={turn.key} className="turn">
            {turn.user && <UserMessage item={turn.user} api={api} sessionId={sessionId} />}
            {(turn.body.length > 0 || live) && (
              <div className="assistant-turn">
                <div className="assistant-label">
                  <ClaudeMark size={20} live={live} />
                  <strong>{agentName}</strong>
                </div>
                <TurnTrace
                  body={turn.body}
                  live={live}
                  startedAt={turn.user?.at}
                  durationMs={turn.status?.durationMs}
                  finalStatus={turn.status?.status}
                  onDecide={live ? onDecide : undefined}
                />
                {sessionId && <TurnImages body={turn.body} api={api} sessionId={sessionId} />}
              </div>
            )}
            {!live && turn.body.length > 0 && (
              <TurnFooter
                status={turn.status}
                body={turn.body}
                onRetry={turn.user && onRetry && !busy ? () => onRetry(turn.user!.text) : undefined}
              />
            )}
          </article>
        );
      })}
    </section>
  );
}

/** Every image the turn's tools produced, as one carousel below the reply. */
function TurnImages({ body, api, sessionId }: { body: Item[]; api: Api; sessionId: string }) {
  const all = body.flatMap((item) => item.kind === "tool" ? item.images ?? [] : []);
  const ids = all.map((image) => image.id).join("|");
  // Stable identity until an image is added, so the gallery doesn't redo work on every streamed token.
  const images = useMemo(() => all, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  return images.length ? <ImageGallery images={images} api={api} sessionId={sessionId} /> : null;
}

function UserMessage({ item, api, sessionId }: { item: User; api: Api; sessionId?: string }) {
  return (
    <motion.div
      className="user-row"
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 520, damping: 38 }}
    >
      <div className="user-bubble">{item.images?.length && sessionId ? <ImageGallery images={item.images} api={api} sessionId={sessionId} /> : null}{item.text && <div>{item.text}</div>}</div>
      <div className="user-actions">
        <CopyButton text={item.text} compact />
      </div>
    </motion.div>
  );
}

/** Actions are on every finished reply (live or reloaded); run metrics only exist for runs seen live. */
function TurnFooter({ status, body, onRetry }: { status?: Status; body: Item[]; onRetry?: () => void }) {
  const meta = status && (STATUS_META[status.status] ?? { label: status.status, icon: <CircleAlert size={13} /> });
  const text = body
    .filter((i): i is Extract<Item, { kind: "assistant" }> => i.kind === "assistant" && !!i.text)
    .map((i) => i.text)
    .join("\n\n");
  return (
    <div className="turn-footer">
      <div className="turn-actions">
        <CopyButton text={text} label="复制回复" compact />
        <Button size="icon" title="重试" aria-label="重试" disabled={!onRetry} icon={<RotateCcw size={14} />} onClick={onRetry} />
      </div>
      {status && meta && (
        <div className="turn-meta">
          <span className={`status-pill ${status.status}`}>
            {meta.icon}
            {meta.label}
          </span>
          {status.durationMs !== undefined && (
            <span title="耗时">
              <Clock3 size={12} />
              {formatDuration(status.durationMs)}
            </span>
          )}
          {status.usage && (
            <span title={`输入 ${status.usage.inputTokens} · 输出 ${status.usage.outputTokens}`}>
              <Coins size={12} />
              {formatTokens(status.usage.inputTokens)} → {formatTokens(status.usage.outputTokens)}
            </span>
          )}
          {status.model && <span className="mono">{status.model}</span>}
        </div>
      )}
      {status?.error && <div className="turn-error">{status.error}</div>}
    </div>
  );
}
