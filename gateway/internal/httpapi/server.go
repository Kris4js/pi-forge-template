// Package httpapi exposes the public HTTP API. Identity always comes from auth, never from bodies.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"pi-forge/gateway/internal/agents"
	"pi-forge/gateway/internal/auth"
	"pi-forge/gateway/internal/ipc"
	"pi-forge/gateway/internal/policy"
	"pi-forge/gateway/internal/runs"
)

const (
	maxBodyBytes = 1 << 20
	maxInputLen  = 100_000
)

type Runtime interface {
	runs.Caller
	WaitReady(ctx context.Context) (ipc.HelloResult, error)
}

type Server struct {
	Auth    *auth.Authenticator
	Agents  *agents.Registry
	Runs    *runs.Manager
	Runtime Runtime
	Log     *slog.Logger
	WebDir  string
}

type handler func(w http.ResponseWriter, r *http.Request, p auth.Principal) error

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.Handle("GET /v1/me", s.authed(s.me))
	mux.Handle("GET /v1/agents", s.authed(s.listAgents))
	mux.Handle("GET /v1/agents/{agent}/sessions", s.authed(s.listSessions))
	mux.Handle("GET /v1/agents/{agent}/sessions/{session}", s.authed(s.getSession))
	mux.Handle("DELETE /v1/agents/{agent}/sessions/{session}", s.authed(s.deleteSession))
	mux.Handle("POST /v1/runs", s.authed(s.startRun))
	mux.Handle("GET /v1/runs/{run}/events", s.authed(s.runEvents))
	mux.Handle("POST /v1/runs/{run}/cancel", s.authed(s.cancelRun))
	mux.Handle("POST /v1/runs/{run}/approvals/{toolCall}", s.authed(s.decide))
	if s.WebDir != "" {
		mux.Handle("GET /", spa(s.WebDir))
	}
	return s.logRequests(mux)
}

func (s *Server) authed(h handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, err := s.Auth.Authenticate(r)
		if err == nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
			err = h(w, r, p)
		}
		if err != nil {
			s.writeErr(w, err)
		}
	})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	hello, _ := s.Runtime.WaitReady(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"principal": p, "runtime": hello})
	return nil
}

type agentView struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Tools       []string `json:"tools"`
	Approval    []string `json:"approvalRequired"`
	Starters    []string `json:"starters"`
}

func (s *Server) listAgents(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	out := []agentView{}
	for _, m := range s.Agents.List() {
		if !policy.CanUseAgent(p, m) {
			continue
		}
		view := agentView{ID: m.ID, Name: m.Name, Description: m.Description, Tools: m.Tools, Approval: []string{}, Starters: m.Starters}
		for tool, d := range m.Policy.Tools {
			if d == agents.Ask {
				view.Approval = append(view.Approval, tool)
			}
		}
		out = append(out, view)
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}

func (s *Server) agent(r *http.Request, p auth.Principal, id string) (agents.Manifest, error) {
	m, ok := s.Agents.Get(id)
	if !ok {
		return m, apiError{http.StatusNotFound, "agent_not_found", "unknown agent " + id}
	}
	if !policy.CanUseAgent(p, m) {
		return m, apiError{http.StatusForbidden, "forbidden", "agent not available to this principal"}
	}
	return m, nil
}

func (s *Server) scope(r *http.Request, p auth.Principal) (ipc.SessionScope, error) {
	m, err := s.agent(r, p, r.PathValue("agent"))
	return ipc.SessionScope{Tenant: p.Tenant, AgentID: m.ID}, err
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	scope, err := s.scope(r, p)
	if err != nil {
		return err
	}
	var out json.RawMessage
	if err := s.Runtime.Call(r.Context(), ipc.MethodSessionList, scope, &out); err != nil {
		return err
	}
	writeRaw(w, http.StatusOK, out)
	return nil
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	scope, err := s.scope(r, p)
	if err != nil {
		return err
	}
	var out json.RawMessage
	params := ipc.SessionParams{SessionScope: scope, SessionID: r.PathValue("session")}
	if err := s.Runtime.Call(r.Context(), ipc.MethodSessionGet, params, &out); err != nil {
		return err
	}
	writeRaw(w, http.StatusOK, out)
	return nil
}

func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	scope, err := s.scope(r, p)
	if err != nil {
		return err
	}
	params := ipc.SessionParams{SessionScope: scope, SessionID: r.PathValue("session")}
	if err := s.Runtime.Call(r.Context(), ipc.MethodSessionDelete, params, nil); err != nil {
		return err
	}
	s.Log.Info("audit: session deleted", "workspace", p.Tenant.Workspace, "user", p.Tenant.UserID, "agent", scope.AgentID, "session", params.SessionID)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type startRunBody struct {
	AgentID   string `json:"agentId"`
	SessionID string `json:"sessionId,omitempty"`
	Text      string `json:"text"`
	// Stream defaults to true (SSE). false waits for the run and returns JSON.
	Stream *bool `json:"stream,omitempty"`
}

func (s *Server) startRun(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	var body startRunBody
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		return apiError{http.StatusBadRequest, "invalid_json", err.Error()}
	}
	if strings.TrimSpace(body.Text) == "" || len(body.Text) > maxInputLen {
		return apiError{http.StatusBadRequest, "invalid_input", "text must be 1..100000 characters"}
	}
	m, err := s.agent(r, p, body.AgentID)
	if err != nil {
		return err
	}
	run, err := s.Runs.Start(r.Context(), runs.StartRequest{Principal: p, Agent: m, SessionID: body.SessionID, Text: body.Text})
	if err != nil {
		return err
	}
	if body.Stream != nil && !*body.Stream {
		return s.waitRun(w, r, run)
	}
	// A client that walks away from the stream walks away from the run.
	return s.streamRun(w, r, run, 0, func() { _ = s.Runs.Cancel(p, run.ID) })
}

