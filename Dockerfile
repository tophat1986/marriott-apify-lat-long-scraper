# Playwright + Chrome base image (Node 22)
FROM apify/actor-node-playwright-chrome:22-24.11.1

# Show preinstalled core libs (optional diagnostic)
RUN npm ls --depth=0 apify crawlee playwright || true

# Workdir is /usr/src/app in Apify base images; user=myuser is set
# Copy package manifests early to leverage Docker layer cache
COPY --chown=myuser package*.json ./

# Install production deps
RUN npm --quiet set progress=false \
    && npm ci --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version \
    && rm -r ~/.npm

# Copy source after deps
COPY --chown=myuser . ./

# (Optional) ensure Playwright has needed browser deps; usually already present.
# Uncomment if you add additional Playwright browsers.
# RUN npx playwright install --with-deps chromium

# Start
CMD npm start --silent
