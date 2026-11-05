package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf16"

	"pi-forge/gateway/internal/auth"
	"pi-forge/gateway/internal/ipc"
)

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	var out json.RawMessage
	if err := s.Runtime.Call(r.Context(), ipc.MethodProjectList, ipc.TenantParams{Tenant: p.Tenant}, &out); err != nil {
		return err
	}
	writeRaw(w, http.StatusOK, out)
	return nil
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	return s.saveProject(w, r, p, true)
}

func (s *Server) updateProject(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	return s.saveProject(w, r, p, false)
}

func (s *Server) saveProject(w http.ResponseWriter, r *http.Request, p auth.Principal, create bool) error {
	var body struct {
		Name         *string `json:"name"`
		Instructions *string `json:"instructions"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		return apiError{http.StatusBadRequest, "invalid_project", "body must contain a project name and/or instructions"}
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return apiError{http.StatusBadRequest, "invalid_project", "body must be one JSON object"}
	}
	if (create && body.Name == nil) || (body.Name == nil && body.Instructions == nil) {
		return apiError{http.StatusBadRequest, "invalid_project", "project name is required when creating; an update must set name or instructions"}
	}
	if body.Name != nil {
		*body.Name = strings.TrimSpace(*body.Name)
		if *body.Name == "" || len(utf16.Encode([]rune(*body.Name))) > 80 {
			return apiError{http.StatusBadRequest, "invalid_project", "project name must be 1..80 characters"}
		}
	}
	if body.Instructions != nil && len(utf16.Encode([]rune(*body.Instructions))) > 20_000 {
		return apiError{http.StatusBadRequest, "invalid_project", "project instructions must be at most 20000 characters"}
	}
	params := ipc.ProjectParams{TenantParams: ipc.TenantParams{Tenant: p.Tenant}, ProjectID: r.PathValue("project"), Name: body.Name, Instructions: body.Instructions}
	method, status := ipc.MethodProjectUpdate, http.StatusOK
	if create {
		method, status = ipc.MethodProjectCreate, http.StatusCreated
	}
	var out json.RawMessage
	if err := s.Runtime.Call(r.Context(), method, params, &out); err != nil {
		return err
	}
	writeRaw(w, status, out)
	return nil
}

func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	params := ipc.ProjectParams{TenantParams: ipc.TenantParams{Tenant: p.Tenant}, ProjectID: r.PathValue("project")}
	if err := s.Runtime.Call(r.Context(), ipc.MethodProjectDelete, params, nil); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
