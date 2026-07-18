# syntax=docker/dockerfile:1

# better-sqlite3 needs a C++ toolchain when no prebuilt binary matches the
# platform, so dependencies are installed in a throwaway stage.
FROM node:20-bookworm-slim AS deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# devDependencies stay: the backend runs TypeScript directly through tsx.
RUN npm ci

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# data/ (SQLite + WAL) and secrets/ (Enable Banking key) are volumes, never baked in.
RUN mkdir -p data secrets && chown -R node:node /app
USER node
EXPOSE 4000
CMD ["npm", "run", "start"]
