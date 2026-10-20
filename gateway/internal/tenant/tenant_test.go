package tenant

import "testing"

func TestNormalize(t *testing.T) {
	cases := []struct {
		in, want string
		lower    bool
	}{
		{"Acme", "acme", true},
		{"../etc/passwd", "etc-passwd", true},
		{"a/../b", "a-b", true},
		{"  ", "fallback", true},
		{".hidden", "hidden", true},
		{"user@example.com", "user@example.com", false},
		{"张三", "fallback", false},
		{"Team A", "Team-A", false},
	}
	for _, c := range cases {
		if got := Normalize(c.in, "fallback", c.lower); got != c.want {
			t.Errorf("Normalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestResolveRequiresUser(t *testing.T) {
	if _, err := Resolve("demo", "", true); err != ErrMissingUser {
		t.Fatalf("expected ErrMissingUser, got %v", err)
	}
	got, err := Resolve("", "", false)
	if err != nil || got.Workspace != DefaultWorkspace || got.UserID != AnonymousUser {
		t.Fatalf("unexpected fallback tenant %+v %v", got, err)
	}
}
