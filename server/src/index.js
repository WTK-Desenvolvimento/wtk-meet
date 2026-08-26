/**
 * Shim **transitório**. Existe entre as fases 5 e 7 da migração para TypeScript
 * e some junto com a conversão dos testes.
 *
 * Três consumidores sobem o servidor fazendo `spawn(process.execPath, [este
 * caminho])`: `e2e/harness.mjs`, `client/test/joinRequestSignaling.test.mjs` e
 * `client/test/roomOccupancy.test.mjs`. Os dois últimos são arquivos de teste
 * que o item 6 do DoD congela — eles não podem ser editados agora.
 *
 * `spawn` cria um processo Node **novo**: um hook de módulo registrado no
 * processo pai não atravessa. Sem este arquivo, converter `index.js` para
 * TypeScript deixaria os dois testes vermelhos por duas fases, e uma suíte
 * vermelha no meio da migração destrói o valor da rede de segurança — que é
 * justamente saber que o vermelho de agora foi você quem causou.
 *
 * Não é o entry point de produção: o container e o E2E rodam `dist/index.js`,
 * compilado por `npm run build`.
 */
import { register } from 'node:module';

register('../../tools/tsLoader.mjs', import.meta.url);

await import('./index.ts');
