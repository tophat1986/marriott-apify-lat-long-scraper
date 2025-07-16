FROM apify/actor-node-playwright:22

RUN npm ls --depth=0 apify crawlee playwright || true

COPY --chown=myuser package*.json ./

# Install prod deps (keep optional!)
RUN npm --quiet set progress=false \
    && npm ci --omit=dev \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version \
    && rm -r ~/.npm

# Pre-create writable Camoufox cache dir
ENV CAMOUFOX_CACHE_DIR=/home/myuser/.cache/camoufox
RUN mkdir -p $CAMOUFOX_CACHE_DIR && chown myuser:myuser $CAMOUFOX_CACHE_DIR

# Fetch Camoufox browser bundle non-interactively.
# The CLI prompts; piping "y" accepts defaults. The fetch may download ~hundreds MB on first build.
# Remove `--firefox` because not supported in your CLI; default fetch includes core stealth build.
RUN yes | npx camoufox fetch

COPY --chown=myuser . ./

CMD npm start --silent
