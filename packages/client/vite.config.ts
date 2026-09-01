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
  // Duas cópias de React no grafo (o `react-router-dom` traz um `react@18`
  // para a raiz, o client declara `react@19`) dão dois dispatchers de hooks e
  // uma página em branco com `Cannot read properties of null (reading
  // 'useRef')`. O `dedupe` obriga o bundle a carregar uma cópia só.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: 5173,
    // TODO(WTK-MEET-21): `'all'` não é um valor aceito. O Vite libera qualquer
    // host só com `true`; para qualquer outro valor ele **itera** o que
    // recebeu — e iterar uma string percorre 'a', 'l', 'l', que não casa com
    // hostname nenhum. Ou seja, hoje isto não libera nada. Preservado
    // exatamente como estava: esta entrega migra tipos e não corrige
    // comportamento (a correção é uma linha: `allowedHosts: true`).
    allowedHosts: 'all' as unknown as true,
  },
});
