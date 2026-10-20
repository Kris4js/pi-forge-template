import { Activity, Database, KeyRound, ShieldAlert, Wrench, X } from "lucide-react";
import type { Agent, Identity } from "../api";
import type { Item } from "../conversation";
import { Button, CopyButton, formatTokens, LiveDot } from "../ui";

type Props = {
  agent?: Agent;
  identity: Identity;
  model?: string;
  sessionId?: string;
  runId?: string;
  items: Item[];
  onClose: () => void;
};

/** Right-hand inspector: what the gateway and runtime are doing for this conversation. */
export function DetailsPanel({ agent, identity, model, sessionId, runId, items, onClose }: Props) {
  const runs = items.filter((i): i is Extract<Item, { kind: "status" }> => i.kind === "status");
  const tools = items.filter((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool");
  const tokensIn = runs.reduce((s, r) => s + (r.usage?.inputTokens ?? 0), 0);
  const tokensOut = runs.reduce((s, r) => s + (r.usage?.outputTokens ?? 0), 0);
  const count = (status: string) => tools.filter((t) => t.status === status).length;

  return (
    <aside className="details" aria-label="运行详情">
      <header className="details-header">
        <strong>运行详情</strong>
        <Button size="icon" title="关闭详情" aria-label="关闭详情" icon={<X size={16} />} onClick={onClose} />
      </header>

      <section>
        <h3>
          <Activity size={13} />
          当前会话
        </h3>
        <dl>
          <dt>状态</dt>
          <dd>
            {runId ? (
              <>
                <LiveDot /> 运行中
              </>
            ) : (
              <>
                <LiveDot tone="muted" /> 空闲
              </>
            )}
          </dd>
          <dt>session</dt>
          <dd className="mono id">
            {sessionId ? (
              <>
                <span title={sessionId}>{sessionId.slice(0, 18)}…</span>
                <CopyButton text={sessionId} compact label="复制 sessionId" />
              </>
            ) : (
              "新会话（首条消息后创建）"
            )}
          </dd>
          {runId && (
            <>
              <dt>run</dt>
              <dd className="mono id">
                <span title={runId}>{runId.slice(0, 18)}…</span>
                <CopyButton text={runId} compact label="复制 runId" />
              </dd>
            </>
          )}
          <dt>模型</dt>
          <dd className="mono">{model ?? "—"}</dd>
        </dl>
        <div className="stats">
          <div>
            <b>{runs.length}</b>
            <span>轮次</span>
          </div>
          <div>
            <b>{tools.length}</b>
            <span>工具调用</span>
          </div>
          <div>
            <b>{formatTokens(tokensIn)}</b>
            <span>输入 tokens</span>
          </div>
          <div>
            <b>{formatTokens(tokensOut)}</b>
            <span>输出 tokens</span>
          </div>
        </div>
        {tools.length > 0 && (
          <div className="tool-tally">
            {(
              [
                ["success", "成功"],
                ["error", "失败"],
                ["denied", "拒绝"],
                ["pending", "待审批"],
                ["running", "执行中"],
              ] as const
            )
              .filter(([status]) => count(status) > 0)
              .map(([status, label]) => (
                <span key={status} className={`badge ${status}`}>
                  {label} {count(status)}
                </span>
              ))}
          </div>
        )}
        <p className="hint">统计范围为本页加载的消息；历史会话的 token 用量不会回放。</p>
      </section>

      {agent && (
        <section>
          <h3>
            <Wrench size={13} />
            工具与策略
          </h3>
          {agent.tools.length === 0 ? (
            <p className="hint">该 agent 没有工具。</p>
          ) : (
            <ul className="policy-list">
              {agent.tools.map((t) => {
                const ask = agent.approvalRequired.includes(t);
                return (
                  <li key={t}>
                    <span className="mono">{t}</span>
                    <span className={`badge ${ask ? "pending" : "success"}`}>
                      {ask ? <ShieldAlert size={11} /> : null}
                      {ask ? "ask" : "allow"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="hint">白名单之外的工具一律由 gateway 拒绝；文件类工具另受 runtime 路径沙箱限制。</p>
        </section>
      )}

      <section>
        <h3>
          <KeyRound size={13} />
          身份
        </h3>
        <dl>
          <dt>workspace</dt>
          <dd className="mono">{identity.workspace || "demo"}</dd>
          <dt>user</dt>
          <dd className="mono">{identity.userId || "anonymous"}</dd>
          <dt>认证</dt>
          <dd>{identity.apiKey ? "Bearer API key" : "dev 模式（无 key）"}</dd>
        </dl>
      </section>

      <section>
        <h3>
          <Database size={13} />
          存储
        </h3>
        <p className="hint mono small">
          .data/workspaces/{identity.workspace || "demo"}/users/{identity.userId || "anonymous"}/sessions/
        </p>
      </section>
    </aside>
  );
}
