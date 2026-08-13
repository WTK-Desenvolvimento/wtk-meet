/**
 * Cálculo do palco em modo destaque — módulo puro, sem nenhuma dependência de DOM.
 *
 * Pela mesma razão de `lib/gridLayout.js`, isto não é CSS: a decisão depende ao
 * mesmo tempo da largura, da altura e da contagem de miniaturas. `flex: 4 / flex: 1`
 * entrega a proporção pedida, mas não sabe que o destaque precisa ser 16:9 **e**
 * caber na altura — numa janela achatada o destaque estoura verticalmente e
 * ressuscita o scroll de página que o layout de viewport fixo (§6.7) eliminou.
 *
 * O "80/20" do requisito é um **alvo com trava**, não uma proporção rígida: em um
 * ultrawide 20% viram 400px de miniatura (desperdício) e num laptop com o chat
 * aberto viram 110px (ilegível). A coluna fica em
 * `clamp(RAIL_MIN_WIDTH, 20%, RAIL_MAX_WIDTH)` e o destaque recebe o resto.
 *
 * Abaixo de `NARROW_STAGE_WIDTH` a coluna não cabe: o destaque passa a ocupar a
 * largura inteira e as miniaturas viram um painel sob demanda. O limiar é medido
 * sobre a **caixa do palco**, não sobre o viewport — o palco encolhe quando o chat
 * abre, e uma media query de viewport diria "desktop" com 400px reais de palco.
 */

import { GRID_GAP, TILE_ASPECT } from './gridLayout.js';

/** Fração da largura do palco que a coluna persegue. O "20" do 80/20. */
export const RAIL_TARGET_RATIO = 0.2;

/** Piso da coluna: abaixo disso a miniatura deixa de ser reconhecível. */
export const RAIL_MIN_WIDTH = 160;

/** Teto da coluna: acima disso ela só rouba área do que interessa. */
export const RAIL_MAX_WIDTH = 280;

/**
 * Largura de palco abaixo da qual a coluna deixa de existir. Não é largura de
 * viewport: é a caixa medida pelo `ResizeObserver` do `SpotlightStage`.
 */
export const NARROW_STAGE_WIDTH = 720;

/**
 * Folga horizontal reservada dentro da coluna. A coluna rola, e a barra de
 * rolagem (quando não é overlay) come largura: sem esta folga a miniatura
 * transborda alguns pixels justamente quando há miniaturas demais.
 */
export const RAIL_GUTTER = 10;

/**
 * Piso de legibilidade da miniatura, no mesmo espírito do `MIN_TILE_WIDTH` da
 * grade: abaixo disso a coluna deixa de cumprir sua função (reconhecer quem
 * está na sala e escolher outra tela) e vira só uma faixa colorida. Quando o
 * alvo de 20% cai abaixo do piso, quem cede é a coluna — ela engorda — e não a
 * miniatura.
 */
export const MIN_THUMB_WIDTH = 120;

const isPositive = (value) => Number.isFinite(value) && value > 0;

/**
 * Estrutura neutra do "ainda não medido". Uma nova a cada chamada, para que
 * ninguém consiga mutar o estado compartilhado de um módulo puro.
 */
