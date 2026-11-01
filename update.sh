#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
RUN_DIR="$ROOT/.run"
LOCK_DIR="$RUN_DIR/app.lock"
REMOTE_URL="https://github.com/zhang-qihao/tong-ci-xiang-yu.git"
BRANCH="master"
PORT="${PORT:-3001}"
LOCK_HELD=0
OLD_HEAD=''
BACKUP_DIR="$RUN_DIR/update-backup-$$"
HAD_DIST=0
LOCAL_BACKUP_DIR=''

check_local_changes() {
  local path blocked=0
  while IFS= read -r -d '' path; do
    case "$path" in
      package-lock.json) ;;
      *) printf 'update.sh: 未提交的源码改动: %s\n' "$path" >&2; blocked=1 ;;
    esac
  done < <(git diff --name-only -z HEAD --; git diff --cached --name-only -z --)
  while IFS= read -r -d '' path; do
    case "$path" in
      .env|.env.*|.claude/launch.json) ;;
      *) printf 'update.sh: 未跟踪的文件: %s\n' "$path" >&2; blocked=1 ;;
    esac
  done < <(git ls-files --others --exclude-standard -z)
  (( blocked == 0 )) || die "请先处理以上源码改动；package-lock.json 和本地部署配置不受此限制"
}

check_local_collisions() {
  local target="$1" path parent
  while IFS= read -r -d '' path; do
    parent="$path"
    while [[ "$parent" != '.' ]]; do
      if [[ -e "$parent" || -L "$parent" ]]; then
        if ! git ls-files --error-unmatch -- "$parent" >/dev/null 2>&1; then
          if [[ ! -d "$parent" || "$parent" == "$path" || -L "$parent" ]]; then
            die "远端文件 $path 会覆盖本地文件 $parent，已拒绝更新"
          fi
        fi
      fi
      [[ "$parent" == */* ]] || break
      parent="${parent%/*}"
    done
  done < <(git ls-tree -r --name-only -z "$target")
}

backup_local_lockfile() {
  if git diff --quiet HEAD -- package-lock.json && git diff --cached --quiet -- package-lock.json; then return; fi
  mkdir -p "$RUN_DIR/local-backups"
  LOCAL_BACKUP_DIR="$(mktemp -d "$RUN_DIR/local-backups/$(date '+%Y%m%d-%H%M%S')-XXXXXX")"
  git diff --binary HEAD -- package-lock.json > "$LOCAL_BACKUP_DIR/working.patch"
  git diff --cached --binary -- package-lock.json > "$LOCAL_BACKUP_DIR/staged.patch"
  if [[ -e package-lock.json || -L package-lock.json ]]; then
    cp -P package-lock.json "$LOCAL_BACKUP_DIR/package-lock.json"
  fi
  log "本地锁文件改动已备份到 $LOCAL_BACKUP_DIR；本次使用远端锁文件安装依赖"
}

restore_local_lockfile() {
  [[ -n "$LOCAL_BACKUP_DIR" ]] || return 0
  if [[ -s "$LOCAL_BACKUP_DIR/working.patch" ]]; then
    git apply "$LOCAL_BACKUP_DIR/working.patch" || return 1
  fi
  if [[ -s "$LOCAL_BACKUP_DIR/staged.patch" ]]; then
    git apply --cached "$LOCAL_BACKUP_DIR/staged.patch" || return 1
  fi
  log "已恢复更新前的本地锁文件改动；备份继续保留"
}

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

die() {
  printf 'update.sh: %s\n' "$*" >&2
  exit 1
}

release_lock() {
  if (( LOCK_HELD == 1 )); then
    rm -rf "$LOCK_DIR"
    LOCK_HELD=0
  fi
}

acquire_lock() {
  mkdir -p "$RUN_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    LOCK_HELD=1
    trap release_lock EXIT
    trap 'release_lock; exit 130' INT TERM
    return
  fi
  local holder=''
  [[ -f "$LOCK_DIR/pid" ]] && holder="$(tr -d '[:space:]' < "$LOCK_DIR/pid" || true)"
  if [[ "$holder" =~ ^[0-9]+$ ]] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$LOCK_DIR"
    acquire_lock
    return
  fi
  die "已有另一个 app.sh/update.sh 操作正在进行${holder:+ (PID $holder)}"
}

ensure_repo() {
  cd "$ROOT"
  if [[ ! -d .git ]]; then
    git init >/dev/null
    git branch -M "$BRANCH"
  fi
  local current_url=''
  current_url="$(git remote get-url origin 2>/dev/null || true)"
  if [[ -n "$current_url" ]]; then
    [[ "$current_url" == "$REMOTE_URL" ]] || die "origin 已指向其他仓库: $current_url"
  else
    git remote add origin "$REMOTE_URL"
  fi
}

restore_old_version() {
  if [[ -z "$OLD_HEAD" ]]; then
    log "没有旧提交可回滚"
    return 0
  fi
  log "恢复旧版本 $OLD_HEAD"
  git reset --hard "$OLD_HEAD" >/dev/null || return 1
  restore_local_lockfile || return 1
  if (( HAD_DIST == 1 )); then
    rm -rf "$ROOT/dist"
    cp -R "$BACKUP_DIR/dist" "$ROOT/dist"
  else
    rm -rf "$ROOT/dist"
  fi
}

cleanup_backup() {
  rm -rf "$BACKUP_DIR"
}

build_target() {
  log "安装锁定依赖"
  npm ci || return 1
  log "构建前端"
  npm run build || return 1
  [[ -f "$ROOT/dist/index.html" ]] || { log "构建未生成 dist/index.html"; return 1; }
}

main() {
  acquire_lock
  ensure_repo

  OLD_HEAD="$(git rev-parse --verify HEAD 2>/dev/null)" || die "请先从远端克隆项目后再运行更新脚本"
  check_local_changes

  log "从 origin/$BRANCH 获取更新"
  git fetch origin "$BRANCH"
  local target
  target="$(git rev-parse FETCH_HEAD)"
  if [[ -n "$OLD_HEAD" ]] && ! git merge-base --is-ancestor "$OLD_HEAD" "$target"; then
    die "远程 master 不是本地版本的快进更新，请手动处理 Git 历史"
  fi

  check_local_collisions "$target"
  backup_local_lockfile

  mkdir -p "$BACKUP_DIR"
  if [[ -d "$ROOT/dist" ]]; then
    cp -R "$ROOT/dist" "$BACKUP_DIR/dist"
    HAD_DIST=1
  fi

  log "切换到远程版本 $target"
  git reset --hard "$target" >/dev/null
  if ! build_target; then
    log "依赖安装或构建失败，保留当前运行服务并恢复代码"
    restore_old_version
    cleanup_backup
    return 1
  fi

  log "重启服务 (PORT $PORT)"
  if ! PORT="$PORT" APP_LOCK_HELD=1 "$ROOT/app.sh" restart; then
    log "新版本启动失败，尝试恢复旧版本"
    restore_old_version
    if [[ -n "$OLD_HEAD" ]]; then
      PORT="$PORT" APP_LOCK_HELD=1 "$ROOT/app.sh" start || log "旧版本恢复启动也失败，请查看 .logs/app.log"
    fi
    cleanup_backup
    return 1
  fi

  if ! curl -fsS --max-time 3 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    log "新版本健康检查失败，尝试恢复旧版本"
    PORT="$PORT" APP_LOCK_HELD=1 "$ROOT/app.sh" stop || true
    restore_old_version
    if [[ -n "$OLD_HEAD" ]]; then
      PORT="$PORT" APP_LOCK_HELD=1 "$ROOT/app.sh" start || log "旧版本恢复启动也失败，请查看 .logs/app.log"
    fi
    cleanup_backup
    return 1
  fi

  cleanup_backup
  log "更新完成，服务运行在 PORT $PORT"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
