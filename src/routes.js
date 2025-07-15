import { createPuppeteerRouter, Dataset, sleep } from 'crawlee';

export const router = createPuppeteerRouter();

router.addDefaultHandler(async ({ page, request, log }) => {
    log.info(`Navigating to hotel page: ${request.url}`);
    try {
        await page.goto(request.url, { waitUntil: 'networkidle0', timeout: 120000 });
    } catch (err) {
        log.error(`Failed to navigate: ${err.message}`);
        return;
    }
    let ldJson;
    try {
        ldJson = await page.$$eval('script[type="application/ld+json"]', scripts => {
            for (const el of scripts) {
                try {
                    const json = JSON.parse(el.textContent);
                    if (json['@type'] && (json['@type'] === 'Hotel' || json['@type'] === 'LodgingBusiness')) {
                        return json;
                    }
                } catch (e) {}
            }
            return null;
        });
    } catch (err) {
        log.error('Could not find or parse ld+json:', err);
        return;
    }
    if (!ldJson) {
        log.warning('No suitable ld+json block found.');
        return;
    }
    function safe(obj, path, fallback = null) {
        return path.reduce((o, k) => (o && o[k] !== undefined ? o[k] : fallback), obj);
    }
    const record = {
        url: request.url,
        id: ldJson['@id'] || null,
        description: ldJson.description || null,
        image: ldJson.image || null,
        hasMap: ldJson.hasMap || null,
        checkin_time: ldJson.checkinTime || null,
        checkout_time: ldJson.checkoutTime || null,
        pets_allowed: ldJson.petsAllowed || null,
        street_address: safe(ldJson, ['address', 'streetAddress']),
        address_locality: safe(ldJson, ['address', 'addressLocality']),
        address_region: safe(ldJson, ['address', 'addressRegion']),
        address_country: safe(ldJson, ['address', 'addressCountry']),
        postal_code: safe(ldJson, ['address', 'postalCode']),
        telephone: ldJson.telephone || null,
        latitude: safe(ldJson, ['geo', 'latitude']),
        longitude: safe(ldJson, ['geo', 'longitude'])
    };
    for (const [key, value] of Object.entries(record)) {
        if (value === null || value === undefined) {
            log.warning(`Missing field: ${key}`);
        }
    }
    await Dataset.pushData(record);
    log.info('Record pushed to dataset.');
});