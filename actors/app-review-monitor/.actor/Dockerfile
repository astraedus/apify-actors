# Node 24 base image: no browser, no Playwright — this Actor only makes plain
# HTTPS requests, so the slim image keeps builds fast and the attack surface small.
FROM apify/actor-node:24

# Dependencies first so a source-only change reuses the cached npm layer.
COPY --chown=myuser:myuser package*.json ./

RUN npm --quiet set progress=false \
    && npm ci --omit=dev --omit=optional \
    && echo "Installed npm packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "npm version:" \
    && npm --version

COPY --chown=myuser:myuser . ./

# Node 24 runs the TypeScript sources directly via native type stripping, so
# there is no build step and no dist/ to keep in sync with src/.
# Fail the BUILD rather than the first customer run if that ever stops working.
RUN node src/selftest.ts

CMD ["node", "src/main.ts"]
