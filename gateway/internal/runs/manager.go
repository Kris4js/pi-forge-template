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
	"maps"
	"slices"
	"strings"
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
	ErrNoQuestion  = errors.New("no pending question for this tool call")
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
	// How long an ask_user question waits on the user before the agent proceeds on its own.
	QuestionTimeout time.Duration
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
	if limits.QuestionTimeout == 0 {
		limits.QuestionTimeout = 24 * time.Hour
	}
	return &Manager{rt: rt, limits: limits, log: log, runs: map[string]*Run{}, sessions: map[string]string{}, perWorkspace: map[string]int{}}
}

type StartRequest struct {
	Principal   auth.Principal
	Agent       agents.Manifest
	SessionID   string
	Text        string
	Attachments []ipc.Attachment
	// Optional model choice (models.list key) and thinking level; validated by the runtime.
	Model         string
	ImageModel    string
	ThinkingLevel string
}

func (m *Manager) Start(ctx context.Context, req StartRequest) (*Run, error) {
	run := newRun(newID(), req.Principal.Tenant, req.Agent, req.SessionID)
	if err := m.admit(run); err != nil {
		return nil, err
	}

	timeout := req.Agent.Timeout(m.limits.RunTimeout)
	run.ctx, run.cancel = context.WithCancel(context.Background())
	run.mu.Lock()
	run.due = time.Now().Add(timeout)
	run.deadline = time.AfterFunc(timeout, func() { m.deadlineExceeded(run) })
	run.mu.Unlock()

	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var result ipc.RunStartResult
	err := m.rt.Call(callCtx, ipc.MethodRunStart, ipc.RunStartParams{
		SessionScope:  ipc.SessionScope{Tenant: run.Tenant, AgentID: run.AgentID},
		RunID:         run.ID,
		SessionID:     req.SessionID,
		Input:         ipc.RunInput{Text: req.Text, Attachments: req.Attachments},
		Model:         req.Model,
		ImageModel:    req.ImageModel,
		ThinkingLevel: req.ThinkingLevel,
	}, &result)
	if err != nil {
		m.release(run)
		run.cancel()
		run.stopDeadline()
		return nil, err
	}

	m.mu.Lock()
	run.SessionID = result.SessionID
	if req.SessionID == "" {
		m.sessions[sessionKey(run)] = run.ID
	}
	m.mu.Unlock()
	m.log.Info("audit: run started", "run", run.ID, "workspace", run.Tenant.Workspace, "user", run.Tenant.UserID,
		"agent", run.AgentID, "session", run.SessionID, "key", req.Principal.KeyID, "timeout", timeout,
		"model", req.Model, "thinking", req.ThinkingLevel)
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
	if !run.parked {
		m.freeSlot(run)
	}
	run.parked = false
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

// freeSlot gives back the run's concurrency slot. Callers hold m.mu.
func (m *Manager) freeSlot(run *Run) {
	m.active--
	m.perWorkspace[run.Tenant.Workspace]--
	if m.perWorkspace[run.Tenant.Workspace] <= 0 {
		delete(m.perWorkspace, run.Tenant.Workspace)
	}
}

// park frees the concurrency slot of a run that waits on its user: a question may stay open for a
// day, and an idle run must not keep everyone else out. The session stays reserved.
func (m *Manager) park(run *Run) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if run.released || run.parked {
		return
	}
	run.parked = true
	m.freeSlot(run)
}

// unpark takes the slot back once the user answered. It may push the counts over the limit for a
// moment; admission of new runs keeps checking the limit, so the excess drains as runs finish.
func (m *Manager) unpark(run *Run) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if run.released || !run.parked {
		return
	}
	run.parked = false
	m.active++
	m.perWorkspace[run.Tenant.Workspace]++
}

func (m *Manager) deadlineExceeded(run *Run) {
	if run.isDone() {
		return
	}
	run.mu.Lock()
	run.timedOut = true
	run.mu.Unlock()
	m.log.Warn("audit: run deadline exceeded", "run", run.ID)
	m.cancelRuntime(run)
}

// pauseDeadline stops the run clock while the user thinks; resumeDeadline restarts it with whatever
// was left. Nested questions (parallel calls) are counted by the questions map.
func (r *Run) pauseDeadline() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.deadline != nil && r.deadline.Stop() {
		r.remaining = max(time.Until(r.due), 0)
	}
}

func (r *Run) resumeDeadline(m *Manager) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done || len(r.questions) > 0 || r.remaining == 0 {
		return
	}
	r.due = time.Now().Add(r.remaining)
	r.deadline = time.AfterFunc(r.remaining, func() { m.deadlineExceeded(r) })
	r.remaining = 0
}

func (r *Run) stopDeadline() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.deadline != nil {
		r.deadline.Stop()
	}
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

