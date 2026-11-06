FROM node:22-bookworm-slim
ARG FMD_RELEASE=development
ENV NODE_ENV=production HOST=0.0.0.0 FMD_CONTAINER=1 FMD_RELEASE=${FMD_RELEASE} FMD_BROWSER_RUNTIME=/usr FMD_FIREFOX_PATH=/usr/bin/firefox-esr
RUN apt-get update && apt-get install -y --no-install-recommends firefox-esr xvfb x11vnc xdotool xauth python3 ca-certificates curl \
    && curl -fsSL https://github.com/mozilla/geckodriver/releases/download/v0.36.0/geckodriver-v0.36.0-linux64.tar.gz | tar -xz -C /usr/local/bin \
    && ln -s /usr/local/bin/geckodriver /usr/bin/geckodriver \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node . .
RUN mkdir -p .data && chown node:node .data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
