// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/).
import Actor from 'apify';
// Web scraping and browser automation library (Read more at https://crawlee.dev)
import { PuppeteerCrawler } from 'crawlee';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { randomUUID } from 'crypto';

puppeteer.use(StealthPlugin());

// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// read more about this here: https://nodejs.org/docs/latest-v18.x/api/esm.html#mandatory-file-extensions
import { router } from './routes.js';

// The init() call configures the Actor for its environment. It's recommended to start every Actor with an init().
await Actor.init();

// Define the URLs to start the crawler with - get them from the input of the Actor.
const input = await Actor.getInput();
let urls = [];
if (Array.isArray(input?.startUrls) && input.startUrls.length > 0) {
    urls = input.startUrls.map(obj => obj.url).filter(Boolean);
} else if (input?.url) {
    urls = [input.url];
}
if (urls.length === 0) {
    throw new Error('Input must have a "url" string property or a "startUrls" array with at least one object containing a "url".');
}
const maxConcurrency = Math.min(5, urls.length);

// Create a proxy configuration that will rotate proxies from Apify's RESIDENTIAL pool with session rotation.
const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    session: true
});

let failedCount = 0;
let successCount = 0;
const startTime = Date.now();

const MAX_RUN_TIME = 300 * 1000; // 300 seconds in ms
const SAFE_SHUTDOWN_BUFFER = 20 * 1000; // 20 seconds in ms
const runStart = Date.now();

// Create a PuppeteerCrawler that will use the proxy configuration and and handle requests with the router from routes.js file.
const crawler = new PuppeteerCrawler({
    proxyConfiguration,
    requestHandler: async (context) => {
        // Clean shutdown: check remaining time before handling each request
        const elapsed = Date.now() - runStart;
        if (MAX_RUN_TIME - elapsed < SAFE_SHUTDOWN_BUFFER) {
            context.log.warning('Approaching run time limit, skipping new requests and allowing in-flight pages to finish.');
            return;
        }
        try {
            await router(context);
            successCount++;
        } catch (err) {
            // This should rarely happen, as failedRequestHandler will handle most errors
            context.log.error(`Handler error for ${context.request.url}: ${err.message}`);
            throw err;
        }
    },
    maxRequestsPerCrawl: urls.length,
    maxConcurrency,
    handlePageTimeoutSecs: 30,
    maxRequestRetries: 1,
    navigationTimeoutSecs: 30, // Keep for navigation
    launchContext: {
        launcher: puppeteer,
        launchOptions: {
            headless: true,
            args: [
                '--disable-gpu',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
            ],
        },
    },
    preNavigationHooks: [
        async ({ page, request, session, log }) => {
            // Set a random User-Agent
            const userAgents = [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
            ];
            const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
            await page.setUserAgent(userAgent);
            // Insert a random delay (500–1500ms)
            const delay = 500 + Math.floor(Math.random() * 1000);
            log.info(`Delaying navigation by ${delay}ms to mimic human behavior.`);
            await new Promise(res => setTimeout(res, delay));
        }
    ],
    failedRequestHandler: async ({ request, error, log }) => {
        failedCount++;
        log.error(`FAILED: ${request.url} | ${error && error.message}`);
    },
});

// Run-level health check: HEAD request to a known Marriott page
const healthCheckUrl = 'https://www.marriott.com/';
try {
    const response = await Actor.utils.requestAsBrowser({
        url: healthCheckUrl,
        method: 'HEAD',
        timeoutSecs: 5,
    });
    if (response.statusCode < 200 || response.statusCode >= 400) {
        throw new Error(`Health check failed with status ${response.statusCode}`);
    }
    console.log('Health check passed: Marriott site is reachable.');
} catch (err) {
    console.error('Site unreachable, aborting run:', err.message);
    await Actor.exit();
}

// Run the crawler with the start URLs and wait for it to finish.
await crawler.run(urls.map(url => ({ url })));

// After crawl, record and store metrics
const runDuration = (Date.now() - startTime) / 1000;
const stats = {
    total_urls: urls.length,
    successes: successCount,
    failures: failedCount,
    run_duration_seconds: runDuration
};
console.log('Run stats:', stats);
await Actor.setValue('RUN-STATS', stats);

// Incremental back-off logic: flag if failure rate > 50%
if (urls.length > 0 && failedCount / urls.length > 0.5) {
    const msg = `High failure rate detected: ${(failedCount / urls.length * 100).toFixed(1)}% failures.`;
    console.warn(msg);
    await Actor.setValue('BACKOFF-FLAG', { flagged: true, message: msg, stats });
}

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit().
await Actor.exit();