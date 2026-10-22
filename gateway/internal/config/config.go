// Package config loads gateway settings from the environment (and an optional .env file).
package config

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr string
	// Root is the repository root; relative paths below resolve against it.
	Root      string
	AgentsDir string
	DataDir   string
	WebDir    string

	KeysFile      string
	DevAuth       bool
	RequireUserID bool

	MaxConcurrentRuns   int
	MaxRunsPerWorkspace int
	RunTimeout          time.Duration
	ApprovalTimeout     time.Duration
	QuestionTimeout     time.Duration

	// RuntimeCommand starts the TS runtime; it speaks JSON-RPC on stdin/stdout.
	RuntimeCommand []string
}

func Load() (Config, error) {
	root, err := filepath.Abs(env("FORGE_ROOT", "."))
	if err != nil {
		return Config{}, err
	}
	envFile := env("FORGE_ENV_FILE", filepath.Join(root, ".env"))
	if err := loadDotEnv(envFile); err != nil && !os.IsNotExist(err) {
		return Config{}, fmt.Errorf("read %s: %w", envFile, err)
	}

	abs := func(p string) string {
		if p == "" || filepath.IsAbs(p) {
			return p
		}
		return filepath.Join(root, p)
	}
	c := Config{
		Addr:                env("FORGE_ADDR", ":8090"),
		Root:                root,
		AgentsDir:           abs(env("FORGE_AGENTS_DIR", "agents")),
		DataDir:             abs(env("FORGE_DATA_DIR", ".data")),
		WebDir:              abs(env("FORGE_WEB_DIR", "")),
		KeysFile:            abs(env("FORGE_KEYS_FILE", "")),
		DevAuth:             boolEnv("FORGE_DEV_AUTH"),
		RequireUserID:       boolEnv("FORGE_REQUIRE_USER_ID"),
		MaxConcurrentRuns:   intEnv("FORGE_MAX_CONCURRENT_RUNS", 16),
		MaxRunsPerWorkspace: intEnv("FORGE_MAX_RUNS_PER_WORKSPACE", 4),
		RunTimeout:          time.Duration(intEnv("FORGE_RUN_TIMEOUT_MS", 300_000)) * time.Millisecond,
		ApprovalTimeout:     time.Duration(intEnv("FORGE_APPROVAL_TIMEOUT_MS", 120_000)) * time.Millisecond,
		QuestionTimeout:     time.Duration(intEnv("FORGE_QUESTION_TIMEOUT_MS", 86_400_000)) * time.Millisecond,
		RuntimeCommand:      strings.Fields(env("FORGE_RUNTIME_CMD", "node --import tsx runtime/src/main.ts")),
	}
	if c.KeysFile == "" && !c.DevAuth {
		return Config{}, fmt.Errorf("no FORGE_KEYS_FILE configured; set FORGE_DEV_AUTH=1 for local anonymous access")
	}
	if len(c.RuntimeCommand) == 0 {
		return Config{}, fmt.Errorf("FORGE_RUNTIME_CMD is empty")
	}
	// The runtime resolves its own paths from the same variables.
	os.Setenv("FORGE_AGENTS_DIR", c.AgentsDir)
	os.Setenv("FORGE_DATA_DIR", c.DataDir)
	os.Setenv("FORGE_ENV_FILE", envFile)
	return c, nil
}

// loadDotEnv sets KEY=VALUE pairs that are not already present in the process environment.
func loadDotEnv(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if i := strings.Index(value, " #"); i >= 0 && !strings.HasPrefix(value, `"`) && !strings.HasPrefix(value, "'") {
			value = strings.TrimSpace(value[:i])
		}
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		if _, exists := os.LookupEnv(key); !exists {
			os.Setenv(key, value)
		}
	}
	return scanner.Err()
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func boolEnv(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func intEnv(key string, fallback int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key))); err == nil && v > 0 {
		return v
	}
	return fallback
}
