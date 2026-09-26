/**
 * O build da extensão: três bundles independentes e a cópia dos estáticos.
 *
 * Roda no Node por type stripping nativo (como `packages/e2e/run.ts` já faz) e
 * chama o `esbuild` que **já é devDependency da raiz**. Nenhuma ferramenta nova
 * entra na árvore — a mesma troca que o §7 do `ARCHITECTURE.md` vem defendendo
 * desde a WTK-MEET-20.
 *
 * **`splitting: false` não é detalhe.** Um service worker de módulo com chunks
 * compartilhados é a forma mais fácil de descobrir, em produção, que um
 * `import()` dinâmico não resolve sob `chrome-extension://`. Três bundles
 * autocontidos custam alguns KB duplicados e nunca falham assim.
 *
 * O plugin `resolveJsToTs` existe pelo mesmo motivo do que está em
 * `packages/client/vite.config.ts` e em `tools/tsLoader.mjs`: os fontes importam
 * `'./x.js'` (a forma que o `tsc` exige e que o server precisa para emitir), e o
 * arquivo em disco é `.ts`.
 *
 * Saída: `dist/`, carregável em `chrome://extensions` → "Carregar sem
 * compactação".
 */
import { existsSync, cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import { gerarIcones } from './tools/makeIcons.ts';

const RAIZ = dirname(fileURLToPath(import.meta.url));
const SRC = join(RAIZ, 'src');
const DIST = join(RAIZ, 'dist');

/** `./x.js` → `./x.ts` quando o `.js` não existe em disco. */
const resolveJsToTs: esbuild.Plugin = {
  name: 'resolve-js-to-ts',
  setup(build) {
    build.onResolve({ filter: /\.jsx?$/ }, (args) => {
      if (args.kind === 'entry-point' || !args.path.startsWith('.')) return null;
      const base = join(args.resolveDir, args.path);
      if (existsSync(base)) return null;
      for (const candidato of ['.ts', '.tsx']) {
        const alvo = base.replace(/\.jsx?$/, candidato);
        if (existsSync(alvo)) return { path: alvo };
      }
      return null;
    });
  },
};

async function build(): Promise<void> {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const sharedOptions = {
    bundle: true,
    target: 'chrome116' as const,
    platform: 'browser' as const,
    sourcemap: 'linked' as const,
    plugins: [resolveJsToTs],
    define: {
      // O client lê `import.meta.env` em `config.ts` — que a extensão **não**
      // importa (ver `src/lib/signaling.ts`). O `define` existe como rede de
      // segurança: se um import futuro arrastar aquele arquivo, o build falha
      // com "import.meta.env is undefined" em vez de silenciosamente embutir a
      // telemetria do app.
      'import.meta.env': 'undefined',
    },
  };

  await esbuild.build({
    ...sharedOptions,
    entryPoints: [
      join(SRC, 'background.ts'),
      join(SRC, 'offscreen.ts'),
      join(SRC, 'popup.ts'),
      join(SRC, 'manager.ts'),
    ],
    outdir: DIST,
    format: 'esm',
    // Ver o cabeçalho: um `import()` que não resolve sob `chrome-extension://` é
    // um bug que só aparece na máquina de quem instalou.
    splitting: false,
    logLevel: 'info',
  });

  // Content script usa IIFE: roda como classic script (sem `type="module"`),
  // o que evita o overhead de negociação de módulo no contexto da página.
  await esbuild.build({
    ...sharedOptions,
    entryPoints: [join(SRC, 'content.ts')],
    outdir: DIST,
    format: 'iife',
    logLevel: 'silent',
  });

  // Ícones: gerados se ainda não existirem (nenhum binário versionado).
  if (!existsSync(join(RAIZ, 'icons', 'icon128.png'))) gerarIcones();

  cpSync(join(RAIZ, 'manifest.json'), join(DIST, 'manifest.json'));
  cpSync(join(RAIZ, 'icons'), join(DIST, 'icons'), { recursive: true });
  for (const arquivo of readdirSync(SRC)) {
    if (arquivo.endsWith('.html') || arquivo.endsWith('.css')) {
      cpSync(join(SRC, arquivo), join(DIST, arquivo));
    }
  }

  console.log(`[extension] dist/ pronto — ${readdirSync(DIST).length} arquivos`);
}

await build();
