package policy

import (
	"testing"

	"pi-forge/gateway/internal/agents"
	"pi-forge/gateway/internal/auth"
)

func TestToolDecision(t *testing.T) {
	m := agents.Manifest{
		ID:    "support",
		Tools: []string{"search", "ticket", "drop"},
		Policy: agents.Policy{
			Tools:        map[string]agents.Decision{"ticket": agents.Ask, "drop": agents.Deny},
			MaxToolCalls: 2,
		},
	}
	cases := []struct {
		tool  string
		calls int
		want  agents.Decision
	}{
		{"search", 0, agents.Allow},
		{"ticket", 0, agents.Ask},
		{"drop", 0, agents.Deny},
		{"bash", 0, agents.Deny},
		{"search", 2, agents.Deny},
	}
	for _, c := range cases {
		if got, _ := ToolDecision(m, c.tool, c.calls); got != c.want {
			t.Errorf("ToolDecision(%s, %d) = %s, want %s", c.tool, c.calls, got, c.want)
		}
	}
}

func TestCanUseAgent(t *testing.T) {
	m := agents.Manifest{Policy: agents.Policy{Roles: []string{"analyst"}}}
	if CanUseAgent(auth.Principal{Roles: []string{"member"}}, m) {
		t.Fatal("member should not use analyst-only agent")
	}
	if !CanUseAgent(auth.Principal{Roles: []string{"analyst"}}, m) || !CanUseAgent(auth.Principal{Roles: []string{"admin"}}, m) {
		t.Fatal("analyst and admin should use the agent")
	}
}
