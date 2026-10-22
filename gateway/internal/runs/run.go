package runs

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"pi-forge/gateway/internal/agents"
	"pi-forge/gateway/internal/ipc"
	"pi-forge/gateway/internal/tenant"
)

// Event is one entry of a run's ordered event log. Data is the full JSON object, including "type".
type Event struct {
	Seq  int
	Type string
	Data json.RawMessage
}

type Run struct {
	ID        string
	AgentID   string
	Tenant    tenant.Tenant
	SessionID string
	StartedAt time.Time
	Manifest  agents.Manifest

	ctx    context.Context
	cancel context.CancelFunc

	mu        sync.Mutex
	events    []Event
	changed   chan struct{}
	done      bool
	status    string
	toolCalls int
	approvals map[string]chan approval
	questions map[string]*question
	timedOut  bool
	released  bool
	// parked: the run waits on the user and holds no concurrency slot (guarded by Manager.mu).
	parked bool

	// The run deadline pauses while a question waits on the user.
	deadline  *time.Timer
	due       time.Time
	remaining time.Duration
}

// question is an ask_user call waiting on the user.
type question struct {
	answers chan answer
	asked   []ipc.AskQuestion
	fields  map[string]any
}

type answer struct {
	answers []ipc.AskAnswer
	skipped bool
	by      string
}

func newRun(id string, t tenant.Tenant, m agents.Manifest, sessionID string) *Run {
	return &Run{
		ID:        id,
		AgentID:   m.ID,
		Tenant:    t,
		SessionID: sessionID,
		StartedAt: time.Now(),
		Manifest:  m,
		changed:   make(chan struct{}),
		approvals: map[string]chan approval{},
		questions: map[string]*question{},
	}
}

func (r *Run) Status() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.status
}

func (r *Run) isDone() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.done
}

// Waiting reports whether the run is parked on a user question.
func (r *Run) Waiting() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.questions) > 0
}

// Pending returns the next event sequence number and the questions still waiting on the user, so a
// client that reattaches can show them and stream from there.
func (r *Run) Pending() (int, []map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]map[string]any, 0, len(r.questions))
	for _, q := range r.questions {
		out = append(out, q.fields)
	}
	return len(r.events), out
}

// publish appends a gateway-originated event.
func (r *Run) publish(eventType string, fields map[string]any) {
	fields["type"] = eventType
	data, _ := json.Marshal(fields)
	r.append(eventType, data)
}

func (r *Run) append(eventType string, data json.RawMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done {
		return
	}
	r.appendLocked(eventType, data)
}

func (r *Run) appendLocked(eventType string, data json.RawMessage) {
	r.events = append(r.events, Event{Seq: len(r.events), Type: eventType, Data: data})
	close(r.changed)
	r.changed = make(chan struct{})
}

// markDone appends the terminal event exactly once.
func (r *Run) markDone(status string, data json.RawMessage) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done {
		return false
	}
	r.appendLocked("run_finished", data)
	r.done = true
	r.status = status
	return true
}

// Next returns events from index `from`, blocking until there is at least one or the run is done.
func (r *Run) Next(ctx context.Context, from int) ([]Event, bool, error) {
	for {
		r.mu.Lock()
		if from < len(r.events) {
			out := append([]Event(nil), r.events[from:]...)
			done := r.done
			r.mu.Unlock()
			return out, done, nil
		}
		if r.done {
			r.mu.Unlock()
			return nil, true, nil
		}
		changed := r.changed
		r.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, false, ctx.Err()
		case <-changed:
		}
	}
}
