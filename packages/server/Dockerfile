# Contexto de build: a **raiz** do repositório (ver `docker-compose.yml`), pelo
# mesmo motivo do client — `server/tsconfig.json` estende `../../tsconfig.base.json`
# e o `tsc` falharia com "File not found" dentro de um contexto isolado.
#
# Multi-stage porque o server passou a ter passo de compilação: o `builder`
# instala devDependencies e roda o `tsc`; a imagem final leva só `dist/` e as
# dependências de produção. Nada de TypeScript sobe para o runtime.
#
# npm workspaces: o lockfile e o package.json raiz são copiados primeiro, e o
# `npm ci --workspace=packages/server` instala apenas as deps deste workspace.

# ── Stage 1: build ───────────────────────────────────────────
FROM node:26-alpine AS builder
WORKDIR /repo

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/server/package.json ./packages/server/

RUN npm ci --workspace=packages/server --include-workspace-root

COPY packages/server ./packages/server
WORKDIR /repo/packages/server
RUN npm run build

# ── Stage 2: runtime ─────────────────────────────────────────
FROM node:26-alpine
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/

RUN npm ci --workspace=packages/server --include-workspace-root --omit=dev

COPY --from=builder /repo/packages/server/dist ./packages/server/dist

WORKDIR /repo/packages/server
EXPOSE 4000
CMD ["node", "dist/index.js"]
