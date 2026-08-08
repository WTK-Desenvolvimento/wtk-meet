/**
 * Politica de "um compartilhamento de tela por vez".
 *
 * Vive no servidor (autoridade) e e espelhada no cliente para desabilitar o
 * botao. Duas copias do mesmo modulo evitam divergencia de regra.
 */

export function createShareLock() {
  /** @type {{id:string, name:string}|null} */
  let holder = null;

  return {
    /** @returns {{ok:true}|{ok:false, holder:{id:string,name:string}}} */
    acquire(peer) {
      if (holder && holder.id !== peer.id) return { ok: false, holder };
      holder = { id: peer.id, name: peer.name };
      return { ok: true };
    },

    release(peerId) {
      if (holder && holder.id === peerId) {
        holder = null;
        return true;
      }
      return false;
    },

    isHeldBy(peerId) {
      return holder != null && holder.id === peerId;
    },

    get holder() {
      return holder;
    },
  };
}
