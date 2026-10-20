import { Anvil, MessageSquare, Plus, Search, Settings2, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Agent, Identity, SessionSummary } from "../api";
import { Button, LiveDot } from "../ui";
import { agentIcon } from "../lib/icons";

type Props = {
  agents: Agent[];
  agentId?: string;
  sessions: SessionSummary[];
  sessionId?: string;
  identity: Identity;
  model?: string;
  online: boolean;
  busy: boolean;
  onAgent: (id: string) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (session: SessionSummary) => void;
  onSettings: () => void;
  onClose?: () => void;
};

export function sessionTitle(s: SessionSummary) {
  const plain = (s.name || s.preview || "")
    .replace(/[#>*`~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain || "未命名会话";
}

function groupLabel(iso: string): string {
  const day = new Date(iso);
  const today = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return "近 7 天";
  if (diff < 30) return "近 30 天";
  return "更早";
}

export function Sidebar(props: Props) {
  const { agents, agentId, sessions, sessionId, identity, busy } = props;
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? sessions.filter((s) => sessionTitle(s).toLowerCase().includes(q)) : sessions;
    const map = new Map<string, SessionSummary[]>();
    for (const s of filtered) {
      const label = groupLabel(s.updatedAt);
      map.set(label, [...(map.get(label) ?? []), s]);
    }
    return [...map.entries()];
  }, [sessions, query]);

  const initials = (identity.userId || "?").slice(0, 2).toUpperCase();

  return (
    <div className="sidebar-inner">
      <div className="brand">
        <span className="brand-mark">
          <Anvil size={22} />
        </span>
        <strong>pi-forge</strong>
        <span className="brand-en">CONSOLE</span>
        {props.onClose && (
          <Button className="mobile-only" size="icon" aria-label="关闭侧栏" icon={<X size={18} />} onClick={props.onClose} />
        )}
      </div>

      <div className="section-heading">Agents</div>
      <nav className="agent-list" aria-label="agents">
        {agents.map((a) => (
          <button
            key={a.id}
            className={`agent-row ${a.id === agentId ? "selected" : ""}`}
            disabled={busy && a.id !== agentId}
            onClick={() => props.onAgent(a.id)}
            title={a.description}
          >
            <span className="agent-avatar">{agentIcon(a.id, 15)}</span>
            <span className="agent-text">
              <strong>{a.name}</strong>
              <small>
                {a.tools.length ? `${a.tools.length} 个工具` : "纯对话"}
                {a.approvalRequired.length ? ` · ${a.approvalRequired.length} 需审批` : ""}
              </small>
            </span>
          </button>
        ))}
        {agents.length === 0 && <div className="history-empty small">没有可用的 agent</div>}
      </nav>

      <Button className="new-chat" icon={<Plus size={17} />} disabled={busy} onClick={props.onNew}>
        新会话
        <kbd>⌘K</kbd>
      </Button>

      <label className="search">
        <Search size={15} />
        <input aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && (
          <button aria-label="清空搜索" onClick={() => setQuery("")}>
            <X size={13} />
          </button>
        )}
      </label>

      <nav className="history" aria-label="会话记录">
        {groups.map(([label, list]) => (
          <div key={label} className="history-group">
            <div className="history-heading">
              {label}
              <span>{list.length}</span>
            </div>
            {list.map((s) => (
              <div key={s.id} className={`session ${s.id === sessionId ? "selected" : ""}`}>
                <button
                  className="session-select"
                  aria-current={s.id === sessionId ? "page" : undefined}
                  disabled={busy && s.id !== sessionId}
                  onClick={() => props.onOpen(s.id)}
                  title={sessionTitle(s)}
                >
                  <MessageSquare size={14} />
                  <span>{sessionTitle(s)}</span>
                  <small>{s.messageCount}</small>
                </button>
                <div className="session-actions">
                  <Button
                    size="icon"
                    aria-label={`删除 ${sessionTitle(s)}`}
                    title="删除"
                    disabled={busy}
                    icon={<Trash2 size={13} />}
                    onClick={() => props.onDelete(s)}
                  />
                </div>
              </div>
            ))}
          </div>
        ))}
        {groups.length === 0 && (
          <div className="history-empty">
            <MessageSquare size={22} />
            <p>{query ? "没有找到相关会话" : "还没有会话"}</p>
            <small>{query ? "换个关键词试试" : "会话保存在 pi 的 JSONL 存储里"}</small>
          </div>
        )}
      </nav>

      <div className="sidebar-bottom">
        <button className="profile" onClick={props.onSettings} title="身份与偏好设置">
          <span className="avatar">{initials}</span>
          <span className="profile-text">
            {identity.userId || "anonymous"}
            <small>
              {identity.workspace || "demo"} · {identity.apiKey ? "API key" : "dev 模式"}
            </small>
          </span>
          <span className="profile-status" title={props.online ? `runtime 在线 · ${props.model ?? ""}` : "无法连接 gateway"}>
            <LiveDot tone={props.online ? "ok" : "danger"} />
          </span>
          <Settings2 size={15} className="profile-gear" />
        </button>
      </div>
    </div>
  );
}
