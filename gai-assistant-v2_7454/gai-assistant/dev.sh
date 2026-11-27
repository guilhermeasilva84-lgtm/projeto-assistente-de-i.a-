#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python_bin="${GAI_PYTHON:-.venv/bin/python}"
"$python_bin" -m uvicorn app.main:app --app-dir backend --port 8010 &
api_pid=$!
trap 'kill "$api_pid" 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM
npm run frontend -- "$@"
