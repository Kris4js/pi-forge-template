import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "ghost" | "primary" | "secondary" | "danger" | "outline";
  size?: "md" | "sm" | "icon";
  icon?: ReactNode;
};

export function Button({ variant = "ghost", size = "md", icon, className = "", children, type, ...props }: ButtonProps) {
  return (
    <button type={type ?? "button"} className={`btn ${variant} ${size} ${className}`} {...props}>
      {icon}
      {children !== undefined && <span>{children}</span>}
    </button>
  );
}

export function CopyButton({ text, label = "复制", compact }: { text: string; label?: string; compact?: boolean }) {
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      size={compact ? "icon" : "sm"}
      disabled={!text}
      title={label}
      aria-label={label}
      icon={state === "done" ? <Check size={14} /> : <Copy size={14} />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("done");
        } catch {
          setState("error");
        }
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 2000);
      }}
    >
      {compact ? undefined : state === "done" ? "已复制" : state === "error" ? "复制失败" : label}
    </Button>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="modal-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-body">
        <header>
          <h2 id="modal-title">{title}</h2>
          <Button size="icon" aria-label="关闭" icon={<X size={18} />} onClick={onClose} />
        </header>
        {children}
      </div>
    </dialog>
  );
}

export function QuietDots({ label }: { label?: string }) {
  return (
    <span className="quiet-dots" role="status">
      <span aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {label}
    </span>
  );
}

export function LiveDot({ tone = "clay" }: { tone?: "clay" | "ok" | "muted" | "danger" }) {
  return (
    <span className={`live-dot ${tone}`} aria-hidden="true">
      {tone !== "muted" && <span />}
    </span>
  );
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
