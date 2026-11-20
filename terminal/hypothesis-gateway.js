"use strict";

const fs = require("fs");
const http = require("http");

const routes = new Map([
  ["/api/v5/status", "GET"],
  ["/api/v5/research", "GET"],
  ["/api/v5/accounts", "POST"],
  ["/api/v5/control", "POST"]
]);

// The caller must authenticate the main-site session before calling this bridge.
function handle(req, res, pathname, {accessFile, port = 3311} = {}) {
  const send = (status, error) => {
    if (res.writableEnded) return;
    res.writeHead(status, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"});
    res.end(JSON.stringify({ok: false, error}));
  };
  if (routes.get(pathname) !== req.method) return send(405, "研究接口或操作不支持");
  if (req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin);
      if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host) {
        return send(403, "请在本站登录后操作");
      }
    } catch {
      return send(403, "来源不合法");
    }
  }
  let access;
  try {
    access = JSON.parse(fs.readFileSync(accessFile, "utf8")).access;
    if (typeof access !== "string" || access.length < 32) throw Error("Invalid access");
  } catch {
    return send(503, "独立研究服务连接尚未配置");
  }
  const chunks = [];
  let length = 0;
  let tooLarge = false;
  req.on("data", chunk => {
    length += chunk.length;
    if (length > 16384) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) chunks.push(chunk);
  });
  req.on("end", () => {
    if (tooLarge) return send(413, "研究请求过大");
    const upstream = http.request({
      hostname: "127.0.0.1", port, path: pathname, method: req.method,
      headers: {Authorization: "Bearer " + access, "Content-Type": "application/json", "Content-Length": length},
      timeout: 20000
    }, response => {
      const result = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) response.destroy(Error("Response too large"));
        else result.push(chunk);
      });
      response.on("error", () => send(502, "独立研究服务响应中断"));
      response.on("end", () => {
        if (res.writableEnded) return;
        res.writeHead(response.statusCode, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"});
        res.end(Buffer.concat(result));
      });
    });
    upstream.on("timeout", () => upstream.destroy(Error("Research timeout")));
    upstream.on("error", () => send(503, "独立研究服务暂不可用，请稍后刷新"));
    upstream.end(Buffer.concat(chunks));
  });
}

module.exports = {handle};
