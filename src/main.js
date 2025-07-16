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

// User agent, viewport, timezone, and language pools
const USER_AGENTS = [
  // Desktop Chrome
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  // Desktop Firefox
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  // Desktop Edge
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  // Mobile Chrome
  'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  // Mobile Safari
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];
const VIEWPORTS = [
  { width: 1920, height: 1080 }, // Desktop
  { width: 1366, height: 768 }, // Desktop
  { width: 390, height: 844 },  // iPhone 12/13/14
  { width: 412, height: 915 },  // Pixel 6
];
const TIMEZONES = [
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Australia/Sydney',
];
const LOCALES = [
  'en-US',
  'en-GB',
  'fr-FR',
  'de-DE',
  'es-ES',
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

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
    async ({ page, request }, gotoOptions) => {
      // Proxy rotation: get a new proxy URL for each request
      const newProxyUrl = await proxyConfiguration.newUrl();
      // (Camoufox handles proxy via launchOptions, so this is a placeholder for future per-request proxy logic if needed)
      // User agent rotation
      const userAgent = pickRandom(USER_AGENTS);
      await page.setUserAgent(userAgent);
      // Viewport randomization
      const viewport = pickRandom(VIEWPORTS);
      await page.setViewportSize(viewport);
      // Timezone randomization
      const timezone = pickRandom(TIMEZONES);
      await page.emulateTimezone(timezone);
      // Language/locale randomization
      const locale = pickRandom(LOCALES);
      await page.emulateLocale(locale);
      // Realistic headers
      await page.setExtraHTTPHeaders({
        'Accept-Language': locale + ',en;q=0.9',
        'Referer': 'https://www.google.com/',
        'DNT': '1',
      });
      // Mobile emulation: if mobile user agent, set touch support
      if (/Mobile|iPhone|Android/i.test(userAgent)) {
        await page.emulateMedia({ colorScheme: 'light' });
        // Optionally, set device scale factor for mobile
        await page.setViewportSize({ width: viewport.width, height: viewport.height, deviceScaleFactor: 2 });
      }
      // Block only heavy media, not styles/scripts
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

  failedRequestHandler: async ({ request, page, error, log }) => {
    log.error(`Failed: ${request.url} :: ${error?.message ?? error}`);

    // Only save screenshot and HTML if page is available (navigation may have failed before page was created)
    if (page) {
        const safeKey = request.url.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 60); // Key must be <= 63 chars
        const timestamp = Date.now();
        const storeId = Actor.getEnv().defaultKeyValueStoreId;

        try {
            const screenshotBuffer = await page.screenshot();
            const screenshotKey = `ERROR_SCREENSHOT_${safeKey}_${timestamp}`;
            await Actor.setValue(screenshotKey, screenshotBuffer, { contentType: 'image/png' });
            const screenshotUrl = `https://api.apify.com/v2/key-value-stores/${storeId}/records/${screenshotKey}`;
            log.info(`Saved screenshot to Key-Value Store: ${screenshotKey}`);
            log.info(`Screenshot URL: ${screenshotUrl}`);
        } catch (e) {
            log.warning(`Could not save screenshot: ${e.message}`);
        }

        try {
            const html = await page.content();
            const htmlKey = `ERROR_HTML_${safeKey}_${timestamp}`;
            await Actor.setValue(htmlKey, html, { contentType: 'text/html' });
            const htmlUrl = `https://api.apify.com/v2/key-value-stores/${storeId}/records/${htmlKey}`;
            log.info(`Saved HTML to Key-Value Store: ${htmlKey}`);
            log.info(`HTML URL: ${htmlUrl}`);
        } catch (e) {
            log.warning(`Could not save HTML: ${e.message}`);
        }
    }

    await Dataset.pushData({
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
