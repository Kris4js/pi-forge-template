package agents

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestDefaultToolsAreAddedUnlessDenied(t *testing.T) {
	dir := t.TempDir()
	write := func(id, body string) {
		if err := os.MkdirAll(filepath.Join(dir, id), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, id, "agent.json"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("plain", `{"id":"plain","name":"p","tools":["search"]}`)
	write("listed", `{"id":"listed","name":"l","tools":["ask_user"]}`)
	write("optout", `{"id":"optout","name":"o","tools":[],"policy":{"tools":{"ask_user":"deny"}}}`)
	r, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := r.Get("plain")
	if !slices.Equal(plain.Tools, []string{"search", "ask_user"}) {
		t.Fatalf("plain tools = %v", plain.Tools)
	}
	listed, _ := r.Get("listed")
	if !slices.Equal(listed.Tools, []string{"ask_user"}) {
		t.Fatalf("listed tools must not duplicate: %v", listed.Tools)
	}
	optout, _ := r.Get("optout")
	if slices.Contains(optout.Tools, "ask_user") {
		t.Fatalf("denied default tool must stay out: %v", optout.Tools)
	}
}
