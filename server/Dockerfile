# Contexto de build: a **raiz** do repositório (ver `docker-compose.yml`), pelo
# mesmo motivo do client — `server/tsconfig.json` estende `../tsconfig.base.json`
# e o `tsc` falharia com "File not found" dentro de um contexto em `./server`.
#
# Multi-stage porque o server passou a ter passo de compilação: o `builder`
# instala devDependencies e roda o `tsc`; a imagem final leva só `dist/` e as
# dependências de produção. Nada de TypeScript sobe para o runtime.

# ── Stage 1: build ───────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /repo

COPY tsconfig.base.json ./
COPY server/package.json server/package-lock.json ./server/
WORKDIR /repo/server
RUN npm ci

WORKDIR /repo
COPY server ./server
WORKDIR /repo/server
RUN npm run build

# ── Stage 2: runtime ─────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /repo/server/dist ./dist
EXPOSE 4000
# Sem `prestart` que reconstrua: a imagem já foi construída, e um rebuild no
# boot mascararia uma imagem mal montada.
CMD ["node", "dist/index.js"]
