/**
 * Cálculo da grade de vídeos — módulo puro, sem nenhuma dependência de DOM.
 *
 * O problema é bidimensional: o tamanho ótimo do tile depende ao mesmo tempo da
 * largura, da altura e da contagem de participantes. CSS não expressa "escolha o
 * número de colunas que maximiza o tile sujeito a caber na altura" —
 * `auto-fit`/`minmax` só enxerga a largura, e é exatamente por isso que o layout
 * anterior (tile único ocupando a largura inteira e estourando a altura) empurrava
 * os controles para fora da tela.
 *
 * Aqui a regra é uma busca exaustiva sobre o número de colunas, que é barata
 * (no máximo `count` candidatos) e determinística. Fica testável em `node:test`
 * sem navegador, no mesmo padrão de `lib/audioLevels.js`.
 */

/** Espaçamento entre tiles, nos dois eixos. Fonte única: o CSS lê via `--grid-gap`. */
export const GRID_GAP = 12;

/** Proporção alvo do tile. 16:9 é a proporção nativa da maioria das câmeras e telas. */
export const TILE_ASPECT = 16 / 9;

/** Piso de legibilidade: abaixo disso o layout declara estouro em vez de encolher mais. */
export const MIN_TILE_WIDTH = 120;

/**
 * Duas configurações que diferem por menos de meio pixel são equivalentes na
 * prática. Sem essa tolerância o vencedor oscila entre grades diferentes a cada
 * pixel de resize, e a grade "pisca" enquanto a janela é arrastada.
 */
const TIE_EPSILON = 0.5;

/** O que `computeGridLayout` devolve. */
export interface GridLayout {
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  overflow: boolean;
}

export interface GridLayoutInput {
  /** Largura útil do container da grade (px). */
  width?: number;
  /** Altura útil do container da grade (px). */
  height?: number;
  /** Quantidade de tiles a acomodar. */
  count?: number;
  /** Proporção largura/altura do tile. */
  aspect?: number;
  /** Espaçamento entre tiles (px). */
  gap?: number;
  /** Piso de largura do tile (px). */
  minTileWidth?: number;
}

const NEUTRAL: Readonly<GridLayout> = Object.freeze({
  cols: 1,
  rows: 1,
  tileWidth: 0,
  tileHeight: 0,
  overflow: false,
});

const isPositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * `tileWidth === 0` significa "ainda não medido / nada a posicionar": é o
 * resultado do primeiro render, antes do `ResizeObserver` entregar a caixa real.
 * O componente usa isso para não pintar a grade com tamanho errado.
 */
export function computeGridLayout({
  width,
  height,
  count,
  aspect = TILE_ASPECT,
  gap = GRID_GAP,
  minTileWidth = MIN_TILE_WIDTH,
}: GridLayoutInput = {}): GridLayout {
  // `count` pode chegar `undefined`; `NaN` reprova no `Number.isFinite` logo
  // abaixo, exatamente como `Math.floor(undefined)` fazia antes.
  const tiles = Math.floor(count ?? NaN);
  if (!Number.isFinite(tiles) || tiles <= 0) return { ...NEUTRAL };
  if (!isPositive(width) || !isPositive(height) || !isPositive(aspect)) return { ...NEUTRAL };

  const spacing = Number.isFinite(gap) && gap > 0 ? gap : 0;
  const floor = isPositive(minTileWidth) ? minTileWidth : 0;

  let best: { cols: number; rows: number; tileWidth: number } | null = null;
  for (let cols = 1; cols <= tiles; cols += 1) {
    const rows = Math.ceil(tiles / cols);
    // Quanto cada tile pode ter de largura pelo eixo horizontal...
    const byWidth = (width - spacing * (cols - 1)) / cols;
    // ...e quanto pode ter, na mesma proporção, pelo eixo vertical.
    const byHeight = ((height - spacing * (rows - 1)) / rows) * aspect;
    const tileWidth = Math.min(byWidth, byHeight);
    if (tileWidth <= 0) continue;
    // Estritamente maior (com tolerância): em empate vence o menor número de
    // colunas, que já foi visitado antes neste laço.
    if (!best || tileWidth > best.tileWidth + TIE_EPSILON) {
      best = { cols, rows, tileWidth };
    }
  }

  if (!best || best.tileWidth < floor) {
    // Nem com a melhor configuração o tile fica legível: fixa o piso e deixa o
    // estouro para o container da grade resolver com scroll **interno**. A
    // página continua sem rolar e os controles continuam visíveis.
    const tileWidth = floor > 0 ? floor : Math.max(1, Math.floor(width));
    const fitting = Math.floor((width + spacing) / (tileWidth + spacing));
    const cols = Math.min(tiles, Math.max(1, fitting));
    const rows = Math.ceil(tiles / cols);
    const tileHeight = Math.floor(tileWidth / aspect);
    return {
      cols,
      rows,
      tileWidth,
      tileHeight,
      overflow:
        cols * tileWidth + spacing * (cols - 1) > width ||
        rows * tileHeight + spacing * (rows - 1) > height,
    };
  }

  // Para baixo, sempre: arredondar para cima produz exatamente a linha extra de
  // estouro que este módulo existe para eliminar.
  const tileWidth = Math.floor(best.tileWidth);
  return {
    cols: best.cols,
    rows: best.rows,
    tileWidth,
    tileHeight: Math.floor(tileWidth / aspect),
    overflow: false,
  };
}
