import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { ArrowDown, Monitor, Moon, PanelLeft, PanelRight, Sun, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Api, type Agent, type Identity, type SessionSummary } from "./api";
import { Composer, type ComposerHandle } from "./components/Composer";
import { DetailsPanel } from "./components/DetailsPanel";
import { MessageList } from "./components/MessageList";
import { Sidebar, sessionTitle } from "./components/Sidebar";
import { NewChat } from "./components/NewChat";
import { agentIcon } from "./lib/icons";
import { applyEvent, fromTranscript, userItem, type Item } from "./conversation";
import { useScrollPinning } from "./hooks/useScrollPinning";
import { Button, LiveDot, Modal } from "./ui";

type Theme = "light" | "dark" | "system";

const IDENTITY_KEY = "pi-forge.identity";
const THEME_KEY = "pi-forge.theme";
const DETAILS_KEY = "pi-forge.details";
const DETAILS_WIDTH = 300;

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: preferences just won't persist
  }
}

export function App() {
  const [identity, setIdentity] = useState<Identity>(() =>
    readStored(IDENTITY_KEY, { workspace: "demo", userId: "alice", apiKey: "" }),
  );
  const [theme, setTheme] = useState<Theme>(() => readStored(THEME_KEY, "system"));
  const [showDetails, setShowDetails] = useState(() => readStored(DETAILS_KEY, false));
  const api = useMemo(() => new Api(identity), [identity]);

  const [model, setModel] = useState<string>();
  const [online, setOnline] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<string>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<{ kind: "settings" } | { kind: "delete"; session: SessionSummary }>();
  const [loadingSession, setLoadingSession] = useState(false);

  const abortRef = useRef<AbortController>();
  const composer = useRef<ComposerHandle>(null);
  const scroll = useScrollPinning([items]);
  const agent = agents.find((a) => a.id === agentId);
  const currentSession = sessions.find((s) => s.id === sessionId);

  // Theme: explicit choice or follow the OS.
  useEffect(() => {
    store(THEME_KEY, theme);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && media.matches));
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    store(DETAILS_KEY, showDetails);
  }, [showDetails]);

  useEffect(() => {
    store(IDENTITY_KEY, identity);
    setNotice(undefined);
    api
      .me()
      .then((me) => {
        setModel(me.runtime.model);
        setOnline(true);
      })
      .catch((e: Error) => {
        setOnline(false);
        setNotice(`无法连接 gateway：${e.message}`);
      });
    api
      .agents()
      .then((list) => {
        setAgents(list);
        setAgentId((current) => (list.some((a) => a.id === current) ? current : list[0]?.id));
      })
      .catch((e: Error) => setNotice(e.message));
  }, [api, identity]);

  const refreshSessions = useCallback(() => {
    if (!agentId) return;
    api
      .sessions(agentId)
      .then(setSessions)
      .catch((e: Error) => setNotice(e.message));
  }, [api, agentId]);

  useEffect(() => {
    setSessionId(undefined);
    setItems([]);
    refreshSessions();
  }, [refreshSessions]);

  const newChat = useCallback(() => {
    if (busy) return;
    setSessionId(undefined);
    setItems([]);
    setMobileNav(false);
    composer.current?.focus();
  }, [busy]);

  // ⌘K / Ctrl+K: new conversation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        newChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat]);

  async function openSession(id: string) {
    if (!agentId || busy) return;
    setMobileNav(false);
    setSessionId(id);
    setLoadingSession(true);
    try {
      const detail = await api.session(agentId, id);
      setItems(fromTranscript(detail.messages));
      requestAnimationFrame(() => scroll.scrollToBottom(false));
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setLoadingSession(false);
    }
  }

  async function confirmDelete(session: SessionSummary) {
    if (!agentId) return;
    try {
      await api.deleteSession(agentId, session.id);
      if (session.id === sessionId) {
        setSessionId(undefined);
        setItems([]);
      }
      refreshSessions();
    } catch (e) {
      setNotice((e as Error).message);
    }
    setModal(undefined);
  }

  async function send(text: string) {
    if (!agentId || !text.trim() || busy) return;
    setNotice(undefined);
    setItems((prev) => [...prev, userItem(text)]);
    requestAnimationFrame(() => scroll.scrollToBottom(true));
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    const startedAt = Date.now();
    let runModel: string | undefined;
    try {
      await api.run(
        { agentId, sessionId, text },
        (event) => {
          if (event.type === "run") {
            setRunId(event.runId);
            setSessionId(event.sessionId);
          } else if (event.type === "run_started") {
            runModel = event.model;
            setSessionId(event.sessionId);
          } else {
            setItems((prev) => applyEvent(prev, event, { now: Date.now(), model: runModel, runStartedAt: startedAt }));
          }
        },
        controller.signal,
      );
    } catch (e) {
      if (!controller.signal.aborted) setNotice((e as Error).message);
    } finally {
      abortRef.current = undefined;
      setBusy(false);
      setRunId(undefined);
      refreshSessions();
    }
  }

  async function stop() {
    if (runId) await api.cancel(runId).catch(() => abortRef.current?.abort());
    else abortRef.current?.abort();
  }

  async function decide(toolCallId: string, decision: "approve" | "reject") {
    if (!runId) return;
    try {
      await api.decide(runId, toolCallId, decision);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  const isNewChat = items.length === 0 && !loadingSession;
  const composerEl = (
    <Composer
      ref={composer}
      agent={agent}
      model={model}
      busy={busy}
      autoFocus={isNewChat}
      placeholder={isNewChat ? "今天我能为您做些什么？" : undefined}
      onSend={(t) => void send(t)}
      onStop={() => void stop()}
    />
  );

  const sidebar = (onClose?: () => void) => (
    <Sidebar
      agents={agents}
      agentId={agentId}
      sessions={sessions}
      sessionId={sessionId}
      identity={identity}
      model={model}
      online={online}
      busy={busy}
      onAgent={(id) => {
        setAgentId(id);
        setMobileNav(false);
      }}
      onNew={newChat}
      onOpen={(id) => void openSession(id)}
      onDelete={(session) => setModal({ kind: "delete", session })}
      onSettings={() => {
        setMobileNav(false);
        setModal({ kind: "settings" });
      }}
      onClose={onClose}
    />
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className="app">
        <aside className="sidebar">{sidebar()}</aside>

        <AnimatePresence>
          {mobileNav && (
            <motion.div
              className="drawer-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileNav(false)}
            >
              <motion.aside
                className="drawer"
                initial={{ x: -300 }}
                animate={{ x: 0 }}
                exit={{ x: -300 }}
                transition={{ type: "spring", stiffness: 420, damping: 40 }}
                onClick={(e) => e.stopPropagation()}
              >
                {sidebar(() => setMobileNav(false))}
              </motion.aside>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="workspace">
        <main className="main">
          <header className="topbar">
            <div className="top-title">
              <Button
                className="mobile-only"
                size="icon"
                aria-label="打开侧栏"
                icon={<PanelLeft size={19} />}
                onClick={() => setMobileNav(true)}
              />
              {agent && (
                <span className="top-agent">
                  {agentIcon(agent.id, 15)}
                  {agent.name}
                </span>
              )}
              <span className="top-sep">/</span>
              <span className="top-session">
                {currentSession ? sessionTitle(currentSession) : sessionId ? "当前会话" : "新会话"}
              </span>
            </div>
            <div className="top-right">
              <span className={`model-badge ${online ? "" : "offline"}`} title={online ? "runtime 在线" : "gateway 不可达"}>
                <LiveDot tone={online ? (busy ? "clay" : "ok") : "danger"} />
                <span className="mono">{online ? (model ?? "pi default") : "离线"}</span>
              </span>
              <Button
                size="icon"
                title="切换主题"
                aria-label="切换主题"
                icon={theme === "dark" ? <Moon size={17} /> : theme === "light" ? <Sun size={17} /> : <Monitor size={17} />}
                onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")}
              />
              <Button
                size="icon"
                title="运行详情"
                aria-label="运行详情"
                aria-pressed={showDetails}
                className={showDetails ? "active" : ""}
                icon={<PanelRight size={17} />}
                onClick={() => setShowDetails((v) => !v)}
              />
            </div>
          </header>

          <div
            className="scroll-area"
            ref={scroll.containerRef}
            onScroll={scroll.onScroll}
            onWheel={scroll.markUserInput}
            onTouchMove={scroll.markUserInput}
            tabIndex={0}
            aria-label="对话内容"
          >
            <div className={`reading-column ${isNewChat ? "empty-column" : ""}`}>
              {loadingSession ? (
                <div className="skeletons" aria-label="加载中">
                  {[70, 92, 54, 80].map((w, i) => (
                    <div key={i} className="skeleton" style={{ width: `${w}%` }} />
                  ))}
                </div>
              ) : isNewChat ? (
                <NewChat
                  agents={agents}
                  agentId={agentId}
                  userName={identity.userId || "你"}
                  composer={composerEl}
                  onAgent={setAgentId}
                  onPick={(text) => composer.current?.fill(text)}
                />
              ) : (
                <MessageList
                  items={items}
                  agentName={agent?.name ?? "agent"}
                  busy={busy}
                  onDecide={runId ? decide : undefined}
                  onRetry={busy ? undefined : (text) => void send(text)}
                />
              )}
            </div>
          </div>

          <div className="composer-zone">
            <AnimatePresence>
              {scroll.showJump && (
                <motion.div
                  className="jump"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                >
                  <Button variant="secondary" size="sm" icon={<ArrowDown size={14} />} onClick={() => scroll.scrollToBottom(true)}>
                    回到最新
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
            {notice && (
              <div className="notice" role="alert">
                <span>{notice}</span>
                <Button size="icon" aria-label="关闭提示" icon={<X size={14} />} onClick={() => setNotice(undefined)} />
              </div>
            )}
            {!isNewChat && composerEl}
          </div>
        </main>

        <AnimatePresence>
          {showDetails && (
            <motion.div
              className="details-wrap"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: DETAILS_WIDTH, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              <DetailsPanel
                agent={agent}
                identity={identity}
                model={model}
                sessionId={sessionId}
                runId={runId}
                items={items}
                onClose={() => setShowDetails(false)}
              />
            </motion.div>
          )}
        </AnimatePresence>
        </div>
      </div>

      {modal?.kind === "settings" && (
        <SettingsModal
          identity={identity}
          theme={theme}
          onTheme={setTheme}
          onSave={(next) => {
            setIdentity(next);
            setModal(undefined);
          }}
          onClose={() => setModal(undefined)}
        />
      )}
      {modal?.kind === "delete" && (
        <Modal title="删除这段会话？" onClose={() => setModal(undefined)}>
          <p className="modal-description">
            「{sessionTitle(modal.session)}」的 pi 会话文件（{modal.session.messageCount} 条记录）将被永久删除，无法恢复。
          </p>
          <div className="modal-actions">
            <Button variant="secondary" autoFocus onClick={() => setModal(undefined)}>
              保留
            </Button>
            <Button variant="danger" onClick={() => void confirmDelete(modal.session)}>
              确认删除
            </Button>
          </div>
        </Modal>
      )}
    </MotionConfig>
  );
}

function SettingsModal({
  identity,
  theme,
  onTheme,
  onSave,
  onClose,
}: {
  identity: Identity;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onSave: (identity: Identity) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(identity);
  const themes: { value: Theme; label: string; icon: JSX.Element }[] = [
    { value: "light", label: "浅色", icon: <Sun size={14} /> },
    { value: "dark", label: "深色", icon: <Moon size={14} /> },
    { value: "system", label: "跟随系统", icon: <Monitor size={14} /> },
  ];
  return (
    <Modal title="身份与偏好" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ workspace: draft.workspace.trim(), userId: draft.userId.trim(), apiKey: draft.apiKey.trim() });
        }}
      >
        <p className="modal-description">
          身份由 gateway 解析：携带 API key 时以 key 绑定的租户为准；dev 模式（FORGE_DEV_AUTH=1）下直接使用下面的 workspace / user。
        </p>
        <div className="field-grid">
          <label className="field">
            Workspace
            <input value={draft.workspace} onChange={(e) => setDraft({ ...draft, workspace: e.target.value })} placeholder="demo" />
          </label>
          <label className="field">
            User ID
            <input value={draft.userId} onChange={(e) => setDraft({ ...draft, userId: e.target.value })} placeholder="anonymous" />
          </label>
        </div>
        <label className="field">
          API key
          <input
            type="password"
            autoComplete="off"
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            placeholder="dev 模式可留空"
          />
        </label>
        <div className="field">
          主题
          <div className="segmented" role="radiogroup">
            {themes.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={theme === t.value}
                className={theme === t.value ? "on" : ""}
                onClick={() => onTheme(t.value)}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary">
            保存并重新连接
          </Button>
        </div>
      </form>
    </Modal>
  );
}
