# Contributing to wtk-meet

> 🌐 [Versão em português](CONTRIBUTING.md)

## Prerequisites

- **Node.js >= 22.18** (uses native type stripping — no transpiler needed)
- **npm** (package manager bundled with Node)
- **Git**

## Local setup

```bash
# 1. Fork and clone
git clone https://github.com/<your-user>/wtk-meet.git
cd wtk-meet

# 2. Install dependencies (npm workspaces resolves everything)
npm install

# 3. Copy environment files
cp packages/server/.env.example packages/server/.env
cp packages/client/.env.example packages/client/.env

# 4. Run in development (two terminals)
npm run dev:server   # Express + Socket.IO on port 4000
npm run dev:client   # Vite on port 5173
```

## Running tests

```bash
npm test           # unit tests (client + server)
npm run test:e2e   # E2E tests with Playwright
npm run lint       # ESLint (flat config)
npm run typecheck  # type checking
```

## Commit convention (Conventional Commits)

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(client): add mute button
fix(server): fix signaling race condition
docs: update README with TURN instructions
refactor(e2e): migrate tests to TypeScript
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

## DCO (Developer Certificate of Origin)

The project requires sign-off on all commits for DCO compliance:

```bash
git commit -s -m "feat(client): add feature X"
```

The `-s` flag automatically appends a `Signed-off-by: Your Name <email>` line to the commit.

## Contribution workflow

1. **Fork** the repository on GitHub.
2. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
3. **Make your commits** following Conventional Commits with sign-off (`-s`).
4. **Make sure everything passes:**
   ```bash
   npm run lint && npm run typecheck && npm test
   ```
5. **Push** to your fork:
   ```bash
   git push origin feat/my-feature
   ```
6. **Open a Pull Request** against `main` on the original repository.

## Code style

- The project uses **ESLint 9** with flat config. Run `npm run lint` before opening a PR.
- Do not disable linter rules without justification in the PR.

## Language

Contributions in **Portuguese** or **English** are welcome — in code, issues, and PRs alike. English names for variables, functions, and commits are preferred but not required.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
