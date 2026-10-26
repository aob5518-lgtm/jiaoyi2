#!/usr/bin/env bash
# Code-only deployment; mutable financial state is never rolled back.
set -Eeuo pipefail
umask 077
APP=/root/app/hyper_safe_ui_v4
ROOT=/root/app/releases
SHA=${1:?exact commit required}
ARCHIVE=${2:?code-only archive required}
MODE=${3:---deploy}
[[ "$SHA" =~ ^[0-9a-f]{40}$ && "$MODE" =~ ^--(deploy|stage-only)$ ]] || exit 2
[[ "$(realpath "$APP")" == "$APP" && "$(realpath "$ARCHIVE")" == "$ROOT/"* && -f "$ARCHIVE" ]] || exit 2
node -e 'if(process.versions.node.split(".")[0]!=="22")throw Error("Requires Node v22")'
STAMP=$(date +%Y%m%d-%H%M%S)
WORK="$ROOT/release-$SHA-$STAMP"
STAGE="$WORK/stage"
BACKUP="/root/app/deploy-backups/release-$SHA-$STAMP"
mkdir -p "$WORK" /root/app/deploy-backups
exec 9>/root/app/deploy-backups/deploy.lock
flock -n 9 || { echo 'Another deployment is active'; exit 1; }
[[ ! -e /root/app/deploy-backups/INCOMPLETE ]] || { echo 'Interrupted deployment requires code-only recovery'; exit 1; }
git init -q "$WORK/verified-git"
git -C "$WORK/verified-git" remote add origin https://github.com/aob5518-lgtm/jiaoyi2.git
git -C "$WORK/verified-git" fetch -q origin main
[[ "$(git -C "$WORK/verified-git" rev-parse FETCH_HEAD)" == "$SHA" ]] || { echo 'GitHub main SHA mismatch'; exit 1; }
git -C "$WORK/verified-git" checkout -q --detach "$SHA"
GUARD="$WORK/verified-git/scripts/release_guard.py"
python3 "$GUARD" verify "$WORK/verified-git" "$SHA" "$ARCHIVE" "$STAGE"
(cd "$STAGE" && npm ci --ignore-scripts --no-audit --no-fund && npm test && python3 tests/deploy_release_test.py) > "$WORK/stage-test.log" 2>&1 || { tail -70 "$WORK/stage-test.log"; exit 1; }
echo "STAGE=$STAGE"
echo 'STAGE_TEST_PASSED'
[[ "$MODE" != --stage-only ]] || exit 0
STOPPED=0; INSTALLED=0
recover(){
 local result=$?
 trap - EXIT INT TERM
 if [[ "$result" != 0 && "$STOPPED" == 1 ]]; then
  echo "Failure; recovering code only from $BACKUP"
  if ! pm2 stop hyper-safe-ui; then echo 'CRITICAL: cannot stop; rollback not attempted'; exit 1; fi
  if [[ "$INSTALLED" == 1 ]]; then
   if ! python3 "$GUARD" rollback "$APP" "$BACKUP"; then echo 'CRITICAL: rollback failed; service STOPPED'; exit 1; fi
  fi
  if ! pm2 restart hyper-safe-ui; then echo 'CRITICAL: old code restored, restart needs attention'; exit 1; fi
  rm -f /root/app/deploy-backups/INCOMPLETE
 fi
 exit "$result"
}
trap recover EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Registered BEFORE stop. Kill -9/power loss leaves a durable marker and stopped service.
# Recover with PM2 stopped and release_guard.py rollback APP BACKUP; never restore state.
printf '%s\n' "$BACKUP" > /root/app/deploy-backups/INCOMPLETE
STOPPED=1
pm2 stop hyper-safe-ui
python3 "$GUARD" backup "$APP" "$BACKUP"
INSTALLED=1
python3 "$GUARD" install "$APP" "$STAGE"
python3 "$GUARD" verify-states "$APP" "$BACKUP"
pm2 restart hyper-safe-ui --update-env
sleep 5
for route in / /api/public/status /api/status /api/v4/terminal; do
 expected=401
 [[ "$route" != / ]] || expected=302
 [[ "$route" != /api/public/status ]] || expected=200
 [[ "$(curl --max-time 20 -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$route")" == "$expected" ]]
done
python3 "$GUARD" verify-code "$APP" "$STAGE"
# Only config/auth remain immutable after restart; ledgers may legitimately advance.
python3 - "$APP" "$BACKUP" <<'PY'
import hashlib,json,pathlib,sys
app,backup=map(pathlib.Path,sys.argv[1:]); hashes=json.loads((backup/'state-before.json').read_text())
for f in ['config.json','auth.json']:
 if f not in hashes or hashlib.sha256((app/f).read_bytes()).hexdigest()!=hashes[f]: raise RuntimeError('Protected config changed: '+f)
for f in hashes:
 if f.endswith('.json'): json.loads((app/f).read_text())
PY
pm2 status hyper-safe-ui
rm -f /root/app/deploy-backups/INCOMPLETE
STOPPED=0
trap - EXIT INT TERM
echo "DEPLOY_COMMIT=$SHA"
echo "BACKUP=$BACKUP"
echo 'DEPLOY_COMPLETE: no accounts created/started, no permissions changed'
