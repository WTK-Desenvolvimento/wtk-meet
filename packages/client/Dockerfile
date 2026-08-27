# Contexto de build: a **raiz** do repositório (ver `docker-compose.yml`).
# `client/tsconfig.json` estende `../../tsconfig.base.json`, e o esbuild que o Vite
# usa lê esse tsconfig para decidir alvo e transformação de JSX. Com o contexto
# isolado o arquivo base não existiria dentro da imagem.
#
# npm workspaces: o lockfile e o package.json raiz são copiados primeiro, e o
# `npm ci --workspace=packages/client` instala apenas as deps deste workspace.

# ── Stage 1: build ───────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /repo

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/client/package.json ./packages/client/

RUN npm ci --workspace=packages/client --include-workspace-root

COPY packages/client ./packages/client
WORKDIR /repo/packages/client

ARG VITE_SIGNALING_URL
ENV VITE_SIGNALING_URL=$VITE_SIGNALING_URL
RUN npm run build

# ── Stage 2: serve ───────────────────────────────────────────
FROM nginx:alpine
COPY --from=builder /repo/packages/client/dist /usr/share/nginx/html
COPY packages/client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
