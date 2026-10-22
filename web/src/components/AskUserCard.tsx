import { Check, ChevronLeft, ChevronRight, PenLine, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AskAnswer, PendingQuestion } from "../api";
import { Button } from "../ui";

export const ASK_USER = "ask_user";

export type AskUserAnswer = { answers: AskAnswer[] } | { skip: true };

type Props = {
  ask: PendingQuestion;
  agentName: string;
  /** Resolves once the gateway took the answer; the card then goes away with the question. */
  onAnswer: (answer: AskUserAnswer) => Promise<void>;
};

type Draft = { selected: string[]; other: string };

const answered = (d: Draft | undefined) => !!d && (d.selected.length > 0 || d.other.trim() !== "");

/**
 * An ask_user call, docked in place of the composer while the agent waits on it. Several questions
 * are tabs; each takes one option (or several when multiSelect) plus optional words of the user's own.
 * Submit sends every answer at once; skip (✕ / Esc) lets the agent decide.
 */
export function AskUserCard({ ask, agentName, onAnswer }: Props) {
  const questions = ask.questions;
  const [tab, setTab] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => ({ selected: [], other: "" })));
  const [sending, setSending] = useState(false);
  const card = useRef<HTMLElement>(null);
  const q = questions[tab]!;
  const draft = drafts[tab]!;
  const many = questions.length > 1;
  const complete = drafts.every(answered);
  const last = tab === questions.length - 1;

  useEffect(() => {
    card.current?.querySelector<HTMLButtonElement>("ol button")?.focus({ preventScroll: true });
  }, [ask.toolCallId, tab]);

  const update = (patch: (d: Draft) => Draft) => setDrafts((all) => all.map((d, i) => (i === tab ? patch(d) : d)));

  /**
   * Multi-select toggles the option. Single choice selects it (radio: picking it again keeps it) and
   * replaces any own words; with several tabs it then moves on to the next question.
   */
  const choose = (option: string) => {
    if (q.multiSelect) {
      update((d) => ({ ...d, selected: d.selected.includes(option) ? d.selected.filter((o) => o !== option) : [...d.selected, option] }));
      return;
    }
    update(() => ({ selected: [option], other: "" }));
    if (many && !last) {
      const from = tab;
      setTimeout(() => setTab((t) => (t === from ? from + 1 : t)), 140);
    }
  };

  const send = async (body: AskUserAnswer) => {
    if (sending) return;
    setSending(true);
    try {
      await onAnswer(body);
    } finally {
      setSending(false);
    }
  };
  const submit = () => {
    if (!complete) {
      // Take the user to the first question still open.
      setTab(drafts.findIndex((d) => !answered(d)));
      return;
    }
    void send({ answers: drafts.map((d) => ({ selected: d.selected, other: d.other.trim() || undefined })) });
  };
  /** Single-choice questions advance on pick / Enter; the last one submits. */
  const next = () => (last ? submit() : setTab(tab + 1));
  const skip = () => void send({ skip: true });

  // 1–9 pick, ←/→ switch tabs, Enter goes on, Esc skips — except while typing.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      skip();
      return;
    }
    if (e.target instanceof HTMLInputElement) return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= q.options.length) {
      e.preventDefault();
      choose(q.options[n - 1]!);
    } else if (many && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !(e.target instanceof HTMLButtonElement && e.target.closest("ol"))) {
      e.preventDefault();
      setTab((t) => Math.min(questions.length - 1, Math.max(0, t + (e.key === "ArrowRight" ? 1 : -1))));
    } else if (e.key === "Enter" && answered(draft) && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      next();
    }
  };

  return (
    <section ref={card} className="ask-user" aria-label={many ? `${questions.length} 个问题` : q.question} aria-busy={sending} onKeyDown={onKeyDown}>
      {many && (
        <div className="ask-user-tabs" role="tablist" aria-label="问题">
          {questions.map((item, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === tab}
              className={`${i === tab ? "on" : ""} ${answered(drafts[i]) ? "done" : ""}`}
              onClick={() => setTab(i)}
            >
              {answered(drafts[i]) ? <Check size={13} aria-label="已回答" /> : <span className="ask-user-tab-index">{i + 1}</span>}
              {item.header || `问题 ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      <header>
        <h3>
          {q.question}
          {q.multiSelect && <span className="ask-user-hint">可多选</span>}
        </h3>
        <Button size="icon" aria-label="跳过" title="跳过（Esc）" disabled={sending} icon={<X size={18} />} onClick={skip} />
      </header>
      <ol role={q.multiSelect ? "group" : "radiogroup"} aria-label="选项">
        {q.options.map((option, index) => {
          const selected = draft.selected.includes(option);
          return (
            <li key={`${tab}-${index}-${option}`}>
              <button
                type="button"
                role={q.multiSelect ? "checkbox" : "radio"}
                aria-checked={selected}
                className={selected ? "picked" : ""}
                disabled={sending}
                onClick={() => choose(option)}
                onDoubleClick={() => {
                  if (!q.multiSelect && !many) void send({ answers: [{ selected: [option] }] });
                }}
              >
                <span className={`ask-user-index ${q.multiSelect ? "box" : ""}`}>{q.multiSelect && selected ? <Check size={13} /> : index + 1}</span>
                <span>{option}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <footer>
        <label className="ask-user-own">
          <PenLine size={15} aria-hidden="true" />
          <input
            value={draft.other}
            maxLength={2000}
            disabled={sending}
            placeholder={q.multiSelect ? `其他补充，告知 ${agentName}…` : `其他，告知 ${agentName} 你的想法…`}
            aria-label="其他想法"
            onChange={(e) => {
              const other = e.target.value;
              // Single choice: own words replace the picked option.
              update((d) => ({ selected: q.multiSelect || !other.trim() ? d.selected : [], other }));
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && answered(draft)) {
                e.preventDefault();
                next();
              }
            }}
          />
        </label>
        {many && (
          <span className="ask-user-step">
            <Button size="icon" aria-label="上一个问题" disabled={tab === 0} icon={<ChevronLeft size={16} />} onClick={() => setTab(tab - 1)} />
            <Button size="icon" aria-label="下一个问题" disabled={last} icon={<ChevronRight size={16} />} onClick={() => setTab(tab + 1)} />
          </span>
        )}
        <Button variant="outline" disabled={sending} onClick={skip}>
          跳过
        </Button>
        <Button variant="primary" disabled={(!complete && (!many || !answered(draft))) || sending} onClick={submit}>
          {sending ? "提交中…" : complete || !many ? "提交" : `提交（${drafts.filter(answered).length}/${questions.length}）`}
        </Button>
      </footer>
    </section>
  );
}
