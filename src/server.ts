import express from "express";
import worker from "./index.js";
import fetch, { Request, Response, Headers } from "node-fetch";

// Polyfill global Web APIs for Node versions that don't have them or have incomplete ones
if (!globalThis.fetch) {
  (globalThis as any).fetch = fetch;
}
if (!globalThis.Request) {
  (globalThis as any).Request = Request;
}
if (!globalThis.Response) {
  (globalThis as any).Response = Response;
}
if (!globalThis.Headers) {
  (globalThis as any).Headers = Headers;
}

const app = express();
const port = process.env.PORT || 3000;

// Handle health checks for Render
app.get("/health", (req, res) => res.status(200).send("OK"));

app.all("*", async (req, res) => {
  // Ignore favicon requests to avoid unnecessary processing
  if (req.path === "/favicon.ico") return res.status(404).end();

  try {
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers.host;
    const url = new URL(req.url, `${protocol}://${host}`);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        if (Array.isArray(value)) {
          value.forEach(v => headers.append(key, v));
        } else {
          headers.set(key, value);
        }
      }
    }

    // Mock Cloudflare Env for Node environment
    const env = {
      MYBROWSER: undefined,
      STREAM_CACHE: undefined,
      TMDB_KEY: process.env.TMDB_KEY || "",
      BRIDGE_URL: process.env.BRIDGE_URL || "https://latanime-bridge.onrender.com",
      MFP_URL: process.env.MFP_URL || "",
      MFP_PASSWORD: process.env.MFP_PASSWORD || "latanime",
      SAVEFILES_KEY: process.env.SAVEFILES_KEY || "10714bycsy7sdam6brjzf",
    };

    // Use the polyfilled or global Request
    const nodeReq = new Request(url.toString(), {
      method: req.method,
      headers: headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : (req as any)
    });

    const response = await worker.fetch(nodeReq as any, env as any);

    res.status(response.status);
    response.headers.forEach((value, key) => {
      // Don't forward transfer-encoding, express handles it
      if (key.toLowerCase() !== "transfer-encoding") {
        res.setHeader(key, value);
      }
    });

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json") || contentType.includes("text/")) {
      const text = await response.text();
      res.send(text);
    } else {
      // Stream binary bodies
      const reader = (response.body as any)?.getReader ? (response.body as any).getReader() : response.body;
      if (reader && typeof (reader as any).read === "function") {
        while (true) {
          const { done, value } = await (reader as any).read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } else if (reader && typeof (reader as any).pipe === "function") {
        (reader as any).pipe(res);
      } else {
        const buffer = await response.arrayBuffer();
        res.send(Buffer.from(buffer));
      }
    }
  } catch (err) {
    console.error("Shim Error:", err);
    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  }
});

app.listen(port, () => {
  console.log(`Latanime Node Shim listening on port ${port}`);
});
