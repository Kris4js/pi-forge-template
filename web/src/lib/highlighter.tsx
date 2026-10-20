/*
 * Shiki loader for CodeBlock, ported from shadcn/ui (apps/v4/registry/bases/radix/lib/highlighter.tsx).
 * Copyright (c) 2023 shadcn — MIT License.
 */
import type { CSSProperties } from "react";
import type { GrammarState, HighlighterCore } from "shiki/core";

// Each language loads the first time it is used. JS regex engine: no WASM.
const languages = {
  bash: () => import("shiki/langs/shellscript.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

const aliases: Record<string, keyof typeof languages> = {
  golang: "go",
  js: "javascript",
  jsonc: "json",
  md: "markdown",
  py: "python",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  ts: "typescript",
  yml: "yaml",
  zsh: "bash",
};

let highlighter: Promise<HighlighterCore> | undefined;

// Shiki itself is loaded on first use too, keeping it out of the initial bundle.
function getHighlighter() {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      }),
  );
  return highlighter;
}

function getLanguage(language: string) {
  const name = language.toLowerCase();
  if (name === "ansi") return name;
  if (name in languages) return name as keyof typeof languages;
  return aliases[name] ?? null;
}

export function isHighlightable(language: string | undefined): boolean {
  return !!language && getLanguage(language) !== null;
}

/** Loads a language and returns a highlighter for it, or null for an unlisted language. */
export async function loadHighlighter(language: string) {
  const lang = getLanguage(language);
  if (!lang) return null;

  const shiki = await getHighlighter();
  if (lang !== "ansi" && !shiki.getLoadedLanguages().includes(lang)) {
    await shiki.loadLanguage(languages[lang]);
  }

  return {
    /** One React node per line, plus the grammar state after the last line to continue from. */
    highlight(code: string, state?: GrammarState) {
      const tokenize = (text: string) =>
        shiki.codeToTokens(text, {
          lang,
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
          grammarState: state,
        }).tokens;

      // ANSI has no grammar state: tokenize line by line so streaming and full renders match.
      const tokens = lang === "ansi" ? code.split("\n").flatMap((line) => tokenize(line)) : tokenize(code);

      return {
        lines: tokens.map((line) =>
          line.map((token, index) => (
            <span key={index} className="shiki-token" style={token.htmlStyle as CSSProperties}>
              {token.content}
            </span>
          )),
        ),
        state: shiki.getLastGrammarState(tokens),
      };
    },
  };
}

export type Highlighter = NonNullable<Awaited<ReturnType<typeof loadHighlighter>>>;
