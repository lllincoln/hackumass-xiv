# Build context is the repo root (see docker-compose.yml) so shared/ is available.
FROM node:24-slim
WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server/ ./
COPY shared/ /app/shared/
ENV NODE_ENV=production
EXPOSE 8787
USER node
CMD ["npx", "tsx", "index.ts"]
