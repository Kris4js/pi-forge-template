import { Search, Shapes } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Agent, Api, ArtifactEntry } from "../api";
import { thumbnailArtifactHtml } from "../lib/artifact-frame";
import { agentIcon } from "../lib/icons";
import { relativeTime } from "../lib/time";

type Props = {
  api: Api;
  agents: Agent[];
  busy: boolean;
  onOpen: (entry: ArtifactEntry) => void;
};

/** Every published page across the user's conversations, newest first; opening one opens its conversation. */
export function ArtifactsView({ api, agents, busy, onOpen }: Props) {
  const [entries, setEntries] = useState<ArtifactEntry[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");

  useEffect(() => {
    let active = true;
    setEntries(undefined);
    setError(undefined);
    api.allArtifacts().then((list) => { if (active) setEntries(list); }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [api]);

  const q = query.trim().toLowerCase();
  const visible = entries?.filter((e) => !q || e.sessionName.toLowerCase().includes(q));
  return (
    <section className="page">
      <header className="page-header">
        <h1 className="page-title">产物</h1>
      </header>
      <label className="page-search">
        <Search size={16} />
        <input aria-label="搜索产物" placeholder="搜索产物" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {error ? (
        <p className="page-empty error" role="alert">{error}</p>
      ) : !visible ? (
        <div className="card-grid artifacts" aria-label="加载中">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton artifact-card-skeleton" />)}
        </div>
      ) : visible.length ? (
        <div className="card-grid artifacts">
          {visible.map((entry) => {
            const agent = agents.find((a) => a.id === entry.agentId);
            return (
              <button key={entry.sessionId} type="button" className="artifact-card" disabled={busy} onClick={() => onOpen(entry)}>
                <Thumbnail api={api} entry={entry} />
                <span className="artifact-card-body">
                  <span className="artifact-card-title" title={entry.sessionName}>{entry.sessionName || "未命名会话"}</span>
                  <span className="page-card-meta">
                    {agent && <>{agentIcon(agent.id, 12)}{agent.name} · </>}
                    v{entry.revision} · {relativeTime(entry.createdAt)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="page-empty">{q ? "没有匹配的产物。" : "还没有产物。设计类 agent 发布的页面会出现在这里。"}</p>
      )}
    </section>
  );
}

/** A scriptless, non-interactive render of the page, loaded once the card scrolls into view. */
function Thumbnail({ api, entry }: { api: Api; entry: ArtifactEntry }) {
  const box = useRef<HTMLSpanElement>(null);
  const [html, setHtml] = useState<string | null>();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let active = true;
    const observer = new IntersectionObserver((records) => {
      if (!records.some((r) => r.isIntersecting)) return;
      observer.disconnect();
      api.artifact(entry.sessionId, entry.revision)
        .then((detail) => { if (active) setHtml(thumbnailArtifactHtml(detail.html)); })
        .catch(() => { if (active) setHtml(null); });
    }, { rootMargin: "200px" });
    observer.observe(el);
    return () => { active = false; observer.disconnect(); };
  }, [api, entry.sessionId, entry.revision]);

  // The page lays out at 1280px and is scaled down to the card width.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const resize = new ResizeObserver(([record]) => {
      if (record) el.style.setProperty("--thumb-scale", String(record.contentRect.width / 1280));
    });
    resize.observe(el);
    return () => resize.disconnect();
  }, []);

  return (
    <span ref={box} className="artifact-thumb" aria-hidden="true">
      {html ? (
        // Empty sandbox: no scripts, no same-origin, no forms; tabIndex keeps it out of keyboard order.
        <iframe title="" tabIndex={-1} sandbox="" referrerPolicy="no-referrer" srcDoc={html} loading="lazy" />
      ) : (
        <span className={`artifact-thumb-empty ${html === undefined ? "loading" : ""}`}><Shapes size={22} /></span>
      )}
    </span>
  );
}
