import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// A local-only server for the exported Expo UI tests; the API is mocked separately.
const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/mobile/dist",
);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const pathname = decodeURIComponent(
      new URL(req.url, "http://127.0.0.1").pathname,
    );
    const path = resolve(
      root,
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") res.end();
    else
      createReadStream(path)
        .on("error", () => res.destroy())
        .pipe(res);
  } catch {
    res.writeHead(404).end();
  }
}).listen(4173, "127.0.0.1", () =>
  console.log("Expo test export: http://127.0.0.1:4173"),
);
