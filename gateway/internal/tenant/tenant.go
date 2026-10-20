// Package tenant canonicalizes tenant identity (workspace + user). The runtime only accepts
// canonical segments, so every identity must pass through here before crossing IPC.
package tenant

import (
	"errors"
	"regexp"
	"strings"
)

const (
	DefaultWorkspace = "demo"
	AnonymousUser    = "anonymous"
	maxSegment       = 128
)

var ErrMissingUser = errors.New("missing user id")

// Tenant is the identity the runtime partitions storage by:
// <data>/workspaces/<Workspace>/users/<UserID>/agents/<agent>/sessions.
type Tenant struct {
	Workspace string `json:"workspace"`
	UserID    string `json:"userId"`
}

var (
	separators = regexp.MustCompile(`[/\\]+`)
	dots       = regexp.MustCompile(`\.\.+`)
	invalid    = regexp.MustCompile(`[^a-zA-Z0-9_.@-]`)
	dashes     = regexp.MustCompile(`-+`)
	canonical  = regexp.MustCompile(`^[A-Za-z0-9_@][A-Za-z0-9_.@-]{0,127}$`)
)

// Normalize maps arbitrary input to a filesystem-safe segment, or fallback when nothing usable remains.
func Normalize(input, fallback string, lower bool) string {
	v := strings.TrimSpace(input)
	if lower {
		v = strings.ToLower(v)
	}
	v = separators.ReplaceAllString(v, "-")
	v = dots.ReplaceAllString(v, "-")
	v = invalid.ReplaceAllString(v, "-")
	v = dashes.ReplaceAllString(v, "-")
	v = strings.Trim(v, "-.")
	if len(v) > maxSegment {
		v = strings.TrimRight(v[:maxSegment], "-.")
	}
	if v == "" || !canonical.MatchString(v) {
		return fallback
	}
	return v
}

// Resolve builds a canonical tenant. An empty user falls back to AnonymousUser unless requireUser.
func Resolve(workspace, userID string, requireUser bool) (Tenant, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		if requireUser {
			return Tenant{}, ErrMissingUser
		}
		userID = AnonymousUser
	}
	return Tenant{
		Workspace: Normalize(workspace, DefaultWorkspace, true),
		UserID:    Normalize(userID, AnonymousUser, false),
	}, nil
}
