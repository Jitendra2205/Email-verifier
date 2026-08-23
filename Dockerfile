FROM node:22-slim

WORKDIR /app

# Install dependencies first so the layer caches across source changes.
COPY package.json package-lock.json ./
# better-sqlite3 is a native module. On this Debian base its prebuilt glibc binary
# is downloaded; on an Alpine/musl base npm would fall back to compiling from
# source and need a full toolchain in the image.
RUN npm ci

COPY client ./client
COPY server ./server
COPY scripts ./scripts

RUN npm run build && npm prune --omit=dev

# Job data lives here; mount a volume to survive redeploys.
RUN mkdir -p server/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=4310
EXPOSE 4310

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4310)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
