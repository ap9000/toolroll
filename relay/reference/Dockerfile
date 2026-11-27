# The self-hosted reference relay (relay/PROTOCOL.md). Build from the repository root:
#   docker build -f relay/reference/Dockerfile -t toolroll-relay .
#   docker run -p 8787:8787 -e RELAY_PUBLIC_HOST=relay.example.com toolroll-relay
# The Mac only talks to a non-loopback relay over wss://, so put a TLS proxy in front and set RELAY_PUBLIC_HOST to the
# proxy's public host (and TRUST_PROXY=1 so rate limits see real client addresses).

FROM node:22-slim AS build
WORKDIR /build
# Just the bundler and the relay's one dependency, pinned (the same versions as the repository's lockfile).
RUN npm install --no-audit --no-fund --no-save esbuild@0.28.2 ws@8.22.1
COPY src/companion/relay-server.ts src/companion/relay-auth.ts src/companion/noise.ts ./src/companion/
COPY relay/reference/server.ts ./relay/reference/
RUN npx esbuild relay/reference/server.ts --bundle --platform=node --target=node22 --format=esm \
      --external:bufferutil --external:utf-8-validate \
      --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --outfile=dist/relay.mjs

FROM node:22-slim
WORKDIR /app
COPY --from=build /build/dist/relay.mjs ./relay.mjs
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/v1/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "relay.mjs"]
