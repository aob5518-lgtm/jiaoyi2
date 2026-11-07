"""Prepare a narrowly scoped H01 main-site entry overlay from an existing server."""
import pathlib
import sys


def prepare(source):
    auth = '    pathname === "/index.html" ||'
    expanded = '    pathname === "/index.html" || pathname === "/legacy-terminal.html" || pathname === "/intelligent-trend.html" ||'
    if source.count(auth) != 1:
        raise ValueError("Unexpected page authentication block")
    if 'pathname.startsWith("/api/v5/")' in source:
        raise ValueError("Existing V5 integration requires an explicit reviewed upgrade")
    anchor = '  if(pathname.startsWith("/api/v4/")){'
    if source.count(anchor) != 1:
        raise ValueError("Unexpected V4 route block")
    bridge = '''  if(pathname.startsWith("/api/v5/")){
    if(!isAuthenticated(req))return jsonRes(res,401,{ok:false,error:"请先登录"});
    require("./terminal/hypothesis-gateway").handle(req,res,pathname,{
      accessFile:process.env.H01_RESEARCH_ACCESS_FILE||"/var/lib/super-agent-v5/research-access.json"
    });return;
  }
'''
    old = 'return redirect(res,valid?`/?account=${encodeURIComponent(id)}#${tab}`:`/#${tab}`);'
    new = 'return redirect(res,valid?`/legacy-terminal.html?account=${encodeURIComponent(id)}#${tab}`:`/legacy-terminal.html#${tab}`);'
    if source.count(old) != 1:
        raise ValueError("Unexpected historical link route")
    return source.replace(auth, expanded).replace(anchor, bridge + anchor).replace(old, new)


if __name__ == "__main__":
    source, target = map(pathlib.Path, sys.argv[1:3])
    target.write_text(prepare(source.read_text(encoding="utf-8")), encoding="utf-8")
