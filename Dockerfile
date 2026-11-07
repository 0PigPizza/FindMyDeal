FROM node:22-bookworm-slim
ARG FMD_RELEASE=development
ENV NODE_ENV=production HOST=0.0.0.0 FMD_CONTAINER=1 FMD_RELEASE=${FMD_RELEASE} FMD_BROWSER_RUNTIME=/usr FMD_FIREFOX_PATH=/opt/firefox/firefox
RUN apt-get update && apt-get install -y --no-install-recommends firefox-esr xvfb x11vnc xdotool xauth python3 ca-certificates curl xz-utils tini \
    && curl -fsSL https://archive.mozilla.org/pub/firefox/releases/158.0.1/linux-x86_64/en-US/firefox-158.0.1.tar.xz -o /tmp/firefox.tar.xz \
    && echo "dce45470139242cf294eb6ada3d192a9bb334696842b02b71ade448a139eb41a  /tmp/firefox.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/firefox.tar.xz -C /opt \
    && rm /tmp/firefox.tar.xz \
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
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "server.js"]
