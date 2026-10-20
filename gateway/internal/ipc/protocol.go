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
	MethodRunStart      = "run.start"
	MethodRunCancel     = "run.cancel"
	MethodSessionList   = "session.list"
	MethodSessionGet    = "session.get"
	MethodSessionDelete = "session.delete"
	MethodToolAuthorize = "tool.authorize"
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

type SessionScope struct {
	Tenant  tenant.Tenant `json:"tenant"`
	AgentID string        `json:"agentId"`
}

type RunStartParams struct {
	SessionScope
	RunID     string   `json:"runId"`
	SessionID string   `json:"sessionId,omitempty"`
	Input     RunInput `json:"input"`
}

type RunInput struct {
	Text string `json:"text"`
}

type RunStartResult struct {
	SessionID string `json:"sessionId"`
}

type SessionParams struct {
	SessionScope
	SessionID string `json:"sessionId"`
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
