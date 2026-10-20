import { ChevronDown, FileCode2, WrapText } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useHighlightedCode } from "../hooks/useHighlightedCode";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "./ui/code-block";

type Props = {
  code: string;
  language?: string;
  /** Header title; defaults to the language. Pass null for a header-less block with floating actions. */
  title?: ReactNode | null;
  icon?: ReactNode;
  size?: "default" | "sm";
  variant?: "default" | "destructive";
  wrap?: boolean;
  /** Default: on for multi-line code in default size. */
  lineNumbers?: boolean;
  /** Collapse past this many lines behind "show more" (ignored while streaming). */
  maxLines?: number;
  streaming?: boolean;
};

/** CodeBlock composed with Shiki highlighting, diff markers, wrap toggle, copy and show-more. */
export function CodeView({
  code,
  language = "text",
  title,
  icon,
  size = "default",
  variant = "default",
  wrap: initialWrap = false,
  lineNumbers,
  maxLines = 24,
  streaming = false,
}: Props) {
  const lines = useHighlightedCode(code, language);
  const rawLines = code.replace(/\n$/, "").split("\n");
  const [wrap, setWrap] = useState(initialWrap);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();

  const numbered = lineNumbers ?? (size === "default" && rawLines.length > 1);
  const collapsible = !streaming && rawLines.length > maxLines;
  const visible = collapsible && !expanded ? lines.slice(0, maxLines) : lines;
  const diff = language === "diff";

  const actions = (
    <CodeBlockActions>
      <button
        type="button"
        className="code-block-button"
        aria-pressed={wrap}
        aria-label="自动换行"
        title={wrap ? "关闭自动换行" : "自动换行"}
        onClick={() => setWrap((v) => !v)}
      >
        <WrapText />
      </button>
      <CodeBlockCopyButton value={code} />
    </CodeBlockActions>
  );

  return (
    <CodeBlock size={size} variant={variant}>
      {title === null ? (
        actions
      ) : (
        <CodeBlockHeader>
          <CodeBlockTitle>
            {icon ?? <FileCode2 />}
            {title ?? language}
          </CodeBlockTitle>
          {actions}
        </CodeBlockHeader>
      )}
      <CodeBlockContent id={contentId} wrap={wrap} lineNumbers={numbered}>
        {visible.map((line, index) => (
          <CodeBlockLine key={index} variant={diff ? diffVariant(rawLines[index]) : "default"}>
            {line}
          </CodeBlockLine>
        ))}
      </CodeBlockContent>
      {collapsible && (
        <CodeBlockFooter>
          <button
            type="button"
            className="code-block-more"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronDown className={expanded ? "rot" : ""} />
            {expanded ? "收起" : `展开全部 ${rawLines.length} 行`}
          </button>
        </CodeBlockFooter>
      )}
    </CodeBlock>
  );
}

function diffVariant(line = ""): "added" | "removed" | "highlighted" | "default" {
  if (line.startsWith("+") && !line.startsWith("+++")) return "added";
  if (line.startsWith("-") && !line.startsWith("---")) return "removed";
  if (line.startsWith("@@")) return "highlighted";
  return "default";
}

/** Best-effort language for tool output: JSON if it parses, otherwise plain text. */
export function guessLanguage(text: string): string {
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 200_000) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // not JSON
    }
  }
  return "text";
}