// Ask serves user.ask from the runtime: an ask_user call waits here until the user answers, skips,
// the question expires (QuestionTimeout) or the run ends. The run clock is paused and the run's
// concurrency slot freed meanwhile; the run itself, and the model's tool call, stay open.
func (m *Manager) Ask(ctx context.Context, params ipc.UserAskParams) ipc.UserAskResult {
	m.mu.Lock()
	run := m.runs[params.RunID]
	m.mu.Unlock()
	if run == nil || run.isDone() {
		return ipc.UserAskResult{Status: "cancelled"}
	}
	expires := time.Now().Add(m.limits.QuestionTimeout)
	q := &question{answers: make(chan answer, 1), asked: params.Questions, fields: map[string]any{
		"type":       "question",
		"toolCallId": params.ToolCallID,
		"questions":  params.Questions,
		"expiresAt":  expires.UTC().Format(time.RFC3339),
	}}
	run.pauseDeadline()
	run.mu.Lock()
	run.questions[params.ToolCallID] = q
	run.mu.Unlock()
	m.park(run)
	run.publish("question", maps.Clone(q.fields))
	m.log.Info("audit: question asked", "run", run.ID, "agent", run.AgentID, "toolCall", params.ToolCallID)

	result := ipc.UserAskResult{Status: "cancelled"}
	var by string
	select {
	case got := <-q.answers:
		by = got.by
		result = ipc.UserAskResult{Status: "answered", Answers: got.answers}
		if got.skipped {
			result = ipc.UserAskResult{Status: "skipped"}
		}
	case <-time.After(m.limits.QuestionTimeout):
		result.Status = "expired"
	case <-run.ctx.Done():
	case <-ctx.Done():
	}
	run.mu.Lock()
	delete(run.questions, params.ToolCallID)
	run.mu.Unlock()
	m.unpark(run)
	run.resumeDeadline(m)
	run.publish("question_resolved", map[string]any{"toolCallId": params.ToolCallID, "status": result.Status, "answers": result.Answers, "by": by})
	m.log.Info("audit: question resolved", "run", run.ID, "toolCall", params.ToolCallID, "status", result.Status, "by", by)
	return result
}

// Answer resolves a pending ask_user call with one answer per question; skip lets the agent decide.
// Answers that do not fit the questions are rejected and leave the call waiting.
func (m *Manager) Answer(p auth.Principal, runID, toolCallID string, answers []ipc.AskAnswer, skip bool) error {
	run, err := m.Get(p, runID)
	if err != nil {
		return err
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	q := run.questions[toolCallID]
	if q == nil {
		return ErrNoQuestion
	}
	if !skip {
		if err := checkAnswers(q.asked, answers); err != nil {
			return err
		}
	} else {
		answers = nil
	}
	delete(run.questions, toolCallID)
	q.answers <- answer{answers: answers, skipped: skip, by: p.Tenant.UserID}
	return nil
}

// ErrInvalidAnswer reports answers that do not match the questions asked.
type ErrInvalidAnswer struct{ Reason string }

func (e ErrInvalidAnswer) Error() string { return e.Reason }

func checkAnswers(asked []ipc.AskQuestion, answers []ipc.AskAnswer) error {
	if len(answers) != len(asked) {
		return ErrInvalidAnswer{fmt.Sprintf("expected %d answers, got %d", len(asked), len(answers))}
	}
	for i, a := range answers {
		q := asked[i]
		if len(a.Selected) > 1 && !q.MultiSelect {
			return ErrInvalidAnswer{fmt.Sprintf("question %d takes one choice", i+1)}
		}
		seen := map[string]bool{}
		for _, s := range a.Selected {
			if !slices.Contains(q.Options, s) || seen[s] {
				return ErrInvalidAnswer{fmt.Sprintf("question %d: %q is not one of its options", i+1, s)}
			}
			seen[s] = true
		}
		if len(a.Selected) == 0 && strings.TrimSpace(a.Other) == "" {
			return ErrInvalidAnswer{fmt.Sprintf("question %d has no answer", i+1)}
		}
	}
	return nil
}

// SessionRun returns the principal's unfinished run on a session, so a client that reloads or opens
// the session elsewhere can reattach to it (and to a question it is waiting on).
func (m *Manager) SessionRun(p auth.Principal, sessionID string) *Run {
	if sessionID == "" {
		return nil
	}
	m.mu.Lock()
	id := m.sessions[fmt.Sprintf("%s/%s/%s", p.Tenant.Workspace, p.Tenant.UserID, sessionID)]
	run := m.runs[id]
	m.mu.Unlock()
	if run == nil || run.isDone() || !p.SameTenant(run.Tenant) {
		return nil
	}
	return run
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
	run.stopDeadline()
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
