import { createPuppeteerRouter, Dataset, sleep } from 'crawlee';

export const router = createPuppeteerRouter();

router.addDefaultHandler(async ({ page, log }) => {
    log.info('Scraping Marriott hotel directory...');

    const hotels = [];

    // Set viewport for better rendering
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        // Wait for the main content to load
        await page.waitForSelector('#worldwide-locations', { timeout: 30000 });
        await sleep(2000); // Give time for initial JS to execute


        // Function to expand all collapsible sections
        async function expandAllSections() {
            let sectionsExpanded = 0;
            
            // Try multiple selectors for expandable elements
            const selectors = [
                'button[aria-expanded="false"]',
                '.accordion-button.collapsed',
                '[data-bs-toggle="collapse"]:not(.show)',
                '.expandable-header:not(.expanded)',
                'h2.clickable',
                'h3.clickable'
            ];

            for (const selector of selectors) {
                const buttons = await page.$$(selector);
                for (const button of buttons) {
                    try {
                        await button.click();
                        sectionsExpanded++;
                        await sleep(100); // Small delay between clicks
                    } catch (e) {
                        // Continue if element is not clickable
                    }
                }
            }
            
            log.info(`Expanded ${sectionsExpanded} sections`);
            return sectionsExpanded;
        }

        // Expand all sections multiple times to ensure everything is loaded
        let totalExpanded = 0;
        for (let i = 0; i < 3; i++) {
            const expanded = await expandAllSections();
            totalExpanded += expanded;
            if (expanded === 0) break; // No more sections to expand
            await sleep(1000);
        }

        log.info(`Total sections expanded: ${totalExpanded}`);

        // Extract all hotel data from the page
        const hotelData = await page.evaluate(() => {
            const results = [];

            // Official GDS Chain Codes mapping
            const gdsChainCodes = {
                'AR': 'AC Hotels by Marriott',
                'IM': 'All-Inclusive by Marriott',
                'AL': 'Aloft',
                'BA': 'Apartments by Marriott Bonvoy',
                'AK': 'Autograph Collection',
                'BG': 'Bvlgari Hotels & Resorts',
                'XE': 'City Express by Marriott',
                'CY': 'Courtyard by Marriott',
                'DE': 'Delta Hotels',
                'DP': 'Design Hotels',
                'EB': 'Edition',
                'EL': 'Element',
                'FN': 'Fairfield by Marriott',
                'FP': 'Four Points by Sheraton',
                'GE': 'Gaylord Hotels',
                'MC': 'Marriott Hotels', // Simplified from multiple brands
                'MD': 'Le Méridien',
                'LC': 'The Luxury Collection',
                'ET': 'Marriott Conference Centers',
                'VC': 'Marriott Vacation Club',
                'OX': 'Moxy Hotels',
                'PR': 'Protea Hotels',
                'BR': 'Renaissance Hotels',
                'RC': 'Residence Inn by Marriott',
                'RZ': 'The Ritz-Carlton',
                'US': 'Sonder by Marriott Bonvoy',
                'SI': 'Sheraton',
                'XV': 'SpringHill Suites',
                'XR': 'St Regis',
                'TO': 'TownePlace Suites',
                'TX': 'Tribute Portfolio',
                'WH': 'W Hotels',
                'WI': 'Westin'
            };

            // Helper function to extract brand from hotel name using GDS codes
            const getBrandInfo = (hotelName) => {
                // Try to match brand patterns and return GDS code
                const brandPatterns = [
                    { pattern: /JW Marriott/i, code: 'MC', name: 'JW Marriott' },
                    { pattern: /Marriott Executive Apartments/i, code: 'MC', name: 'Marriott Executive Apartments' },
                    { pattern: /The Ritz[- ]Carlton/i, code: 'RZ', name: 'The Ritz-Carlton' },
                    { pattern: /Ritz[- ]Carlton/i, code: 'RZ', name: 'The Ritz-Carlton' },
                    { pattern: /St\.? Regis/i, code: 'XR', name: 'St Regis' },
                    { pattern: /W Hotels?/i, code: 'WH', name: 'W Hotels' },
                    { pattern: /The Luxury Collection/i, code: 'LC', name: 'The Luxury Collection' },
                    { pattern: /EDITION/i, code: 'EB', name: 'Edition' },
                    { pattern: /Marriott Hotels?/i, code: 'MC', name: 'Marriott Hotels' },
                    { pattern: /Sheraton/i, code: 'SI', name: 'Sheraton' },
                    { pattern: /Marriott Vacation Club/i, code: 'VC', name: 'Marriott Vacation Club' },
                    { pattern: /Westin/i, code: 'WI', name: 'Westin' },
                    { pattern: /Le M[eé]ridien/i, code: 'MD', name: 'Le Méridien' },
                    { pattern: /Renaissance/i, code: 'BR', name: 'Renaissance Hotels' },
                    { pattern: /Gaylord Hotels?/i, code: 'GE', name: 'Gaylord Hotels' },
                    { pattern: /Courtyard/i, code: 'CY', name: 'Courtyard by Marriott' },
                    { pattern: /SpringHill Suites?/i, code: 'XV', name: 'SpringHill Suites' },
                    { pattern: /Fairfield/i, code: 'FN', name: 'Fairfield by Marriott' },
                    { pattern: /Residence Inn/i, code: 'RC', name: 'Residence Inn by Marriott' },
                    { pattern: /TownePlace Suites?/i, code: 'TO', name: 'TownePlace Suites' },
                    { pattern: /AC Hotels?/i, code: 'AR', name: 'AC Hotels by Marriott' },
                    { pattern: /Aloft/i, code: 'AL', name: 'Aloft' },
                    { pattern: /Moxy/i, code: 'OX', name: 'Moxy Hotels' },
                    { pattern: /Protea Hotels?/i, code: 'PR', name: 'Protea Hotels' },
                    { pattern: /City Express/i, code: 'XE', name: 'City Express by Marriott' },
                    { pattern: /Four Points/i, code: 'FP', name: 'Four Points by Sheraton' },
                    { pattern: /Element/i, code: 'EL', name: 'Element' },
                    { pattern: /Autograph Collection/i, code: 'AK', name: 'Autograph Collection' },
                    { pattern: /Tribute Portfolio/i, code: 'TX', name: 'Tribute Portfolio' },
                    { pattern: /Design Hotels?/i, code: 'DP', name: 'Design Hotels' },
                    { pattern: /Delta Hotels?/i, code: 'DE', name: 'Delta Hotels' },
                    { pattern: /B[vu]lgari/i, code: 'BG', name: 'Bvlgari Hotels & Resorts' },
                    { pattern: /Sonder/i, code: 'US', name: 'Sonder by Marriott Bonvoy' },
                    { pattern: /All[- ]Inclusive/i, code: 'IM', name: 'All-Inclusive by Marriott' },
                    { pattern: /Apartments by Marriott/i, code: 'BA', name: 'Apartments by Marriott Bonvoy' },
                    { pattern: /Conference Center/i, code: 'ET', name: 'Marriott Conference Centers' }
                ];

                // Check each pattern
                for (const { pattern, code, name } of brandPatterns) {
                    if (pattern.test(hotelName)) {
                        return { code, name };
                    }
                }

                // Default to Marriott Hotels
                return { code: 'MC', name: 'Marriott Hotels' };
            };

            // Helper function to extract Marsha code from URL
            const getMarshaCode = (url) => {
                if (!url) return '';
                
                // Multiple patterns to match Marsha codes
                const patterns = [
                    /marriott\.com\/([A-Z]{3,6})(?:$|\/|\?|#)/i,
                    /marriott\.com\/hotels\/travel\/([a-z]{3,6})-/i,
                    /marriott\.com\/[^\/]+\/([A-Z]{3,6})$/i,
                    /\/([A-Z]{3,6})$/i
                ];

                for (const pattern of patterns) {
                    const match = url.match(pattern);
                    if (match && match[1]) {
                        return match[1].toUpperCase();
                    }
                }
                return '';
            };

            // Find all hotel links on the page
            const hotelLinks = document.querySelectorAll('a[href*="marriott.com"]:not([href*="careers"]):not([href*="franchise"]):not([href*="meetings"])');
            
            hotelLinks.forEach(link => {
                const hotelName = link.textContent.trim();
                const url = link.href;
                
                // Skip if it doesn't look like a hotel link
                if (!hotelName || hotelName.length < 5 || !url.includes('marriott.com')) {
                    return;
                }
                
                // Skip navigation/footer links
                if (url.includes('/help/') || url.includes('/loyalty/') || url.includes('/default/')) {
                    return;
                }

                const marshaCode = getMarshaCode(url);
                
                // Only include if we have a valid Marsha code
                if (marshaCode && marshaCode.length >= 3) {
                    // Try to find the country and region by traversing up the DOM
                    let countryName = 'Unknown';
                    let regionName = 'Unknown';
                    
                    // Look for parent elements that might contain location info
                    let parent = link.parentElement;
                    let attempts = 0;
                    
                    while (parent && attempts < 10) {
                        // Look for country headers (usually h3)
                        const countryHeader = parent.querySelector('h3, .country-name, .location-name');
                        if (countryHeader && countryHeader.textContent.trim() !== hotelName) {
                            countryName = countryHeader.textContent.trim();
                        }
                        
                        // Look for region headers (usually h2)
                        const regionHeader = parent.querySelector('h2, .region-name, .region-title');
                        if (regionHeader) {
                            const regionText = regionHeader.textContent.trim();
                            // Remove count from region name (e.g., "AFRICA (15)" -> "AFRICA")
                            regionName = regionText.replace(/\s*\(\d+\)/, '');
                        }
                        
                        parent = parent.parentElement;
                        attempts++;
                    }
                    
                    // Alternative method: check for data attributes
                    const closestCountry = link.closest('[data-country]');
                    if (closestCountry) {
                        countryName = closestCountry.getAttribute('data-country') || countryName;
                    }
                    
                    const closestRegion = link.closest('[data-region]');
                    if (closestRegion) {
                        regionName = closestRegion.getAttribute('data-region') || regionName;
                    }

                    const brandInfo = getBrandInfo(hotelName);

                    results.push({
                        hotel_name: hotelName,
                        url: url,
                        country: countryName,
                        region: regionName,
                        brand_name: brandInfo.name,
                        brand_code: brandInfo.code,
                        marsha_code: marshaCode
                    });
                }
            });

            // Remove duplicates based on marsha_code
            const uniqueHotels = results.filter((hotel, index, self) =>
                index === self.findIndex(h => h.marsha_code === hotel.marsha_code)
            );

            return uniqueHotels;
        });

        hotels.push(...hotelData);

        // If we got very few results, try a more targeted approach
        if (hotels.length < 100) {
            log.info('Attempting alternative extraction method...');
            
            // Look specifically within the worldwide-locations section
            const alternativeData = await page.evaluate(() => {
                const results = [];
                const container = document.querySelector('#worldwide-locations, .locations-container, .hotel-directory');
                
                if (container) {
                    const links = container.querySelectorAll('a[href*="marriott.com"]');
                    links.forEach(link => {
                        const text = link.textContent.trim();
                        const url = link.href;
                        
                        // More lenient filtering
                        if (text && text.length > 3 && url && !url.includes('/help/')) {
                            results.push({
                                hotel_name: text,
                                url: url
                            });
                        }
                    });
                }
                
                return results;
            });

            // Process alternative data
            for (const item of alternativeData) {
                const marshaCode = item.url.match(/marriott\.com\/([A-Z]{3,6})(?:$|\/|\?)/i)?.[1]?.toUpperCase() || '';
                if (marshaCode && !hotels.find(h => h.marsha_code === marshaCode)) {
                    // Get brand info from hotel name
                    const brandInfo = await page.evaluate((hotelName) => {
                        // Recreate the getBrandInfo function within evaluate context
                        const brandPatterns = [
                            { pattern: /JW Marriott/i, code: 'MC', name: 'JW Marriott' },
                            { pattern: /The Ritz[- ]Carlton/i, code: 'RZ', name: 'The Ritz-Carlton' },
                            { pattern: /St\.? Regis/i, code: 'XR', name: 'St Regis' },
                            { pattern: /Sheraton/i, code: 'SI', name: 'Sheraton' },
                            { pattern: /Courtyard/i, code: 'CY', name: 'Courtyard by Marriott' },
                            { pattern: /Residence Inn/i, code: 'RC', name: 'Residence Inn by Marriott' },
                            // Add more patterns as needed
                        ];
                        
                        for (const { pattern, code, name } of brandPatterns) {
                            if (pattern.test(hotelName)) {
                                return { code, name };
                            }
                        }
                        return { code: 'MC', name: 'Marriott Hotels' };
                    }, item.hotel_name);

                    hotels.push({
                        hotel_name: item.hotel_name,
                        url: item.url,
                        country: 'Unknown',
                        region: 'Unknown',
                        brand_name: brandInfo.name,
                        brand_code: brandInfo.code,
                        marsha_code: marshaCode
                    });
                }
            }
        }

    } catch (error) {
        log.error('Error during scraping:', error);
        throw error;
    }

    log.info(`Total hotels found: ${hotels.length}`);

    // Save the results
    await Dataset.pushData({ hotels });
});