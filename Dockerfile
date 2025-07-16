# Known-good base you were using before
FROM apify/actor-node-puppeteer-chrome:22-24.11.1

# Show preinstalled libs (optional)
RUN npm ls --depth=0 apify crawlee puppeteer || true

# Copy package manifests first (for layer cache)
COPY --chown=myuser package*.json ./

# Install prod deps
RUN npm --quiet set progress=false \
    && npm ci --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version \
    && rm -r ~/.npm

# Install Playwright browser binaries + any missing OS deps
# (chromium only; reduces size vs full suite)
RUN npx playwright install --with-deps chromium

# Copy source
COPY --chown=myuser . ./

# Run
CMD npm start --silent
