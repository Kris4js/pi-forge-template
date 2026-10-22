// Package httpapi exposes the public HTTP API. Identity always comes from auth, never from bodies.
package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
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
	mux.Handle("GET /v1/image-models", s.authed(s.listImageModels))
	mux.Handle("GET /v1/models", s.authed(s.listModels))
	mux.Handle("GET /v1/sessions", s.authed(s.listSessions))
	mux.Handle("GET /v1/sessions/{session}", s.authed(s.getSession))
	mux.Handle("PATCH /v1/sessions/{session}", s.authed(s.updateSession))
	mux.Handle("DELETE /v1/sessions/{session}", s.authed(s.deleteSession))
	mux.Handle("GET /v1/sessions/{session}/artifacts", s.authed(s.listArtifacts))
	mux.Handle("GET /v1/sessions/{session}/artifacts/{revision}", s.authed(s.getArtifact))
	mux.Handle("GET /v1/sessions/{session}/images/{image}", s.authed(s.getImage))
	mux.Handle("POST /v1/runs", s.authed(s.startRun))
	mux.Handle("GET /v1/runs/{run}/events", s.authed(s.runEvents))
	mux.Handle("POST /v1/runs/{run}/cancel", s.authed(s.cancelRun))
	mux.Handle("POST /v1/runs/{run}/approvals/{toolCall}", s.authed(s.decide))
	mux.Handle("POST /v1/runs/{run}/answers/{toolCall}", s.authed(s.answer))
	mux.Handle("GET /v1/sessions/{session}/run", s.authed(s.sessionRun))
	if s.WebDir != "" {
		mux.Handle("GET /", spa(s.WebDir))
	}
	return s.logRequests(mux)
}

func (s *Server) authed(h handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, err := s.Auth.Authenticate(r)
		if err == nil {
			limit := int64(maxBodyBytes)
			if r.Method == http.MethodPost && r.URL.Path == "/v1/runs" {
				limit = 112 << 20
			}
			r.Body = http.MaxBytesReader(w, r.Body, limit)
			err = h(w, r, p)
		}
		if err != nil {
			s.writeErr(w, err)
		}
	})
}

func (s *Server) getImage(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	params, err := s.session(r, p)
	if err != nil {
		return err
	}
	var result struct {
		Name     string `json:"name"`
		MimeType string `json:"mimeType"`
		Data     string `json:"data"`
	}
	request := struct {
		ipc.SessionParams
		ID string `json:"id"`
	}{params, r.PathValue("image")}
	if err := s.Runtime.Call(r.Context(), "image.get", request, &result); err != nil {
		return err
	}
	if result.MimeType != "image/png" && result.MimeType != "image/jpeg" && result.MimeType != "image/webp" {
		return errors.New("invalid image type")
	}
	data, err := base64.StdEncoding.DecodeString(result.Data)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", result.MimeType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusOK)
	_, err = w.Write(data)
	return err
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
	Preview     bool     `json:"preview"`
}

