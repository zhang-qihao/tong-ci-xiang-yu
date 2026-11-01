#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
TEMP="$(mktemp -d)"
FIXTURE="$TEMP/中文 service"
SERVER_PID=''
FOREIGN_PID=''
cleanup() {
  [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true
  [[ -z "$FOREIGN_PID" ]] || kill "$FOREIGN_PID" 2>/dev/null || true
  rm -rf "$TEMP"
}
trap cleanup EXIT
mkdir -p "$FIXTURE/dist" "$FIXTURE/.run"
cp "$PROJECT/app.sh" "$FIXTURE/app.sh"
ln -s "$PROJECT/node_modules" "$FIXTURE/node_modules"
printf '<html>fixture</html>\n' > "$FIXTURE/dist/index.html"
printf '%s\n' 'import http from "node:http"; http.createServer((req,res)=>res.end("fixture")).listen(Number(process.env.PORT), "0.0.0.0");' > "$FIXTURE/server.mjs"
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
export PORT
run_app() { bash "$FIXTURE/app.sh" "$@"; }
read_server_pid() { SERVER_PID="$(< "$FIXTURE/.run/app.pid")"; }

cd "$TEMP"
run_app start
read_server_pid
FIRST_PID="$SERVER_PID"
run_app start
[[ "$(< "$FIXTURE/.run/app.pid")" == "$FIRST_PID" ]]
run_app status
run_app restart
read_server_pid
[[ "$SERVER_PID" != "$FIRST_PID" ]]
run_app stop
SERVER_PID=''
run_app stop
if run_app status; then exit 1; else [[ "$?" == 3 ]]; fi
printf 'PASS start/idempotent/status/restart/stop from another directory\n'

sleep 60 &
FOREIGN_PID=$!
printf '%s\n' "$FOREIGN_PID" > "$FIXTURE/.run/app.pid"
run_app stop
kill -0 "$FOREIGN_PID"
printf 'PASS unrelated PID is not stopped\n'
printf '99999999\n' > "$FIXTURE/.run/app.pid"
run_app start
read_server_pid
run_app stop
SERVER_PID=''
printf 'PASS stale PID recovery\n'

PORT="$PORT" node --input-type=commonjs -e 'require("net").createServer().listen(Number(process.env.PORT),"0.0.0.0")' &
BLOCKER=$!
kill "$FOREIGN_PID" 2>/dev/null || true
FOREIGN_PID="$BLOCKER"
sleep 1
if run_app start; then exit 1; fi
kill -0 "$FOREIGN_PID"
printf 'PASS occupied port rejected without stopping its owner\n'
kill "$FOREIGN_PID"
wait "$FOREIGN_PID" 2>/dev/null || true
FOREIGN_PID=''

source "$PROJECT/app.sh"
ROOT="$FIXTURE"
mkdir -p "$TEMP/proc"
ln -s "$FIXTURE" "$TEMP/proc/cwd"
printf '/usr/bin/node\0%s/server.mjs\0' "$FIXTURE" > "$TEMP/proc/cmdline"
linux_process_is_ours "$TEMP/proc"
printf '/usr/bin/node\0./server.mjs\0' > "$TEMP/proc/cmdline"
linux_process_is_ours "$TEMP/proc"
printf '/usr/bin/node\0another-server.mjs\0' > "$TEMP/proc/cmdline"
if linux_process_is_ours "$TEMP/proc"; then exit 1; fi
printf '/usr/bin/python\0server.mjs\0' > "$TEMP/proc/cmdline"
if linux_process_is_ours "$TEMP/proc"; then exit 1; fi
printf 'PASS Linux proc identity accepts only Node and this project entry point\n'
