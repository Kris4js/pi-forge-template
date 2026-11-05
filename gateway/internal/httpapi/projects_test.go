package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pi-forge/gateway/internal/agents"
	"pi-forge/gateway/internal/auth"
	"pi-forge/gateway/internal/ipc"
	"pi-forge/gateway/internal/runs"
	"pi-forge/gateway/internal/tenant"
)

type projectCall struct {
	method string
	params map[string]any
}

type projectRuntime struct {
	calls []projectCall
	err   error
}

func (f *projectRuntime) WaitReady(context.Context) (ipc.HelloResult, error) {
	return ipc.HelloResult{}, nil
}

func (f *projectRuntime) Call(_ context.Context, method string, params, out any) error {
	raw, _ := json.Marshal(params)
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	f.calls = append(f.calls, projectCall{method, fields})
	if f.err != nil {
		return f.err
	}
	if out == nil {
		return nil
	}
	response := `{"id":"p1","name":"Personal","instructions":"shared","createdAt":"2026-01-01","updatedAt":"2026-01-01"}`
	if method == ipc.MethodProjectList {
		response = `[` + response + `]`
	}
	if method == ipc.MethodSessionList {
		response = `[{"id":"s1","projectId":"p1"}]`
	}
	return json.Unmarshal([]byte(response), out)
}

