// Package runs is the run-governance core: admission (global / per-workspace concurrency, one
// active run per session), deadlines, tool-call authorization including human approval, the
// per-run event log that HTTP streams from, and the audit trail.
package runs

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"pi-forge/gateway/internal/agents"
	"pi-forge/gateway/internal/auth"
	"pi-forge/gateway/internal/ipc"
	"pi-forge/gateway/internal/policy"
)

var (
	ErrBusy        = errors.New("too many concurrent runs")
	ErrSessionBusy = errors.New("session already has an active run")
	ErrNotFound    = errors.New("run not found")
	ErrForbidden   = errors.New("run belongs to another tenant")
	ErrNoApproval  = errors.New("no pending approval for this tool call")
)

// Caller is the runtime connection (ipc.Supervisor).
type Caller interface {
	Call(ctx context.Context, method string, params, out any) error
}

type Limits struct {
	MaxConcurrent   int
	MaxPerWorkspace int
	RunTimeout      time.Duration
	ApprovalTimeout time.Duration
	// How long finished runs stay readable (event replay, late approvals get a clear 404 after).
	Retention time.Duration
}

type Manager struct {
	rt     Caller
	limits Limits
	log    *slog.Logger

	mu           sync.Mutex
	runs         map[string]*Run
	sessions     map[string]string // session key -> run id
	perWorkspace map[string]int
	active       int
}

func NewManager(rt Caller, limits Limits, log *slog.Logger) *Manager {
	if limits.Retention == 0 {
		limits.Retention = 5 * time.Minute
	}
	return &Manager{rt: rt, limits: limits, log: log, runs: map[string]*Run{}, sessions: map[string]string{}, perWorkspace: map[string]int{}}
}

type StartRequest struct {
	Principal auth.Principal
	Agent     agents.Manifest
	SessionID string
	Text      string
}

func (m *Manager) Start(ctx context.Context, req StartRequest) (*Run, error) {
	run := newRun(newID(), req.Principal.Tenant, req.Agent, req.SessionID)
	if err := m.admit(run); err != nil {
		return nil, err
	}

	timeout := req.Agent.Timeout(m.limits.RunTimeout)
	run.ctx, run.cancel = context.WithTimeout(context.Background(), timeout)
	go m.watchDeadline(run)

	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var result ipc.RunStartResult
	err := m.rt.Call(callCtx, ipc.MethodRunStart, ipc.RunStartParams{
		SessionScope: ipc.SessionScope{Tenant: run.Tenant, AgentID: run.AgentID},
		RunID:        run.ID,
		SessionID:    req.SessionID,
		Input:        ipc.RunInput{Text: req.Text},
	}, &result)
	if err != nil {
		m.release(run)
		run.cancel()
		return nil, err
	}

	m.mu.Lock()
	run.SessionID = result.SessionID
	if req.SessionID == "" {
		m.sessions[sessionKey(run)] = run.ID
	}
	m.mu.Unlock()
	m.log.Info("audit: run started", "run", run.ID, "workspace", run.Tenant.Workspace, "user", run.Tenant.UserID,
		"agent", run.AgentID, "session", run.SessionID, "key", req.Principal.KeyID, "timeout", timeout)
	return run, nil
}

func (m *Manager) admit(run *Run) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.limits.MaxConcurrent > 0 && m.active >= m.limits.MaxConcurrent {
		return ErrBusy
	}
	if m.limits.MaxPerWorkspace > 0 && m.perWorkspace[run.Tenant.Workspace] >= m.limits.MaxPerWorkspace {
		return ErrBusy
	}
	if run.SessionID != "" {
		if _, busy := m.sessions[sessionKey(run)]; busy {
			return ErrSessionBusy
		}
		m.sessions[sessionKey(run)] = run.ID
	}
	m.active++
	m.perWorkspace[run.Tenant.Workspace]++
	m.runs[run.ID] = run
	return nil
}

func (m *Manager) release(run *Run) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if run.released {
		return
	}
	run.released = true
	m.active--
	m.perWorkspace[run.Tenant.Workspace]--
	if m.perWorkspace[run.Tenant.Workspace] <= 0 {
		delete(m.perWorkspace, run.Tenant.Workspace)
	}
	if run.SessionID != "" && m.sessions[sessionKey(run)] == run.ID {
		delete(m.sessions, sessionKey(run))
	}
	if !run.isDone() {
		// Start failed before the runtime accepted it.
		delete(m.runs, run.ID)
		return
	}
	time.AfterFunc(m.limits.Retention, func() {
		m.mu.Lock()
		delete(m.runs, run.ID)
		m.mu.Unlock()
	})
}

func (m *Manager) watchDeadline(run *Run) {
	<-run.ctx.Done()
	if !errors.Is(run.ctx.Err(), context.DeadlineExceeded) || run.isDone() {
		return
	}
	run.mu.Lock()
	run.timedOut = true
	run.mu.Unlock()
	m.log.Warn("audit: run deadline exceeded", "run", run.ID)
	m.cancelRuntime(run)
}

// Get returns a run the principal may access.
func (m *Manager) Get(p auth.Principal, runID string) (*Run, error) {
	m.mu.Lock()
	run := m.runs[runID]
	m.mu.Unlock()
	if run == nil {
		return nil, ErrNotFound
	}
	if !p.SameTenant(run.Tenant) {
		return nil, ErrForbidden
	}
	return run, nil
}

func (m *Manager) Cancel(p auth.Principal, runID string) error {
	run, err := m.Get(p, runID)
	if err != nil {
		return err
	}
	m.log.Info("audit: run cancel requested", "run", runID, "by", p.Tenant.UserID)
	m.cancelRuntime(run)
	return nil
}

