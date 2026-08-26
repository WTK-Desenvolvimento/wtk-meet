/**
 * Hooks de módulo que ensinam o `node --test` a enxergar TypeScript.
 *
 * Duas responsabilidades, e só duas:
 *
 * 1. **`resolve`** — um especificador terminado em `.js`/`.jsx` que não existe
 *    em disco é reapontado para o `.ts`/`.tsx` de mesmo nome. É o que permite
 *    aos fontes continuarem escrevendo `'./rooms.js'` e `'../lib/webrtcMesh.js'`
 *    depois da conversão, que é exigência de três consumidores diferentes: o
 *    `tsc` do server (que **emite**, e por isso não pode importar `.ts`), o Vite
 *    (que resolve `.js` → `.ts` sozinho) e os testes das fases 2–6, que não
 *    podem ser tocados e importam pelo nome antigo.
 *
 * 2. **`load`** — só `.tsx`, transformado com esbuild. Arquivos `.ts` **não**
 *    são interceptados: o Node ≥ 22.18 faz type stripping nativo, e não
 *    interceptar é uma engrenagem a menos.
 *
 * O que este arquivo deliberadamente **não** faz: type-check. O portão de tipos
 * é `npm run typecheck`; misturar os dois deixaria o `npm test` lento e vermelho
 * pelo motivo errado.
 *
 * Substitui o antigo `client/test/jsxLoader.mjs`, que fazia só o item 2 e só
 * para `.jsx`. O mesmo espírito do `viteUrlLoader.mjs`, que já mora aqui ao
 * lado: um hook por problema.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Candidatos a substituir cada sufixo. `.ts` primeiro: é o caso comum. */
const SUBSTITUTOS = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx', '.ts'],
};

/**
 * O esbuild vive em `client/node_modules` — `tools/` fica na raiz, onde não há
 * `node_modules` nenhum. A resolução é **preguiçosa** (só na primeira vez que um
 * `.tsx` for carregado) e ancorada no client, para que `server` e `e2e`, que
 * nunca carregam `.tsx`, possam usar este mesmo arquivo sem ter esbuild
 * instalado.
 */
let transformar = null;

async function esbuildTransform() {
  if (transformar) return transformar;
  const ancora = new URL('../client/package.json', import.meta.url);
  const { transform } = await import(new URL('./node_modules/esbuild/lib/main.js', new URL('.', ancora)));
  transformar = transform;
  return transformar;
}

export async function resolve(specifier, context, nextResolve) {
  // A query é separada antes de olhar o sufixo, e recolocada depois. Dois
  // consumidores reais dependem disso: `algo.js?url` (o worklet, via Vite) e
  // `algo.js?n=3` (cache-busting de `await import()` em teste, que precisa de uma
  // instância nova do módulo a cada caso).
  const corte = specifier.indexOf('?');
  const caminho = corte < 0 ? specifier : specifier.slice(0, corte);
  const query = corte < 0 ? '' : specifier.slice(corte);
  const sufixo = Object.keys(SUBSTITUTOS).find((ext) => caminho.endsWith(ext));

  // Bare specifiers ficam de fora: este hook nunca resolve pacote.
  if (sufixo && (caminho.startsWith('.') || caminho.startsWith('/') || caminho.startsWith('file:'))) {
    let alvo;
    try {
      alvo = new URL(caminho, context.parentURL);
    } catch {
      alvo = null;
    }
    if (alvo && alvo.protocol === 'file:' && !existsSync(fileURLToPath(alvo))) {
      const base = alvo.href.slice(0, -sufixo.length);
      for (const candidato of SUBSTITUTOS[sufixo]) {
        if (existsSync(fileURLToPath(new URL(base + candidato)))) {
          return nextResolve(base + candidato + query, context);
        }
      }
    }
  }

  // Nada encontrado: delega sem engolir o erro original — um "não achei
  // ./foo.js" é mais útil do que um "não achei ./foo.ts" que nunca foi pedido.
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // `.ts` vai para o type stripping nativo do Node. A query é ignorada aqui
  // pelo mesmo motivo do `resolve`.
  const semQuery = url.split('?')[0];
  if (!semQuery.endsWith('.tsx')) return nextLoad(url, context);

  const { readFile } = await import('node:fs/promises');
  const transform = await esbuildTransform();
  const source = await readFile(fileURLToPath(semQuery), 'utf8');
  const { code } = await transform(source, {
    loader: 'tsx',
    jsx: 'automatic',
    format: 'esm',
    // Preservado para o stack trace apontar para o arquivo de verdade.
    sourcefile: fileURLToPath(semQuery),
  });

  return { format: 'module', source: code, shortCircuit: true };
}
