/**
 * Da URL da aba ativa ao endereço da sala wtk-meet.
 *
 * Módulo **puro**: sem DOM, sem `chrome.*`, sem rede. Recebe uma string (ou
 * `undefined`, que é o que `chrome.tabs.query` devolve quando não há permissão
 * para ler aquela aba) e devolve um veredito. É o que permite cobrir em
 * `node --test` a lista inteira de formas que uma URL do Meet assume, sem
 * navegador.
 *
 * **A normalização final é a de `roomSlug.ts` do client, e não uma daqui.** O
 * path é a chave da sala no servidor de sinalização: duas implementações de
 * normalização põem a extensão e o app em salas diferentes, cada um vendo uma
 * sala vazia, sem nenhum erro na tela. Por isso `normalizeRoomPath` e
 * `isValidRoomPath` são importados de lá.
 *
 * **O código da reunião vira o endereço da sala verbatim** (`abc-defg-hij` →
 * `abc-defg-hij`), sem prefixo. É o que o DoD desta entrega pede, e o que faz
 * duas pessoas da mesma reunião chegarem à mesma sala sem combinar nada. O
 * preço está registrado no `ARCHITECTURE.md` §11.4: quem conhece o código da
 * reunião adivinha o endereço da sala, e a defesa que sobra é a aprovação
 * humana do §4 — que a extensão não enfraquece (ela nunca aprova sozinha).
 */

import { isValidRoomPath, normalizeRoomPath } from '../../../client/src/lib/roomSlug.js';

/** O host — e só ele. `meet.google.com` sem `www`, que é como a Google serve. */
const MEET_HOST = 'meet.google.com';

/**
 * O código de uma reunião: três grupos de letras minúsculas, `3-4-3`.
 *
 * Deliberadamente estrito. Um padrão frouxo (`[a-z-]+`) casaria com `/lookup`,
 * `/new`, `/landing` e com qualquer rota futura da Google — e cada falso
 * positivo vira uma sala com nome de rota, criada por engano e que ninguém
 * consegue adivinhar de volta.
 */
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** Por que o campo não veio preenchido. A UI traduz; aqui só se classifica. */
export type MeetRefusal =
  /** A aba não tem URL legível (`chrome://`, `about:blank`, sem permissão). */
  | 'no-url'
  /** A aba é de outro site. */
  | 'not-meet'
  /** É o Meet, mas não é uma reunião (`/`, `/new`, `/lookup/...`, `/landing`). */
  | 'no-code';

export interface MeetCodeOk {
  ok: true;
  /** O código como a Google escreve: `abc-defg-hij`. */
  code: string;
  /** O endereço da sala, já passado por `normalizeRoomPath`. */
  roomPath: string;
}

export interface MeetCodeFail {
  ok: false;
  reason: MeetRefusal;
}

export type MeetCodeResult = MeetCodeOk | MeetCodeFail;

/** Mensagens de recusa. Ficam aqui para que popup e `manager` digam o mesmo. */
export const MEET_REFUSALS: Record<MeetRefusal, string> = {
  'no-url':
    'Não consigo ler o endereço da aba ativa — digite o id da sala ou use a última usada.',
  'not-meet':
    'A aba ativa não é uma reunião do Google Meet, então não houve preenchimento automático.',
  'no-code':
    'Essa aba é do Google Meet, mas ainda não é uma reunião (falta o código `abc-defg-hij`).',
};

/**
 * Extrai o código de reunião de uma URL do Meet.
 *
 * Casos que este módulo trata **de propósito**, todos com teste:
 *
 * - `?authuser=1` e qualquer outra query: ignorada — a conta de quem abriu não
 *   faz parte do endereço da sala.
 * - `#algumacoisa`: ignorado, e **nunca** usado para derivar chave nenhuma
 *   (§11.2 do `ARCHITECTURE.md`: a extensão não deriva chave de E2EE).
 * - Caixa alta (`/ABC-DEFG-HIJ`): a Google aceita e redireciona; aqui vira
 *   minúsculo antes de comparar, senão a mesma reunião daria duas salas.
 * - `/lookup/<apelido>`, `/new`, `/landing`, `/` e qualquer outra rota: recusa
 *   com `no-code`. Um apelido de `/lookup/` **não** é o código da reunião: ele
 *   resolve para códigos diferentes a cada vez, e usá-lo como endereço juntaria
 *   pessoas de reuniões distintas na mesma sala de áudio.
 * - `http://` no lugar de `https://`, ou `www.meet.google.com`: `not-meet`.
 *   Estreito de propósito — a Google serve a reunião em exatamente um lugar.
 */
export function meetCodeFromUrl(rawUrl: unknown): MeetCodeResult {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return { ok: false, reason: 'no-url' };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // `about:blank` e `chrome://extensions` até fazem `new URL`; o que cai aqui
    // é string que não é URL nenhuma — mesma resposta de aba ilegível.
    return { ok: false, reason: 'no-url' };
  }

  if (url.protocol !== 'https:' || url.hostname !== MEET_HOST) return { ok: false, reason: 'not-meet' };

  // `pathname` já vem sem query e sem fragmento. O `filter` derruba as barras
  // extras de `//abc-defg-hij/`, que é o que sobra de um link colado duas vezes.
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return { ok: false, reason: 'no-code' };

  const code = decodeURIComponent(segments[0]!).toLowerCase();
  if (!MEET_CODE.test(code)) return { ok: false, reason: 'no-code' };

  const roomPath = normalizeRoomPath(code);
  // Cinturão e suspensório: o código casa com o padrão do Meet, mas quem decide
  // o que é endereço de sala válido é o `roomSlug.ts` do client.
  if (!isValidRoomPath(roomPath)) return { ok: false, reason: 'no-code' };

  return { ok: true, code, roomPath };
}

/**
 * O que o campo de id do popup deve mostrar quando ele abre.
 *
 * Três entradas e uma saída — puro de propósito, para que a regra de precedência
 * ("a reunião ativa ganha da última sala usada") seja testável sem popup.
 * `notice` é `null` quando houve preenchimento pela aba: nesse caso não há nada
 * a explicar.
 */
export function prefillFromTab(
  tabUrl: unknown,
  lastRoom: string | null | undefined,
): { value: string; fromMeet: boolean; notice: string | null } {
  const meet = meetCodeFromUrl(tabUrl);
  if (meet.ok) return { value: meet.roomPath, fromMeet: true, notice: null };

  const last = normalizeRoomPath(lastRoom);
  return {
    value: isValidRoomPath(last) ? last : '',
    fromMeet: false,
    notice: MEET_REFUSALS[meet.reason],
  };
}
