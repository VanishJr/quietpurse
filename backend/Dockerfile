# syntax=docker/dockerfile:1

# better-sqlite3 (a devDependency now, used only by the SQLite import script) needs
# a C++ toolchain when no prebuilt binary matches - hence a throwaway stage.
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# devDependencies stay: the backend runs TypeScript directly through tsx.
#
# @napi-rs/canvas is pdfjs's renderer, and this app reads a text layer and never
# draws. 61 MiB of it: no @napi-rs/canvas package declares `libc`, so npm installs
# the glibc and the musl binary both - a release that adds the field halves this.
# What makes the removal survivable is src/providers/pdfjsloader.ts: without the
# DOMMatrix and Path2D stubs it installs before loading pdfjs, pdf.mjs does not
# evaluate at all and no PDF can be read here (ROADMAP row 28).
#
# Not `npm ci --omit=optional`: that also drops @esbuild/linux-x64, whose postinstall
# re-fetches the binary from the registry three times a build - a lockfile-pinned
# artefact traded for a download nothing pins. `test -d` is what makes a removal that
# has stopped matching anything a failed build instead of an image quietly 61 MiB
# heavier; the scope directory is left behind, empty, so that a future @napi-rs/*
# something needs is not deleted by this line.
RUN npm ci \
    && test -d node_modules/@napi-rs/canvas \
    && rm -rf node_modules/@napi-rs/canvas*

FROM node:22-bookworm-slim
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