func projectServer(t *testing.T, rt *projectRuntime, fixedAuth bool) *Server {
	t.Helper()
	keys := ""
	if fixedAuth {
		keys = filepath.Join(t.TempDir(), "keys.json")
		if err := os.WriteFile(keys, []byte(`{"keys":[{"id":"alice","key":"secret","workspace":"acme","user":"alice","roles":["member"]}]}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	a, err := auth.New(keys, !fixedAuth, false)
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &Server{Auth: a, Runtime: rt, Log: log}
}

func TestProjectRoutesUseAuthenticatedTenant(t *testing.T) {
	for _, tc := range []struct {
		method, path, body, rpc string
		status                  int
	}{
		{"GET", "/v1/projects?workspace=other&userId=bob", "", ipc.MethodProjectList, 200},
		{"POST", "/v1/projects", `{"name":" Personal ","instructions":"shared"}`, ipc.MethodProjectCreate, 201},
		{"PATCH", "/v1/projects/p1", `{"instructions":""}`, ipc.MethodProjectUpdate, 200},
		{"DELETE", "/v1/projects/p1", "", ipc.MethodProjectDelete, 204},
		{"GET", "/v1/sessions?projectId=p1&userId=bob", "", ipc.MethodSessionList, 200},
		{"GET", "/v1/sessions", "", ipc.MethodSessionList, 200},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			rt := &projectRuntime{}
			s := projectServer(t, rt, true)
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Authorization", "Bearer secret")
			res := httptest.NewRecorder()
			s.Handler().ServeHTTP(res, req)
			if res.Code != tc.status || len(rt.calls) != 1 {
				t.Fatalf("status=%d body=%s calls=%v", res.Code, res.Body.String(), rt.calls)
			}
			call := rt.calls[0]
			if call.method != tc.rpc {
				t.Fatalf("method=%s", call.method)
			}
			raw, _ := json.Marshal(call.params["tenant"])
			var got tenant.Tenant
			_ = json.Unmarshal(raw, &got)
			if got.Workspace != "acme" || got.UserID != "alice" {
				t.Fatalf("tenant=%+v", got)
			}
			if strings.Contains(tc.path, "p1") && call.params["projectId"] != "p1" {
				t.Fatalf("projectId not forwarded: %v", call.params)
			}
			if tc.path == "/v1/sessions" {
				if _, exists := call.params["projectId"]; exists {
					t.Fatal("unfiltered sessions must omit projectId")
				}
			}
			if tc.method == "POST" && call.params["name"] != "Personal" {
				t.Fatalf("name not trimmed: %v", call.params)
			}
			if tc.method == "PATCH" && call.params["instructions"] != "" {
				t.Fatal("empty instructions not forwarded")
			}
			if tc.rpc == ipc.MethodSessionList && !strings.Contains(res.Body.String(), `"projectId":"p1"`) {
				t.Fatal("session projectId lost")
			}
		})
	}
}

func TestProjectRoutesRejectIdentityOverrides(t *testing.T) {
	for _, method := range []string{"GET", "POST", "PATCH", "DELETE"} {
		t.Run(method, func(t *testing.T) {
			for _, header := range []string{"", "X-Workspace", "X-User-Id"} {
				rt := &projectRuntime{}
				s := projectServer(t, rt, true)
				path := "/v1/projects"
				if method == "PATCH" || method == "DELETE" {
					path += "/p1"
				}
				req := httptest.NewRequest(method, path, strings.NewReader(`{"name":"test"}`))
				want := 401
				if header != "" {
					req.Header.Set("Authorization", "Bearer secret")
					req.Header.Set(header, "other")
					want = 403
				}
				res := httptest.NewRecorder()
				s.Handler().ServeHTTP(res, req)
				if res.Code != want || len(rt.calls) != 0 {
					t.Fatalf("header=%s status=%d calls=%v", header, res.Code, rt.calls)
				}
			}
		})
	}
}

func TestProjectValidation(t *testing.T) {
	for _, tc := range []struct{ method, body string }{
		{"POST", `{}`}, {"POST", `{"name":"  "}`}, {"POST", `{"name":123}`},
		{"POST", `{"name":"ok","tenant":{"userId":"bob"}}`},
		{"POST", `{"name":"ok","workspace":"other"}`},
		{"POST", `{"name":"` + strings.Repeat("界", 81) + `"}`},
		{"POST", `{"name":"` + strings.Repeat("😀", 41) + `"}`},
		{"POST", `{"name":"ok","instructions":"` + strings.Repeat("a", 20_001) + `"}`},
		{"POST", `{"name":"ok"} {"name":"second"}`},
		{"PATCH", `{}`}, {"PATCH", `{"projectId":"other","name":"ok"}`},
	} {
		rt := &projectRuntime{}
		s := projectServer(t, rt, false)
		path := "/v1/projects"
		if tc.method == "PATCH" {
			path += "/p1"
		}
		res := httptest.NewRecorder()
		s.Handler().ServeHTTP(res, httptest.NewRequest(tc.method, path, strings.NewReader(tc.body)))
		if res.Code != 400 || len(rt.calls) != 0 {
			t.Fatalf("method=%s status=%d calls=%v", tc.method, res.Code, rt.calls)
		}
	}
	// Non-ASCII names use the same limits as the browser and runtime, not UTF-8 bytes.
	rt := &projectRuntime{}
	s := projectServer(t, rt, false)
	res := httptest.NewRecorder()
	s.Handler().ServeHTTP(res, httptest.NewRequest("POST", "/v1/projects", strings.NewReader(`{"name":"`+strings.Repeat("界", 80)+`","instructions":"`+strings.Repeat("界", 20_000)+`"}`)))
	if res.Code != 201 {
		t.Fatalf("valid Unicode project: %d %s", res.Code, res.Body.String())
	}
}

func TestProjectRuntimeErrorsPreserveStatus(t *testing.T) {
	for _, code := range []int{ipc.CodeNotFound, ipc.CodeConflict, ipc.CodeInvalidParams} {
		rt := &projectRuntime{err: &ipc.Error{Code: code, Message: "project refused"}}
		s := projectServer(t, rt, false)
		res := httptest.NewRecorder()
		s.Handler().ServeHTTP(res, httptest.NewRequest("DELETE", "/v1/projects/p1", nil))
		want := code
		if code == ipc.CodeInvalidParams {
			want = 400
		}
		if res.Code != want || len(rt.calls) != 1 {
			t.Fatalf("code=%d status=%d calls=%v", code, res.Code, rt.calls)
		}
	}
}

func TestRunRouteForwardsProjectAndRejectsWrongType(t *testing.T) {
	for _, value := range []string{`"p1"`, `""`, `123`} {
		rt := &projectRuntime{err: &ipc.Error{Code: ipc.CodeConflict, Message: "project mismatch"}}
		s := projectServer(t, rt, true)
		dir := t.TempDir()
		if err := os.Mkdir(filepath.Join(dir, "a"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "a", "agent.json"), []byte(`{"id":"a","name":"Agent","tools":[]}`), 0o644); err != nil {
			t.Fatal(err)
		}
		registry, err := agents.Load(dir)
		if err != nil {
			t.Fatal(err)
		}
		s.Agents = registry
		s.Runs = runs.NewManager(rt, runs.Limits{RunTimeout: time.Minute}, s.Log)
		req := httptest.NewRequest(http.MethodPost, "/v1/runs", strings.NewReader(`{"agentId":"a","sessionId":"s1","projectId":`+value+`,"text":"hello"}`))
		req.Header.Set("Authorization", "Bearer secret")
		res := httptest.NewRecorder()
		s.Handler().ServeHTTP(res, req)
		if value == "123" {
			if res.Code != 400 || len(rt.calls) != 0 {
				t.Fatalf("wrong type accepted: %d", res.Code)
			}
			continue
		}
		if res.Code != 409 || len(rt.calls) != 1 {
			t.Fatalf("status=%d calls=%v", res.Code, rt.calls)
		}
		call := rt.calls[0]
		if call.method != ipc.MethodRunStart || call.params["projectId"] != strings.Trim(value, `"`) || call.params["sessionId"] != "s1" {
			t.Fatalf("run params=%v", call)
		}
		got := call.params["tenant"].(map[string]any)
		if got["workspace"] != "acme" || got["userId"] != "alice" {
			t.Fatalf("run tenant=%v", got)
		}
	}
}

// A session moves into a project with a string id and out of it with null; omitting projectId
// leaves it alone. The gateway forwards exactly that distinction and rejects other values.
func TestSessionProjectMove(t *testing.T) {
	for _, tc := range []struct {
		body   string
		status int
		want   any // projectId forwarded to session.update; "absent" when omitted
	}{
		{`{"projectId":"p1"}`, 200, "p1"},
		{`{"projectId":null}`, 200, nil},
		{`{"pinned":true}`, 200, "absent"},
		{`{"projectId":""}`, 400, nil},
		{`{"projectId":7}`, 400, nil},
	} {
		t.Run(tc.body, func(t *testing.T) {
			rt := &sessionInfoRuntime{}
			s := projectServer(t, &rt.projectRuntime, false)
			s.Runtime = rt
			res := httptest.NewRecorder()
			s.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodPatch, "/v1/sessions/s1", strings.NewReader(tc.body)))
			if res.Code != tc.status {
				t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
			}
			var update *projectCall
			for i := range rt.calls {
				if rt.calls[i].method == ipc.MethodSessionUpdate {
					update = &rt.calls[i]
				}
			}
			if tc.status != 200 {
				if update != nil {
					t.Fatalf("invalid projectId forwarded: %v", update.params)
				}
				return
			}
			got, exists := update.params["projectId"]
			if tc.want == "absent" {
				if exists {
					t.Fatalf("projectId must stay omitted: %v", update.params)
				}
			} else if !exists || got != tc.want {
				t.Fatalf("projectId=%v exists=%v", got, exists)
			}
		})
	}
}

// sessionInfoRuntime answers session.info with an unbound session, so no agent registry is needed.
type sessionInfoRuntime struct{ projectRuntime }

func (f *sessionInfoRuntime) Call(ctx context.Context, method string, params, out any) error {
	if method == ipc.MethodSessionInfo {
		f.calls = append(f.calls, projectCall{method: method})
		return json.Unmarshal([]byte(`{"id":"s1"}`), out)
	}
	return f.projectRuntime.Call(ctx, method, params, out)
}
