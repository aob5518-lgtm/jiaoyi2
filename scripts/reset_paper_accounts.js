"use strict";
// One-time, offline administrative reset. No API endpoint and no exchange imports.
const fs = require("fs"), path = require("path"), crypto = require("crypto"), child = require("child_process");
const reset = require("../terminal/paper-reset");
function apply(directory, backup) {
  const root = path.resolve(directory), dest = path.resolve(backup);
  const processes = JSON.parse(child.execFileSync("pm2", ["jlist"], {encoding: "utf8"}));
  const app = processes.find(item => item.name === "hyper-safe-ui");
  if (!app || app.pm2_env.status !== "stopped") throw Error("必须先停止生产进程并取得一致性备份");
  if (!fs.existsSync(path.join(dest, "application-before.tar.gz"))) throw Error("缺少完整部署前备份");
  const source = {}, ledgerValues = {};
  for (const file of ["config.json", ...reset.files]) {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) continue;
    source[file] = fs.readFileSync(target);
    if (file !== "config.json") ledgerValues[file] = JSON.parse(source[file]);
  }
  const result = reset.plan(JSON.parse(source["config.json"]), ledgerValues);
  const transaction = path.join(dest, "paper-reset");
  fs.mkdirSync(transaction, {mode: 0o700});
  for (const [file, bytes] of Object.entries(source)) fs.writeFileSync(path.join(transaction, file), bytes, {mode: 0o600, flag: "wx"});
  const changes = {"config.json": result.config, ...result.ledgers};
  const hashes = Object.fromEntries(Object.entries(source).map(([file, bytes]) => [file, crypto.createHash("sha256").update(bytes).digest("hex")]));
  fs.writeFileSync(path.join(transaction, "PREPARED.json"), JSON.stringify(hashes), {mode: 0o600});
  try {
    for (const [file, data] of Object.entries(changes)) {
      const current = fs.readFileSync(path.join(root, file));
      if (crypto.createHash("sha256").update(current).digest("hex") !== hashes[file]) throw Error("停止后文件仍发生变化");
      const temp = path.join(root, file + ".paper-reset.tmp");
      const fd = fs.openSync(temp, "w", 0o600);
      try {fs.writeFileSync(fd, JSON.stringify(data, null, 2));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    }
    for (const file of Object.keys(changes)) fs.renameSync(path.join(root, file + ".paper-reset.tmp"), path.join(root, file));
    fs.writeFileSync(path.join(transaction, "COMMITTED.json"), JSON.stringify(result.report, null, 2), {mode: 0o600});
    return result.report;
  } catch (error) {
    for (const [file, bytes] of Object.entries(source)) fs.writeFileSync(path.join(root, file), bytes, {mode: 0o600});
    throw error;
  }
}
if (require.main === module) {
  if (process.argv.length !== 5 || process.argv[2] !== "--apply") throw Error("用法 --apply APP_DIRECTORY BACKUP_DIRECTORY");
  console.log(JSON.stringify(apply(process.argv[3], process.argv[4]), null, 2));
}
module.exports = {apply};
