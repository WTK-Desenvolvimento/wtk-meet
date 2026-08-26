/**
 * Hook de módulo que ensina o Node a importar `algo.js?url`, o sufixo do Vite
 * que devolve a URL final do asset em vez do módulo.
 *
 * `micPipeline.js` usa isso para passar o worklet ao `addModule`, e é a única
 * razão pela qual o Node não conseguiria importar aquele arquivo: sem o hook, o
 * erro é `does not provide an export named 'default'`, e o módulo inteiro fica
 * fora do alcance de `node --test`.
 *
 * Arquivo separado do `jsxLoader.mjs` de propósito. Os dois são registráveis em
 * conjunto (`register()` encadeia), e manter separado evita que um teste de
 * componente já verde passe a depender de um hook que não tem nada a ver com
 * ele.
 *
 * O valor devolvido é o caminho real do arquivo, não uma URL de produção: o que
 * o teste precisa afirmar é que **algo** identificável chega ao `addModule`, e
 * um caminho verdadeiro dá uma mensagem de erro legível quando não chega.
 *
 * O sufixo devolvido é sempre `.js`, mesmo depois de o worklet ter virado
 * TypeScript. Dois motivos, e o segundo é o que importa: (a) é o que o navegador
 * recebe de verdade — o plugin `ts-url-asset` do `vite.config.ts` transpila e
 * emite o asset como `.js`, porque um `.ts` cru no `AudioWorkletGlobalScope` é
 * `SyntaxError`; e (b) o hook de resolução de `tools/tsLoader.mjs` mapeia
 * `.js` → `.ts` no caminho, e sem desfazer isso aqui a URL entregue passaria a
 * terminar em `.ts`, quebrando um teste que esta migração não pode tocar.
 */
const SUFFIX = '?url';

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.endsWith(SUFFIX)) return nextResolve(specifier, context);
  const resolved = await nextResolve(specifier.slice(0, -SUFFIX.length), context);
  const comoAsset = resolved.url.replace(/\.tsx?$/, '.js');
  return { url: `${comoAsset}${SUFFIX}`, format: 'module', shortCircuit: true };
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(SUFFIX)) return nextLoad(url, context);
  const real = url.slice(0, -SUFFIX.length);
  return {
    format: 'module',
    source: `export default ${JSON.stringify(real)};`,
    shortCircuit: true,
  };
}
