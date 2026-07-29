# syntax=docker/dockerfile:1

# better-sqlite3 (a devDependency now, used only by the SQLite import script) needs
# a C++ toolchain when no prebuilt binary matches - hence a throwaway stage.
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
# generated migrations: applied at startup, so the container will not boot without them
COPY drizzle ./drizzle
# secrets/ (Enable Banking key) is a mounted volume, never baked in; data/documents
# is the source document store (ROADMAP 4.5) and is a named volume in compose - a
# named volume takes its ownership from the directory present in the image, so it
# has to exist and belong to `node` here or the container writes as root into a tree
# it cannot read afterwards
RUN mkdir -p secrets data/documents && chown -R node:node /app
USER node
EXPOSE 4000
CMD ["npm", "run", "start"]
