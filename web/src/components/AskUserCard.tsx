import { PenLine, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PendingQuestion } from "../api";
import { Button } from "../ui";

export const ASK_USER = "ask_user";

export type AskUserAnswer = { answer: string } | { skip: true };

type Props = {
  ask: PendingQuestion;
  agentName: string;
  /** Resolves once the gateway took the answer; the card then goes away with the question. */
  onAnswer: (answer: AskUserAnswer) => Promise<void>;
};

/**
 * An ask_user question, docked in place of the composer while the agent waits on it: pick a
 * numbered option or write your own, then submit; skip (or ✕) lets the agent decide.
 */
export function AskUserCard({ ask, agentName, onAnswer }: Props) {
  const [picked, setPicked] = useState<number>();
  const [own, setOwn] = useState("");
  const [sending, setSending] = useState(false);
  const card = useRef<HTMLElement>(null);
  const answer = own.trim() || (picked !== undefined ? ask.options[picked]! : "");

  useEffect(() => {
    card.current?.querySelector<HTMLButtonElement>("ol button")?.focus({ preventScroll: true });
  }, [ask.toolCallId]);

  const send = async (body: AskUserAnswer) => {
    if (sending) return;
    setSending(true);
    try {
      await onAnswer(body);
    } finally {
      setSending(false);
    }
  };
  const submit = (text = answer) => {
    if (text) void send({ answer: text });
  };
  const skip = () => void send({ skip: true });

  // 1–9 pick an option while focus is on the card but not in the text field; Esc skips.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      skip();
      return;
    }
    if (e.target instanceof HTMLInputElement) return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= ask.options.length) {
      e.preventDefault();
      setPicked(n - 1);
      setOwn("");
    } else if (e.key === "Enter" && answer && !(e.target instanceof HTMLButtonElement && e.target.closest("footer"))) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <section ref={card} className="ask-user" aria-label={ask.question} aria-busy={sending} onKeyDown={onKeyDown}>
      <header>
        <h3>{ask.question}</h3>
        <Button size="icon" aria-label="跳过" title="跳过（Esc）" disabled={sending} icon={<X size={18} />} onClick={skip} />
      </header>
      <ol role="listbox" aria-label="选项">
        {ask.options.map((option, index) => {
          const selected = picked === index && !own.trim();
          return (
            <li key={`${index}-${option}`}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className={selected ? "picked" : ""}
                disabled={sending}
                onClick={() => {
                  setPicked(index);
                  setOwn("");
                }}
                onDoubleClick={() => submit(option)}
              >
                <span className="ask-user-index">{index + 1}</span>
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
            value={own}
            maxLength={2000}
            disabled={sending}
            placeholder={`其他，告知 ${agentName} 你的想法…`}
            aria-label="其他想法"
            onChange={(e) => setOwn(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <Button variant="outline" disabled={sending} onClick={skip}>
          跳过
        </Button>
        <Button variant="primary" disabled={!answer || sending} onClick={() => submit()}>
          {sending ? "提交中…" : "提交"}
        </Button>
      </footer>
    </section>
  );
}
