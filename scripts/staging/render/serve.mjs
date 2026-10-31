// Loopback static server for a built dist/: applies dist/_headers as the
// static host would. Rehearsal render check only.
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const [dist, port] = process.argv.slice(2);
const rules = [];
let current;
for (const line of readFileSync(join(dist, "_headers"), "utf8").split("\n")) {
  if (!line.trim() || line.startsWith("#")) continue;
  if (!line.startsWith(" ")) rules.push((current = { pattern: line.trim(), headers: [] }));
  else {
    const i = line.indexOf(":");
    current.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
}
const match = (p, path) => (p.endsWith("*") ? path.startsWith(p.slice(0, -1)) : p === path);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
http.createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const file = join(dist, path === "/" ? "index.html" : path);
  if (path.includes("..") || !existsSync(file) || !statSync(file).isFile() || path === "/_headers") {
    res.writeHead(404);
    return res.end();
  }
  for (const rule of rules) if (match(rule.pattern, path)) for (const [k, v] of rule.headers) res.setHeader(k, v);
  res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
  res.end(readFileSync(file));
}).listen(Number(port), "127.0.0.1");
