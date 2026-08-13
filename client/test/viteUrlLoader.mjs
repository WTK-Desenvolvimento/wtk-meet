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
 */
const SUFFIX = '?url';

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.endsWith(SUFFIX)) return nextResolve(specifier, context);
  const resolved = await nextResolve(specifier.slice(0, -SUFFIX.length), context);
  return { url: `${resolved.url}${SUFFIX}`, format: 'module', shortCircuit: true };
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
