import { Check, Copy, Download, ExternalLink, Monitor, RotateCw, Smartphone, Tablet, X } from "lucide-react";
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Api, ArtifactSummary } from "../api";
import { prepareArtifactHtml, safeLinkUrl, type FrameMessage } from "../lib/artifact-frame";
import { EMPTY_DRAFT_DOCUMENT, patchDraftDocument } from "../lib/draft-preview";
import { Button } from "../ui";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./ui/select";

/** Lets transcript items (e.g. a publish_design step) open a revision in the preview. */
export const PreviewLink = createContext<((revision: number) => void) | null>(null);

type Device = "desktop" | "tablet" | "mobile";
const DEVICE_WIDTH: Record<Device, number | null> = { desktop: null, tablet: 820, mobile: 390 };

type Props = {
  api: Api;
  sessionId?: string;
  artifacts: ArtifactSummary[];
  /** Selected revision; null follows the latest. */
  revision: number | null;
  onRevision: (revision: number | null) => void;
  /** The design as the model writes it (scriptless), while a publish streams. */
  draft: string | null;
  live: boolean;
  onClose: () => void;
};

export function PreviewPanel({ api, sessionId, artifacts, revision, onRevision, draft, live, onClose }: Props) {
  const latest = artifacts.at(-1)?.revision;
  const shown = revision ?? latest;
  const [html, setHtml] = useState<{ key: string; html: string } | null>(null);
  const [error, setError] = useState<string>();
  const [device, setDevice] = useState<Device>("desktop");
  const [nonce, setNonce] = useState(0);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cache = useRef(new Map<string, string>());
  const key = sessionId && shown ? `${sessionId}/${shown}` : null;

  useEffect(() => {
    setError(undefined);
    if (!key || !sessionId || !shown) {
      setHtml(null);
      return;
    }
    const cached = cache.current.get(key);
    if (cached !== undefined) {
      setHtml({ key, html: cached });
      return;
    }
    let cancelled = false;
    api
      .artifact(sessionId, shown)
      .then((detail) => {
        cache.current.set(key, detail.html);
        if (!cancelled) setHtml({ key, html: detail.html });
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, shown, key]);

  // The draft stays on top until the published revision it became has painted underneath.
  const liveDraft = draft && renderable(draft) ? draft : null;
  const [heldDraft, setHeldDraft] = useState<string | null>(null);
  const [paintedKey, setPaintedKey] = useState<string | null>(null);
  useEffect(() => {
    if (liveDraft) setHeldDraft(liveDraft);
    else if (!draft && (!live || (html && paintedKey === html.key && revision === null))) setHeldDraft(null);
  }, [liveDraft, draft, live, html, paintedKey, revision]);
  const draftLayer = revision === null ? (liveDraft ?? heldDraft) : null;

  const onPainted = useCallback((k: string) => setPaintedKey(k), []);
  const onOpen = useCallback((url: string) => setLink((current) => current ?? url), []);

  const current = html && html.key === key ? html.html : null;
  const versionItems = [
    { label: `v${latest}（最新）`, value: "latest" },
    ...[...artifacts]
      .reverse()
      .slice(1)
      .map((a) => ({ label: `v${a.revision} · ${new Date(a.createdAt).toLocaleTimeString()}`, value: String(a.revision) })),
  ];
  const width = DEVICE_WIDTH[device];

  const copy = async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  };
  const download = () => {
    if (!current) return;
    const url = URL.createObjectURL(new Blob([current], { type: "text/html" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `design-v${shown}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="preview">
      <div className="preview-toolbar">
        {artifacts.length > 0 ? (
          <Select
            items={versionItems}
            value={revision === null ? "latest" : String(revision)}
            onValueChange={(value) => onRevision(value === "latest" || value == null ? null : Number(value))}
          >
            <SelectTrigger size="sm" className="preview-version" aria-label="版本">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>版本</SelectLabel>
                {versionItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          <span className="preview-version muted">{draftLayer ? "生成中…" : "暂无版本"}</span>
        )}
        {draftLayer && liveDraft && <span className="preview-live">实时草稿</span>}
        <span className="grow" />
        <div className="segmented small" role="radiogroup" aria-label="设备宽度">
          {(
            [
              ["desktop", <Monitor key="d" size={14} />, "桌面"],
              ["tablet", <Tablet key="t" size={14} />, "平板"],
              ["mobile", <Smartphone key="m" size={14} />, "手机"],
            ] as const
          ).map(([value, icon, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={device === value}
              aria-label={label}
              title={label}
              className={device === value ? "on" : ""}
              onClick={() => setDevice(value)}
            >
              {icon}
            </button>
          ))}
        </div>
        <Button size="icon" title="重新加载" aria-label="重新加载" disabled={!current} icon={<RotateCw size={15} />} onClick={() => setNonce((n) => n + 1)} />
        <Button
          size="icon"
          title={copied ? "已复制" : "复制 HTML"}
          aria-label="复制 HTML"
          disabled={!current}
          icon={copied ? <Check size={15} /> : <Copy size={15} />}
          onClick={() => void copy()}
        />
        <Button size="icon" title="下载 HTML" aria-label="下载 HTML" disabled={!current} icon={<Download size={15} />} onClick={download} />
        <span className="preview-divider" aria-hidden="true" />
        <Button size="icon" title="关闭预览" aria-label="关闭预览" icon={<X size={16} />} onClick={onClose} />
      </div>

      <div className={`preview-stage ${width ? "framed" : ""}`}>
        <div className="preview-device" style={width ? { width: `min(100%, ${width}px)` } : undefined}>
          {current && key && <ArtifactFrame key={`${key}#${nonce}`} frameKey={key} html={current} onPainted={onPainted} onOpen={onOpen} />}
          {draftLayer && <DraftFrame html={draftLayer} />}
          {!current && !draftLayer && (
            <div className="preview-empty">
              {error ? <p className="error">{error}</p> : live ? <p>等待 agent 开始写页面…</p> : <p>这个会话还没有生成页面</p>}
            </div>
          )}
        </div>
      </div>

      {link && (
        <div className="preview-link" role="alertdialog" aria-label="打开外部链接">
          <ExternalLink size={15} />
          <span>
            页面请求打开 <b title={link}>{link}</b>
          </span>
          <Button size="sm" variant="secondary" onClick={() => setLink(null)}>
            忽略
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              window.open(link, "_blank", "noopener,noreferrer");
              setLink(null);
            }}
          >
            在新标签页打开
          </Button>
          <button type="button" className="preview-link-close" aria-label="关闭" onClick={() => setLink(null)}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Interactive published page: opaque-origin sandbox, embedded CSP, restored if it navigates itself away. */
function ArtifactFrame({
  frameKey,
  html,
  onPainted,
  onOpen,
}: {
  frameKey: string;
  html: string;
  onPainted: (key: string) => void;
  onOpen: (url: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [restores, setRestores] = useState(0);
  const token = useMemo(() => crypto.randomUUID(), [restores]); // eslint-disable-line react-hooks/exhaustive-deps
  const srcDoc = useMemo(
    () =>
      prepareArtifactHtml(html, token) ??
      `<!doctype html><html><body style="font:14px system-ui;padding:24px;color:#888">这个版本无法预览。</body></html>`,
    [html, token],
  );

  useEffect(() => {
    let lastBeat = Date.now();
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as FrameMessage | undefined;
      if (!data || data.token !== token) return;
      lastBeat = Date.now();
      if (data.type === "painted") onPainted(frameKey);
      // Only links the reader just clicked: user activation propagates to this window from the frame.
      if (data.type === "open" && navigator.userActivation?.isActive !== false) {
        const url = safeLinkUrl(data.url);
        if (url) onOpen(url);
      }
    };
    window.addEventListener("message", onMessage);
    const watchdog = setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - lastBeat > 3000) setRestores((n) => n + 1);
    }, 500);
    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(watchdog);
    };
  }, [token, frameKey, onPainted, onOpen]);

  return (
    <iframe
      ref={frame}
      key={token}
      title="页面预览"
      className="preview-frame"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
    />
  );
}

/** A scriptless picture of the page while it is written; patched in place so it never flashes. */
function DraftFrame({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const latest = useRef(html);
  latest.current = html;
  const pushed = useRef("");
  const lastPush = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [painted, setPainted] = useState(false);

  const schedule = useCallback(() => {
    if (!ready.current || timer.current || latest.current === pushed.current) return;
    timer.current = setTimeout(
      () => {
        timer.current = null;
        const doc = frame.current?.contentDocument;
        if (!doc || !ready.current) return;
        patchDraftDocument(doc, latest.current);
        pushed.current = latest.current;
        lastPush.current = Date.now();
        setPainted(true);
      },
      Math.max(0, 150 - (Date.now() - lastPush.current)),
    );
  }, []);

  useEffect(() => {
    schedule();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [html, schedule]);

  return (
    <iframe
      ref={frame}
      title="生成中的页面草稿"
      className={`preview-frame draft ${painted ? "" : "hidden"}`}
      srcDoc={EMPTY_DRAFT_DOCUMENT}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      onLoad={() => {
        ready.current = true;
        schedule();
      }}
    />
  );
}

/** A cut that ends before any body content would render blank, so the draft waits for the body. */
function renderable(html: string): boolean {
  const body = /<body[^>]*>/i.exec(html);
  return body != null && /<[a-z]/i.test(html.slice(body.index + body[0].length));
}
