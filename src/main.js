import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

// ---------- defaults ----------
const DEF_CONCURRENCY = 3;         // start low; scale later
const DEF_SESSION_PAGES = 10;      // pages to reuse before rotating proxy/session
const DEF_NAV_TIMEOUT_SECS = 35;   // network budget; Marriott heavy
const DEF_HANDLER_TIMEOUT_SECS = 10;  // parsing budget
const DEF_DELAY_MIN = 250;
const DEF_DELAY_MAX = 900;

// Basic UA pool (rotate per session). Expand if needed.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
];

// ---------- helper ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// Pick hotel JSON‑LD node client‑side (stringified arr in page)
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
const sessionPages = Number(input?.sessionPages) || DEF_SESSION_PAGES;
const navigationTimeoutSecs = Number(input?.navigationTimeoutSecs) || DEF_NAV_TIMEOUT_SECS;
const requestHandlerTimeoutSecs = Number(input?.requestHandlerTimeoutSecs) || DEF_HANDLER_TIMEOUT_SECS;
const delayMsMin = Number(input?.delayMsMin) || DEF_DELAY_MIN;
const delayMsMax = Number(input?.delayMsMax) || DEF_DELAY_MAX;

// proxy config
const proxyConfiguration = await Actor.createProxyConfiguration({
  groups: ['RESIDENTIAL'],
});

// session mgmt: rotate Apify proxy session + UA after N pages
const sessionState = new Map(); // sessionId -> { ua, pagesUsed }
function newSessionId() {
  return `sess_${Math.random().toString(36).slice(2, 10)}`;
}

// We'll flip sessions by reassigning new proxy URLs in preNav hook when needed.
let currentSessionId = newSessionId();
sessionState.set(currentSessionId, { ua: USER_AGENTS[rand(0, USER_AGENTS.length - 1)], pagesUsed: 0 });

async function rotateSession() {
  currentSessionId = newSessionId();
  sessionState.set(currentSessionId, { ua: USER_AGENTS[rand(0, USER_AGENTS.length - 1)], pagesUsed: 0 });
  log.info(`Rotated session -> ${currentSessionId}`);
}

// Build PlaywrightCrawler
const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  useChrome: true,                  // real Chrome build (stronger fingerprint)
  headless: true,
  maxConcurrency: concurrency,
  requestHandlerTimeoutSecs,
  navigationTimeoutSecs,
  maxRequestsPerCrawl: startUrls.length,

  // Use built-in SessionPool for retries & blocked detection?
  // We'll rely on our manual session rotation; keep SessionPool default.

  preNavigationHooks: [
    async ({ request, page, session }, gotoOptions) => {
      // rotate if sessionPages exceeded
      const state = sessionState.get(currentSessionId) ?? { ua: USER_AGENTS[0], pagesUsed: 0 };
      if (state.pagesUsed >= sessionPages) {
        await rotateSession();
      }
      const s = sessionState.get(currentSessionId);
      s.pagesUsed += 1;

      // assign proxy URL with sticky session param
      // NOTE: newUrl is async
      const proxyUrl = await proxyConfiguration.newUrl(currentSessionId);
      // Playwright proxy credentials configured globally at launch by Apify infra;
      // adding query param session is enough to stick.

      // Set UA header
      await page.setUserAgent(s.ua);

      // Block heavy resources
      await page.route('**/*', (route) => {
        const r = route.request();
        const type = r.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
          return route.abort();
        }
        return route.continue();
      });

      // We expect heavy JS; wait only for DOM
      gotoOptions.waitUntil = 'domcontentloaded';
      // If you want to override default Apify goto (it uses request.url), just leave as is.
    },
  ],

  async requestHandler({ request, page, log }) {
    // We need both original (short marsha) and final (page.url())
    const origUrl = request.userData?.origUrl ?? request.url;
    const finalUrl = page.url();

    // Grab all ld+json in page context
    const jsonBlocks = await page.$$eval('script[type="application/ld+json"]', (nodes) => {
      const out = [];
      for (const n of nodes) {
        const txt = n?.textContent?.trim();
        if (!txt) continue;
        try {
          out.push(JSON.parse(txt));
        } catch {
          /* ignore */
        }
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
      url: origUrl,          // short
      finalUrl,              // resolved
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

// Start URLs: we want to preserve orig short URL to parse marsha later
const startRequests = startUrls.map((r) => ({
  url: r.url,
  userData: { origUrl: r.url },
}));

await crawler.run(startRequests);

// Stats
const stats = {
  total_urls: startUrls.length,
  successes: (await Dataset.getData()).items.filter((i) => i.hotelInfo).length,
  failures: (await Dataset.getData()).items.filter((i) => !i.hotelInfo && !i.type).length,
  // rough; not perfect because we re-read dataset
};
log.info('Run stats:', stats);
await Actor.setValue('RUN-STATS', stats);
await Dataset.pushData({ type: 'run-stats', ...stats });

await Actor.exit();
