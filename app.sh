#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RUN_DIR="$ROOT/.run"
LOG_DIR="$ROOT/.logs"
PID_FILE="$RUN_DIR/app.pid"
LOCK_DIR="$RUN_DIR/app.lock"
LOG_FILE="$LOG_DIR/app.log"
PORT="${PORT:-3001}"
LOCK_HELD=0

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"
}

die() {
  printf 'app.sh: %s\n' "$*" >&2
  exit 1
}

validate_port() {
  [[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT 必须是数字，当前为: $PORT"
  (( PORT > 0 && PORT < 65536 )) || die "PORT 超出范围: $PORT"
}

release_lock() {
  if (( LOCK_HELD == 1 )); then
    rm -rf "$LOCK_DIR"
    LOCK_HELD=0
  fi
}

acquire_lock() {
  mkdir -p "$RUN_DIR" "$LOG_DIR"
  if [[ "${APP_LOCK_HELD:-0}" == "1" ]]; then
    return
  fi
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

pid_is_ours() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local command_line field process_dev='' process_inode='' root_identity
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command_line" == *server.mjs* ]] || return 1
  [[ "$command_line" == *node* ]] || return 1
  root_identity="$(stat -f '%d:%i' "$ROOT")"
  while IFS= read -r field; do
    case "$field" in
      D*) process_dev="${field#D}" ;;
      i*) process_inode="${field#i}" ;;
    esac
  done < <(lsof -a -p "$pid" -d cwd -F Dni 2>/dev/null || true)
  [[ -n "$process_dev" && -n "$process_inode" ]] || return 1
  process_dev=$((process_dev))
  [[ "$process_dev:$process_inode" == "$root_identity" ]]
}

read_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE" || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$pid"
}

port_listeners() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true
}

our_listener_pid() {
  local listener
  for listener in $(port_listeners); do
    if pid_is_ours "$listener"; then
      printf '%s\n' "$listener"
      return 0
    fi
  done
  return 1
}

ensure_port_available() {
  local listeners
  listeners="$(port_listeners)"
  [[ -z "$listeners" ]] && return 0
  local listener
  for listener in $listeners; do
    if ! pid_is_ours "$listener"; then
      printf 'app.sh: 端口 %s 已被其他进程占用 (PID %s)\n' "$PORT" "$listener" >&2
      ps -p "$listener" -o pid=,command= 2>/dev/null || true
      return 1
    fi
  done
  return 0
}

health_check() {
  curl -fsS --max-time 3 "http://127.0.0.1:$PORT/" >/dev/null 2>&1
}

start_app() {
  validate_port
  mkdir -p "$RUN_DIR" "$LOG_DIR"

  local existing_pid=''
  if existing_pid="$(read_pid 2>/dev/null || true)"; then
    :
  else
    existing_pid="$(our_listener_pid 2>/dev/null || true)"
    [[ -n "$existing_pid" ]] && printf '%s\n' "$existing_pid" > "$PID_FILE"
  fi
  if [[ -n "$existing_pid" ]]; then
    if pid_is_ours "$existing_pid"; then
      if health_check; then
        log "服务已在运行 (PID $existing_pid, PORT $PORT)"
        return 0
      fi
      log "发现本项目进程但健康检查未通过，将清理后重启"
      kill "$existing_pid" 2>/dev/null || true
    else
      rm -f "$PID_FILE"
    fi
  fi

  ensure_port_available || return 1
  [[ -f "$ROOT/dist/index.html" ]] || die "缺少 dist/index.html，请先运行 npm run build"

  log "启动服务 (PORT $PORT)"
  nohup env NODE_ENV=production PORT="$PORT" node "$ROOT/server.mjs" >> "$LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  printf '%s\n' "$pid" > "$PID_FILE"

  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      log "服务进程启动后退出，请查看 $LOG_FILE"
      return 1
    fi
    if health_check; then
      log "服务已启动 (PID $pid, PORT $PORT)"
      return 0
    fi
    sleep 0.5
  done

  log "服务启动后健康检查失败，将停止进程"
  kill "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  return 1
}

stop_app() {
  validate_port
  local pid=''
  if ! pid="$(read_pid 2>/dev/null || true)"; then
    pid="$(our_listener_pid 2>/dev/null || true)"
    if [[ -n "$pid" ]]; then
      printf '%s\n' "$pid" > "$PID_FILE"
    else
      local listeners
      listeners="$(port_listeners)"
      if [[ -n "$listeners" ]]; then
        printf 'app.sh: 没有本项目 PID 文件，但端口 %s 仍被其他进程占用\n' "$PORT" >&2
        return 1
      fi
      log "服务未运行"
      return 0
    fi
  fi

  if ! pid_is_ours "$pid"; then
    rm -f "$PID_FILE"
    log "清理失效 PID 文件"
    return 0
  fi

  log "停止服务 (PID $pid)"
  kill -TERM "$pid" 2>/dev/null || true
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      log "服务已停止"
      return 0
    fi
    sleep 0.5
  done

  log "服务未能优雅退出，发送 KILL"
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  return 0
}

status_app() {
  validate_port
  local pid=''
  if pid="$(read_pid 2>/dev/null || true)" && pid_is_ours "$pid"; then
    if health_check; then
      printf 'running PID=%s PORT=%s\n' "$pid" "$PORT"
      return 0
    fi
    printf 'starting-or-unhealthy PID=%s PORT=%s\n' "$pid" "$PORT"
    return 1
  fi
  printf 'stopped PORT=%s\n' "$PORT"
  return 3
}

usage() {
  printf '用法: %s {start|stop|restart|status}\n' "$(basename "$0")"
}

main() {
  local action="${1:-}"
  case "$action" in
    start|stop|restart|status) ;;
    *) usage >&2; return 2 ;;
  esac
  acquire_lock
  case "$action" in
    start) start_app ;;
    stop) stop_app ;;
    restart) stop_app && start_app ;;
    status) status_app ;;
  esac
}

main "$@"
