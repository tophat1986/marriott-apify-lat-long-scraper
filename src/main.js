// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/).
import * as Actor from 'apify';

// Health check: HEAD request to a known Marriott page before any heavy imports/instantiation
await (async () => {
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
        Actor.log.info('Health check passed: Marriott site is reachable.');
    } catch (err) {
        Actor.log.error('Site unreachable, aborting run:', err.message);
        process.exit(0);
    }
})();

// Web scraping and browser automation library (Read more at https://crawlee.dev)
import { PuppeteerCrawler } from 'crawlee';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { router } from './routes.js';

puppeteer.use(StealthPlugin());

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

const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    session: true
});

let failedCount = 0;
let successCount = 0;
const runStart = Date.now();
const MAX_RUN_TIME = 300 * 1000; // 300 seconds in ms
const SAFE_SHUTDOWN_BUFFER = 20 * 1000; // 20 seconds in ms

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
            const userAgents = [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
            ];
            const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
            await page.setUserAgent(userAgent);
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

await crawler.run(urls.map(url => ({ url })));

const runDuration = (Date.now() - runStart) / 1000;
const stats = {
    total_urls: urls.length,
    successes: successCount,
    failures: failedCount,
    run_duration_seconds: runDuration
};
Actor.log.info('Run stats:', stats);
await Actor.setValue('RUN-STATS', stats);
await Actor.pushData({ type: 'run-stats', ...stats });

if (urls.length > 0 && failedCount / urls.length > 0.5) {
    const msg = `High failure rate detected: ${(failedCount / urls.length * 100).toFixed(1)}% failures.`;
    Actor.log.warning(msg);
    await Actor.setValue('BACKOFF-FLAG', { flagged: true, message: msg, stats });
    await Actor.pushData({ type: 'backoff-flag', flagged: true, message: msg, stats });
}
// No Actor.exit() at the end; let process exit naturally.