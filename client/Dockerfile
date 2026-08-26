# Contexto de build: a **raiz** do repositório (ver `docker-compose.yml`).
# `client/tsconfig.json` estende `../tsconfig.base.json`, e o esbuild que o Vite
# usa lê esse tsconfig para decidir alvo e transformação de JSX. Com o contexto
# em `./client` o arquivo base não existiria dentro da imagem, e o sintoma seria
# um `vite build` que **passa** com o alvo de transpilação errado.

# ── Stage 1: build ───────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /repo

# O tsconfig base e o manifesto primeiro: as camadas de dependência só
# invalidam quando o `package-lock.json` muda.
COPY tsconfig.base.json ./
COPY client/package.json client/package-lock.json ./client/
WORKDIR /repo/client
RUN npm ci

WORKDIR /repo
COPY client ./client
WORKDIR /repo/client

ARG VITE_SIGNALING_URL
ENV VITE_SIGNALING_URL=$VITE_SIGNALING_URL
RUN npm run build

# ── Stage 2: serve ───────────────────────────────────────────
FROM nginx:alpine
COPY --from=builder /repo/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
