/**
 * Marriott JSON-LD scraper (Camoufox + PlaywrightCrawler + Apify Proxy RESIDENTIAL).
 * - Input: { startUrls: [{url: ...}, ...] }
 * - Output rows: { url, finalUrl, scrapedAt, jsonLdData, hotelInfo, error }
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
await Actor.init();

const input = await Actor.getInput();
log.info('input', input);

// Extract start URLs (support simple string array or array of {url})
let startUrls = [];
if (Array.isArray(input?.startUrls) && input.startUrls.length) {
  startUrls = input.startUrls.map((r) => (typeof r === 'string' ? { url: r } : { url: r.url }));
} else if (input?.url) {
  startUrls = [{ url: input.url }];
}
if (!startUrls.length) {
  log.warning('No startUrls; exiting.');
  await Actor.exit();
  process.exit(0);
}

// Scrape knobs (all optional)
const concurrency = Number(input?.concurrency) || 3;
const navigationTimeoutSecs = Number(input?.navigationTimeoutSecs) || 35;
const requestHandlerTimeoutSecs = Number(input?.requestHandlerTimeoutSecs) || 10;
const delayMsMin = Number(input?.delayMsMin) || 250;
const delayMsMax = Number(input?.delayMsMax) || 900;

// Proxy (RESIDENTIAL group recommended)
const proxyConfiguration = await Actor.createProxyConfiguration({
  groups: ['RESIDENTIAL'],
});

// Camoufox launch options
// Each crawler browser launch gets a fresh proxy session (newUrl()).
// If you want sticky session across all requests, call newUrl() once and reuse (see comment below).
const camouLaunch = await camoufoxLaunchOptions({
  headless: true,
  proxy: await proxyConfiguration.newUrl(), // sticky for whole run; change to newUrl() in preNav to rotate
  geoip: true,
  // fonts: ['Times New Roman'], // example custom Camoufox option
});

// Build crawler
const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  // Camoufox runs via Playwright's firefox launcher
  launchContext: {
    launcher: firefox,
    launchOptions: camouLaunch, // stealth + proxy baked in
  },

  maxConcurrency: concurrency,
  navigationTimeoutSecs,
  requestHandlerTimeoutSecs,
  maxRequestsPerCrawl: startUrls.length,

  preNavigationHooks: [
    async ({ page }, gotoOptions) => {
      // Block heavy assets (keep scripts so JSON-LD loads)
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'font', 'media'].includes(type)) {
          return route.abort();
        }
        // keep stylesheets; Marriott sometimes gates JS behind CSS loads
        return route.continue();
      });
      gotoOptions.waitUntil = 'domcontentloaded';
    },
  ],

  async requestHandler({ request, page, log }) {
    const origUrl = request.userData?.origUrl ?? request.url;
    const finalUrl = page.url();

    // Wait flexibly in case JSON-LD injected late
    await page.waitForSelector('script[type="application/ld+json"]', { timeout: 8000 }).catch(() => {});

    const jsonBlocks = await page.$$eval('script[type="application/ld+json"]', (nodes) => {
      const out = [];
      for (const n of nodes) {
        const txt = n?.textContent?.trim();
        if (!txt) continue;
        try { out.push(JSON.parse(txt)); } catch { /* ignore parse */ }
      }
      return out;
    });

    const hotelInfo = pickHotelNode(jsonBlocks);
    if (hotelInfo) {
      log.info(`Hotel JSON-LD: ${hotelInfo.name ?? '(no name)'}`);
    } else {
      log.warning(`No hotel JSON-LD @ ${finalUrl}`);
    }

    await Dataset.pushData({
      url: origUrl,
      finalUrl,
      scrapedAt: new Date().toISOString(),
      jsonLdData: jsonBlocks,
      hotelInfo,
      error: hotelInfo ? null : 'no-hotel-jsonld',
    });

    // polite jitter
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

// Preserve original short URL (so Supabase ingest can parse marsha_code)
const startRequests = startUrls.map((r) => ({
  url: r.url,
  userData: { origUrl: r.url },
}));

await crawler.run(startRequests);

// Summarise
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
