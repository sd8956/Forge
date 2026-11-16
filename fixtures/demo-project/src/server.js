// Todo web app. No runtime dependencies: Node's http module serves the page and the API.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const STATIC_FILES = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript; charset=utf-8"] };

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const file = req.method === "GET" ? STATIC_FILES[url.pathname] : undefined;
    if (file) {
      res.writeHead(200, { "content-type": file[1] });
      res.end(await readFile(join(PUBLIC_DIR, file[0])));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

if (process.argv[1] === import.meta.filename) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, "127.0.0.1", () => process.stdout.write(`demo-project listening on http://127.0.0.1:${port}\n`));
}
