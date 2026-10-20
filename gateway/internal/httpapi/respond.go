package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"pi-forge/gateway/internal/auth"
	"pi-forge/gateway/internal/ipc"
	"pi-forge/gateway/internal/runs"
	"pi-forge/gateway/internal/tenant"
)

type apiError struct {
	status  int
	code    string
	message string
}

func (e apiError) Error() string { return e.message }

func (s *Server) writeErr(w http.ResponseWriter, err error) {
	var api apiError
	var rpc *ipc.Error
	switch {
	case errors.As(err, &api):
	case errors.Is(err, auth.ErrUnauthenticated):
		api = apiError{http.StatusUnauthorized, "unauthenticated", "missing or invalid API key"}
	case errors.Is(err, auth.ErrForbidden), errors.Is(err, runs.ErrForbidden):
		api = apiError{http.StatusForbidden, "forbidden", err.Error()}
	case errors.Is(err, tenant.ErrMissingUser):
		api = apiError{http.StatusBadRequest, "missing_user", "X-User-Id header is required"}
	case errors.Is(err, runs.ErrBusy):
		api = apiError{http.StatusTooManyRequests, "busy", err.Error()}
	case errors.Is(err, runs.ErrSessionBusy):
		api = apiError{http.StatusConflict, "session_busy", err.Error()}
	case errors.Is(err, runs.ErrNotFound), errors.Is(err, runs.ErrNoApproval):
		api = apiError{http.StatusNotFound, "not_found", err.Error()}
	case errors.Is(err, ipc.ErrUnavailable):
		api = apiError{http.StatusServiceUnavailable, "runtime_unavailable", err.Error()}
	case errors.As(err, &rpc):
		switch rpc.Code {
		case ipc.CodeNotFound:
			api = apiError{http.StatusNotFound, "not_found", rpc.Message}
		case ipc.CodeConflict:
			api = apiError{http.StatusConflict, "conflict", rpc.Message}
		case ipc.CodeInvalidParams:
			api = apiError{http.StatusBadRequest, "invalid_params", rpc.Message}
		default:
			s.Log.Error("runtime error", "code", rpc.Code, "err", rpc.Message)
			api = apiError{http.StatusBadGateway, "runtime_error", rpc.Message}
		}
	default:
		s.Log.Error("internal error", "err", err)
		api = apiError{http.StatusInternalServerError, "internal", "internal error"}
	}
	writeJSON(w, api.status, map[string]string{"error": api.code, "message": api.message})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	raw, _ := json.Marshal(v)
	writeRaw(w, status, raw)
}

func writeRaw(w http.ResponseWriter, status int, raw []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

// writeSSE writes one event; id < 0 omits the id line (non-replayable control events).
func writeSSE(w http.ResponseWriter, id int, event string, data any) {
	raw, ok := data.(json.RawMessage)
	if !ok {
		raw, _ = json.Marshal(data)
	}
	if id >= 0 {
		fmt.Fprintf(w, "id: %d\n", id)
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw)
}
