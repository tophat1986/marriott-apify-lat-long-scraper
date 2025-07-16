import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

// ---------- defaults ----------
const DEF_CONCURRENCY = 3;
const DEF_NAV_TIMEOUT_SECS = 35;
const DEF_HANDLER_TIMEOUT_SECS = 10;
const DEF_DELAY_MIN = 250;
const DEF_DELAY_MAX = 900;

// Single UA (good Chrome string)
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function pickHotelNode(blocks) {
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    const t = b?.['@type'];
    if (t === 'Hotel' || t === 'LodgingBusiness') return b;
    if (Array.isArray(t) && t.includes('Hotel')) return b;
  }
  return null;
}

// ---------- main ----------
await Actor.init();
const input = await Actor.getInput();
log.info('input', input);

// startUrls
let startUrls = [];
if (Array.isArray(input?.startUrls) && input.startUrls.length) {
  startUrls = input.startUrls.map((r) => ({ url: r.url }));
} else if (input?.url) {
  startUrls = [{ url: input.url }];
}
if (!startUrls.length) {
  log.warning('No startUrls; exiting.');
  await Actor.exit();
  process.exit(0);
}

// knobs
const concurrency = Number(input?.concurrency) || DEF_CONCURRENCY;
const navigationTimeoutSecs = Number(input?.navigationTimeoutSecs) || DEF_NAV_TIMEOUT_SECS;
const requestHandlerTimeoutSecs = Number(input?.requestHandlerTimeoutSecs) || DEF_HANDLER_TIMEOUT_SECS;
const delayMsMin = Number(input?.delayMsMin) || DEF_DELAY_MIN;
const delayMsMax = Number(input?.delayMsMax) || DEF_DELAY_MAX;

// proxy
const proxyConfiguration = await Actor.createProxyConfiguration({
  groups: ['RESIDENTIAL'],
});

// Build crawler
const crawler = new PlaywrightCrawler({
  proxyConfiguration,

  // Set UA & headers at context creation (Playwright way)
  launchContext: {
    launchOptions: { headless: true }, // Chromium bundled in base image
    contextOptions: {
      userAgent: USER_AGENT,
      locale: 'en-US',
      extraHTTPHeaders: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8',
        Connection: 'keep-alive',
      },
    },
  },

  maxConcurrency: concurrency,
  requestHandlerTimeoutSecs,
  navigationTimeoutSecs,
  maxRequestsPerCrawl: startUrls.length,

  // Lightweight resource blocking to speed load
  preNavigationHooks: [
    async ({ page }, gotoOptions) => {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
          return route.abort();
        }
        return route.continue();
      });
      gotoOptions.waitUntil = 'domcontentloaded';
    },
  ],

  async requestHandler({ request, page, log }) {
    const origUrl = request.userData?.origUrl ?? request.url;
    const finalUrl = page.url();

    // Wait briefly for JSON-LD
    await page.waitForSelector('script[type="application/ld+json"]', { timeout: 5000 }).catch(() => {});

    const jsonBlocks = await page.$$eval('script[type="application/ld+json"]', (nodes) => {
      const out = [];
      for (const n of nodes) {
        const txt = n?.textContent?.trim();
        if (!txt) continue;
        try { out.push(JSON.parse(txt)); } catch { /* ignore */ }
      }
      return out;
    });

    const hotelInfo = pickHotelNode(jsonBlocks);
    if (hotelInfo) {
      log.info(`Hotel JSON-LD found: ${hotelInfo.name ?? '(no name)'}`);
    } else {
      log.warning(`No hotel JSON-LD found @ ${finalUrl}`);
    }

    await Dataset.pushData({
      url: origUrl,
      finalUrl,
      scrapedAt: new Date().toISOString(),
      jsonLdData: jsonBlocks,
      hotelInfo,
      error: hotelInfo ? null : 'no-hotel-jsonld',
    });

    // jitter
    const delay = rand(delayMsMin, delayMsMax);
    await sleep(delay);
  },

  failedRequestHandler({ request, error, log }) {
    log.error(`Failed: ${request.url} :: ${error?.message ?? error}`);
    Dataset.pushData({
      url: request.userData?.origUrl ?? request.url,
      finalUrl: request.url,
      scrapedAt: new Date().toISOString(),
      jsonLdData: [],
      error: error?.message ?? 'failed-navigation',
    }).catch(() => {});
  },
});

// preserve orig short URL
const startRequests = startUrls.map((r) => ({
  url: r.url,
  userData: { origUrl: r.url },
}));

await crawler.run(startRequests);

// Stats
const { items } = await Dataset.getData();
const successes = items.filter((i) => i.hotelInfo).length;
const failures = items.filter((i) => !i.hotelInfo && !i.type).length;
const stats = {
  total_urls: startUrls.length,
  successes,
  failures,
};
log.info('Run stats:', stats);
await Actor.setValue('RUN-STATS', stats);
await Dataset.pushData({ type: 'run-stats', ...stats });

await Actor.exit();
