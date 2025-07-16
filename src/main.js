/**
 * Marriott JSON-LD scraper (Camoufox stealth Firefox + PlaywrightCrawler + Apify Proxy).
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';
import fs from 'fs';

// ---- helpers ----
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

// ---- main ----
await Actor.init();
const input = await Actor.getInput();
log.info('input', input);

// Parse startUrls (string[] or [{url}])
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

// knobs
const concurrency = Number(input?.concurrency) || 3;
const navigationTimeoutSecs = Number(input?.navigationTimeoutSecs) || 45;
const requestHandlerTimeoutSecs = Number(input?.requestHandlerTimeoutSecs) || 10;
const delayMsMin = Number(input?.delayMsMin) || 300;
const delayMsMax = Number(input?.delayMsMax) || 1000;

// proxy (residential)
const proxyConfiguration = await Actor.createProxyConfiguration({
  groups: ['RESIDENTIAL'],
});

// Camoufox launch opts (points to cache populated at build)
const camoufoxVersionPath = `${process.env.HOME || process.env.USERPROFILE}/.cache/camoufox/version.json`;
if (!fs.existsSync(camoufoxVersionPath)) {
  log.error('Camoufox version info missing. Please run `npx camoufox fetch` before running this script.');
  await Actor.exit();
  process.exit(1);
}
const proxyUrl = await proxyConfiguration.newUrl();
let camouLaunch;
try {
  camouLaunch = await camoufoxLaunchOptions({
    headless: true,
    proxy: proxyUrl,
    geoip: true,
  });
} catch (e) {
  if (e.message && e.message.includes('Version information not found')) {
    log.error('Camoufox cache missing. Run `npx camoufox fetch`.');
    await Actor.exit();
    process.exit(1);
  }
  throw e;
}

// Build crawler
const crawler = new PlaywrightCrawler({
  proxyConfiguration,              // informs Crawlee, but Camoufox also handles proxy via launchOptions
  launchContext: {
    launcher: firefox,
    launchOptions: camouLaunch,    // includes stealth + proxy
  },
  maxConcurrency: concurrency,
  navigationTimeoutSecs,
  requestHandlerTimeoutSecs,
  maxRequestsPerCrawl: startUrls.length,

  // Let Marriott run its JS fully; we block only heavy media, not styles/scripts.
  preNavigationHooks: [
    async ({ page }, gotoOptions) => {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'font', 'media'].includes(type)) {
          return route.abort();
        }
        return route.continue();
      });
      gotoOptions.waitUntil = 'load'; // full load → give WAF JS max chance
    },
  ],

  async requestHandler({ request, page, log }) {
    const origUrl = request.userData?.origUrl ?? request.url;
    const finalUrl = page.url();

    // JSON-LD sometimes loads late; 15s budget
    await page.waitForSelector('script[type="application/ld+json"]', { timeout: 15000 }).catch(() => {});

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

    // throttle
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

// preserve orig marsha
const startRequests = startUrls.map((r) => ({
  url: r.url,
  userData: { origUrl: r.url },
}));

await crawler.run(startRequests);

// stats
const { items } = await Dataset.getData();
const successes = items.filter((i) => i.hotelInfo).length;
const failures = items.filter((i) => !i.hotelInfo && !i.type).length;
const stats = { total_urls: startUrls.length, successes, failures };
log.info('Run stats:', stats);
await Actor.setValue('RUN-STATS', stats);
await Dataset.pushData({ type: 'run-stats', ...stats });

await Actor.exit();
