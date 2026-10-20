import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { AppWindow, ArrowDown, Monitor, Moon, PanelLeft, PanelRight, Sun, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Api, type Agent, type ArtifactSummary, type Identity, type SessionSummary } from "./api";
import { Composer, type ComposerHandle } from "./components/Composer";
import { DetailsPanel } from "./components/DetailsPanel";
import { PreviewLink, PreviewPanel } from "./components/PreviewPanel";
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
const PREVIEW_WIDTH_KEY = "pi-forge.preview-width";

type PanelTab = "preview" | "details";

const defaultPreviewWidth = () => Math.round(Math.min(Math.max(window.innerWidth * 0.42, 380), 1000));

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
  const [panel, setPanel] = useState<PanelTab | null>(() => (readStored(DETAILS_KEY, false) ? "details" : null));
  const [previewWidth, setPreviewWidth] = useState(() => readStored(PREVIEW_WIDTH_KEY, defaultPreviewWidth()));
  const [resizing, setResizing] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
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
    store(DETAILS_KEY, panel === "details");
  }, [panel]);

  useEffect(() => {
    if (!resizing) store(PREVIEW_WIDTH_KEY, previewWidth);
  }, [previewWidth, resizing]);

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

  // Sessions belong to the user and mix all agents; each row carries the agent it is bound to.
  const refreshSessions = useCallback(() => {
    api
      .sessions()
      .then(setSessions)
      .catch((e: Error) => setNotice(e.message));
  }, [api]);

  const clearPreview = useCallback(() => {
    setArtifacts([]);
    setPreviewRevision(null);
    setDraft(null);
    setPanel((p) => (p === "preview" ? null : p));
  }, []);

  useEffect(() => {
    setSessionId(undefined);
    setItems([]);
    clearPreview();
    refreshSessions();
  }, [refreshSessions, clearPreview]);

  const newChat = useCallback(() => {
    if (busy) return;
    setSessionId(undefined);
    setItems([]);
    clearPreview();
    setMobileNav(false);
    composer.current?.focus();
  }, [busy, clearPreview]);

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
    if (busy) return;
    setMobileNav(false);
    setSessionId(id);
    setLoadingSession(true);
    try {
      const [detail, list] = await Promise.all([api.session(id), api.artifacts(id)]);
      // A session is continued by the agent it was started with.
      if (detail.agentId && agents.some((a) => a.id === detail.agentId)) setAgentId(detail.agentId);
      setItems(fromTranscript(detail.messages));
      setArtifacts(list);
      setPreviewRevision(null);
      setDraft(null);
      setPanel((p) => (list.length ? "preview" : p === "preview" ? null : p));
      requestAnimationFrame(() => scroll.scrollToBottom(false));
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setLoadingSession(false);
    }
  }

  async function updateSession(session: SessionSummary, update: { name?: string; pinned?: boolean }) {
    // Optimistic: reflect the change at once, then reconcile with the server's order.
    setSessions((list) => list.map((s) => (s.id === session.id ? { ...s, ...update } : s)));
    try {
      await api.updateSession(session.id, update);
    } catch (e) {
      const err = e as Error & { status?: number };
      setNotice(err.status === 409 ? "会话正在运行，结束后再重命名" : err.message);
    }
    refreshSessions();
  }

  async function confirmDelete(session: SessionSummary) {
    try {
      await api.deleteSession(session.id);
      if (session.id === sessionId) {
        setSessionId(undefined);
        setItems([]);
        clearPreview();
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
    let runSession = sessionId;
    let previewOpened = false;
    try {
      await api.run(
        { agentId, sessionId, text },
        (event) => {
          if (event.type === "run") {
            setRunId(event.runId);
            setSessionId(event.sessionId);
            runSession = event.sessionId;
          } else if (event.type === "run_started") {
            runModel = event.model;
            setSessionId(event.sessionId);
            runSession = event.sessionId;
          } else if (event.type === "artifact_draft") {
            setDraft((prev) => (event.offset === 0 ? event.delta : (prev ?? "").slice(0, event.offset) + event.delta));
            // Open the preview once per run when the page starts streaming; a reader who closes it keeps it closed.
            if (!previewOpened) {
              previewOpened = true;
              setPreviewRevision(null);
              setPanel("preview");
            }
          } else {
            if (event.type === "artifact" && runSession) {
              const sid = runSession;
              api
                .artifacts(sid)
                .then((list) => {
                  setArtifacts(list);
                  setPreviewRevision(null);
                  setDraft(null);
                })
                .catch((e: Error) => setNotice(e.message));
            }
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
      setDraft(null);
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
  const canPreview = !!agent?.preview || artifacts.length > 0;
  const panelWidth = panel === "preview" ? previewWidth : DETAILS_WIDTH;

  const openPreviewAt = (revision: number) => {
    setPreviewRevision(revision === artifacts.at(-1)?.revision ? null : revision);
    setPanel("preview");
  };

  // Drag the panel's left edge. Iframes would swallow the pointer, so they ignore it while resizing.
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = previewWidth;
    const max = Math.max(380, window.innerWidth - 264 - 420);
    setResizing(true);
    const move = (ev: PointerEvent) => setPreviewWidth(Math.round(Math.min(max, Math.max(340, startWidth + startX - ev.clientX))));
    const up = () => {
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
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
      sessions={sessions}
      sessionId={sessionId}
      identity={identity}
      model={model}
      online={online}
      busy={busy}
      runningSessionId={busy ? sessionId : undefined}
      onNew={newChat}
      onOpen={(id) => void openSession(id)}
      onDelete={(session) => setModal({ kind: "delete", session })}
      onRename={(session, name) => void updateSession(session, { name })}
      onPin={(session, pinned) => void updateSession(session, { pinned })}
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
              {canPreview && (
                <Button
                  size="icon"
                  title="页面预览"
                  aria-label="页面预览"
                  aria-pressed={panel === "preview"}
                  className={panel === "preview" ? "active" : ""}
                  icon={<AppWindow size={17} />}
                  onClick={() => setPanel((p) => (p === "preview" ? null : "preview"))}
                />
              )}
              <Button
                size="icon"
                title="运行详情"
                aria-label="运行详情"
                aria-pressed={panel === "details"}
                className={panel === "details" ? "active" : ""}
                icon={<PanelRight size={17} />}
                onClick={() => setPanel((p) => (p === "details" ? null : "details"))}
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
                <PreviewLink.Provider value={openPreviewAt}>
                  <MessageList
                    items={items}
                    agentName={agent?.name ?? "agent"}
                    busy={busy}
                    onDecide={runId ? decide : undefined}
                    onRetry={busy ? undefined : (text) => void send(text)}
                  />
                </PreviewLink.Provider>
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
          {panel && (
            <motion.div
              className={`details-wrap ${resizing ? "resizing" : ""}`}
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: panelWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={resizing ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              <aside className="side-panel" style={{ width: panelWidth }} aria-label="侧栏">
                {panel === "preview" && (
                  <div
                    className="panel-resizer"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整预览宽度"
                    onPointerDown={startResize}
                  />
                )}
                <div className="side-body">
                  {panel === "preview" ? (
                    <PreviewPanel
                      api={api}
                      sessionId={sessionId}
                      artifacts={artifacts}
                      revision={previewRevision}
                      onRevision={setPreviewRevision}
                      draft={draft}
                      live={busy}
                      onClose={() => setPanel(null)}
                    />
                  ) : (
                    <DetailsPanel
                      agent={agent}
                      identity={identity}
                      model={model}
                      sessionId={sessionId}
                      runId={runId}
                      items={items}
                      onClose={() => setPanel(null)}
                    />
                  )}
                </div>
              </aside>
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
