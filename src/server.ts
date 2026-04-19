import express from "express";
import worker from "./index.js";

const app = express();
const port = process.env.PORT || 3000;

app.all("*", async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
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
      MYBROWSER: undefined, // Browser rendering not available in Node shim (use BRIDGE_URL)
      STREAM_CACHE: undefined,
      TMDB_KEY: process.env.TMDB_KEY || "",
      BRIDGE_URL: process.env.BRIDGE_URL || "https://latanime-bridge.onrender.com",
      MFP_URL: process.env.MFP_URL || "",
      MFP_PASSWORD: process.env.MFP_PASSWORD || "latanime",
      SAVEFILES_KEY: process.env.SAVEFILES_KEY || "10714bycsy7sdam6brjzf",
    };

    const request = new Request(url.toString(), {
      method: req.method,
      headers: headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : (req as any)
    });

    const response = await worker.fetch(request, env as any);

    res.status(response.status);
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json") || contentType.includes("text/")) {
      res.send(await response.text());
    } else {
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    }
  } catch (err) {
    console.error("Shim Error:", err);
    res.status(500).send("Internal Server Error");
  }
});

app.listen(port, () => {
  console.log(`Latanime Node Shim listening on port ${port}`);
});
