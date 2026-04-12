import { createServer } from "http";
import worker from "./index.js";

const PORT = parseInt(process.env.PORT || "3000", 10);

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Basic body parser for POST requests (if needed for search_ajax)
  let body: Buffer[] = [];
  req.on("data", (chunk) => body.push(chunk));

  req.on("end", async () => {
    const fullBody = Buffer.concat(body);

    // Construct a Fetch Request object from the Node.js request
    const workerReq = new Request(url.toString(), {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method !== "GET" && req.method !== "HEAD" ? fullBody : null,
    });

    try {
      // Execute the Worker's fetch handler
      // On Render, we might not have all the bindings (KV, Browser) unless provided via env
      const response = await worker.fetch(workerReq, process.env as any);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      res.writeHead(response.status, responseHeaders);

      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (e: any) {
      console.error("Worker error:", e);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(e));
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
