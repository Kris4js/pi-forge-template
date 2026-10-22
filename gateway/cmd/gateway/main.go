// Command gateway is the pi-forge HTTP entry point: auth, tenancy, run governance. Agent execution
// is delegated to the TS runtime child process over JSON-RPC (see docs/ipc-protocol.md).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"pi-forge/gateway/internal/agents"
	"pi-forge/gateway/internal/auth"
	"pi-forge/gateway/internal/config"
	"pi-forge/gateway/internal/httpapi"
	"pi-forge/gateway/internal/ipc"
	"pi-forge/gateway/internal/runs"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("gateway stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	authn, err := auth.New(cfg.KeysFile, cfg.DevAuth, cfg.RequireUserID)
	if err != nil {
		return err
	}
	if cfg.DevAuth {
		log.Warn("FORGE_DEV_AUTH is on: requests without an API key act as admin of the workspace in X-Workspace")
	}
	registry, err := agents.Load(cfg.AgentsDir)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var manager *runs.Manager
	supervisor := ipc.NewSupervisor(ipc.SupervisorOptions{
		Command: cfg.RuntimeCommand,
		Dir:     cfg.Root,
		Logger:  log,
		Handlers: map[string]ipc.Handler{
			ipc.MethodToolAuthorize: func(ctx context.Context, raw json.RawMessage) (any, error) {
				var params ipc.ToolAuthorizeParams
				if err := json.Unmarshal(raw, &params); err != nil {
					return nil, err
				}
				return manager.Authorize(ctx, params), nil
			},
			ipc.MethodUserAsk: func(ctx context.Context, raw json.RawMessage) (any, error) {
				var params ipc.UserAskParams
				if err := json.Unmarshal(raw, &params); err != nil {
					return nil, err
				}
				return manager.Ask(ctx, params), nil
			},
		},
		Notifies: map[string]ipc.NotifyHandler{
			ipc.MethodRunEvent: func(raw json.RawMessage) {
				var params ipc.RunEventParams
				if json.Unmarshal(raw, &params) == nil {
					manager.OnEvent(params)
				}
			},
		},
		OnExit: func(err error) { manager.FailAll("agent runtime exited") },
	})
	manager = runs.NewManager(supervisor, runs.Limits{
		MaxConcurrent:   cfg.MaxConcurrentRuns,
		MaxPerWorkspace: cfg.MaxRunsPerWorkspace,
		RunTimeout:      cfg.RunTimeout,
		ApprovalTimeout: cfg.ApprovalTimeout,
		QuestionTimeout: cfg.QuestionTimeout,
	}, log)

	supervised := make(chan struct{})
	go func() {
		supervisor.Run(ctx)
		close(supervised)
	}()
	readyCtx, cancelReady := context.WithTimeout(ctx, 60*time.Second)
	hello, err := supervisor.WaitReady(readyCtx)
	cancelReady()
	if err != nil {
		if errors.Is(err, ipc.ErrConfig) {
			return err
		}
		return errors.New("agent runtime did not become ready")
	}

	server := &http.Server{
		Addr: cfg.Addr,
		Handler: (&httpapi.Server{
			Auth: authn, Agents: registry, Runs: manager, Runtime: supervisor, Log: log, WebDir: cfg.WebDir,
		}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	log.Info("gateway listening", "addr", cfg.Addr, "agents", len(registry.List()), "model", hello.Model)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	<-supervised
	return nil
}
