/*
 * CodeBlock — code, terminal output, logs and diffs. Ported from shadcn/ui
 * (apps/v4/registry/bases/radix/ui/code-block.tsx) with the same parts, props and data-slot
 * structure; styling lives in ai-elements.css instead of Tailwind.
 * Copyright (c) 2023 shadcn — MIT License.
 */
import { Check, Copy } from "lucide-react";
import { useEffect, useState, type ComponentProps, type MouseEvent } from "react";

const cx = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

export function CodeBlock({
  className,
  variant = "default",
  size = "default",
  ...props
}: ComponentProps<"div"> & { variant?: "default" | "destructive"; size?: "default" | "sm" }) {
  return <div data-slot="code-block" data-variant={variant} data-size={size} className={cx("code-block", className)} {...props} />;
}

export function CodeBlockHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="code-block-header" className={cx("code-block-header", className)} {...props} />;
}

export function CodeBlockTitle({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="code-block-title" className={cx("code-block-title", className)} {...props} />;
}

/** Inside a header: right-aligned. As a direct child of CodeBlock: floating, shown on hover/focus. */
export function CodeBlockActions({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="code-block-actions" className={cx("code-block-actions", className)} {...props} />;
}

export function CodeBlockCopyButton({
  value,
  className,
  onClick,
  ...props
}: ComponentProps<"button"> & { value: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  return (
    <>
      <button
        type="button"
        data-slot="code-block-copy-button"
        data-copied={copied || undefined}
        aria-label={copied ? "已复制" : "复制"}
        title={copied ? "已复制" : "复制"}
        className={cx("code-block-button", className)}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          onClick?.(event);
          navigator.clipboard
            .writeText(value)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
        {...props}
      >
        {copied ? <Check /> : <Copy />}
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? "已复制" : ""}
      </span>
    </>
  );
}

export function CodeBlockContent({
  className,
  children,
  style,
  wrap = false,
  lineNumbers = false,
  startLine = 1,
  ...props
}: ComponentProps<"pre"> & { wrap?: boolean; lineNumbers?: boolean; startLine?: number }) {
  return (
    <pre
      data-slot="code-block-content"
      data-wrap={wrap || undefined}
      data-numbered={lineNumbers || undefined}
      dir="ltr"
      tabIndex={0}
      style={{ counterReset: `line ${startLine - 1}`, ...style }}
      className={cx("code-block-content", className)}
      {...props}
    >
      <code data-slot="code-block-code" className="code-block-code">
        {lineNumbers && typeof children === "string"
          ? children
              .replace(/\n$/, "")
              .split("\n")
              .map((line, index) => <CodeBlockLine key={index}>{line}</CodeBlockLine>)
          : children}
      </code>
    </pre>
  );
}

export function CodeBlockLine({
  className,
  variant = "default",
  children,
  ...props
}: ComponentProps<"span"> & { variant?: "default" | "added" | "removed" | "highlighted" }) {
  // An empty line holds a newline so copying a selection keeps blank lines.
  const empty =
    children === undefined || children === null || children === "" || (Array.isArray(children) && children.length === 0);
  return (
    <span data-slot="code-block-line" data-variant={variant} className={cx("code-block-line", className)} {...props}>
      <span data-slot="code-block-line-content" className="code-block-line-content">
        {empty ? "\n" : children}
      </span>
    </span>
  );
}

export function CodeBlockFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="code-block-footer" className={cx("code-block-footer", className)} {...props} />;
}
