/**
 * Rate limit do soundboard: no máximo `BURST_LIMIT` disparos por
 * `BURST_WINDOW_MS`, por participante.
 *
 * Módulo **puro**, e o relógio é **injetado**: `consume(state, now)` não olha
 * `Date.now()` nem agenda nada. É o que permite testar a janela inteira em
 * `node:test` sem timer de verdade — um teste que espera 5 segundos de relógio
 * real é um teste que ninguém roda.
 *
 * A **mesma** tabela vale nas duas pontas, e é de propósito: quem envia se
 * autolimita (o botão fica indisponível e mostra o tempo restante) e quem
 * recebe descarta o excedente antes de qualquer efeito.
 *
 * **O que o limitador da ponta receptora protege — e o que ele não protege.**
 * O áudio do efeito chega mixado no canal de música de quem disparou: descartar
 * um anúncio **não** silencia som nenhum. O limitador de entrada protege a lista
 * de atividade, o agendamento das janelas de mute e a CPU de quem recebe. Contra
 * um peer com client modificado, a única defesa real é o mute daquele
 * participante — e é por isso que a UI oferece esse botão justamente quando
 * alguém estoura o limite. Prometer que o rate limit protege a sala contra spam
 * de áudio seria pior que não ter rate limit nenhum.
 */

/** Disparos permitidos dentro da janela. */
export const BURST_LIMIT = 3;

/** Tamanho da janela deslizante, em ms. */
export const BURST_WINDOW_MS = 5_000;

/**
 * O estado do limitador: os instantes dos disparos recentes, do mais antigo
 * para o mais novo. Imutável — `consume` devolve um estado novo.
 */
export type RateState = readonly number[];

export interface RateDecision {
  allowed: boolean;
  state: RateState;
  /** Quanto falta para o próximo disparo caber. `0` quando já cabe. */
  retryInMs: number;
}

export function createRateState(): RateState {
  return [];
}

function recentes(state: RateState | null | undefined, now: number): number[] {
  if (!Array.isArray(state)) return [];
  // Só instantes válidos e dentro da janela. O `<= now` descarta carimbo do
  // futuro, que apareceria se o relógio andasse para trás no meio da sessão e
  // que, sem isso, bloquearia disparos até passar.
  return state.filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t) && t <= now && now - t < BURST_WINDOW_MS,
  );
}

/**
 * Quanto falta para o próximo disparo ser aceito, sem consumir nada. É o número
 * que o botão mostra enquanto está indisponível.
 */
export function retryInMs(state: RateState | null | undefined, now: number): number {
  const janela = recentes(state, now);
  if (janela.length < BURST_LIMIT) return 0;
  // O mais antigo da janela é o que vai expirar primeiro e abrir a vaga.
  const primeiro = janela[janela.length - BURST_LIMIT]!;
  return Math.max(0, BURST_WINDOW_MS - (now - primeiro));
}

/**
 * Tenta consumir uma vaga. Devolve o veredito e o estado novo — que, na recusa,
 * é o mesmo de antes **podado**: uma tentativa recusada não conta para o limite,
 * senão quem clica repetidamente nunca sairia do cooldown.
 */
export function consume(state: RateState | null | undefined, now: number): RateDecision {
  const janela = recentes(state, now);
  if (janela.length >= BURST_LIMIT) {
    return { allowed: false, state: janela, retryInMs: retryInMs(janela, now) };
  }
  const proximo = [...janela, now];
  return { allowed: true, state: proximo, retryInMs: retryInMs(proximo, now) };
}
