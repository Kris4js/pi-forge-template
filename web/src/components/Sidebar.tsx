import { Anvil, Check, ChevronDown, MoreVertical, Pin, Plus, Search, Settings2, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, Identity, SessionSummary } from "../api";
import { agentIcon } from "../lib/icons";
import { Button, LiveDot } from "../ui";
import { SessionMenu } from "./SessionMenu";

const COLLAPSED_KEY = "pi-forge.history-collapsed";

type Props = {
  /** For the agent filter. */
  agents: Agent[];
  sessions: SessionSummary[];
  sessionId?: string;
  /** The session a run is streaming in, if any. */
  runningSessionId?: string;
  identity: Identity;
  model?: string;
  online: boolean;
  busy: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (session: SessionSummary) => void;
  onRename: (session: SessionSummary, name: string) => void;
  onPin: (session: SessionSummary, pinned: boolean) => void;
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

export function Sidebar(props: Props) {
  const { agents, sessions, sessionId, identity, busy } = props;
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>();
  const [filterOpen, setFilterOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [menu, setMenu] = useState<{ session: SessionSummary; anchor: HTMLElement }>();
  const [renaming, setRenaming] = useState<string>();

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // preference only
    }
  }, [collapsed]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter(
      (s) => (!agentFilter || s.agentId === agentFilter) && (!q || sessionTitle(s).toLowerCase().includes(q)),
    );
  }, [sessions, query, agentFilter]);

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

      <div className="history-header">
        <button
          type="button"
          className="history-toggle"
          aria-expanded={!collapsed}
          aria-controls="history-list"
          onClick={() => setCollapsed((v) => !v)}
        >
          对话和任务
          <ChevronDown size={14} className={collapsed ? "collapsed" : ""} />
        </button>
        <div className="history-tools">
          <button
            type="button"
            className={`history-tool ${agentFilter ? "on" : ""}`}
            aria-label="按 agent 筛选"
            title="按 agent 筛选"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((v) => !v)}
          >
            <SlidersHorizontal size={15} />
          </button>
          {filterOpen && (
            <AgentFilter
              agents={agents}
              value={agentFilter}
              onChange={(id) => {
                setAgentFilter(id);
                setFilterOpen(false);
              }}
              onClose={() => setFilterOpen(false)}
            />
          )}
        </div>
      </div>

      {/* Collapsing hides the rows only: the list keeps its space so the profile stays at the bottom. */}
      <nav id="history-list" className="history" aria-label="对话和任务">
        {!collapsed && visible.map((s) => {
          const selected = s.id === sessionId;
          const running = s.id === props.runningSessionId;
          const menuOpen = menu?.session.id === s.id;
          return (
            <div key={s.id} className={`session ${selected ? "selected" : ""} ${menuOpen ? "menu-open" : ""}`}>
              {renaming === s.id ? (
                <RenameInput
                  initial={sessionTitle(s)}
                  onDone={(name) => {
                    setRenaming(undefined);
                    if (name && name !== sessionTitle(s)) props.onRename(s, name);
                  }}
                />
              ) : (
                <button
                  className="session-select"
                  aria-current={selected ? "page" : undefined}
                  disabled={busy && !selected}
                  onClick={() => props.onOpen(s.id)}
                  title={sessionTitle(s)}
                >
                  <span className={`session-dot ${running ? "running" : ""}`} aria-hidden="true">
                    {s.pinned && !running ? <Pin size={11} /> : null}
                  </span>
                  <span className="session-title">{sessionTitle(s)}</span>
                </button>
              )}
              {renaming !== s.id && (
                <button
                  type="button"
                  className="session-more"
                  aria-label={`${sessionTitle(s)} 的更多操作`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={(e) => setMenu(menuOpen ? undefined : { session: s, anchor: e.currentTarget })}
                >
                  <MoreVertical size={15} />
                </button>
              )}
            </div>
          );
        })}
      </nav>

      {menu && (
        <SessionMenu
          anchor={menu.anchor}
          pinned={!!menu.session.pinned}
          onPin={() => props.onPin(menu.session, !menu.session.pinned)}
          onRename={() => setRenaming(menu.session.id)}
          onDelete={() => props.onDelete(menu.session)}
          onClose={() => setMenu(undefined)}
        />
      )}

      <div className="sidebar-bottom">
        <button className="profile" onClick={props.onSettings} title="身份与偏好设置">
          <span className="avatar">{initials}</span>
          <span className="profile-text">{identity.userId || "anonymous"}</span>
          <span className="profile-status" title={props.online ? `runtime 在线 · ${props.model ?? ""}` : "无法连接 gateway"}>
            <LiveDot tone={props.online ? "ok" : "danger"} />
          </span>
          <Settings2 size={15} className="profile-gear" />
        </button>
      </div>
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <input
      ref={input}
      className="session-rename"
      aria-label="会话名称"
      value={value}
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") finish(value.trim() || null);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value.trim() || null)}
    />
  );
}

function AgentFilter({
  agents,
  value,
  onChange,
  onClose,
}: {
  agents: Agent[];
  value?: string;
  onChange: (id: string | undefined) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!box.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const options: Array<{ id?: string; label: string; icon?: JSX.Element }> = [
    { label: "全部" },
    ...agents.map((a) => ({ id: a.id, label: a.name, icon: agentIcon(a.id, 14) })),
  ];
  return (
    <div ref={box} className="session-menu filter-menu" role="menu">
      {options.map((o) => (
        <button key={o.id ?? "all"} type="button" role="menuitemradio" aria-checked={value === o.id} onClick={() => onChange(o.id)}>
          {o.icon ?? <span className="filter-spacer" />}
          <span>{o.label}</span>
          {value === o.id && <Check size={14} />}
        </button>
      ))}
    </div>
  );
}
