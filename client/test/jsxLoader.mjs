/**
 * Hook de módulo que ensina o Node a importar os componentes `.jsx` do client.
 *
 * O projeto testa com `node --test` puro, sem runner de navegador — o E2E é
 * quem exercita o DOM, e ele não sobe neste ambiente (Chromium não inicia; ver
 * o §7 do documento de arquitetura do destaque). Para que os testes de QA
 * consigam ao menos **renderizar** um componente e olhar o HTML resultante,
 * falta só o transform de JSX: o esbuild que já vem com o Vite faz isso, e o
 * `register()` do Node liga os dois sem nenhuma dependência nova.
 *
 * Só transforma; não resolve nada. Os imports dentro dos componentes continuam
 * sendo resolvidos pelo Node normalmente (por isso os `./Arquivo.jsx` com
 * extensão explícita do projeto funcionam sem ajuda).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { transform } from 'esbuild';

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.jsx')) return nextLoad(url, context);

  const source = await readFile(fileURLToPath(url), 'utf8');
  const { code } = await transform(source, {
    loader: 'jsx',
    jsx: 'automatic',
    format: 'esm',
    sourcefile: url,
  });

  return { format: 'module', source: code, shortCircuit: true };
}
