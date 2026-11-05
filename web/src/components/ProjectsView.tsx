import { ArrowLeft, FolderClosed, MessageSquare, Plus, Search, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Project, SessionSummary } from "../api";
import { relativeTime } from "../lib/time";
import { Button } from "../ui";
import { sessionTitle } from "./Sidebar";

type Props = {
  projects: Project[];
  sessions: SessionSummary[];
  loading: boolean;
  /** The project being viewed; the index otherwise. */
  project?: Project;
  busy: boolean;
  onOpenProject: (project: Project | undefined) => void;
  onCreate: () => void;
  onEdit: (project: Project) => void;
  onNewChat: (project: Project) => void;
  onOpenSession: (id: string) => void;
};

/** Projects index (cards) and one project's page: its instructions and conversations. */
export function ProjectsView(props: Props) {
  const [query, setQuery] = useState("");
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of props.sessions) if (s.projectId) map.set(s.projectId, (map.get(s.projectId) ?? 0) + 1);
    return map;
  }, [props.sessions]);

  if (props.project) {
    const project = props.project;
    const sessions = props.sessions.filter((s) => s.projectId === project.id);
    return (
      <section className="page">
        <button type="button" className="page-back" onClick={() => props.onOpenProject(undefined)}>
          <ArrowLeft size={15} />
          全部项目
        </button>
        <header className="page-header">
          <h1 className="page-title" title={project.name}>{project.name}</h1>
          <div className="page-actions">
            <Button variant="outline" icon={<Settings2 size={15} />} disabled={props.busy} onClick={() => props.onEdit(project)}>
              设置
            </Button>
            <Button variant="primary" icon={<Plus size={16} />} disabled={props.busy} onClick={() => props.onNewChat(project)}>
              新会话
            </Button>
          </div>
        </header>
        <div className="project-instructions">
          <h2>项目指令</h2>
          {project.instructions.trim() ? (
            <p>{project.instructions}</p>
          ) : (
            <button type="button" className="link-button" disabled={props.busy} onClick={() => props.onEdit(project)}>
              添加项目指令
            </button>
          )}
        </div>
        <h2 className="page-section">会话 <span>{sessions.length}</span></h2>
        {sessions.length ? (
          <ul className="page-list">
            {sessions.map((s) => (
              <li key={s.id}>
                <button type="button" disabled={props.busy} onClick={() => props.onOpenSession(s.id)}>
                  <MessageSquare size={15} />
                  <span className="page-list-title">{sessionTitle(s)}</span>
                  <time dateTime={s.updatedAt}>{relativeTime(s.updatedAt)}</time>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="page-empty">还没有会话。</p>
        )}
      </section>
    );
  }

  const q = query.trim().toLowerCase();
  const visible = props.projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.instructions.toLowerCase().includes(q));
  return (
    <section className="page">
      <header className="page-header">
        <h1 className="page-title">项目</h1>
        <div className="page-actions">
          <Button variant="primary" icon={<Plus size={16} />} disabled={props.busy || props.loading} onClick={props.onCreate}>
            新建项目
          </Button>
        </div>
      </header>
      <label className="page-search">
        <Search size={16} />
        <input aria-label="搜索项目" placeholder="搜索项目" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {props.loading && !props.projects.length ? (
        <div className="card-grid" aria-label="加载中">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton page-card-skeleton" />)}
        </div>
      ) : visible.length ? (
        <div className="card-grid">
          {visible.map((p) => (
            <button key={p.id} type="button" className="page-card" onClick={() => props.onOpenProject(p)}>
              <span className="page-card-title"><FolderClosed size={15} />{p.name}</span>
              <span className="page-card-text">{p.instructions.trim() || "没有项目指令"}</span>
              <span className="page-card-meta">
                {counts.get(p.id) ?? 0} 个会话 · 更新于 {relativeTime(p.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="page-empty">{q ? "没有匹配的项目。" : "还没有项目。项目把相关会话和共享指令放在一起。"}</p>
      )}
    </section>
  );
}
