FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY relay ./relay
ENV PORT=8787
ENV HOST=0.0.0.0
EXPOSE 8787
CMD ["npx", "tsx", "-e", "import('./relay/reference/server.ts').then(m => m.startReferenceRelay({ host: process.env.HOST || '0.0.0.0', port: Number(process.env.PORT || 8787) }).then(r => console.log('Toolroll reference relay listening on', r.url)))"]
