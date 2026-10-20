import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Agent } from "../api";
import { agentIcon, ClaudeMark } from "../lib/icons";

const SPRING = { type: "spring" as const, stiffness: 420, damping: 36 };

function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 13) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

type Props = {
  agents: Agent[];
  agentId?: string;
  userName: string;
  /** The composer, rendered centered under the greeting. */
  composer: ReactNode;
  onAgent: (id: string) => void;
  onPick: (prompt: string) => void;
};

/**
 * Empty-conversation screen: greeting, centered composer, and agent chips below it. Picking an agent
 * swaps the chips for a small card of that agent's starter prompts; picking one fills the composer.
 */
export function NewChat({ agents, agentId, userName, composer, onAgent, onPick }: Props) {
  const reduce = useReducedMotion();
  const [panel, setPanel] = useState<string>();
  const panelAgent = agents.find((a) => a.id === panel);

  return (
    <section className="new-chat-screen">
      <motion.h1
        className="greeting"
        initial={reduce ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING}
      >
        <ClaudeMark size={38} />
        <span>
          {greeting()}，{userName}
        </span>
      </motion.h1>

      {composer}

      <div className="new-chat-below">
        <AnimatePresence mode="wait" initial={false}>
          {panelAgent ? (
            <motion.div
              key="card"
              className="starter-card"
              initial={reduce ? false : { opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            >
              <header>
                {agentIcon(panelAgent.id, 14)}
                <span title={panelAgent.description}>{panelAgent.name}</span>
                <button type="button" className="starter-close" aria-label="关闭" onClick={() => setPanel(undefined)}>
                  <X size={16} />
                </button>
              </header>
              {panelAgent.starters.length ? (
                <ul>
                  {panelAgent.starters.map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        onClick={() => {
                          onPick(s);
                          setPanel(undefined);
                        }}
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="starter-empty">{panelAgent.description ?? "直接在上方输入问题即可开始。"}</p>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="chips"
              className="agent-chips"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              {agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`agent-chip ${a.id === agentId ? "selected" : ""}`}
                  aria-pressed={a.id === agentId}
                  title={a.description}
                  onClick={() => {
                    onAgent(a.id);
                    setPanel(a.id);
                  }}
                >
                  {agentIcon(a.id, 15)}
                  {a.name}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
