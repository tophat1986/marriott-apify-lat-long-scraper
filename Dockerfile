FROM apify/actor-node-playwright:22

RUN npm ls --depth=0 apify crawlee playwright || true

COPY --chown=myuser package*.json ./

# IMPORTANT: don't omit optional (impit native)
RUN npm --quiet set progress=false \
    && npm ci --omit=dev \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version \
    && rm -r ~/.npm

# Fetch Camoufox stealth browser assets (non-interactive)
# Use --yes to auto-accept; --all to fetch all browsers, or --firefox only.
RUN npx camoufox fetch --yes --firefox

# Copy source
COPY --chown=myuser . ./

CMD npm start --silent
