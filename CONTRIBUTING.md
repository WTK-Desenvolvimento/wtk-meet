# Contribuindo com o wtk-meet

> 🌐 [English version](CONTRIBUTING.en.md)

## Pre-requisitos

- **Node.js >= 22.18** (usa type stripping nativo — sem transpilador)
- **npm** (gerenciador de pacotes incluido no Node)
- **Git**

## Setup local

```bash
# 1. Fork e clone
git clone https://github.com/<seu-usuario>/wtk-meet.git
cd wtk-meet

# 2. Instale as dependencias (npm workspaces resolve tudo)
npm install

# 3. Copie os arquivos de ambiente
cp packages/server/.env.example packages/server/.env
cp packages/client/.env.example packages/client/.env

# 4. Rode em desenvolvimento (dois terminais)
npm run dev:server   # Express + Socket.IO na porta 4000
npm run dev:client   # Vite na porta 5173
```

## Rodando testes

```bash
npm test           # testes unitarios (client + server)
npm run test:e2e   # testes E2E com Playwright
npm run lint       # ESLint (flat config)
npm run typecheck  # checagem de tipos
```

## Padrao de commits (Conventional Commits)

Todos os commits devem seguir o [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(client): adiciona botao de mute
fix(server): corrige race condition no signaling
docs: atualiza README com instrucoes de TURN
refactor(e2e): migra testes para TypeScript
```

Tipos comuns: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

## DCO (Developer Certificate of Origin)

O projeto exige sign-off em todos os commits para conformidade com o DCO:

```bash
git commit -s -m "feat(client): adiciona recurso X"
```

O flag `-s` adiciona automaticamente a linha `Signed-off-by: Seu Nome <email>` ao commit.

## Fluxo de contribuicao

1. **Fork** o repositorio no GitHub.
2. **Crie uma branch** a partir de `main`:
   ```bash
   git checkout -b feat/minha-feature
   ```
3. **Faca seus commits** seguindo Conventional Commits e com sign-off (`-s`).
4. **Garanta que tudo passa:**
   ```bash
   npm run lint && npm run typecheck && npm test
   ```
5. **Push** para o seu fork:
   ```bash
   git push origin feat/minha-feature
   ```
6. **Abra um Pull Request** contra `main` no repositorio original.

## Estilo de codigo

- O projeto usa **ESLint 9** com flat config. Rode `npm run lint` antes de abrir PR.
- Nao desabilite regras do linter sem justificativa no PR.

## Idioma

Contribuicoes em **portugues** ou **ingles** sao bem-vindas — tanto no codigo quanto em issues e PRs. Nomes de variaveis, funcoes e commits em ingles sao preferidos, mas nao obrigatorios.

## Licenca

Ao contribuir, voce concorda que suas contribuicoes serao licenciadas sob a [Apache License 2.0](LICENSE).
