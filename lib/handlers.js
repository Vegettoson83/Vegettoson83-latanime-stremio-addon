
export async function handleExtraction(page, url) {
  let streamUrl = null;

  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.includes('.m3u8') || (u.includes('.mp4') && !u.includes('analytics'))) {
      streamUrl = u;
    }
    route.continue();
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

  // Try to click play if needed
  const playButton = await page.$('div.player, button.play, .play-button');
  if (playButton) await playButton.click().catch(() => {});

  const deadline = Date.now() + 15000;
  while (!streamUrl && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }

  return streamUrl;
}
