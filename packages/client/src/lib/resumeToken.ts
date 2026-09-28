/**
 * Token de retorno: a prova de que esta aba já foi admitida naquela sala.
 *
 * Este módulo é **puro**: não toca em `window` nem em `sessionStorage`. Ele
 * recebe um objeto storage-like por parâmetro e devolve (ou grava) strings —
 * mesmo padrão de `lib/devices.ts` (`readPreferences(window.localStorage)`), e
 * é o que permite testar a gravação, a leitura e a limpeza em `node:test`, sem
 * jsdom e sem navegador.
 *
 * **`sessionStorage`, e não `localStorage`** (decisão da task, não desta
 * camada): o token precisa sobreviver ao F5 e à reconexão, e precisa morrer com
 * a aba. Fechar a aba volta a exigir aprovação — é proposital, para que um link
 * vazado numa máquina compartilhada não entre sozinho na reunião de ninguém.
 *
 * O valor guardado aqui **é** poder de entrada na sala durante a janela de
 * graça: quem o lê entra sem aprovação. Por isso ele nunca vai para `console`,
 * nunca entra em mensagem de erro e nunca viaja em evento que não seja o
 * `join-request` da própria sala a que pertence — a chave é por `roomId`
 * justamente para que o token da sala A não tenha como ser apresentado na B.
 *
 * Todo acesso vai dentro de `try/catch`: `sessionStorage` lança em modo
 * privado, sob política de cookies de terceiros e com a cota estourada. Nenhum
 * desses casos pode deixar alguém **fora** da sala — a falha degrada para "sem
 * token", que é o fluxo de aprovação de sempre.
 */

/** Prefixo da chave por sala. A chave cheia é `wtk-meet:resume:<roomId>`. */
export const RESUME_KEY_PREFIX = 'wtk-meet:resume:';

/**
 * A fatia de `Storage` que este módulo usa.
 *
 * Os três métodos são opcionais para que um duplo de teste possa omitir o que
 * não exercita, e para que um `storage` de navegador capado (sem `removeItem`,
 * por exemplo) não vire `TypeError` no caminho de saída da sala.
 */
export interface ResumeStorage {
  getItem?(key: string): string | null;
  setItem?(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** A chave daquela sala. Uma sala, uma chave — nunca uma chave global. */
export function resumeKey(roomId: string): string {
  return `${RESUME_KEY_PREFIX}${roomId}`;
}

/**
 * O token guardado para aquela sala, ou `null`.
 *
 * `null` cobre os três casos em que não há o que apresentar — nunca houve
 * token, o storage está indisponível, ou o que estava lá não é uma string útil
 * — e todos eles significam a mesma coisa para quem chama: peça aprovação como
 * sempre.
 */
export function readResumeToken(storage: ResumeStorage | null | undefined, roomId: string): string | null {
  try {
    const raw = storage?.getItem?.(resumeKey(roomId));
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Grava o token daquela sala, sobrescrevendo o anterior.
 *
 * Sobrescrever é o comportamento correto e não uma consequência: o servidor
 * rotaciona o token a cada admissão e invalida o antigo na hora, então guardar
 * o anterior seria guardar lixo com cara de credencial.
 */
export function writeResumeToken(
  storage: ResumeStorage | null | undefined,
  roomId: string,
  token: unknown,
): void {
  if (typeof token !== 'string' || token.length === 0) return;
  try {
    storage?.setItem?.(resumeKey(roomId), token);
  } catch {
    // Storage indisponível: seguimos sem retomada. Não há o que reportar a
    // quem chama — e um `console.warn` aqui teria o token no escopo.
  }
}

/** Apaga o token daquela sala. Chamado na saída intencional pela UI. */
export function clearResumeToken(storage: ResumeStorage | null | undefined, roomId: string): void {
  try {
    storage?.removeItem?.(resumeKey(roomId));
  } catch {
    // Idem: nada a fazer, e nada a logar.
  }
}
