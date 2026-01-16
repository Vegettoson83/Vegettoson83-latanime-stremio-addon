const PROVIDERS = {
    'yourupload.com': async (page) => {
        await page.waitForSelector('video');
        return page.evaluate(() => document.querySelector('video')?.src || document.querySelector('video source')?.src);
    },
    'mp4upload.com': async (page) => {
        await page.waitForSelector('video', { state: 'visible', timeout: 20000 });
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/https?:\/\/[^"']+\.(mp4|m3u8)[^"']*/);
                if (match) return match[0];
            }
            const video = document.querySelector('video');
            return video?.src || video?.querySelector('source')?.src;
        });
    },
    'vidsrc.to': async (page) => {
        await page.waitForSelector('iframe');
        const iframeSrc = await page.$eval('iframe', el => el.src);
        if (iframeSrc.includes('m3u8')) return iframeSrc;
        return page.evaluate(() => {
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const match = script.textContent.match(/https?:\/\/[^"']+\.m3u8[^"']*/);
                if (match) return match[0];
            }
            return null;
        });
    }
};

/**
 * Validates if a URL is a direct streamable link.
 * @param {string} url - The URL to validate.
 * @returns {boolean} - True if valid.
 */
function isValidStreamUrl(url) {
    if (!url) return false;
    const path = url.split('?')[0];
    const isDirect = path.endsWith('.mp4') || path.endsWith('.m3u8');
    const isBlacklisted = /[/_-]ad([/_-]|$)/.test(url) || url.includes('placeholder');
    return isDirect && !isBlacklisted;
}

module.exports = {
    PROVIDERS,
    isValidStreamUrl
};
