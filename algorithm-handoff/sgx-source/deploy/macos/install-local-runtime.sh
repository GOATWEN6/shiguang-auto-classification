#!/bin/zsh
set -euo pipefail

project_dir="${SGX_PROJECT_DIR:-/Users/wenqingzhong/Documents/SGX}"
release_name="${SGX_RELEASE_NAME:-$(date +%Y%m%d-%H%M%S)}"
support_dir="${HOME}/Library/Application Support/SGX"
releases_dir="${support_dir}/releases"
data_dir="${support_dir}/data/http-current"
release_dir="${releases_dir}/${release_name}"
staging_dir="${releases_dir}/.staging-${release_name}-$$"
provider_env="${HOME}/.config/sgx/provider.env"
source_data="${project_dir}/harness/live-baseline/v0.1/.local-runs/http-current"

if [[ ! "${release_name}" =~ '^[A-Za-z0-9._-]+$' ]]; then
  print -u2 "SGX_RELEASE_NAME contains unsupported characters."
  exit 2
fi
if [[ ! -f "${project_dir}/.next/standalone/server.js" ]]; then
  print -u2 "Standalone build is missing; run npm run build after enabling output: standalone."
  exit 3
fi
if [[ ! -f "${project_dir}/.env.local" ]]; then
  print -u2 "Provider configuration .env.local is missing."
  exit 4
fi
if [[ -e "${release_dir}" ]]; then
  print -u2 "Release already exists: ${release_name}"
  exit 5
fi

mkdir -p "${releases_dir}" "${data_dir}" "${HOME}/.config/sgx"
chmod 700 "${support_dir}" "${releases_dir}" "${support_dir}/data" "${data_dir}" "${HOME}/.config/sgx"
install -m 600 "${project_dir}/.env.local" "${provider_env}"

mkdir -p "${staging_dir}"
cp -R "${project_dir}/.next/standalone/." "${staging_dir}/"
mkdir -p "${staging_dir}/.next"
cp -R "${project_dir}/.next/static" "${staging_dir}/.next/static"
cp -R "${project_dir}/public" "${staging_dir}/public"

mkdir -p "${staging_dir}/bin"
install -m 700 "${project_dir}/deploy/macos/run-algorithm-service.sh" "${staging_dir}/bin/run-algorithm-service.sh"
install -m 700 "${project_dir}/deploy/macos/run-public-gateway.sh" "${staging_dir}/bin/run-public-gateway.sh"
install -m 600 "${project_dir}/scripts/public-test-gateway.mjs" "${staging_dir}/bin/public-test-gateway.mjs"

mkdir -p "${staging_dir}/harness/live-baseline/v0.1/live-canary"
install -m 600 "${project_dir}/harness/live-baseline/v0.1/live-canary/manifest.json" \
  "${staging_dir}/harness/live-baseline/v0.1/live-canary/manifest.json"
install -m 600 "${project_dir}/harness/live-baseline/v0.1/live-canary/run-http-first-batch.mjs" \
  "${staging_dir}/harness/live-baseline/v0.1/live-canary/run-http-first-batch.mjs"

for source_file in \
  "src/lib/algorithm-service/composition.ts" \
  "src/lib/interview-policy/continuation-v03.ts" \
  "src/lib/response-runtime/spoken-text.ts"; do
  mkdir -p "${staging_dir}/${source_file:h}"
  install -m 600 "${project_dir}/${source_file}" "${staging_dir}/${source_file}"
done

if [[ -d "${source_data}" && -z "$(find "${data_dir}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  cp -R "${source_data}/." "${data_dir}/"
fi
mkdir -p "${staging_dir}/harness/live-baseline/v0.1/.local-runs"
ln -s "${data_dir}" "${staging_dir}/harness/live-baseline/v0.1/.local-runs/http-current"
ln -s "${provider_env}" "${staging_dir}/.env.local"
chmod -R go-rwx "${staging_dir}"

mv "${staging_dir}" "${release_dir}"
ln -s "${release_dir}" "${support_dir}/.current-$$"
mv -f "${support_dir}/.current-$$" "${support_dir}/current"
print "${release_dir}"
