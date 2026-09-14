# Two-stage build: compile TypeScript with dev dependencies, then ship a
# production image carrying only the compiled output and runtime dependencies.
FROM apify/actor-node:24 AS builder

COPY --chown=myuser package*.json ./

# Dev dependencies are needed here (and only here) for `tsc`.
RUN npm install --include=dev --audit=false --fund=false

COPY --chown=myuser . ./

RUN npm run build

# ---

FROM apify/actor-node:24

COPY --chown=myuser package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --audit=false --fund=false \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version

COPY --from=builder --chown=myuser /usr/src/app/dist ./dist

COPY --chown=myuser . ./

CMD ["npm", "run", "start:prod", "--silent"]
