// Package agents reads agent manifests (agents/<id>/agent.json). The gateway uses the metadata and
// the `policy` block; the runtime reads the same files for prompts, tools and skills.
package agents

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"time"
)

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

type Decision string

const (
	Allow Decision = "allow"
	Ask   Decision = "ask"
	Deny  Decision = "deny"
)

type Policy struct {
	// Tools maps tool name to decision; tools in the allowlist without an entry default to allow.
	Tools        map[string]Decision `json:"tools,omitempty"`
	MaxToolCalls int                 `json:"maxToolCalls,omitempty"`
	TimeoutMs    int                 `json:"timeoutMs,omitempty"`
	// Roles that may use this agent; empty means everyone.
	Roles []string `json:"roles,omitempty"`
}

type Manifest struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Tools       []string `json:"tools"`
	Policy      Policy   `json:"policy"`
	Starters    []string `json:"starters,omitempty"`
	// Preview marks an agent that publishes HTML artifacts (see runtime artifact store).
	Preview *struct {
		Tool     string `json:"tool"`
		Argument string `json:"argument"`
	} `json:"preview,omitempty"`
}

// DefaultTools are available to every agent without listing them in agent.json. The runtime adds the
// same set (runtime/src/agents/manifest.ts). An agent opts out with policy.tools.<name> = "deny".
var DefaultTools = []string{"ask_user"}

// withDefaultTools appends the default tools the manifest does not list or deny.
func withDefaultTools(m Manifest) Manifest {
	for _, tool := range DefaultTools {
		if m.Policy.Tools[tool] == Deny || slices.Contains(m.Tools, tool) {
			continue
		}
		m.Tools = append(slices.Clone(m.Tools), tool)
	}
	return m
}

func (m Manifest) Timeout(fallback time.Duration) time.Duration {
	if m.Policy.TimeoutMs > 0 {
		if d := time.Duration(m.Policy.TimeoutMs) * time.Millisecond; d < fallback {
			return d
		}
	}
	return fallback
}

type Registry struct {
	byID  map[string]Manifest
	order []string
}

func Load(dir string) (*Registry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	r := &Registry{byID: map[string]Manifest{}}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name(), "agent.json"))
		if os.IsNotExist(err) {
			continue
		} else if err != nil {
			return nil, err
		}
		var m Manifest
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, fmt.Errorf("%s/agent.json: %w", e.Name(), err)
		}
		if m.ID != e.Name() || !idPattern.MatchString(m.ID) {
			return nil, fmt.Errorf("%s/agent.json: id must equal the directory name and match %s", e.Name(), idPattern)
		}
		for tool, d := range m.Policy.Tools {
			if d != Allow && d != Ask && d != Deny {
				return nil, fmt.Errorf("%s: tool %s has invalid decision %q", m.ID, tool, d)
			}
		}
		m = withDefaultTools(m)
		r.byID[m.ID] = m
		r.order = append(r.order, m.ID)
	}
	sort.Strings(r.order)
	return r, nil
}

func (r *Registry) Get(id string) (Manifest, bool) {
	m, ok := r.byID[id]
	return m, ok
}

func (r *Registry) List() []Manifest {
	out := make([]Manifest, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.byID[id])
	}
	return out
}