func (s *Server) listAgents(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	out := []agentView{}
	for _, m := range s.Agents.List() {
		if !policy.CanUseAgent(p, m) {
			continue
		}
		view := agentView{ID: m.ID, Name: m.Name, Description: m.Description, Tools: m.Tools, Approval: []string{}, Starters: m.Starters, Preview: m.Preview != nil}
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

// session resolves a session of the principal's own and checks that the principal may use the
// agent it is bound to. Sessions are per user; the binding still decides who may open them.
func (s *Server) session(r *http.Request, p auth.Principal) (ipc.SessionParams, error) {
	params := ipc.SessionParams{TenantParams: ipc.TenantParams{Tenant: p.Tenant}, SessionID: r.PathValue("session")}
	var info ipc.SessionInfo
	if err := s.Runtime.Call(r.Context(), ipc.MethodSessionInfo, params, &info); err != nil {
		return params, err
	}
	if info.AgentID != "" {
		if _, err := s.agent(r, p, info.AgentID); err != nil {
			return params, err
		}
	}
	return params, nil
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	var raw []json.RawMessage
	if err := s.Runtime.Call(r.Context(), ipc.MethodSessionList, ipc.TenantParams{Tenant: p.Tenant}, &raw); err != nil {
		return err
	}
	// Only sessions of agents this principal may use (and that still exist) are listed.
	visible := make([]json.RawMessage, 0, len(raw))
	for _, item := range raw {
		var head struct {
			AgentID string `json:"agentId"`
		}
		if json.Unmarshal(item, &head) != nil {
			continue
		}
		if head.AgentID != "" {
			if m, ok := s.Agents.Get(head.AgentID); !ok || !policy.CanUseAgent(p, m) {
				continue
			}
		}
		visible = append(visible, item)
	}
	writeJSON(w, http.StatusOK, visible)
	return nil
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	params, err := s.session(r, p)
	if err != nil {
		return err
	}
	var out json.RawMessage
	if err := s.Runtime.Call(r.Context(), ipc.MethodSessionGet, params, &out); err != nil {
		return err
	}
	writeRaw(w, http.StatusOK, out)
	return nil
}

// updateSession accepts {"name"?: string, "pinned"?: bool}. Renaming a session that has an active
// run is refused by the runtime (409): it would fork pi's session entry tree.
func (s *Server) updateSession(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	session, err := s.session(r, p)
	if err != nil {
		return err
	}
	var body struct {
		Name   *string `json:"name"`
		Pinned *bool   `json:"pinned"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil || (body.Name == nil && body.Pinned == nil) {
		return apiError{http.StatusBadRequest, "invalid_update", `body must set "name" and/or "pinned"`}
	}
	params := ipc.SessionUpdateParams{SessionParams: session, Name: body.Name, Pinned: body.Pinned}
	if err := s.Runtime.Call(r.Context(), ipc.MethodSessionUpdate, params, nil); err != nil {
		return err
	}
	s.Log.Info("audit: session updated", "workspace", p.Tenant.Workspace, "user", p.Tenant.UserID, "session", session.SessionID,
		"renamed", body.Name != nil, "pinned", body.Pinned)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	params, err := s.session(r, p)
	if err != nil {
		return err
	}
	if err := s.Runtime.Call(r.Context(), ipc.MethodSessionDelete, params, nil); err != nil {
		return err
	}
	s.Log.Info("audit: session deleted", "workspace", p.Tenant.Workspace, "user", p.Tenant.UserID, "session", params.SessionID)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listArtifacts(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	params, err := s.session(r, p)
	if err != nil {
		return err
	}
	var out json.RawMessage
	if err := s.Runtime.Call(r.Context(), ipc.MethodArtifactList, params, &out); err != nil {
		return err
	}
	writeRaw(w, http.StatusOK, out)
	return nil
}

// getArtifact returns {revision, bytes, createdAt, html} as JSON. Artifacts are model-written pages, so
// they are never served as text/html from this origin; the console renders them in a sandboxed iframe.
// "latest" names the newest revision.
func (s *Server) getArtifact(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	session, err := s.session(r, p)
	if err != nil {
		return err
	}
	params := ipc.ArtifactParams{SessionParams: session}
	if rev := r.PathValue("revision"); rev != "latest" {
		n, err := strconv.Atoi(rev)
		if err != nil || n < 1 {
			return apiError{http.StatusBadRequest, "invalid_revision", "revision must be a positive integer or latest"}
		}
		params.Revision = &n
	}
	var out json.RawMessage
	if err := s.Runtime.Call(r.Context(), ipc.MethodArtifactGet, params, &out); err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeRaw(w, http.StatusOK, out)
	return nil
}

type startRunBody struct {
	AgentID     string           `json:"agentId"`
	SessionID   string           `json:"sessionId,omitempty"`
	Text        string           `json:"text"`
	Attachments []ipc.Attachment `json:"attachments,omitempty"`
	// Model is a key from GET /v1/models; ThinkingLevel one of its thinkingLevels.
	Model         string `json:"model,omitempty"`
	ImageModel    string `json:"imageModel,omitempty"`
	ThinkingLevel string `json:"thinkingLevel,omitempty"`
	// Stream defaults to true (SSE). false waits for the run and returns JSON.
	Stream *bool `json:"stream,omitempty"`
}

// listModels returns the models registered in the runtime's .env, which are the only ones a run may use.
func (s *Server) listModels(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	var out json.RawMessage
	if err := s.Runtime.Call(r.Context(), ipc.MethodModelsList, struct{}{}, &out); err != nil {
		return err
	}
	writeRaw(w, http.StatusOK, out)
	return nil
}

func (s *Server) listImageModels(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	var out json.RawMessage
	if err := s.Runtime.Call(r.Context(), "images.models", struct{}{}, &out); err != nil {
		return err
	}
	writeRaw(w, http.StatusOK, out)
	return nil
}

func (s *Server) startRun(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	var body startRunBody
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return err
		}
		return apiError{http.StatusBadRequest, "invalid_json", err.Error()}
	}
	if (strings.TrimSpace(body.Text) == "" && len(body.Attachments) == 0) || len(body.Text) > maxInputLen || len(body.Attachments) > 20 {
		return apiError{http.StatusBadRequest, "invalid_input", "text must be 1..100000 characters"}
	}
	m, err := s.agent(r, p, body.AgentID)
	if err != nil {
		return err
	}
	run, err := s.Runs.Start(r.Context(), runs.StartRequest{
		Principal: p, Agent: m, SessionID: body.SessionID, Text: body.Text, Attachments: body.Attachments, Model: body.Model, ImageModel: body.ImageModel, ThinkingLevel: body.ThinkingLevel,
	})
	if err != nil {
		return err
	}
	if body.Stream != nil && !*body.Stream {
		return s.waitRun(w, r, run)
	}
	// A client that walks away from the stream walks away from the run, unless the run waits on the
	// user's answer: that wait outlives a reload or a closed tab, and the client reattaches through
	// GET /v1/sessions/{session}/run.
	return s.streamRun(w, r, run, 0, func() {
		if !run.Waiting() {
			_ = s.Runs.Cancel(p, run.ID)
		}
	})
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

// answer resolves an ask_user question: {"answer": "..."} or {"skip": true}.
func (s *Server) answer(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	var body struct {
		Answer string `json:"answer"`
		Skip   bool   `json:"skip"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || (!body.Skip && strings.TrimSpace(body.Answer) == "") || len(body.Answer) > 4000 {
		return apiError{http.StatusBadRequest, "invalid_answer", `body must set "answer" (1..4000 characters) or "skip": true`}
	}
	if err := s.Runs.Answer(p, r.PathValue("run"), r.PathValue("toolCall"), strings.TrimSpace(body.Answer), body.Skip); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

// sessionRun reports the session's unfinished run (204 when there is none): its id, the event
// sequence to stream from, and any questions waiting on the user. The console uses it to reattach.
func (s *Server) sessionRun(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	run := s.Runs.SessionRun(p, r.PathValue("session"))
	if run == nil {
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	next, questions := run.Pending()
	writeJSON(w, http.StatusOK, map[string]any{"runId": run.ID, "agentId": run.AgentID, "next": next, "questions": questions})
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
