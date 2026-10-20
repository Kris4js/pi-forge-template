import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeView } from "./CodeView";

type HastNode = { type: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: HastNode[] };

function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`markdown ${streaming ? "streaming" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Fenced code is a <pre><code class="language-x">; route it to CodeView. Inline code stays inline.
          pre: ({ node }) => {
            const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === "code");
            const classes = code?.properties?.className;
            const className = Array.isArray(classes) ? classes.join(" ") : String(classes ?? "");
            const language = /language-(\S+)/.exec(className)?.[1];
            return <CodeView code={textOf(code)} language={language} streaming={streaming} />;
          },
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
