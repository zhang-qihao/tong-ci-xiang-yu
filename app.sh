#!/usr/bin/env bash
set -Eeuo pipefail
source "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/scripts/node-env.sh"

ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
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
  [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || die "PORT 必须是 1 到 65535 的数字"
  PORT=$((10#$PORT))
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
    trap 'exit 130' INT
    trap 'exit 143' TERM
    return
  fi
  local holder=''
  [[ -f "$LOCK_DIR/pid" ]] && holder="$(tr -d '[:space:]' < "$LOCK_DIR/pid")"
  if [[ "$holder" =~ ^[0-9]+$ ]] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$LOCK_DIR"
    acquire_lock
    return
  fi
  die "已有另一个 app.sh/update.sh 操作正在进行${holder:+ (PID $holder)}"
}

pid_is_running() {
  local state
  kill -0 "$1" 2>/dev/null || return 1
  state="$(ps -p "$1" -o stat= 2>/dev/null)" || return 1
  [[ "$state" != *Z* ]]
}

linux_process_is_ours() {
  local proc_dir="$1" executable script
  [[ "$proc_dir/cwd" -ef "$ROOT" && -r "$proc_dir/cmdline" ]] || return 1
  {
    IFS= read -r -d '' executable && IFS= read -r -d '' script
  } < "$proc_dir/cmdline" || return 1
  case "${executable##*/}" in
    node|nodejs) ;;
    *) return 1 ;;
  esac
  [[ "$script" == "$ROOT/server.mjs" || "$script" == server.mjs || "$script" == ./server.mjs ]]
}

pid_is_ours() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) || return 1
  pid_is_running "$pid" || return 1
  if [[ "$(uname -s)" == Linux ]]; then
    linux_process_is_ours "/proc/$pid"
    return $?
  fi

  local command_line executable field process_dev='' process_inode='' root_identity
  executable="$(ps -p "$pid" -o comm= 2>/dev/null)" || return 1
  case "${executable##*/}" in
    node|nodejs) ;;
    *) return 1 ;;
  esac
  command_line="$(ps -p "$pid" -o command= 2>/dev/null)" || return 1
  [[ "$command_line" == *server.mjs ]] || return 1
  root_identity="$(stat -f '%d:%i' "$ROOT")" || return 1
  while IFS= read -r field; do
    case "$field" in
      D*) process_dev="${field#D}" ;;
      i*) process_inode="${field#i}" ;;
    esac
  done < <(lsof -a -p "$pid" -d cwd -F Dni 2>/dev/null || true)
  [[ "$process_dev" =~ ^0x[0-9a-fA-F]+$ && "$process_inode" =~ ^[0-9]+$ ]] || return 1
  process_dev=$((process_dev))
  [[ "$process_dev:$process_inode" == "$root_identity" ]]
}

read_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) || return 1
  printf '%s\n' "$pid"
}

our_listener_pid() {
  command -v lsof >/dev/null 2>&1 || return 1
  local listener
  for listener in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true); do
    if pid_is_ours "$listener"; then
      printf '%s\n' "$listener"
      return 0
    fi
  done
  return 1
}

managed_pid() {
  local pid
  if pid="$(read_pid)" && pid_is_ours "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi
  our_listener_pid
}

ensure_port_available() {
  node --input-type=commonjs -e '
    const server = require("node:net").createServer();
    server.once("error", (error) => {
      console.error(`app.sh: 无法监听端口 ${process.argv[1]} (${error.code})，不会停止占用端口的其他进程`);
      process.exitCode = 1;
    });
    server.listen(Number(process.argv[1]), "0.0.0.0", () => server.close());
  ' "$PORT"
}

health_check() {
  curl -fsS --max-time 3 "http://127.0.0.1:$PORT/" >/dev/null 2>&1
}

stop_app() {
  local pid attempt
  if ! pid="$(managed_pid)"; then
    rm -f "$PID_FILE"
    log "服务未运行或没有可验证的本项目 PID；不会停止其他进程"
    return 0
  fi

  log "停止服务 (PID $pid)"
  kill -TERM "$pid" 2>/dev/null || return 1
  for (( attempt = 0; attempt < 20; attempt++ )); do
    if ! pid_is_running "$pid"; then
      rm -f "$PID_FILE"
      log "服务已停止"
      return 0
    fi
    sleep 0.5
  done

  if pid_is_ours "$pid"; then
    log "服务未能优雅退出，发送 KILL"
    kill -KILL "$pid" || return 1
    for (( attempt = 0; attempt < 10; attempt++ )); do
      pid_is_running "$pid" || break
      sleep 0.2
    done
    if pid_is_running "$pid"; then
      log "服务停止失败，保留 PID 文件"
      return 1
    fi
  fi
  rm -f "$PID_FILE"
  log "服务已停止"
}

start_app() {
  local pid attempt
  if pid="$(managed_pid)"; then
    printf '%s\n' "$pid" > "$PID_FILE"
    if health_check; then
      log "服务已在运行 (PID $pid, PORT $PORT)"
      return 0
    fi
    log "本项目服务健康检查失败，清理后重启"
    stop_app || return 1
  fi
  rm -f "$PID_FILE"
  ensure_port_available || return 1
  [[ -f "$ROOT/dist/index.html" ]] || die "缺少 dist/index.html，请先运行 npm ci 和 npm run build"
  node --input-type=module -e 'await import("ws"); await import("vite")' >/dev/null 2>&1 || die "项目依赖未安装完整，请先运行 npm ci"

  log "启动服务 (PORT $PORT)"
  nohup env NODE_ENV=production PORT="$PORT" node "$ROOT/server.mjs" >> "$LOG_FILE" 2>&1 < /dev/null &
  pid=$!
  printf '%s\n' "$pid" > "$PID_FILE"
  for (( attempt = 0; attempt < 20; attempt++ )); do
    sleep 0.5
    if ! pid_is_running "$pid"; then
      rm -f "$PID_FILE"
      log "服务进程启动后退出，请查看 $LOG_FILE"
      return 1
    fi
    if health_check; then
      log "服务已启动 (PID $pid, PORT $PORT)"
      return 0
    fi
  done

  log "服务启动后健康检查失败，将停止本项目进程"
  stop_app
  return 1
}

status_app() {
  local pid
  if pid="$(managed_pid)"; then
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

main() {
  local action="${1:-}"
  case "$action" in
    start|stop|restart|status) ;;
    *) printf '用法: %s {start|stop|restart|status}\n' "$(basename "$0")" >&2; return 2 ;;
  esac
  validate_port
  command -v node >/dev/null 2>&1 || die "未找到 Node.js，请先安装 Node.js"
  command -v curl >/dev/null 2>&1 || die "未找到 curl，请先安装 curl"
  if [[ "$(uname -s)" != Linux ]]; then
    command -v lsof >/dev/null 2>&1 || die "当前系统需要 lsof 才能安全识别进程"
  fi
  cd "$ROOT"
  acquire_lock
  case "$action" in
    start) start_app ;;
    stop) stop_app ;;
    restart) stop_app && start_app ;;
    status) status_app ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
