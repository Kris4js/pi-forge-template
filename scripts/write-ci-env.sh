#!/bin/sh
set -eu

ENV_FILE="${1:-.env}"
TMP_FILE="$ENV_FILE.tmp"

: > "$TMP_FILE"

if [ -n "${PORT:-}" ]; then
  printf 'PORT=%s\n' "$PORT" >> "$TMP_FILE"
fi

env | sort | while IFS='=' read -r key value; do
  case "$key" in
    PI_MODEL_*) printf '%s=%s\n' "$key" "$value" >> "$TMP_FILE" ;;
  esac
done

mv "$TMP_FILE" "$ENV_FILE"