func (s *Server) runEvents(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	run, err := s.Runs.Get(p, r.PathValue("run"))
	if err != nil {
		return err
	}
	from := 0
	if v := r.URL.Query().Get("from"); v != "" {
		if err := json.Unmarshal([]byte(v), &from); err != nil || from < 0 {
			return apiError{http.StatusBadRequest, "invalid_from", "from must be a non-negative integer"}
		}
	}
	return s.streamRun(w, r, run, from, nil)
}

func (s *Server) streamRun(w http.ResponseWriter, r *http.Request, run *runs.Run, from int, onDisconnect func()) error {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return errors.New("streaming unsupported")
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	writeSSE(w, -1, "run", map[string]string{"runId": run.ID, "sessionId": run.SessionID, "agentId": run.AgentID})
	flusher.Flush()

	ctx := r.Context()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	type batch struct {
		events []runs.Event
		done   bool
		err    error
	}
	for {
		next := make(chan batch, 1)
		go func() {
			events, done, err := run.Next(ctx, from)
			next <- batch{events, done, err}
		}()
		var b batch
	wait:
		for {
			select {
			case b = <-next:
				break wait
			case <-heartbeat.C:
				_, _ = w.Write([]byte(": ping\n\n"))
				flusher.Flush()
			}
		}
		if b.err != nil {
			if onDisconnect != nil {
				onDisconnect()
			}
			return nil
		}
		for _, e := range b.events {
			writeSSE(w, e.Seq, e.Type, e.Data)
			from = e.Seq + 1
		}
		flusher.Flush()
		if b.done {
			return nil
		}
	}
}

func (s *Server) waitRun(w http.ResponseWriter, r *http.Request, run *runs.Run) error {
	var text string
	var final json.RawMessage
	for from := 0; ; {
		events, done, err := run.Next(r.Context(), from)
		if err != nil {
			return nil
		}
		for _, e := range events {
			from = e.Seq + 1
			switch e.Type {
			case "message_end":
				var msg struct {
					Text string `json:"text"`
				}
				if json.Unmarshal(e.Data, &msg) == nil && msg.Text != "" {
					text = msg.Text
				}
			case "run_finished":
				final = e.Data
			}
		}
		if done {
			break
		}
	}
	var result map[string]any
	_ = json.Unmarshal(final, &result)
	if result == nil {
		result = map[string]any{}
	}
	delete(result, "type")
	result["runId"], result["sessionId"], result["agentId"], result["text"] = run.ID, run.SessionID, run.AgentID, text
	writeJSON(w, http.StatusOK, result)
	return nil
}

func (s *Server) cancelRun(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	if err := s.Runs.Cancel(p, r.PathValue("run")); err != nil {
		return err
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
	return nil
}

func (s *Server) decide(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	var body struct {
		Decision string `json:"decision"` // approve | reject
		Reason   string `json:"reason,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || (body.Decision != "approve" && body.Decision != "reject") {
		return apiError{http.StatusBadRequest, "invalid_decision", `decision must be "approve" or "reject"`}
	}
	if err := s.Runs.Decide(p, r.PathValue("run"), r.PathValue("toolCall"), body.Decision == "approve", body.Reason); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func spa(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		files.ServeHTTP(w, r)
	})
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if r.URL.Path != "/healthz" {
			s.Log.Info("http", "method", r.Method, "path", r.URL.Path, "status", rec.status, "duration", time.Since(start).Round(time.Millisecond))
		}
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
