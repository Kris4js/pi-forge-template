package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"testing"

	"pi-forge/gateway/internal/auth"
	"pi-forge/gateway/internal/ipc"
	"pi-forge/gateway/internal/tenant"
)

type imageRuntime struct{ calls []string }

func (f *imageRuntime) WaitReady(context.Context) (ipc.HelloResult, error) {
	return ipc.HelloResult{}, nil
}
func (f *imageRuntime) Call(_ context.Context, method string, params, out any) error {
	f.calls = append(f.calls, method)
	if method == ipc.MethodSessionInfo {
		return nil
	}
	raw, _ := json.Marshal(params)
	var request struct {
		Tenant tenant.Tenant `json:"tenant"`
		ID     string        `json:"id"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		return err
	}
	if request.Tenant.UserID != "alice" {
		return &ipc.Error{Code: 404, Message: "image not found"}
	}
	return json.Unmarshal([]byte(`{"name":"sample.png","mimeType":"image/png","data":"iVBORw0KGgo="}`), out)
}

func TestImageRouteRequiresAuth(t *testing.T) {
	a, _ := auth.New("", false, false)
	runtime := &imageRuntime{}
	s := &Server{Auth: a, Runtime: runtime, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	res := httptest.NewRecorder()
	s.Handler().ServeHTTP(res, httptest.NewRequest("GET", "/v1/sessions/s/images/i", nil))
	if res.Code != 401 || len(runtime.calls) != 0 {
		t.Fatalf("status=%d calls=%v", res.Code, runtime.calls)
	}
}

func TestImageRouteUsesAuthenticatedTenantAndPrivateHeaders(t *testing.T) {
	a, _ := auth.New("", true, false)
	for _, user := range []string{"alice", "bob"} {
		runtime := &imageRuntime{}
		s := &Server{Auth: a, Runtime: runtime, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
		req := httptest.NewRequest("GET", "/v1/sessions/s/images/i", nil)
		req.Header.Set("X-Workspace", "acme")
		req.Header.Set("X-User-Id", user)
		res := httptest.NewRecorder()
		s.Handler().ServeHTTP(res, req)
		if user == "bob" {
			if res.Code != 404 {
				t.Fatalf("other user: status %d", res.Code)
			}
			continue
		}
		if res.Code != 200 || res.Header().Get("Content-Type") != "image/png" || res.Header().Get("Cache-Control") != "private, no-store" || res.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("status=%d headers=%v body=%s", res.Code, res.Header(), res.Body.String())
		}
		if string(res.Body.Bytes()) != "\x89PNG\r\n\x1a\n" {
			t.Fatal("image not decoded")
		}
	}
}
