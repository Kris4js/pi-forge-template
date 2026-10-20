// Package auth turns a request's API key (+ optional tenant headers) into a Principal.
package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strings"

	"pi-forge/gateway/internal/tenant"
)

const (
	HeaderWorkspace = "X-Workspace"
	HeaderUser      = "X-User-Id"
	// Wildcard in a key's workspace/user lets the caller pick it via header (trusted backends).
	Wildcard = "*"
)

var (
	ErrUnauthenticated = errors.New("unauthenticated")
	ErrForbidden       = errors.New("forbidden")
)

type Principal struct {
	KeyID  string        `json:"keyId"`
	Tenant tenant.Tenant `json:"tenant"`
	Roles  []string      `json:"roles"`
}

func (p Principal) HasRole(role string) bool { return slices.Contains(p.Roles, role) }

// SameTenant reports whether p may act on resources owned by t (admins of the workspace included).
func (p Principal) SameTenant(t tenant.Tenant) bool {
	if p.Tenant.Workspace != t.Workspace {
		return false
	}
	return p.Tenant.UserID == t.UserID || p.HasRole("admin")
}

type KeyEntry struct {
	ID        string   `json:"id"`
	Key       string   `json:"key"`
	Workspace string   `json:"workspace"`
	User      string   `json:"user"`
	Roles     []string `json:"roles"`
}

type Authenticator struct {
	keys          []KeyEntry
	hashes        [][32]byte
	devAuth       bool
	requireUserID bool
}

func New(keysFile string, devAuth, requireUserID bool) (*Authenticator, error) {
	a := &Authenticator{devAuth: devAuth, requireUserID: requireUserID}
	if keysFile == "" {
		return a, nil
	}
	raw, err := os.ReadFile(keysFile)
	if err != nil {
		return nil, err
	}
	var file struct {
		Keys []KeyEntry `json:"keys"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("parse %s: %w", keysFile, err)
	}
	for _, k := range file.Keys {
		if k.Key == "" || k.ID == "" || k.Workspace == "" {
			return nil, fmt.Errorf("key entry %q needs id, key and workspace", k.ID)
		}
		a.keys = append(a.keys, k)
		a.hashes = append(a.hashes, sha256.Sum256([]byte(k.Key)))
	}
	return a, nil
}

func (a *Authenticator) Authenticate(r *http.Request) (Principal, error) {
	token, hasToken := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !hasToken || token == "" {
		if !a.devAuth {
			return Principal{}, ErrUnauthenticated
		}
		t, err := tenant.Resolve(r.Header.Get(HeaderWorkspace), r.Header.Get(HeaderUser), a.requireUserID)
		if err != nil {
			return Principal{}, err
		}
		return Principal{KeyID: "dev", Tenant: t, Roles: []string{"admin"}}, nil
	}

	key, ok := a.lookup(token)
	if !ok {
		return Principal{}, ErrUnauthenticated
	}
	workspace := key.Workspace
	if workspace == Wildcard {
		workspace = r.Header.Get(HeaderWorkspace)
	} else if h := r.Header.Get(HeaderWorkspace); h != "" && tenant.Normalize(h, "", true) != tenant.Normalize(workspace, "", true) {
		return Principal{}, ErrForbidden
	}
	user := key.User
	if user == "" || user == Wildcard {
		user = r.Header.Get(HeaderUser)
	} else if h := r.Header.Get(HeaderUser); h != "" && h != user {
		return Principal{}, ErrForbidden
	}
	t, err := tenant.Resolve(workspace, user, a.requireUserID)
	if err != nil {
		return Principal{}, err
	}
	return Principal{KeyID: key.ID, Tenant: t, Roles: key.Roles}, nil
}

func (a *Authenticator) lookup(token string) (KeyEntry, bool) {
	sum := sha256.Sum256([]byte(token))
	found := -1
	for i, h := range a.hashes {
		if subtle.ConstantTimeCompare(sum[:], h[:]) == 1 {
			found = i
		}
	}
	if found < 0 {
		return KeyEntry{}, false
	}
	return a.keys[found], true
}
