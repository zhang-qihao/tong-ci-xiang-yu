#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RUN_DIR="$ROOT/.run"
LOCK_DIR="$RUN_DIR/app.lock"
REMOTE_URL="https://github.com/zhang-qihao/tong-ci-xiang-yu.git"
BRANCH="master"
PORT="${PORT:-3001}"
LOCK_HELD=0
OLD_HEAD=''
BACKUP_DIR="$RUN_DIR/update-backup-$$"
HAD_DIST=0

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
  git reset --hard "$OLD_HEAD" >/dev/null || true
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

  local dirty
  dirty="$(git status --porcelain --untracked-files=all)"
  [[ -z "$dirty" ]] || die "工作树有未提交改动，请先提交或清理后再更新"

  if OLD_HEAD="$(git rev-parse --verify HEAD 2>/dev/null)"; then
    :
  else
    OLD_HEAD=''
  fi

  log "从 origin/$BRANCH 获取更新"
  git fetch origin "$BRANCH"
  local target
  target="$(git rev-parse FETCH_HEAD)"
  if [[ -n "$OLD_HEAD" ]] && ! git merge-base --is-ancestor "$OLD_HEAD" "$target"; then
    die "远程 master 不是本地版本的快进更新，请手动处理 Git 历史"
  fi

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

main "$@"
