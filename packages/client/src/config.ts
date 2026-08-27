import { configureIceServers, getIceServers, type IceServer } from './lib/iceServers.js';
import { configureTelemetry } from './lib/telemetry.js';

export const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'http://localhost:4000';

export const MAX_PARTICIPANTS = 6;

// Quem conhece a URL do servidor é este arquivo; quem sabe cachear e renovar é
// `lib/iceServers.js`, que fica puro (sem `import.meta.env`, sem DOM) para poder
// ser testado em `node --test` e para o mesh poder importá-lo sem arrastar a
// configuração da aplicação para dentro de `lib/`.
configureIceServers({ endpoint: `${SIGNALING_URL}/turn-credentials` });

/**
 * O beacon vai para o **próprio servidor de sinalização**, e nunca para a stack
 * de monitoramento: o navegador não conhece o endereço do collector, e é assim
 * de propósito (um `VITE_OTEL_ENDPOINT` seria legível no DevTools, e um
 * collector OTLP aberto na internet é vetor de flood contra o Prometheus).
 *
 * `VITE_TELEMETRY_ENABLED` é lido **aqui**, e não dentro de `lib/telemetry.ts`,
 * pelo mesmo motivo que `SIGNALING_URL`: `lib/` fica puro, sem
 * `import.meta.env`, e por isso roda em `node --test`.
 *
 * A comparação com a string `'false'` é literal e não é preciosismo:
 * `import.meta.env.VITE_TELEMETRY_ENABLED` é **string**, e `if (enabled)` com
 * `'false'` é `true` — a variável configurada corretamente não desligaria nada.
 * Falha silenciosa clássica, e a segunda mora no `Dockerfile`: `import.meta.env`
 * é substituído em **build time**, então a variável precisa ser build arg; no
 * runtime do nginx ela não tem efeito nenhum.
 */
configureTelemetry({
  endpoint: `${SIGNALING_URL}/telemetry`,
  enabled: import.meta.env.VITE_TELEMETRY_ENABLED !== 'false',
});

/**
 * Obtém ICE servers com credenciais efêmeras do servidor de sinalização, que por
 * sua vez as busca na Cloudflare TURN API. As credenciais nunca ficam baked no
 * bundle do client.
 *
 * O cache **não** dura mais a sessão da aba: ele vence junto com a credencial
 * (`lib/iceServers.js`), e o mesh renova antes de cada `RTCPeerConnection` nova.
 * Uma aba aberta desde ontem criava conexões com credencial morta — e sob
 * `iceTransportPolicy: 'relay'` isso significa zero candidatos e conexão que
 * nunca fecha, sem nenhum sinal.
 *
 * Duas propriedades desta função são contrato com `pages/Room.jsx` e não podem
 * mudar aqui:
 *
 * - **Devolve sempre um array** e **nunca rejeita.** O `Room.jsx` chama isto
 *   dentro de um `Promise.all` cujo `catch` leva a sala para a tela de acesso
 *   negado *sem motivo*; uma rejeição transformaria "o TURN está fora" em
 *   "acesso negado".
 * - O array pode vir **vazio**. Antes havia um fallback para o STUN público da
 *   Cloudflare, que foi removido: sob `relay`, STUN puro gera zero candidatos
 *   utilizáveis, então ele não era resiliência — era falha com aparência de
 *   sucesso, que ainda por cima falava com um terceiro. Quem torna a lista vazia
 *   visível é o mesh, via `onPeerStateChange(peerId, 'failed')`.
 */
export async function fetchIceServers(): Promise<IceServer[]> {
  return getIceServers();
}
