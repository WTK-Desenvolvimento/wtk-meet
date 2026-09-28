/**
 * Empacota `dist/` num `.zip` pronto para download (release do GitHub) ou para
 * "Carregar sem compactação" depois de descompactado.
 *
 * O `manifest.json` precisa ficar na **raiz** do zip — por isso o `zip` roda de
 * dentro de `dist/`. Sourcemaps (`*.map`) ficam de fora: pesam e não servem a
 * quem só instala a extensão.
 *
 * O zip vai para `release/` (ignorado pelo git, como `dist/`).
 *
 * Usa o `zip` do sistema (presente nos runners `ubuntu-latest`) para não
 * adicionar dependência à árvore.
 *
 * Rodar: `node tools/pack.ts` depois de `npm run build`. Imprime o caminho do
 * zip gerado.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(RAIZ, 'dist');
const SAIDA = join(RAIZ, 'release');
const MANIFEST = join(DIST, 'manifest.json');

if (!existsSync(MANIFEST)) {
  console.error('dist/manifest.json não existe — rode `npm run build` antes do pack.');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { version?: string };
if (!version) {
  console.error('dist/manifest.json não tem "version".');
  process.exit(1);
}

mkdirSync(SAIDA, { recursive: true });
const destino = join(SAIDA, `wtk-meet-extension-v${version}.zip`);
rmSync(destino, { force: true });

execFileSync('zip', ['-r', '-q', destino, '.', '-x', '*.map'], { cwd: DIST, stdio: 'inherit' });

console.log(destino);
