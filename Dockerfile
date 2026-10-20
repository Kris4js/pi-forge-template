# syntax=docker/dockerfile:1

FROM golang:1.23-alpine AS gateway
WORKDIR /src
COPY gateway/ ./
RUN CGO_ENABLED=0 go build -o /out/gateway ./cmd/gateway

FROM node:22-alpine AS node
WORKDIR /app
COPY package.json package-lock.json ./
COPY runtime/package.json runtime/
COPY web/package.json web/
RUN npm config set registry https://registry.npmmirror.com && npm ci
COPY runtime/ runtime/
COPY web/ web/
RUN npm run build -w web && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV FORGE_ADDR=:8090 \
    FORGE_WEB_DIR=web/dist \
    FORGE_DATA_DIR=/data
COPY --from=node /app/node_modules ./node_modules
COPY --from=node /app/runtime ./runtime
COPY --from=node /app/web/dist ./web/dist
COPY --from=gateway /out/gateway ./bin/gateway
COPY package.json ./
COPY agents/ ./agents/
VOLUME /data
EXPOSE 8090
CMD ["./bin/gateway"]
