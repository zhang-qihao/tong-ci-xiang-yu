#!/usr/bin/env bash

# Resolve a Node.js toolchain suitable for Vite, including non-interactive SSH.
node_env_init() {
  local nvm_root="${NVM_DIR:-${HOME:-}/.nvm}" candidate highest='' version

  if [[ -n "${NODE_BIN_DIR:-}" ]]; then
    PATH="$NODE_BIN_DIR:$PATH"
  else
    nvm_root="${NVM_DIR:-${HOME:-}/.nvm}"
    if [[ -s "$nvm_root/nvm.sh" ]]; then
      # nvm may fail when no default alias exists; continue to directory lookup.
      source "$nvm_root/nvm.sh" >/dev/null 2>&1 || true
      nvm use default >/dev/null 2>&1 || true
    fi
    if [[ -d "$nvm_root/versions/node" ]]; then
      highest="$(find "$nvm_root/versions/node" -mindepth 1 -maxdepth 1 -type d -print |
        while IFS= read -r candidate; do [[ -x "$candidate/bin/node" ]] && printf '%s\n' "$candidate"; done |
        sort -V | tail -n 1)"
      [[ -n "$highest" ]] && PATH="$highest/bin:$PATH"
    fi
  fi
  export PATH

  local node_path npm_path
  node_path="$(command -v node || true)"
  npm_path="$(command -v npm || true)"
  if [[ -n "$node_path" ]]; then
    NODE_BIN_DIR="$(CDPATH= cd -- "$(dirname -- "$node_path")" && pwd -P)"
    PATH="$NODE_BIN_DIR:$PATH"
    export PATH NODE_BIN_DIR
  fi
  if [[ -z "$node_path" || -z "$npm_path" || "$(dirname -- "$npm_path")" != "${NODE_BIN_DIR:-}" ]]; then
    printf 'Node.js 环境错误：node 和 npm 必须来自同一目录，且 Node.js >= 20.19.0\n' >&2
    return 1
  fi
  version="$(node -v 2>/dev/null || true)"
  if [[ ! "$version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+) ]] ||
     (( BASH_REMATCH[1] < 20 || (BASH_REMATCH[1] == 20 && BASH_REMATCH[2] < 19) )); then
    printf 'Node.js 版本过低：需要 >= 20.19.0，当前为 %s\n' "${version:-未知}" >&2
    return 1
  fi
}

node_env_init || exit 1
