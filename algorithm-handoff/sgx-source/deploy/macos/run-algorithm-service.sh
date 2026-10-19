#!/bin/zsh
set -euo pipefail

: "${SGX_RUNTIME_DIR:?SGX_RUNTIME_DIR is required}"
runtime_env="${SGX_RUNTIME_ENV_FILE:-${HOME}/.config/sgx/algorithm-runtime.env}"
if [[ ! -r "${runtime_env}" ]]; then
  print -u2 "SGX runtime env file is missing or unreadable."
  exit 2
fi

set -a
source "${runtime_env}"
set +a

cd "${SGX_RUNTIME_DIR}"
if [[ ! -f server.js || ! -f .next/BUILD_ID ]]; then
  print -u2 "SGX standalone production build is missing; deploy it before starting the service."
  exit 3
fi
export HOSTNAME="127.0.0.1"
export PORT="3100"
exec "${SGX_NODE_BIN:-/opt/homebrew/bin/node}" server.js
