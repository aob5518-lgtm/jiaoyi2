"""Build a minimal account-management overlay against the current production code."""
import pathlib
import sys


def prepare(server, api, reference):
    start = reference.index("async function checkAccountConnection(account) {")
    end = reference.index("\nconst server = http.createServer", start)
    helper = reference[start:end]
    marker = "const server = http.createServer((req, res) => {"
    context = "verifyLiveFlat:verifyLegacyLiveFlat,"
    route = ' const route=parsed.pathname,q=parsed.query,send=(code,payload)=>d.json(res,code,Model.redact(payload));'
    if "checkAccountConnection" in server or "/api/v4/connections" in api:
        raise ValueError("Account-management integration already exists")
    if server.count(marker) != 1 or server.count(context) != 1 or api.count(route) != 1:
        raise ValueError("Unexpected production route/context layout")
    server = server.replace(marker, helper + "\n" + marker)
    server = server.replace(context, context + "checkConnection:checkAccountConnection,")
    api = api.replace(route, route + '\n if(route.startsWith("/api/v4/connections"))return require("./connections").handle(req,res,parsed,d);')
    return server, api


if __name__ == "__main__":
    current, release, output = map(pathlib.Path, sys.argv[1:4])
    output.mkdir(parents=True, exist_ok=True)
    server, api = prepare((current / "server.js").read_text(encoding="utf-8"), (current / "terminal/api.js").read_text(encoding="utf-8"), (release / "server.js").read_text(encoding="utf-8"))
    (output / "server.js").write_text(server, encoding="utf-8")
    (output / "terminal-api.js").write_text(api, encoding="utf-8")
