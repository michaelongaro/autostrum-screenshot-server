FROM node:20-bookworm

WORKDIR /app

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Install headless Chromium and an init that reaps orphaned browser processes.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npx playwright install --only-shell --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

COPY docker/trim-screenshot-file-cache.c /tmp/
RUN cc -O2 -Wall -Wextra -o /usr/local/bin/trim-screenshot-file-cache /tmp/trim-screenshot-file-cache.c \
    && rm /tmp/trim-screenshot-file-cache.c
ENV SCREENSHOT_CACHE_TRIMMER=/usr/local/bin/trim-screenshot-file-cache

# Copy the rest of your code
COPY . .

# Build your TypeScript
RUN npm run build

# Expose your server port
EXPOSE 8080

# Start the server
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
