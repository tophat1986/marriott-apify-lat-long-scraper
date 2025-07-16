FROM apify/actor-node-playwright:22

# Inspect preinstalled libs (optional)
RUN npm ls --depth=0 apify crawlee playwright || true

# Copy manifests
COPY --chown=myuser package*.json ./

# Install prod deps
RUN npm --quiet set progress=false \
    && npm ci --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version \
    && rm -r ~/.npm

# Copy source
COPY --chown=myuser . ./

# Start actor
CMD npm start --silent
