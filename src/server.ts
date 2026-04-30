
import express from 'express';
import cors from 'cors';
import { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import worker from './index.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Shim for Cloudflare Worker environment
const env = {
  STREAM_CACHE: null as any, // KV not available in Node shim without extra setup
  TMDB_KEY: process.env.TMDB_KEY || "",
  BRIDGE_URL: process.env.BRIDGE_URL || "https://latanime-bridge.onrender.com",
  MFP_URL: process.env.MFP_URL || "",
  MFP_PASSWORD: process.env.MFP_PASSWORD || "latanime",
  SAVEFILES_KEY: process.env.SAVEFILES_KEY || "10714bycsy7sdam6brjzf",
};

app.all('*', async (req: ExpressRequest, res: ExpressResponse) => {
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  // Construct a Fetch Request from the Express request
  const fetchReq = new Request(url, {
    method: req.method,
    headers: req.headers as any,
    body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body) : undefined,
  });

  try {
    const response = await worker.fetch(fetchReq, env);

    // Copy headers from Fetch Response to Express Response
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    res.status(response.status);

    // Stream the body if possible
    if (response.body) {
      const reader = response.body.getReader();
      const stream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } catch (err) {
          console.error('Stream error:', err);
        } finally {
          res.end();
        }
      };
      stream();
    } else {
      res.end();
    }
  } catch (error) {
    console.error('Worker error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(port, () => {
  console.log(`Latanime shim listening on port ${port}`);
});
