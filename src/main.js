import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

// ---------- defaults ----------
const DEF_CONCURRENCY = 3;
const DEF_SESSION_PAGES = 10;
const DEF_NAV_TIMEOUT_SECS = 35;
const DEF_HANDLER_TIMEOUT_SECS = 10;
const DEF_DELAY_MIN = 250;
const DEF_DELAY_MAX = 900;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

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
const sessionPages = Number(input?.sessionPages) || DEF_SESSION_PAGES;
const navigationTimeoutSecs = Number(input?.navigationTimeoutSecs) || DEF_NAV_TIMEOUT_SECS;
const requestHandlerTimeoutSecs = Number(input?.requestHandlerTimeoutSecs) || DEF_HANDLER_TIMEOUT_SECS;
const delayMsMin = Number(input?.delayMsMin) || DEF_DELAY_MIN;
const delayMsMax = Number(input?.delayMsMax) || DEF_DELAY_MAX;

// proxy
const proxyConfiguration = await Actor.createProxyConfiguration({
  groups: ['RESIDENTIAL'],
});

// session mgmt (rotate sticky proxy + UA)
const sessionState = new Map();
function newSessionId() {
  return `sess_${Math.random().toString(36).slice(2, 10)}`;
}
let currentSessionId = newSessionId();
sessionState.set(currentSessionId, { ua: USER_AGENTS[rand(0, USER_AGENTS.length - 1)], pagesUsed: 0 });

async function rotateSession() {
  currentSessionId = newSessionId();
  sessionState.set(currentSessionId, { ua: USER_AGENTS[rand(0, USER_AGENTS.length - 1)], pagesUsed: 0 });
  log.info(`Rotated session -> ${currentSessionId}`);
}

// Build crawler
const crawler = new PlaywrightCrawler({
  proxyConfiguration,

  // Launch options – default Chromium from image is fine
  // Uncomment the channel line if you want Chrome channel:
  // launchContext: { launchOptions: { channel: 'chrome', headless: true } },
  launchContext: { launchOptions: { headless: true } },

  maxConcurrency: concurrency,
  requestHandlerTimeoutSecs,
  navigationTimeoutSecs,
  maxRequestsPerCrawl: startUrls.length,

  preNavigationHooks: [
    async ({ request, page }, gotoOptions) => {
      // rotate if sessionPages exceeded
      const state = sessionState.get(currentSessionId) ?? { ua: USER_AGENTS[0], pagesUsed: 0 };
      if (state.pagesUsed >= sessionPages) {
        await rotateSession();
      }
      const s = sessionState.get(currentSessionId);
      s.pagesUsed += 1;

      // sticky proxy session
      // (Apify Proxy uses ?session= under the hood; newUrl builds URL)
      const proxyUrl = await proxyConfiguration.newUrl(currentSessionId);
      // Apify automatically routes the traffic through the actor container's env proxy,
      // but we still call newUrl to register the session and rotate IP. Setting it here
      // ensures session tracking works server-side even though page.goto won't use the URL directly.

      // user-agent
      await page.setUserAgent(s.ua);

      // block heavy assets
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
          return route.abort();
        }
        return route.continue();
      });

      // minimal wait
      gotoOptions.waitUntil = 'domcontentloaded';
    },
  ],

  async requestHandler({ request, page, log }) {
    const origUrl = request.userData?.origUrl ?? request.url;
    const finalUrl = page.url();

    // wait if JSON-LD loads slightly late
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

// preserve orig short URL for marsha parsing later
const startRequests = startUrls.map((r) => ({
  url: r.url,
  userData: { origUrl: r.url },
}));

await crawler.run(startRequests);

// Stats (lightweight; read dataset once)
const { items } = await Dataset.getData();
const successes = items.filter((i) => i.hotelInfo).length;
const failures = items.filter((i) => !i.hotelInfo && !i.type).length;
const stats = {
  total_urls: startUrls.length,
  successes,
  failures,
  run_duration_seconds: null, // Apify log shows runtime; omit if not measured
};
log.info('Run stats:', stats);
await Actor.setValue('RUN-STATS', stats);
await Dataset.pushData({ type: 'run-stats', ...stats });

await Actor.exit();
