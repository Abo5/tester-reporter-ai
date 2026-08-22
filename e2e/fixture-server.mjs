// =============================================================================
// e2e/fixture-server.mjs
// A tiny static server for the fixture pages, with one endpoint that fails on
// purpose so the extension has a real 4xx/5xx to capture.
//
// WHY a real server and not file:// — content scripts, fetch and webRequest all
// behave differently on file:// URLs, so testing there would prove nothing
// about how the extension works on a staging site.
// =============================================================================

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "..", "fixtures");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** Starts the server and resolves with { url, close }. */
export function startFixtureServer(port = 0) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    // The deliberate failure the extension is meant to notice.
    if (url.pathname.startsWith("/api/contracts/")) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "tenant_not_found", traceId: "9f21" }));
      return;
    }

    // A second failure shape: a request that never returns a body.
    if (url.pathname === "/api/slow-fail") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "service_unavailable" }));
      return;
    }

    const name = url.pathname === "/" ? "/catalog.html" : url.pathname;
    const filePath = path.join(FIXTURE_DIR, path.normalize(name).replace(/^(\.\.[/\\])+/, ""));

    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actualPort = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
