import { Api } from "../api";
import { ImageGallery } from "./ImageGallery";
import { FileCard } from "./FileCard";
import { motion } from "framer-motion";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import type { Item } from "../conversation";
import { ClaudeMark } from "../lib/icons";
import { Button, CopyButton } from "../ui";
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

/** A reloaded turn: from the question to the last assistant message (stored sessions carry timestamps). */
function storedDuration(turn: Turn): number | undefined {
  const end = [...turn.body].reverse().find((i): i is Extract<Item, { kind: "assistant" }> => i.kind === "assistant" && !!i.at)?.at;
  return turn.user?.at && end && end > turn.user.at ? end - turn.user.at : undefined;
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
                  durationMs={turn.status?.durationMs ?? storedDuration(turn)}
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

/** Long questions start folded to a few lines; the toggle only appears when the text actually overflows. */
function CollapsibleText({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open]);
  return <>
    <div ref={ref} className={`user-text${open ? "" : " folded"}${overflows && !open ? " faded" : ""}`}>{text}</div>
    {overflows && <button type="button" className="user-text-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? "收起" : "展开全部"}<ChevronDown size={14} />
    </button>}
  </>;
}

function UserMessage({ item, api, sessionId }: { item: User; api: Api; sessionId?: string }) {
  return (
    <motion.div
      className="user-row"
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 520, damping: 38 }}
    >
      {item.files?.length ? <div className="user-files">{item.files.map((file, index) => <FileCard key={`${index}-${file.name}`} file={file} />)}</div> : null}
      {(item.text || (item.images?.length && sessionId)) && <div className="user-bubble">{item.images?.length && sessionId ? <ImageGallery images={item.images} api={api} sessionId={sessionId} /> : null}{item.text && <CollapsibleText text={item.text} />}</div>}
      {item.text && <div className="user-actions">
        <CopyButton text={item.text} compact />
      </div>}
    </motion.div>
  );
}

/** Actions under every finished reply; a failed run also shows its error. */
function TurnFooter({ status, body, onRetry }: { status?: Status; body: Item[]; onRetry?: () => void }) {
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
      {status?.error && <div className="turn-error">{status.error}</div>}
    </div>
  );
}
