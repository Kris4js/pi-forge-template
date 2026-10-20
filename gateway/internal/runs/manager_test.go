package runs

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"pi-forge/gateway/internal/agents"
	"pi-forge/gateway/internal/auth"
	"pi-forge/gateway/internal/ipc"
	"pi-forge/gateway/internal/tenant"
)

// fakeRuntime accepts run.start and, on run.cancel, reports the run as cancelled like the TS runtime.
type fakeRuntime struct {
	mu      sync.Mutex
	m       *Manager
	started []ipc.RunStartParams
}

func (f *fakeRuntime) Call(_ context.Context, method string, params, out any) error {
	switch method {
	case ipc.MethodRunStart:
		p := params.(ipc.RunStartParams)
		f.mu.Lock()
		f.started = append(f.started, p)
		f.mu.Unlock()
		sid := p.SessionID
		if sid == "" {
			sid = "new-session"
		}
		*(out.(*ipc.RunStartResult)) = ipc.RunStartResult{SessionID: sid}
	case ipc.MethodRunCancel:
		id := params.(map[string]string)["runId"]
		go f.m.OnEvent(ipc.RunEventParams{RunID: id, Event: json.RawMessage(`{"type":"run_finished","status":"cancelled"}`)})
	}
	return nil
}

var alice = auth.Principal{KeyID: "k", Tenant: tenant.Tenant{Workspace: "acme", UserID: "alice"}, Roles: []string{"member"}}

func newTestManager(limits Limits) (*Manager, *fakeRuntime) {
	rt := &fakeRuntime{}
	m := NewManager(rt, limits, slog.New(slog.NewTextHandler(io.Discard, nil)))
	rt.m = m
	return m, rt
}

func finish(m *Manager, run *Run) {
	m.OnEvent(ipc.RunEventParams{RunID: run.ID, Event: json.RawMessage(`{"type":"run_finished","status":"completed"}`)})
}

func TestAdmission(t *testing.T) {
	m, _ := newTestManager(Limits{MaxConcurrent: 10, MaxPerWorkspace: 2, RunTimeout: time.Minute, ApprovalTimeout: time.Second})
	agent := agents.Manifest{ID: "a"}
	ctx := context.Background()

	r1, err := m.Start(ctx, StartRequest{Principal: alice, Agent: agent, SessionID: "s1", Text: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start(ctx, StartRequest{Principal: alice, Agent: agent, SessionID: "s1", Text: "hi"}); !errors.Is(err, ErrSessionBusy) {
		t.Fatalf("expected ErrSessionBusy, got %v", err)
	}
	if _, err := m.Start(ctx, StartRequest{Principal: alice, Agent: agent, Text: "hi"}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start(ctx, StartRequest{Principal: alice, Agent: agent, Text: "hi"}); !errors.Is(err, ErrBusy) {
		t.Fatalf("expected per-workspace ErrBusy, got %v", err)
	}
	finish(m, r1)
	if _, err := m.Start(ctx, StartRequest{Principal: alice, Agent: agent, SessionID: "s1", Text: "hi"}); err != nil {
		t.Fatalf("session should be free after finish: %v", err)
	}
}

func TestDeadlineReportsTimeout(t *testing.T) {
	m, _ := newTestManager(Limits{RunTimeout: 50 * time.Millisecond, ApprovalTimeout: time.Second})
	run, err := m.Start(context.Background(), StartRequest{Principal: alice, Agent: agents.Manifest{ID: "a"}, Text: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for from := 0; ; {
		events, done, err := run.Next(ctx, from)
		if err != nil {
			t.Fatal(err)
		}
		from += len(events)
		if done {
			break
		}
	}
	if run.Status() != "timeout" {
		t.Fatalf("status = %s, want timeout", run.Status())
	}
}

func TestApprovalFlow(t *testing.T) {
	m, _ := newTestManager(Limits{RunTimeout: time.Minute, ApprovalTimeout: 200 * time.Millisecond})
	agent := agents.Manifest{ID: "a", Tools: []string{"ticket"}, Policy: agents.Policy{Tools: map[string]agents.Decision{"ticket": agents.Ask}}}
	run, err := m.Start(context.Background(), StartRequest{Principal: alice, Agent: agent, Text: "hi"})
	if err != nil {
		t.Fatal(err)
	}

	result := make(chan ipc.ToolAuthorizeResult)
	go func() {
		result <- m.Authorize(context.Background(), ipc.ToolAuthorizeParams{RunID: run.ID, ToolCallID: "tc1", ToolName: "ticket"})
	}()
	events, _, _ := run.Next(context.Background(), 0)
	if events[0].Type != "approval_required" {
		t.Fatalf("first event = %s", events[0].Type)
	}
	bob := auth.Principal{Tenant: tenant.Tenant{Workspace: "acme", UserID: "bob"}}
	if err := m.Decide(bob, run.ID, "tc1", true, ""); !errors.Is(err, ErrForbidden) {
		t.Fatalf("another member must not approve: %v", err)
	}
	if err := m.Decide(alice, run.ID, "tc1", true, ""); err != nil {
		t.Fatal(err)
	}
	if got := <-result; got.Decision != "allow" {
		t.Fatalf("decision = %+v", got)
	}

	// Unanswered approvals expire as deny.
	got := m.Authorize(context.Background(), ipc.ToolAuthorizeParams{RunID: run.ID, ToolCallID: "tc2", ToolName: "ticket"})
	if got.Decision != "deny" || got.Reason != "approval timed out" {
		t.Fatalf("expected timeout deny, got %+v", got)
	}
	// Tools outside the allowlist never reach a human.
	if got := m.Authorize(context.Background(), ipc.ToolAuthorizeParams{RunID: run.ID, ToolCallID: "tc3", ToolName: "bash"}); got.Decision != "deny" {
		t.Fatalf("bash should be denied, got %+v", got)
	}
}

func TestRuntimeCrashFailsInflightRuns(t *testing.T) {
	m, _ := newTestManager(Limits{RunTimeout: time.Minute, ApprovalTimeout: time.Second})
	run, _ := m.Start(context.Background(), StartRequest{Principal: alice, Agent: agents.Manifest{ID: "a"}, Text: "hi"})
	m.FailAll("agent runtime exited")
	if run.Status() != "failed" {
		t.Fatalf("status = %s", run.Status())
	}
}

func TestAttachmentsForwardedToRuntime(t *testing.T) {
	m, rt := newTestManager(Limits{RunTimeout: time.Minute})
	files := []ipc.Attachment{{Name: "notes.txt", MimeType: "text/plain", Data: "aGk="}}
	run, err := m.Start(context.Background(), StartRequest{Principal: alice, Agent: agents.Manifest{ID: "a"}, Attachments: files})
	if err != nil {
		t.Fatal(err)
	}
	defer finish(m, run)
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if len(rt.started) != 1 || len(rt.started[0].Input.Attachments) != 1 || rt.started[0].Input.Attachments[0] != files[0] {
		t.Fatal("attachments not forwarded")
	}
}
