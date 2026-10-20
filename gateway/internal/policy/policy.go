// Package policy holds the authorization rules: who may use an agent and what each tool call needs.
package policy

import (
	"fmt"
	"slices"

	"pi-forge/gateway/internal/agents"
	"pi-forge/gateway/internal/auth"
)

// CanUseAgent checks the agent's role restriction.
func CanUseAgent(p auth.Principal, m agents.Manifest) bool {
	if len(m.Policy.Roles) == 0 || p.HasRole("admin") {
		return true
	}
	return slices.ContainsFunc(m.Policy.Roles, p.HasRole)
}

// ToolDecision decides a single tool call. toolCallsSoFar counts earlier calls in the same run.
// Tools outside the manifest allowlist are always denied, even if the runtime somehow exposes them.
func ToolDecision(m agents.Manifest, toolName string, toolCallsSoFar int) (agents.Decision, string) {
	if !slices.Contains(m.Tools, toolName) {
		return agents.Deny, fmt.Sprintf("tool %s is not enabled for agent %s", toolName, m.ID)
	}
	if limit := m.Policy.MaxToolCalls; limit > 0 && toolCallsSoFar >= limit {
		return agents.Deny, fmt.Sprintf("tool call budget exhausted (%d per run)", limit)
	}
	switch d := m.Policy.Tools[toolName]; d {
	case agents.Deny:
		return agents.Deny, fmt.Sprintf("tool %s is denied by policy", toolName)
	case agents.Ask:
		return agents.Ask, ""
	default:
		return agents.Allow, ""
	}
}
