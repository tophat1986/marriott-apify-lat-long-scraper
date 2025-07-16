FROM apify/actor-node-playwright:22

RUN npm ls --depth=0 apify crawlee playwright || true

COPY --chown=myuser package*.json ./

# install prod deps (keep optionals so impit builds)
RUN npm --quiet set progress=false \
    && npm ci --omit=dev \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version \
    && rm -r ~/.npm

# ensure a writable cache directory for Camoufox downloads
ENV CAMOUFOX_CACHE_DIR=/home/myuser/.camoufox
RUN mkdir -p $CAMOUFOX_CACHE_DIR && chown myuser:myuser $CAMOUFOX_CACHE_DIR

COPY --chown=myuser . ./

CMD npm start --silent
