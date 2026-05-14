// Tiny static server for the browser benchmark harness.
// Usage: node serve.mjs [port]
//        defaults to port 8765, serves tests/browser/ as web root.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.argv[2] ?? 8765);

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".map": "application/json",
  ".css": "text/css",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let filePath = path.join(ROOT, decodeURIComponent(url.pathname));
    const st = await stat(filePath).catch(() => null);
    if (st?.isDirectory()) filePath = path.join(filePath, "index.html");
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`Not found: ${req.url}`);
  }
}).listen(PORT, () => {
  console.log(`serving ${ROOT} on http://localhost:${PORT}`);
});
