#!/usr/bin/env bash
# Code-only release. Production state and credentials never travel in the release archive.
set -Eeuo pipefail
APP=/root/app/hyper_safe_ui_v4
SHA=${1:?commit required}
ARCHIVE=${2:?archive required}
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$ARCHIVE" == /root/app/releases/* && -f "$ARCHIVE" ]] || exit 2
[[ "$(realpath "$APP")" == /root/app/hyper_safe_ui_v4 ]] || exit 2
STAMP=$(date +%Y%m%d-%H%M%S)
STAGE="/root/app/releases/compound-$SHA-$STAMP"
BACKUP="/root/app/deploy-backups/compound-$SHA-$STAMP"
mkdir -p "$STAGE" "$BACKUP"
chmod 700 "$BACKUP"
tar -tzf "$ARCHIVE" > "$BACKUP/release-files.list"
if grep -E '(^/|(^|/)\.\.(/|$)|(^|/)(config\.json|auth\.json|profit_history\.json|simulation_orders\.json|smart_runtime\.json|trend_only_runtime\.json|compound_4h_runtime\.json|node_modules|\.env)(/|$))' "$BACKUP/release-files.list"; then echo 'Unsafe release path'; exit 2; fi
tar -xzf "$ARCHIVE" -C "$STAGE"
printf '%s\n' "$SHA" > "$STAGE/DEPLOY_COMMIT"
ln -s "$APP/node_modules" "$STAGE/node_modules"
(cd "$STAGE" && npm test) > "$BACKUP/stage-test.log" 2>&1 || { tail -70 "$BACKUP/stage-test.log"; exit 1; }
echo 'Staged npm test passed'
cd "$APP"
node -e 'const fs=require("fs");for(const f of ["config.json","auth.json","profit_history.json","simulation_orders.json","smart_runtime.json","trend_only_runtime.json"]){if(fs.existsSync(f))JSON.parse(fs.readFileSync(f,"utf8"));}'
pm2 stop hyper-safe-ui
STOPPED=1
COPIED=0
recover(){ local code=$?; if [[ "$code" != 0 ]]; then echo 'Deployment failed; recovering original service'; if [[ "$COPIED" == 1 ]]; then tar -xzf "$BACKUP/source-before.tgz" -C "$APP"; for f in config.json auth.json; do if [[ -f "$BACKUP/$f" ]]; then cp -a "$BACKUP/$f" "$APP/$f"; fi; done; fi; if [[ "${STOPPED:-0}" == 1 || "$COPIED" == 1 ]]; then pm2 restart hyper-safe-ui; fi; fi; exit "$code"; }
trap recover EXIT
# Freeze first: all runtime files now represent the exact same stopped process.
tar --exclude='./backups' --exclude='./deploy-backups' --exclude='./.git' --exclude='./.audit' -czf "$BACKUP/app-full.tgz" -C "$APP" .
for f in config.json auth.json profit_history.json simulation_orders.json smart_runtime.json trend_only_runtime.json compound_4h_runtime.json; do if [[ -f "$f" ]]; then cp -a "$f" "$BACKUP/$f"; fi; done
find "$STAGE" -type f -printf '%P\n' > "$BACKUP/code-files.list"
while IFS= read -r f; do if [[ -f "$APP/$f" ]]; then printf '%s\n' "$f"; fi; done < "$BACKUP/code-files.list" > "$BACKUP/replaced-existing.list"
tar -czf "$BACKUP/source-before.tgz" -C "$APP" -T "$BACKUP/replaced-existing.list"
CONFIG_HASH=$(sha256sum config.json | cut -d' ' -f1)
AUTH_HASH=$(sha256sum auth.json | cut -d' ' -f1)
COPIED=1
tar -xzf "$ARCHIVE" -C "$APP"
printf '%s\n' "$SHA" > "$APP/DEPLOY_COMMIT"
for f in config.json auth.json profit_history.json simulation_orders.json smart_runtime.json trend_only_runtime.json compound_4h_runtime.json; do if [[ -f "$BACKUP/$f" ]]; then cmp "$BACKUP/$f" "$APP/$f"; fi; done
pm2 restart hyper-safe-ui --update-env
STOPPED=0
sleep 5
[[ "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/)" == 302 ]]
[[ "$(curl -sS -o "$BACKUP/public-status.json" -w '%{http_code}' http://127.0.0.1:3000/api/public/status)" == 200 ]]
[[ "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/status)" == 401 ]]
[[ "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/compound/status)" == 401 ]]
[[ "$(sha256sum config.json | cut -d' ' -f1)" == "$CONFIG_HASH" ]]
[[ "$(sha256sum auth.json | cut -d' ' -f1)" == "$AUTH_HASH" ]]
node -e 'const fs=require("fs"),C=require("./strategy/compound_4h/config"),V=require("./trend_only_v3");if(C.normalize({allowLive:true}).allowLive!==false||V.normalizeConfig({}).allowLive!==false)throw Error("Paper-only failed");const before=JSON.parse(fs.readFileSync(process.argv[1]+"/config.json")),after=JSON.parse(fs.readFileSync("config.json"));if(JSON.stringify(before)!==JSON.stringify(after))throw Error("Production account settings changed");const b=JSON.parse(fs.readFileSync(process.argv[1]+"/profit_history.json")),a=JSON.parse(fs.readFileSync("profit_history.json"));for(const [id,rows]of Object.entries(b)){const ids=new Set((a[id]||[]).map(v=>v.id));for(const v of rows)if(v.id&&!ids.has(v.id))throw Error("History lost");}console.log("Paper-only, production configuration and history preservation passed");' "$BACKUP"
node -e 'const fs=require("fs"),crypto=require("crypto"),path=require("path");let count=0;for(const line of fs.readFileSync(process.argv[2],"utf8").trim().split("\n")){if(!line||line==="DEPLOY_COMMIT")continue;const actual=fs.readFileSync(line),expected=fs.readFileSync(path.join(process.argv[1],line));if(!actual.equals(expected))throw Error("Release content mismatch: "+line);count++;}console.log("Verified release files:",count);' "$STAGE" "$BACKUP/code-files.list"
pm2 status hyper-safe-ui
echo "DEPLOY_COMMIT=$SHA"
echo "BACKUP=$BACKUP"
echo 'DEPLOY_COMPLETE: no production accounts created or started; no Live enabled'
trap - EXIT
