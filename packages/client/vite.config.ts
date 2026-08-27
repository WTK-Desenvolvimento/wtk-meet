import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { transform } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';

/** Separa `./x.js?url` em caminho e query, que os dois plugins abaixo tratam. */
function partirQuery(source: string): [string, string] {
  const corte = source.indexOf('?');
  return corte < 0 ? [source, ''] : [source.slice(0, corte), source.slice(corte)];
}

/** `./x.js` → `./x.ts` ou `./x.tsx`, se o `.js` não existir e o TypeScript sim. */
function trocarSufixo(alvo: string): string | null {
  if (existsSync(alvo)) return null;
  const ext = path.extname(alvo);
  if (ext !== '.js' && ext !== '.jsx') return null;
  const base = alvo.slice(0, -ext.length);
  for (const candidato of ['.ts', '.tsx']) {
    if (existsSync(base + candidato)) return base + candidato;
  }
  return null;
}

/**
 * Resolução `.js` → `.ts`/`.tsx` para importadores que **ainda** são JavaScript.
 *
 * Transitório, e só existe por causa da ordem da migração. O Vite já faz este
 * mapeamento sozinho — mas apenas quando o importador é um arquivo TypeScript
 * (é o que `isTsRequest(importer)` decide dentro do plugin de resolução dele).
 * Durante a conversão a situação inversa acontece o tempo todo: as folhas viram
 * `.ts` primeiro, e quem as importa continua `.js` por mais alguns commits. Sem
 * isto, `npm run build` fica vermelho no meio de toda fase com
 * "Could not resolve ./gridLayout.js" — sintoma que se lê como erro de digitação
 * e não é.
 *
 * Mesmo contrato de `tools/tsLoader.mjs`, que faz exatamente isto para o
 * `node --test`: só age quando o `.js` pedido **não existe** em disco, e nunca
 * toca em bare specifier.
 *
 * **Some quando `client/src/` não tiver mais nenhum `.js`**: a partir daí o Vite
 * resolve tudo sozinho.
 */
function resolveJsToTs(): Plugin {
  return {
    name: 'wtk-meet:resolve-js-to-ts',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null;
      const [caminho, query] = partirQuery(source);
      const alvo = path.resolve(path.dirname(importer), caminho);
      const trocado = trocarSufixo(alvo);
      return trocado ? trocado + query : null;
    },
  };
}

/**
 * `?url` sobre um arquivo TypeScript: transpila antes de entregar.
 *
 * O sufixo `?url` do Vite entrega o arquivo **como asset**, verbatim, sem
 * transformação nenhuma — é exatamente para isso que ele existe, e é o que o
 * `noiseSuppressorWorklet` precisa, porque ele é carregado por
 * `audioWorklet.addModule(url)` num escopo global isolado. Só que um arquivo
 * `.ts` com anotações entregue a um `AudioWorkletGlobalScope` é `SyntaxError` no
 * `addModule`.
 *
 * E a falha seria **silenciosa**: `micPipeline` engole a rejeição do `addModule`
 * de propósito (`console.warn` + passthrough), porque uma promise rejeitada
 * solta num efeito reprova a checagem G do E2E. Ou seja, o produto continuaria
 * "funcionando" com a supressão de ruído desligada e ninguém veria. Quem prova
 * que este plugin funciona é a checagem **T8** do E2E (RMS ≥ 6 dB menor com
 * supressão ligada), a única que morre se o worklet não carregar.
 *
 * Ao contrário do plugin acima, este **não** é transitório: enquanto o worklet
 * for TypeScript e for carregado por URL, ele é necessário.
 */
