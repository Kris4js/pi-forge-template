import { ArrowUp, Square } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Agent, ModelsResult } from "../api";
import { agentIcon } from "../lib/icons";
import { AttachmentButton, AttachmentPreview } from "./AttachmentButton";
import { ModelSelector } from "./ModelSelector";
import { Button } from "../ui";

const MAX = 100_000;

export type ComposerHandle = { focus: () => void; fill: (text: string) => void };

type Props = {
  agent?: Agent;
  /** Registered models and the current choice; the selector hides until the catalog loads. */
  catalog?: ModelsResult;
  model?: string;
  effort?: string;
  onModel?: (key: string) => void;
  onEffort?: (level: string) => void;
  busy: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  onSend: (text: string, files: File[]) => Promise<void>;
  onStop: () => void;
};

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { agent, catalog, model, effort, onModel, onEffort, busy, placeholder, autoFocus, onSend, onStop },
  ref,
) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    fill: (value) => {
      setText(value);
      requestAnimationFrame(() => {
        area.current?.focus();
        area.current?.setSelectionRange(value.length, value.length);
      });
    },
  }));

  // Auto-grow up to the CSS max-height.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = async () => {
    if ((!text.trim() && !files.length) || busy || sending || !agent) return;
    setSending(true);
    setError("");
    try {
      await onSend(text, files);
      setText("");
      setFiles([]);
    } catch (error) {
      setError((error as Error).message);
    } finally { setSending(false); }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {files.length > 0 && <div className="composer-attachments">{files.map((file, index) => <AttachmentPreview key={`${index}-${file.name}`} file={file} disabled={busy || sending} onRemove={() => setFiles((prev) => prev.filter((_, i) => i !== index))} />)}</div>}
      {error && <div className="attachment-error" role="alert">{error}</div>}
      <textarea
        ref={area}
        value={text}
        rows={2}
        maxLength={MAX}
        autoFocus={autoFocus}
        aria-label="输入消息"
        placeholder={placeholder ?? (agent ? `给「${agent.name}」发消息…` : "请先选择一个 agent")}
        disabled={!agent || sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-tools">
        <div className="composer-left">
          <AttachmentButton files={files} onChange={setFiles} disabled={!agent || busy || sending} />
          {agent && (
            <span className="chip" title={agent.description}>
              {agentIcon(agent.id, 13)}
              <span className="chip-text">{agent.name}</span>
            </span>
          )}
        </div>
        <div className="send-group">
          {text.length > MAX * 0.9 && <span className="input-hint">{`${text.length}/${MAX}`}</span>}
          {catalog && model && effort && onModel && onEffort && (
            <ModelSelector catalog={catalog} model={model} effort={effort} onModel={onModel} onEffort={onEffort} />
          )}
          {busy ? (
            <Button
              variant="primary"
              className="send"
              aria-label="停止"
              title="停止生成"
              icon={<Square size={14} fill="currentColor" />}
              onClick={onStop}
            />
          ) : (
            <Button
              type="submit"
              variant="primary"
              className="send"
              aria-label="发送"
              title="发送"
              disabled={(!text.trim() && !files.length) || !agent || sending}
              icon={<ArrowUp size={19} />}
            />
          )}
        </div>
      </div>
    </form>
  );
});
