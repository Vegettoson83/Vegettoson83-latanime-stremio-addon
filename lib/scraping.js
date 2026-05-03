
const SB_API_KEY = process.env.SB_API_KEY || "";

export async function fetchHtmlSB(url) {
  if (!SB_API_KEY) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    return r.text();
  }

  const sbUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SB_API_KEY}&url=${encodeURIComponent(url)}&render_js=true`;
  const r = await fetch(sbUrl);
  if (!r.ok) throw new Error(`ScrapingBee error: ${r.status}`);
  return r.text();
}
