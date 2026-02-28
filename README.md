# Latanime Stremio Addon

A Stremio addon for watching anime in Spanish (Latino/Castellano) from latanime.org, running as a Cloudflare Worker.

## Auto-Deploy via GitHub Actions

Every push to `main` automatically deploys to Cloudflare Workers.

### One-time Setup

#### 1. Get your Cloudflare credentials

- **Account ID**: Go to [dash.cloudflare.com](https://dash.cloudflare.com) → any domain or Workers page → right sidebar shows your Account ID
- **API Token**: Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token → use the **"Edit Cloudflare Workers"** template → Create Token → copy it

#### 2. Add secrets to GitHub

In your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Your API token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | Your Account ID from step 1 |

#### 3. Push to main

```bash
git add .
git commit -m "Initial deploy"
git push origin main
```

GitHub Actions will deploy automatically. Check the **Actions** tab for progress.

#### 4. Add to Stremio

After deploy succeeds, your URL will be:
```
https://latanime-stremio.<your-subdomain>.workers.dev
```

In Stremio → **Addons** → **Community Addons** → paste the URL → Install 🎉

## Manual Deploy (Cloudflare)

```bash
npm install
npx wrangler login
npx wrangler deploy
```

## Render Deployment

This repository is also configured for deployment on Render. It uses a hybrid architecture with an addon server and a scraping bridge.

- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm start`
- **Environment Variables**:
  - `SB_API_KEY`: Your ScrapingBee API key (required for bridge).
