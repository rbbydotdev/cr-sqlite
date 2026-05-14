// Minimal static server for the FUGUE·LIVE demo.
// Sets COOP/COEP so SharedArrayBuffer / WASM threading works if needed,
// and serves the right MIME types for .wasm / .mjs / .js / .css / .html.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT ?? 8787);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map":  "application/json; charset=utf-8",
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const normalised = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = join(root, normalised);
  if (!full.startsWith(root)) return null;
  return full;
}

const server = createServer(async (req, res) => {
  try {
    let urlPath = req.url ?? "/";
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = safeJoin(ROOT, urlPath);
    if (!filePath) {
      res.writeHead(403); res.end("forbidden"); return;
    }
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404); res.end("not found: " + urlPath); return;
    }
    const buf = await readFile(filePath);
    const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": buf.byteLength,
      "Cache-Control": "no-store",
      // crsqlite-wasm runs fine without COOP/COEP, but enabling these
      // keeps the door open for SharedArrayBuffer-based experiments.
      "Cross-Origin-Opener-Policy":   "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.end(buf);
  } catch (err) {
    console.error("serve error:", err);
    res.writeHead(500); res.end("server error");
  }
});

server.listen(PORT, () => {
  console.log(`fugue·live serving on http://localhost:${PORT}`);
});