const neutral = () => ({
  mode: 'spotlight',
  spotlight: { width: 0, height: 0 },
  rail: { width: 0, thumbWidth: 0, thumbHeight: 0, scrolls: false },
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * @param {object} input
 * @param {number} input.width   Largura útil do palco (px).
 * @param {number} input.height  Altura útil do palco (px).
 * @param {number} input.count   Quantidade de miniaturas na coluna.
 * @param {number} [input.aspect]      Proporção largura/altura dos tiles.
 * @param {number} [input.gap]         Espaçamento entre destaque/coluna e entre miniaturas.
 * @param {number} [input.railMin]     Piso da largura da coluna (px).
 * @param {number} [input.railMax]     Teto da largura da coluna (px).
 * @param {number} [input.railRatio]   Fração alvo da largura do palco.
 * @param {number} [input.narrowWidth] Limiar do modo estreito (px).
 * @param {number} [input.minThumbWidth] Piso de legibilidade da miniatura (px).
 * @returns {{
 *   mode: 'spotlight' | 'spotlight-narrow',
 *   spotlight: {width: number, height: number},
 *   rail: {width: number, thumbWidth: number, thumbHeight: number, scrolls: boolean},
 * }}
 *
 * `spotlight.width === 0` significa "ainda não medido": é o primeiro render,
 * antes de o `ResizeObserver` entregar a caixa real. O componente usa isso para
 * não pintar o palco com um tamanho que seria errado por um frame.
 *
 * `rail.width` é a largura ocupada pela coluna **no fluxo do palco** — por isso é
 * `0` no modo estreito (onde a lista é um overlay) e também quando não há
 * miniatura nenhuma. `thumbWidth`/`thumbHeight` continuam preenchidos no modo
 * estreito: são a geometria das miniaturas dentro do painel sob demanda.
 */
export function computeSpotlightLayout({
  width,
  height,
  count,
  aspect = TILE_ASPECT,
  gap = GRID_GAP,
  railMin = RAIL_MIN_WIDTH,
  railMax = RAIL_MAX_WIDTH,
  railRatio = RAIL_TARGET_RATIO,
  narrowWidth = NARROW_STAGE_WIDTH,
  minThumbWidth = MIN_THUMB_WIDTH,
} = {}) {
  if (!isPositive(width) || !isPositive(height) || !isPositive(aspect)) return neutral();

  const thumbs = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const spacing = Number.isFinite(gap) && gap > 0 ? gap : 0;
  const min = isPositive(railMin) ? railMin : 0;
  const max = isPositive(railMax) && railMax >= min ? railMax : min;
  const narrow = width < (Number.isFinite(narrowWidth) ? narrowWidth : NARROW_STAGE_WIDTH);

  // Largura "ideal" da coluna: o alvo de 20%, preso entre o piso e o teto, e
  // nunca maior que metade do palco — a invariante "o destaque nunca é menor que
  // a miniatura" precisa valer mesmo com um limiar de modo estreito customizado.
  //
  // O piso efetivo já embute a miniatura legível mais a folga da barra de
  // rolagem: quando 20% dariam uma miniatura ilegível, quem engorda é a coluna.
  // O teto continua tendo a última palavra (`clamp` aplica o `min` primeiro),
  // porque um `railMax` explícito é uma decisão de quem chama.
  const thumbFloor = isPositive(minThumbWidth) ? minThumbWidth : 0;
  const target = Math.floor(width * (Number.isFinite(railRatio) && railRatio > 0 ? railRatio : RAIL_TARGET_RATIO));
  const railWidth = Math.min(
    Math.floor(clamp(target, Math.max(min, thumbFloor + RAIL_GUTTER), max)),
    Math.max(0, Math.floor((width - spacing) / 2)),
  );

  // No modo estreito a coluna não ocupa espaço no fluxo; no modo largo ela só
  // existe se houver o que listar.
  const railInFlow = !narrow && thumbs > 0 ? railWidth : 0;

  const availableWidth = Math.max(0, width - railInFlow - (railInFlow > 0 ? spacing : 0));
  // Para baixo, sempre: arredondar para cima é o pixel de estouro que este
  // módulo existe para evitar (mesma regra de `gridLayout.js`).
  const spotWidth = Math.max(0, Math.floor(Math.min(availableWidth, height * aspect)));
  const spotHeight = Math.floor(spotWidth / aspect);

  const thumbWidth = thumbs > 0 ? Math.max(0, railWidth - RAIL_GUTTER) : 0;
  const thumbHeight = Math.floor(thumbWidth / aspect);
  const stackHeight = thumbs > 0 ? thumbs * thumbHeight + spacing * (thumbs - 1) : 0;

  return {
    mode: narrow ? 'spotlight-narrow' : 'spotlight',
    spotlight: { width: spotWidth, height: spotHeight },
    rail: {
      width: railInFlow,
      thumbWidth,
      thumbHeight,
      // Só a coluna rola. O destaque e a página permanecem imóveis.
      scrolls: stackHeight > height,
    },
  };
}

/**
 * Qual tela aparece em destaque.
 *
 * A escolha do usuário (`pinnedId`) é **local** e nunca é "corrigida" por um
 * efeito: ela pode continuar apontando para uma tela que já acabou à vontade,
 * porque nunca é lida sem validação. Se a escolhida ainda está ativa, ela vence;
 * senão, o destaque cai para a primeira tela da lista. É isso que faz o destaque
 * migrar sozinho quando o dono para de compartilhar, em vez de piscar em branco
 * ou cair para a grade enquanto ainda há o que mostrar.
 *
 * @param {Array<{screenId: string}>} screens Telas ativas, em ordem determinística.
 * @param {string|null} pinnedId Escolha local do usuário, se houver.
 * @returns {object|null} A tela em destaque, ou `null` quando não há nenhuma
 *   ativa — o sinal de "volte para a grade uniforme".
 */
export function resolveSpotlightScreen(screens, pinnedId) {
  if (!Array.isArray(screens) || screens.length === 0) return null;
  if (pinnedId) {
    const pinned = screens.find((screen) => screen && screen.screenId === pinnedId);
    if (pinned) return pinned;
  }
  return screens[0];
}

/** Faixas de prioridade da coluna. Menor = mais perto do topo. */
const RANK_SCREEN = 0;
const RANK_SPEAKING = 1;
const RANK_SHARING = 2;
const RANK_LOCAL = 3;
const RANK_OTHER = 4;

function rankOf(item, speaking) {
  if (!item) return RANK_OTHER;
  if (item.screenId) return RANK_SCREEN;
  if (item.audioId && speaking.has(item.audioId)) return RANK_SPEAKING;
  if (item.sharing) return RANK_SHARING;
  if (item.local) return RANK_LOCAL;
  return RANK_OTHER;
}

/**
 * Ordem das miniaturas na coluna.
 *
 * Sobem para o topo, nesta ordem: as telas compartilhadas que não estão em
 * destaque, quem está falando, quem está compartilhando, você, e o resto na
 * ordem de chegada. Dentro de cada faixa a ordem de origem é preservada — dois
 * participantes calados nunca trocam de lugar entre si, e dois falando ao mesmo
 * tempo não dançam a cada sílaba (o indicador de fala já vem com a histerese de
 * `lib/audioLevels.js`, que segura meio segundo antes de apagar).
 *
 * `frozen` existe por causa da rolagem. Reordenar enquanto o usuário rolou a
 * coluna para olhar alguém no fim da lista **move o conteúdo debaixo da mão
 * dele**: o item observado salta para outro ponto do scroll. Congelada, a ordem
 * anterior é preservada item a item e só as novidades entram — no fim, que é o
 * único lugar que não desloca nada do que já está sob os olhos. Quem decide
 * congelar é a UI (a coluna fora do topo); a política não é decisão deste
 * módulo, o que mantém a função pura e testável.
 *
 * @param {object} input
 * @param {Array<object>} input.items Miniaturas na ordem determinística de origem.
 * @param {Iterable<string>} [input.speaking] `audioId`s de quem está falando.
 * @param {Array<string>} [input.previousOrder] Chaves na ordem do render anterior.
 * @param {boolean} [input.frozen] Manter a ordem anterior (usuário rolando).
 * @returns {Array<object>} Os mesmos objetos de `items`, reordenados.
 */
export function orderRailItems({ items, speaking, previousOrder, frozen = false } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];

  if (frozen && Array.isArray(previousOrder) && previousOrder.length > 0) {
    const pending = new Map(items.map((item) => [item.key, item]));
    const kept = [];
    for (const key of previousOrder) {
      const item = pending.get(key);
      if (item) {
        kept.push(item);
        pending.delete(key);
      }
    }
    for (const item of items) {
      if (pending.has(item.key)) kept.push(item);
    }
    return kept;
  }

  const speakingSet = speaking instanceof Set ? speaking : new Set(speaking || []);
  return items
    .map((item, index) => ({ item, index, rank: rankOf(item, speakingSet) }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map((entry) => entry.item);
}
