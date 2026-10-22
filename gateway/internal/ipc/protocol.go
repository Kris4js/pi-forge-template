// Package ipc talks to the TS runtime: JSON-RPC 2.0, one JSON object per LF-terminated line over
// the child's stdin/stdout. Mirrors runtime/src/protocol.ts; see docs/ipc-protocol.md.
package ipc

import (
	"encoding/json"

	"pi-forge/gateway/internal/tenant"
)

const ProtocolVersion = 1

const (
	MethodHello         = "runtime.hello"
	MethodModelsList    = "models.list"
	MethodRunStart      = "run.start"
	MethodRunCancel     = "run.cancel"
	MethodSessionList   = "session.list"
	MethodSessionGet    = "session.get"
	MethodSessionInfo   = "session.info"
	MethodSessionDelete = "session.delete"
	MethodSessionUpdate = "session.update"
	MethodArtifactList  = "artifact.list"
	MethodArtifactGet   = "artifact.get"
	MethodToolAuthorize = "tool.authorize"
	MethodUserAsk       = "user.ask"
	MethodRunEvent      = "run.event"
)

// Application error codes returned by the runtime (JSON-RPC reserves negative codes).
const (
	CodeInvalidParams = -32602
	CodeNotFound      = 404
	CodeConflict      = 409
)

type HelloResult struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Runtime         string `json:"runtime"`
	Model           string `json:"model,omitempty"`
}

// TenantParams addresses the user's own data. Sessions belong to the user, not to an agent.
type TenantParams struct {
	Tenant tenant.Tenant `json:"tenant"`
}

// SessionScope is a run's target: the user plus the agent that runs it.
type SessionScope struct {
	Tenant  tenant.Tenant `json:"tenant"`
	AgentID string        `json:"agentId"`
}

type RunStartParams struct {
	SessionScope
	RunID     string   `json:"runId"`
	SessionID string   `json:"sessionId,omitempty"`
	Input     RunInput `json:"input"`
	// Model is a key from models.list; the runtime refuses models that are not registered.
	Model         string `json:"model,omitempty"`
	ImageModel    string `json:"imageModel,omitempty"`
	ThinkingLevel string `json:"thinkingLevel,omitempty"`
}

type Attachment struct {
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

type RunInput struct {
	Text        string       `json:"text"`
	Attachments []Attachment `json:"attachments,omitempty"`
}

type RunStartResult struct {
	SessionID string `json:"sessionId"`
}

type SessionParams struct {
	TenantParams
	SessionID string `json:"sessionId"`
}

// SessionUpdateParams renames (pi session_info) and/or pins a session.
type SessionUpdateParams struct {
	SessionParams
	Name   *string `json:"name,omitempty"`
	Pinned *bool   `json:"pinned,omitempty"`
}

// SessionInfo names the agent a session is bound to (empty for a session without a binding).
type SessionInfo struct {
	ID      string `json:"id"`
	AgentID string `json:"agentId,omitempty"`
}

type ArtifactParams struct {
	SessionParams
	Revision *int `json:"revision,omitempty"`
}

type ToolAuthorizeParams struct {
	RunID      string          `json:"runId"`
	ToolCallID string          `json:"toolCallId"`
	ToolName   string          `json:"toolName"`
	Input      json.RawMessage `json:"input"`
}

type ToolAuthorizeResult struct {
	Decision string `json:"decision"` // allow | deny
	Reason   string `json:"reason,omitempty"`
}

// AskQuestion is one question of an ask_user call; several are shown as tabs.
type AskQuestion struct {
	// Header is the short tab label.
	Header      string   `json:"header,omitempty"`
	Question    string   `json:"question"`
	Options     []string `json:"options"`
	MultiSelect bool     `json:"multiSelect,omitempty"`
}

// AskAnswer answers one question: chosen options (at most one unless multiSelect) and/or own words.
type AskAnswer struct {
	Selected []string `json:"selected,omitempty"`
	Other    string   `json:"other,omitempty"`
}

// UserAskParams is an ask_user call: the runtime waits for the answers (or until they expire / the run ends).
type UserAskParams struct {
	RunID      string        `json:"runId"`
	ToolCallID string        `json:"toolCallId"`
	Questions  []AskQuestion `json:"questions"`
}

// UserAskResult: status answered | skipped | expired | cancelled; Answers (one per question) when answered.
type UserAskResult struct {
	Status  string      `json:"status"`
	Answers []AskAnswer `json:"answers,omitempty"`
}

// RunEventParams carries a runtime event verbatim; the gateway only peeks at its type.
type RunEventParams struct {
	RunID string          `json:"runId"`
	Seq   int             `json:"seq"`
	Event json.RawMessage `json:"event"`
}

type Error struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *Error) Error() string { return e.Message }
