#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
source "$PROJECT/update.sh"
ROOT="$TEMP/repo"
RUN_DIR="$ROOT/.run"
mkdir -p "$ROOT"
cd "$ROOT"
git init -q
git config user.name 'Update Test'
git config user.email 'test@example.invalid'
cp "$PROJECT/.gitignore" .gitignore
printf 'base\n' > package-lock.json
printf 'source\n' > server.mjs
git add .
git commit -qm base
OLD_HEAD="$(git rev-parse HEAD)"
mkdir -p .claude
printf '{}\n' > .claude/launch.json
printf 'secret\n' > .env
check_local_changes
printf 'PASS local env and preview config do not block updates\n'

printf 'local lock\n' > package-lock.json
check_local_changes
backup_local_lockfile
[[ -s "$LOCAL_BACKUP_DIR/working.patch" ]]
[[ "$(< "$LOCAL_BACKUP_DIR/package-lock.json")" == 'local lock' ]]
git restore package-lock.json
restore_local_lockfile
[[ "$(< package-lock.json)" == 'local lock' ]]
printf 'PASS unstaged lockfile backed up and restored\n'

git add package-lock.json
printf 'working lock\n' > package-lock.json
LOCAL_BACKUP_DIR=''
backup_local_lockfile
git reset --hard "$OLD_HEAD" -q
restore_local_lockfile
[[ "$(< package-lock.json)" == 'working lock' ]]
[[ "$(git show :package-lock.json)" == 'local lock' ]]
printf 'PASS staged and working lockfile changes restored independently\n'

git reset --hard "$OLD_HEAD" -q
printf 'changed source\n' > server.mjs
if (check_local_changes); then printf 'FAIL dirty source allowed\n'; exit 1; fi
git restore server.mjs
printf 'custom\n' > custom.txt
if (check_local_changes); then printf 'FAIL unknown untracked file allowed\n'; exit 1; fi
rm custom.txt
printf 'PASS source changes and unknown files still blocked\n'

check_local_collisions "$OLD_HEAD"
printf 'remote config\n' > config.new
git add config.new
git commit -qm 'remote config'
TARGET="$(git rev-parse HEAD)"
git reset --hard "$OLD_HEAD" -q
mkdir config.new
printf 'local secret\n' > config.new/secret
if (check_local_collisions "$TARGET"); then printf 'FAIL local directory collision allowed\n'; exit 1; fi
[[ "$(< config.new/secret)" == 'local secret' ]]
rm -r config.new

printf 'remote env\n' > .env
git add -f .env
git commit -qm 'remote env'
TARGET="$(git rev-parse HEAD)"
git reset --hard "$OLD_HEAD" -q
printf 'local env\n' > .env
if (check_local_collisions "$TARGET"); then printf 'FAIL local env collision allowed\n'; exit 1; fi
[[ "$(< .env)" == 'local env' ]]
printf 'PASS remote collisions refuse to overwrite local files\n'