func (m *Manager) cancelRuntime(run *Run) {
	if run.isDone() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := m.rt.Call(ctx, ipc.MethodRunCancel, map[string]string{"runId": run.ID}, nil); err != nil {
		m.log.Error("run.cancel failed", "run", run.ID, "err", err)
	}
}

// Decide resolves a pending approval.
func (m *Manager) Decide(p auth.Principal, runID, toolCallID string, approve bool, reason string) error {
	run, err := m.Get(p, runID)
	if err != nil {
		return err
	}
	run.mu.Lock()
	ch := run.approvals[toolCallID]
	delete(run.approvals, toolCallID)
	run.mu.Unlock()
	if ch == nil {
		return ErrNoApproval
	}
	ch <- approval{approve: approve, reason: reason, by: p.Tenant.UserID}
	return nil
}

// Authorize serves tool.authorize from the runtime. Every decision is audited.
func (m *Manager) Authorize(ctx context.Context, params ipc.ToolAuthorizeParams) ipc.ToolAuthorizeResult {
	m.mu.Lock()
	run := m.runs[params.RunID]
	m.mu.Unlock()
	if run == nil || run.isDone() {
		return ipc.ToolAuthorizeResult{Decision: "deny", Reason: "unknown run"}
	}

	run.mu.Lock()
	decision, reason := policy.ToolDecision(run.Manifest, params.ToolName, run.toolCalls)
	run.toolCalls++
	run.mu.Unlock()
	audit := func(final, why string) {
		m.log.Info("audit: tool decision", "run", run.ID, "workspace", run.Tenant.Workspace, "user", run.Tenant.UserID,
			"agent", run.AgentID, "tool", params.ToolName, "toolCall", params.ToolCallID, "policy", decision, "decision", final, "reason", why)
	}

	switch decision {
	case agents.Allow:
		audit("allow", "")
		return ipc.ToolAuthorizeResult{Decision: "allow"}
	case agents.Deny:
		audit("deny", reason)
		return ipc.ToolAuthorizeResult{Decision: "deny", Reason: reason}
	}

	// Ask: park the tool call until a human decides, the approval times out or the run ends.
	ch := make(chan approval, 1)
	run.mu.Lock()
	run.approvals[params.ToolCallID] = ch
	run.mu.Unlock()
	expires := time.Now().Add(m.limits.ApprovalTimeout)
	run.publish("approval_required", map[string]any{
		"toolCallId": params.ToolCallID,
		"toolName":   params.ToolName,
		"args":       params.Input,
		"expiresAt":  expires.UTC().Format(time.RFC3339),
	})

	var got approval
	select {
	case got = <-ch:
	case <-time.After(m.limits.ApprovalTimeout):
		got = approval{reason: "approval timed out"}
	case <-run.ctx.Done():
		got = approval{reason: "run ended before approval"}
	case <-ctx.Done():
		got = approval{reason: "runtime disconnected"}
	}
	run.mu.Lock()
	delete(run.approvals, params.ToolCallID)
	run.mu.Unlock()

	result := ipc.ToolAuthorizeResult{Decision: "allow"}
	if !got.approve {
		result = ipc.ToolAuthorizeResult{Decision: "deny", Reason: firstNonEmpty(got.reason, "rejected by reviewer")}
	}
	run.publish("approval_resolved", map[string]any{
		"toolCallId": params.ToolCallID,
		"decision":   result.Decision,
		"reason":     result.Reason,
		"by":         got.by,
	})
	audit(result.Decision, result.Reason)
	return result
}

// OnEvent ingests a runtime run.event notification.
func (m *Manager) OnEvent(params ipc.RunEventParams) {
	m.mu.Lock()
	run := m.runs[params.RunID]
	m.mu.Unlock()
	if run == nil {
		return
	}
	var head struct {
		Type   string `json:"type"`
		Status string `json:"status"`
		Error  string `json:"error"`
		Usage  any    `json:"usage"`
	}
	if json.Unmarshal(params.Event, &head) != nil || head.Type == "" {
		return
	}
	if head.Type != "run_finished" {
		run.append(head.Type, params.Event)
		return
	}

	run.mu.Lock()
	timedOut := run.timedOut
	run.mu.Unlock()
	data := params.Event
	if timedOut && head.Status == "cancelled" {
		head.Status, head.Error = "timeout", "run exceeded its time limit"
		data, _ = json.Marshal(map[string]any{"type": head.Type, "status": head.Status, "error": head.Error, "usage": head.Usage})
	}
	m.finish(run, head.Status, head.Error, data)
}

// FailAll is called when the runtime process dies: every in-flight run is lost.
func (m *Manager) FailAll(reason string) {
	m.mu.Lock()
	var inflight []*Run
	for _, run := range m.runs {
		if !run.isDone() {
			inflight = append(inflight, run)
		}
	}
	m.mu.Unlock()
	for _, run := range inflight {
		data, _ := json.Marshal(map[string]any{"type": "run_finished", "status": "failed", "error": reason})
		m.finish(run, "failed", reason, data)
	}
}

func (m *Manager) finish(run *Run, status, errMsg string, data json.RawMessage) {
	if !run.markDone(status, data) {
		return
	}
	run.cancel()
	m.release(run)
	m.log.Info("audit: run finished", "run", run.ID, "agent", run.AgentID, "workspace", run.Tenant.Workspace,
		"user", run.Tenant.UserID, "status", status, "error", errMsg, "duration", time.Since(run.StartedAt).Round(time.Millisecond))
}

type approval struct {
	approve bool
	reason  string
	by      string
}

func sessionKey(run *Run) string {
	return fmt.Sprintf("%s/%s/%s", run.Tenant.Workspace, run.Tenant.UserID, run.SessionID)
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