function transpilarUrlTypeScript(): Plugin {
  let ehBuild = false;
  let raiz = process.cwd();

  return {
    name: 'wtk-meet:ts-url-asset',
    enforce: 'pre',
    configResolved(config) {
      ehBuild = config.command === 'build';
      raiz = config.root;
    },
    async load(id) {
      const [caminho, query] = partirQuery(id);
      if (query !== '?url' || !/\.tsx?$/.test(caminho)) return null;

      if (!ehBuild) {
        // Em desenvolvimento não há asset para emitir: o próprio servidor do
        // Vite transpila o `.ts` ao servi-lo, então a URL do módulo já entrega
        // JavaScript válido ao `addModule`.
        const relativo = `/${path.relative(raiz, caminho).split(path.sep).join('/')}`;
        return `export default ${JSON.stringify(relativo)};`;
      }

      const fonte = await readFile(caminho, 'utf8');
      const { code } = await transform(fonte, {
        loader: 'ts',
        format: 'esm',
        // O `AudioWorkletGlobalScope` do Chromium acompanha o motor da página;
        // não há transpilação para baixo a fazer além de apagar os tipos.
        target: 'es2022',
        sourcefile: caminho,
      });
      const referencia = this.emitFile({
        type: 'asset',
        name: path.basename(caminho).replace(/\.tsx?$/, '.js'),
        source: code,
      });
      return `export default import.meta.ROLLUP_FILE_URL_${referencia};`;
    },
  };
}

export default defineConfig({
  plugins: [resolveJsToTs(), transpilarUrlTypeScript(), react()],
  /**
   * Uma cópia de React, e só uma. Sem esta linha o app **não renderiza nada**.
   *
   * O bump da PR #26 (`6973768`, "React para 19, react-router-dom para 7",
   * mergeado em `b9fb31f`) deixou o lockfile com **duas** cópias de React:
   *
   *   node_modules/react                  18.3.1   ← içado para satisfazer o
   *   node_modules/react-router-dom        7.18.2     peer `react >=18` do router
   *   packages/client/node_modules/react  19.2.8   ← o que o app declara
   *
   * O bundle carrega React 19 (resolvido a partir de `packages/client`) e o
   * `react-router-dom` carrega o 18 do topo. Duas cópias, dois dispatchers, e o
   * primeiro hook que o router chama estoura com
   * `Cannot read properties of null (reading 'useRef')` — a árvore inteira
   * morre, `#root` fica vazio e a página fica branca, sem nada no servidor que
   * indique problema.
   *
   * `dedupe` faz o Vite resolver todo `react`/`react-dom` a partir da raiz do
   * projeto (`packages/client`), ou seja, sempre o 19.2.8. É a remediação
   * documentada do Vite para exatamente este caso em monorepo.
   *
   * **Conserto mais fundo, para quem cuidar das dependências:** um bloco
   * `overrides` no `package.json` da raiz fixando `react`/`react-dom` em
   * `^19.2.8` faria o npm parar de instalar a segunda cópia — resolve na origem,
   * e não só no build do client. Ficou de fora aqui de propósito: mexe na
   * resolução de dependências do repositório inteiro e pede um install limpo.
   */
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: 5173,
    // `'all'` não é um valor aceito. O Vite libera qualquer host só com `true`;
    // para qualquer outro valor ele **itera** o que recebeu — e iterar uma
    // string percorre 'a', 'l', 'l', que não casa com hostname nenhum. Ou
    // seja, isto não libera nada, e o servidor de desenvolvimento segue com a
    // proteção contra DNS rebinding de pé.
    //
    // Decidido na WTK-MEET-21 (que herdou o TODO por causa do identificador,
    // não do assunto): **mantido como está, de propósito**. A "correção" de uma
    // linha — `allowedHosts: true` — é um afrouxamento de proteção, não um
    // conserto, e ninguém pediu acesso remoto ao dev server. Quem precisar
    // disso deve listar os hosts explicitamente (`allowedHosts: ['meu.host']`),
    // em commit próprio, revertível sozinho. O registro está em
    // `docs/progress/WTK-MEET-21.md`.
    allowedHosts: 'all' as unknown as true,
  },
});
