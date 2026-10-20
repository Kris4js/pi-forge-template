/*
 * Streaming-aware Shiki highlighting, ported from shadcn/ui (hooks/use-highlighted-code.ts).
 * Copyright (c) 2023 shadcn — MIT License.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { loadHighlighter, type Highlighter } from "../lib/highlighter";

type GrammarState = Parameters<Highlighter["highlight"]>[1];

/** Returns one node per line. Plain strings until the language loads (or for unknown languages). */
export function useHighlightedCode(value: string, language: string): ReactNode[] {
  // A trailing newline would render as an extra empty line.
  const code = value.endsWith("\n") ? value.slice(0, -1) : value;
  const [loaded, setLoaded] = useState<{ language: string; highlighter: Highlighter | null } | null>(null);
  const highlighter = loaded?.language === language ? loaded.highlighter : null;

  useEffect(() => {
    let cancelled = false;
    loadHighlighter(language)
      .then((next) => {
        if (!cancelled) setLoaded({ language, highlighter: next });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [language]);

  // Complete lines, highlighted. While the code streams, only new lines are tokenized,
  // continuing from the grammar state of the last one.
  const [done, setDone] = useState<{
    highlighter: Highlighter | null;
    text: string;
    lines: ReactNode[];
    state?: GrammarState;
  }>({ highlighter: null, text: "", lines: [] });

  let next = done;
  if (next.highlighter !== highlighter || !code.startsWith(next.text)) {
    next = { highlighter, text: "", lines: [] };
  }

  const end = code.lastIndexOf("\n") + 1;
  if (highlighter && end > next.text.length) {
    const result = highlighter.highlight(code.slice(next.text.length, end - 1), next.state);
    next = { highlighter, text: code.slice(0, end), lines: [...next.lines, ...result.lines], state: result.state };
  }

  if (next !== done) setDone(next);

  // The last line may still be streaming, so it is tokenized on every render.
  const tail = code.slice(end);

  return useMemo(() => {
    if (!highlighter) return code.split("\n");
    return [...next.lines, highlighter.highlight(tail, next.state).lines[0]];
  }, [code, highlighter, next, tail]);
}
