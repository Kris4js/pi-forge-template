# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com && npm ci

FROM node:22-alpine AS runtime
WORKDIR /app
RUN sed -i 's#https://dl-cdn.alpinelinux.org/alpine#https://mirrors.aliyun.com/alpine#g' /etc/apk/repositories \
    && apk add --no-cache python3
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8090
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 8090
CMD ["npm", "run", "server"]
