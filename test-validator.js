const { isValidStreamUrl } = require('./bridge-server');

const testCases = [
    { url: 'https://example.com/video.mp4', expected: true },
    { url: 'https://example.com/playlist.m3u8', expected: true },
    { url: 'https://googleusercontent.com/proxy/abc', expected: true },
    { url: 'https://mp4upload.com/abc.mp4', expected: true },
    { url: 'https://example.com/ads/script.js', expected: false },
    { url: 'https://doubleclick.net/tracker', expected: false },
    { url: 'https://example.com/embed/123', expected: false },
    { url: 'https://example.com/video.mp4?ad=123', expected: false }, // Should fail due to ad pattern
    { url: 'https://example.com/master.m3u8', expected: true },
];

let failures = 0;
testCases.forEach(({ url, expected }) => {
    const result = isValidStreamUrl(url);
    if (result !== expected) {
        console.error(`FAIL: url=${url}, expected=${expected}, got=${result}`);
        failures++;
    } else {
        console.log(`PASS: url=${url}`);
    }
});

if (failures === 0) {
    console.log('All validation tests passed.');
    process.exit(0);
} else {
    console.error(`${failures} tests failed.`);
    process.exit(1);
}
