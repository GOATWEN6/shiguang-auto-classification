#!/bin/zsh
set -euo pipefail

: "${SGX_RUNTIME_DIR:?SGX_RUNTIME_DIR is required}"
gateway_env="${SGX_GATEWAY_ENV_FILE:-${HOME}/.config/sgx/public-gateway.env}"
if [[ ! -r "${gateway_env}" ]]; then
  print -u2 "SGX gateway env file is missing or unreadable."
  exit 2
fi

set -a
source "${gateway_env}"
set +a

cd "${SGX_RUNTIME_DIR}"
exec "${SGX_NODE_BIN:-/opt/homebrew/bin/node}" bin/public-test-gateway.mjs
