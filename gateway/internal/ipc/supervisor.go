package ipc

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"time"
)

var ErrUnavailable = errors.New("agent runtime unavailable")

// ErrConfig means the runtime refused to start because its configuration is invalid
// (exit code 78, EX_CONFIG). Restarting cannot fix that, so supervision stops.
var ErrConfig = errors.New("agent runtime configuration is invalid (see runtime log above)")

const exitConfig = 78

type SupervisorOptions struct {
	Command []string
	Dir     string
	Logger  *slog.Logger
	// Handlers for runtime->gateway traffic.
	Handlers map[string]Handler
	Notifies map[string]NotifyHandler
	// OnExit runs after the runtime process dies; in-flight runs are lost and must be failed.
	OnExit func(err error)
}

// Supervisor keeps one runtime child process alive, restarting it with backoff when it exits.
type Supervisor struct {
	opts  SupervisorOptions
	mu    sync.RWMutex
	conn  *Conn
	hello HelloResult
	ready chan struct{}
	once  sync.Once
	fatal chan error
}

func NewSupervisor(opts SupervisorOptions) *Supervisor {
	return &Supervisor{opts: opts, ready: make(chan struct{}), fatal: make(chan error, 1)}
}

// Run blocks until ctx is cancelled.
func (s *Supervisor) Run(ctx context.Context) {
	backoff := 500 * time.Millisecond
	for ctx.Err() == nil {
		started := time.Now()
		err := s.runOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		if errors.Is(err, ErrConfig) {
			s.opts.Logger.Error("runtime refused to start", "err", err)
			s.fatal <- err
			return
		}
		s.opts.Logger.Error("runtime exited", "err", err)
		if s.opts.OnExit != nil {
			s.opts.OnExit(err)
		}
		if time.Since(started) > 30*time.Second {
			backoff = 500 * time.Millisecond
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 15*time.Second)
	}
}

// WaitReady blocks until the first runtime has answered hello.
func (s *Supervisor) WaitReady(ctx context.Context) (HelloResult, error) {
	select {
	case <-ctx.Done():
		return HelloResult{}, ctx.Err()
	case err := <-s.fatal:
		s.fatal <- err
		return HelloResult{}, err
	case <-s.ready:
		s.mu.RLock()
		defer s.mu.RUnlock()
		return s.hello, nil
	}
}

func (s *Supervisor) Call(ctx context.Context, method string, params, out any) error {
	s.mu.RLock()
	conn := s.conn
	s.mu.RUnlock()
	if conn == nil {
		return ErrUnavailable
	}
	err := conn.Call(ctx, method, params, out)
	if errors.Is(err, ErrClosed) {
		return ErrUnavailable
	}
	return err
}

func (s *Supervisor) runOnce(ctx context.Context) error {
	cmd := exec.Command(s.opts.Command[0], s.opts.Command[1:]...)
	cmd.Dir = s.opts.Dir
	cmd.Env = os.Environ()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start runtime: %w", err)
	}
	s.opts.Logger.Info("runtime started", "pid", cmd.Process.Pid)
	go s.pipeLogs(stderr)

	conn := NewConn(stdin, s.opts.Handlers, s.opts.Notifies)
	served := make(chan struct{})
	go func() {
		_ = conn.Serve(stdout)
		close(served)
	}()

	helloCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	var hello HelloResult
	err = conn.Call(helloCtx, MethodHello, struct{}{}, &hello)
	cancel()
	if err == nil && hello.ProtocolVersion != ProtocolVersion {
		err = fmt.Errorf("runtime protocol %d, gateway expects %d", hello.ProtocolVersion, ProtocolVersion)
	}
	if err != nil {
		_ = cmd.Process.Kill()
		if exitCode(cmd.Wait()) == exitConfig {
			return ErrConfig
		}
		return fmt.Errorf("runtime handshake: %w", err)
	}
	s.mu.Lock()
	s.conn = conn
	s.hello = hello
	s.mu.Unlock()
	s.once.Do(func() { close(s.ready) })
	s.opts.Logger.Info("runtime ready", "model", hello.Model)

	select {
	case <-served:
	case <-ctx.Done():
		// Graceful stop: closing stdin tells the runtime to abort runs and exit.
		_ = stdin.Close()
		select {
		case <-served:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
		}
	}
	s.mu.Lock()
	s.conn = nil
	s.mu.Unlock()
	conn.Close()
	err = cmd.Wait()
	if exitCode(err) == exitConfig {
		return ErrConfig
	}
	return err
}

func exitCode(err error) int {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return 0
}

func (s *Supervisor) pipeLogs(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		s.opts.Logger.Info(scanner.Text(), "src", "runtime")
	}
}
