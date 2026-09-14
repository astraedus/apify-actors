FROM apify/actor-node:24

# Install dependencies first so the layer is cached across source-only changes.
COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed npm packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "npm version:" \
    && npm --version

COPY . ./

CMD ["npm", "start", "--silent"]
