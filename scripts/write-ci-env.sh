#!/bin/sh
# Writes .env for docker compose from CI variables (PI_MODEL_*, FORGE_*, provider API keys).
set -eu

ENV_FILE="${1:-.env}"
TMP_FILE="$ENV_FILE.tmp"
: > "$TMP_FILE"

env | sort | while IFS='=' read -r key value; do
  case "$key" in
    PI_MODEL_*|FORGE_*|ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|GEMINI_API_KEY)
      printf '%s=%s\n' "$key" "$value" >> "$TMP_FILE" ;;
  esac
done

mv "$TMP_FILE" "$ENV_FILE"
