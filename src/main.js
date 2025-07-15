// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/).
import { Actor } from 'apify';
// Web scraping and browser automation library (Read more at https://crawlee.dev)
import { PuppeteerCrawler } from 'crawlee';

// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// read more about this here: https://nodejs.org/docs/latest-v18.x/api/esm.html#mandatory-file-extensions
import { router } from './routes.js';

// The init() call configures the Actor for its environment. It's recommended to start every Actor with an init().
await Actor.init();

// Define the URL to start the crawler with - get it from the input of the Actor.
const input = await Actor.getInput();
let url = null;
if (input?.url) {
    url = input.url;
} else if (Array.isArray(input?.startUrls) && input.startUrls.length > 0 && input.startUrls[0].url) {
    url = input.startUrls[0].url;
}
if (!url) {
    throw new Error('Input must have a "url" string property or a "startUrls" array with at least one object containing a "url".');
}
const startUrls = [{ url }];

// Create a proxy configuration that will rotate proxies from Apify Proxy.
const proxyConfiguration = await Actor.createProxyConfiguration();

// Create a PuppeteerCrawler that will use the proxy configuration and and handle requests with the router from routes.js file.
const crawler = new PuppeteerCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxRequestsPerCrawl: 1,
    navigationTimeoutSecs: 30, // Reduced from 120 to 30 seconds
    maxRequestRetries: 1,      // Only 1 retry (2 attempts total)
    launchContext: {
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
});

// Run the crawler with the start URLs and wait for it to finish.
await crawler.run(startUrls);

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit().
await Actor.exit();