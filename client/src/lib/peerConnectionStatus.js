/**
 * Tradução de `RTCPeerConnection.connectionState` para algo que caiba num tile.
 *
 * O estado da conexão já existia — `webrtcMesh.js` o dispara a cada transição —
 * e ninguém o lia. Por isso todo problema de mídia nesta aplicação tinha o mesmo
 * sintoma: "a pessoa aparece, muda e parada". O tile vem da lista do servidor de
 * sinalização, e essa lista é idêntica com a conexão perfeita, em `failed` e
 * nunca estabelecida.
 *
 * Duas decisões que este módulo carrega:
 *
 * 1. **O caminho feliz é silencioso.** `connected` devolve `null` e o tile não
 *    ganha elemento nenhum. Um indicador aceso o tempo todo vira ruído, ninguém
 *    o lê, e o problema volta em outra forma.
 * 2. **Nenhum rótulo é o estado cru.** `new`/`connecting`/`disconnected` não são
 *    palavras para o usuário final; o objetivo é uma frase acionável ("Sem
 *    conexão"), não um despejo de enum.
 *
 * Puro de propósito: sem DOM, sem React, sem i18n dinâmico — é a única lógica de
 * verdade do assunto, e puro ela é testável sem navegador, no mesmo padrão de
 * `gridLayout.js` e `devices.js`.
 *
 * Aqui só se **observa**. Reagir a `failed` (reiniciar o ICE, refazer a
 * negociação) é do `webrtcMesh.js`, e não deste módulo.
 */

const CONNECTING = { level: 'warn', label: 'Conectando…', live: 'polite' };

const BY_STATE = {
  new: CONNECTING,
  connecting: CONNECTING,
  // O único estado sem indicador: ver a decisão 1 acima.
  connected: null,
  disconnected: { level: 'warn', label: 'Instável', live: 'polite' },
  // O que a pessoa precisa ler sem abrir o console.
  failed: { level: 'bad', label: 'Sem conexão', live: 'assertive' },
  closed: { level: 'bad', label: 'Desconectado', live: 'polite' },
};

/**
 * @param {string} [state] Um valor de `RTCPeerConnection.connectionState`.
 * @returns {{level: 'warn'|'bad', label: string, live: 'polite'|'assertive'}|null}
 *   `null` quando não há nada a dizer (conexão saudável).
 */
export function describeConnection(state) {
  // Ausente é o intervalo entre o registro do participante entrar no mapa e a
  // primeira transição chegar — que é exatamente "conectando", e não "sem
  // informação". Estado desconhecido (um valor novo do navegador) cai aqui pela
  // mesma razão: o pessimismo custa um rótulo, o otimismo custa o silêncio que
  // esta entrega existe para acabar.
  if (state == null || !(state in BY_STATE)) return CONNECTING;
  return BY_STATE[state];
}

export default describeConnection;
