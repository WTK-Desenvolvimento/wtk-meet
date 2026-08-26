/// <reference types="vite/client" />

/**
 * As variáveis de ambiente que este client lê. O `vite/client` já declara
 * `import.meta.env` com as chaves nativas (`MODE`, `DEV`, `PROD`); esta
 * declaração acrescenta as duas do produto, para que um erro de digitação em
 * `VITE_SIGNALING_URL` vire erro de compilação em vez de `undefined` em runtime.
 */
interface ImportMetaEnv {
  readonly VITE_SIGNALING_URL?: string;
  /**
   * `string | boolean` porque o código a compara com os dois: o Vite injeta
   * string, mas um `define` de build pode substituir a expressão por um
   * booleano literal, e a checagem defensiva de `isYouTubeEnabled` cobre os
   * dois casos desde antes desta migração.
   */
  readonly VITE_ENABLE_YOUTUBE?: string | boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * O sufixo `?url` do Vite: entrega a URL final do asset em vez do módulo. O
 * `vite/client` já declara isto; a redeclaração existe porque `types` do
 * tsconfig lista só `node`, e sem ela `micPipeline.ts` não compila.
 */
declare module '*?url' {
  const url: string;
  export default url;
}
