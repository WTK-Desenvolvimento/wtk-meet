/**
 * Agrupamento e debounce dos eventos de entrada/saida.
 *
 * Dois problemas reais que este modulo resolve:
 *  1. Oscilacao de rede gera leave+join em sequencia. Sem debounce a sala vira
 *     um letreiro de "Fulano saiu / Fulano entrou".
 *  2. Varias pessoas entrando juntas geram uma tempestade de toasts. Eventos
 *     dentro de uma mesma janela sao agrupados num unico aviso.
 *
 * O tempo e injetado (`now`) para manter o modulo puro e testavel.
 */

/**
 * @param {object} [options]
 * @param {(peer:object) => string} [options.keyOf] identidade usada para casar
 *   saida com reconexao. O padrao e o id, mas quando o id e por conexao (nosso
 *   caso: um uuid por socket) o chamador deve passar algo estavel, como o nome.
 */
export function createPresenceTracker({ leaveDebounceMs = 2000, groupWindowMs = 600, keyOf } = {}) {
  const key = keyOf ?? ((peer) => peer.id);
  /** @type {Map<string, {peer:object, dueAt:number}>} */
  const pendingLeaves = new Map();
  /** @type {Array<{type:'join'|'leave', peer:object, at:number}>} */
  const queue = [];

  function enqueue(type, peer, at) {
    queue.push({ type, peer, at });
  }

  return {
    /** @returns {boolean} true se foi uma entrada real (nao uma reconexao) */
    join(peer, now) {
      if (pendingLeaves.has(key(peer))) {
        // Reconexao dentro da janela de debounce: cancela a saida, nao anuncia nada.
        pendingLeaves.delete(key(peer));
        return false;
      }
      enqueue('join', peer, now);
      return true;
    },

    leave(peer, now) {
      pendingLeaves.set(key(peer), { peer, dueAt: now + leaveDebounceMs });
    },

    /**
     * Promove saidas vencidas e drena os lotes prontos.
     * @returns {Array<{type:'join'|'leave', peers:object[]}>}
     */
    tick(now) {
      for (const [id, pending] of pendingLeaves) {
        if (now >= pending.dueAt) {
          pendingLeaves.delete(id);
          enqueue('leave', pending.peer, now);
        }
      }

      if (queue.length === 0) return [];
      // Aguarda a janela de agrupamento fechar antes de emitir.
      if (now - queue[0].at < groupWindowMs) return [];

      const batches = [];
      for (const item of queue.splice(0, queue.length)) {
        const last = batches[batches.length - 1];
        if (last && last.type === item.type) last.peers.push(item.peer);
        else batches.push({ type: item.type, peers: [item.peer] });
      }
      return batches;
    },

    get pendingLeaveCount() {
      return pendingLeaves.size;
    },

    clear() {
      pendingLeaves.clear();
      queue.length = 0;
    },
  };
}

/** Texto do aviso, ja no plural correto. */
export function describeBatch(batch) {
  const names = batch.peers.map((p) => p.name);
  const entrando = batch.type === 'join';
  const verb = entrando ? 'entrou' : 'saiu';
  const verbPlural = entrando ? 'entraram' : 'saíram';
  const onde = entrando ? 'na chamada' : 'da chamada';
  if (names.length === 1) return `${names[0]} ${verb} ${onde}`;
  if (names.length === 2) return `${names[0]} e ${names[1]} ${verbPlural} ${onde}`;
  return `${names[0]}, ${names[1]} e mais ${names.length - 2} ${verbPlural} ${onde}`;
}
