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
	"testing"

	"pi-forge/gateway/internal/agents"
	"pi-forge/gateway/internal/auth"
	"pi-forge/gateway/internal/ipc"
	"pi-forge/gateway/internal/tenant"
)

type artifactRuntime struct {
	method string
	tenant tenant.Tenant
}

func (f *artifactRuntime) WaitReady(context.Context) (ipc.HelloResult, error) {
	return ipc.HelloResult{}, nil
}

func (f *artifactRuntime) Call(_ context.Context, method string, params, out any) error {
	f.method = method
	f.tenant = params.(ipc.TenantParams).Tenant
	return json.Unmarshal([]byte(`[
		{"sessionId":"s1","sessionName":"open","agentId":"open","revision":2,"bytes":10,"createdAt":"2026-01-02","revisions":2},
		{"sessionId":"s2","sessionName":"restricted","agentId":"admin-only","revision":1,"bytes":10,"createdAt":"2026-01-01","revisions":1},
		{"sessionId":"s3","sessionName":"removed","agentId":"gone","revision":1,"bytes":10,"createdAt":"2026-01-01","revisions":1},
		{"sessionId":"s4","sessionName":"unbound","revision":1,"bytes":10,"createdAt":"2026-01-01","revisions":1}
	]`), out)
}

func TestListAllArtifactsUsesTenantAndAgentPolicy(t *testing.T) {
	dir := t.TempDir()
	for id, manifest := range map[string]string{
		"open":       `{"id":"open","name":"Open","tools":[]}`,
		"admin-only": `{"id":"admin-only","name":"Admin","tools":[],"policy":{"roles":["admin"]}}`,
	} {
		if err := os.MkdirAll(filepath.Join(dir, id), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, id, "agent.json"), []byte(manifest), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	registry, err := agents.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	keys := filepath.Join(t.TempDir(), "keys.json")
	if err := os.WriteFile(keys, []byte(`{"keys":[{"id":"alice","key":"secret","workspace":"acme","user":"alice","roles":["member"]}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	a, err := auth.New(keys, false, false)
	if err != nil {
		t.Fatal(err)
	}
	rt := &artifactRuntime{}
	s := &Server{Auth: a, Runtime: rt, Agents: registry, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}

	req := httptest.NewRequest(http.MethodGet, "/v1/artifacts?workspace=other&userId=bob", nil)
	req.Header.Set("Authorization", "Bearer secret")
	res := httptest.NewRecorder()
	s.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	if rt.method != ipc.MethodArtifactListAll || rt.tenant.Workspace != "acme" || rt.tenant.UserID != "alice" {
		t.Fatalf("method=%s tenant=%+v", rt.method, rt.tenant)
	}
	var got []struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].SessionID != "s1" || got[1].SessionID != "s4" {
		t.Fatalf("visible artifacts=%+v", got)
	}
}
