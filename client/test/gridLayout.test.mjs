/**
 * Testes do cálculo da grade de vídeos.
 *
 * A grade é a peça que decide se a sala cabe ou não no viewport, e ela não tem
 * como ser verificada por CSS: o resultado depende de largura, altura e contagem
 * ao mesmo tempo. Como o módulo é puro, dá para fixar aqui — de forma
 * determinística e sem navegador — tanto a forma esperada da grade (1x1, 2x1,
 * 2x2, …) quanto a invariante que realmente importa: **o conjunto cabe na caixa
 * disponível**. O E2E prova que isso se traduz em ausência de scroll no browser
 * de verdade; a aritmética fica provada aqui.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeGridLayout,
  GRID_GAP,
  MIN_TILE_WIDTH,
  TILE_ASPECT,
} from '../src/lib/gridLayout.js';

/** Palco típico de desktop: paisagem larga, já descontados cabeçalho e rodapé. */
const LANDSCAPE = { width: 1600, height: 800 };
/** Coluna estreita: janela em retrato, ou a grade espremida pelo chat aberto. */
const NARROW = { width: 400, height: 900 };
/** Faixa larga e baixa: janela achatada verticalmente. */
const WIDE_SHORT = { width: 1600, height: 220 };

const layout = (box, count, extra = {}) => computeGridLayout({ ...box, count, ...extra });

/** A grade inteira cabe na caixa, nos dois eixos. */
function assertFits(box, result, label) {
  const usedWidth = result.cols * result.tileWidth + GRID_GAP * (result.cols - 1);
  const usedHeight = result.rows * (result.tileWidth / TILE_ASPECT) + GRID_GAP * (result.rows - 1);
  assert.ok(
    usedWidth <= box.width + 0.001,
    `${label}: largura usada ${usedWidth} excede ${box.width}`,
  );
  assert.ok(
    usedHeight <= box.height + 0.001,
    `${label}: altura usada ${usedHeight} excede ${box.height}`,
  );
}

test('a forma da grade acompanha a contagem de participantes', () => {
  // Exatamente a tabela do critério de aceite, num palco de desktop.
  const expected = {
    1: [1, 1],
    2: [2, 1],
    3: [2, 2],
    4: [2, 2],
    5: [3, 2],
    6: [3, 2],
    7: [3, 3],
    8: [3, 3],
    9: [3, 3],
    10: [4, 3],
    11: [4, 3],
    12: [4, 3],
  };

  for (const [count, [cols, rows]] of Object.entries(expected)) {
    const result = layout(LANDSCAPE, Number(count));
    assert.deepEqual(
      [result.cols, result.rows],
      [cols, rows],
      `${count} tiles deveria dar ${cols}x${rows}, deu ${result.cols}x${result.rows}`,
    );
  }
});

test('rows é sempre ceil(count / cols)', () => {
  for (const box of [LANDSCAPE, NARROW, WIDE_SHORT]) {
    for (let count = 1; count <= 12; count += 1) {
      const result = layout(box, count);
      assert.equal(
        result.rows,
        Math.ceil(count / result.cols),
        `${count} tiles em ${box.width}x${box.height}`,
      );
    }
  }
});

test('de 1 a 12 tiles, a grade cabe na caixa sem estouro — em qualquer proporção de palco', () => {
  for (const box of [LANDSCAPE, NARROW, WIDE_SHORT, { width: 900, height: 900 }]) {
    for (let count = 1; count <= 12; count += 1) {
      const result = layout(box, count);
      assert.equal(result.overflow, false, `${count} tiles em ${box.width}x${box.height}`);
      assertFits(box, result, `${count} tiles em ${box.width}x${box.height}`);
    }
  }
});

test('um tile ocupa o maior retângulo 16:9 que cabe no palco, sem exceder a altura', () => {
  // Palco mais "alto" que 16:9: quem manda é a altura, não a largura.
  const tall = layout({ width: 1600, height: 500 }, 1);
  assert.equal(tall.cols, 1);
  assert.equal(tall.rows, 1);
  assert.ok(tall.tileWidth <= 500 * TILE_ASPECT, `tile ${tall.tileWidth} estourou a altura`);
  assert.equal(tall.tileWidth, Math.floor(500 * TILE_ASPECT));

  // Palco mais "largo" que 16:9: quem manda é a largura.
  const wide = layout({ width: 600, height: 800 }, 1);
  assert.equal(wide.tileWidth, 600);
});

test('a orientação do palco decide a grade de 2 tiles', () => {
  const landscape = layout({ width: 1200, height: 500 }, 2);
  assert.deepEqual([landscape.cols, landscape.rows], [2, 1]);

  const portrait = layout({ width: 500, height: 1200 }, 2);
  assert.deepEqual([portrait.cols, portrait.rows], [1, 2]);
});

test('palco largo e baixo empilha em uma única linha', () => {
  for (const count of [2, 3, 4, 5, 6]) {
    const result = layout(WIDE_SHORT, count);
    assert.equal(result.rows, 1, `${count} tiles em ${WIDE_SHORT.width}x${WIDE_SHORT.height}`);
    assert.equal(result.cols, count);
  }
});

test('palco estreito empilha em uma única coluna', () => {
  for (const count of [1, 2, 3, 4]) {
    const result = layout({ width: 320, height: 1400 }, count);
    assert.equal(result.cols, 1, `${count} tiles numa coluna de 320px`);
    assert.equal(result.rows, count);
  }
});

test('o tile mantém 16:9 e é arredondado para baixo nos dois eixos', () => {
  for (const box of [LANDSCAPE, NARROW, WIDE_SHORT]) {
    for (let count = 1; count <= 12; count += 1) {
      const { tileWidth, tileHeight } = layout(box, count);
      assert.equal(tileWidth, Math.floor(tileWidth), 'largura deve ser inteira');
      assert.equal(tileHeight, Math.floor(tileWidth / TILE_ASPECT));
      // Arredondar para cima produziria a linha extra de estouro.
      assert.ok(tileHeight <= tileWidth / TILE_ASPECT);
    }
  }
});

test('espaço insuficiente fixa o piso de largura e declara estouro', () => {
  const box = { width: 300, height: 120 };
  const result = layout(box, 8);

  assert.equal(result.overflow, true);
  assert.equal(result.tileWidth, MIN_TILE_WIDTH, 'o tile para de encolher no piso');
  assert.ok(result.cols >= 1);
  assert.equal(result.rows, Math.ceil(8 / result.cols));
  // O estouro é vertical: a largura continua respeitada, quem transborda é a
  // altura — e é o container da grade que rola, não a página.
  assert.ok(result.cols * result.tileWidth + GRID_GAP * (result.cols - 1) <= box.width);
  assert.ok(result.rows * result.tileHeight + GRID_GAP * (result.rows - 1) > box.height);
});

test('caixa mais estreita que o piso do tile também é estouro', () => {
  const result = layout({ width: 80, height: 600 }, 2);
  assert.equal(result.overflow, true);
  assert.equal(result.cols, 1);
  assert.equal(result.tileWidth, MIN_TILE_WIDTH);
});

test('o piso de largura é configurável', () => {
  const box = { width: 300, height: 120 };
  assert.equal(layout(box, 8).overflow, true);
  // Com um piso baixo o mesmo espaço passa a caber — nada de estouro.
  const relaxed = layout(box, 8, { minTileWidth: 20 });
  assert.equal(relaxed.overflow, false);
  assertFits(box, relaxed, 'piso relaxado');
});

test('antes da primeira medição devolve resultado neutro, sem lançar', () => {
  const neutral = { cols: 1, rows: 1, tileWidth: 0, tileHeight: 0, overflow: false };

  assert.deepEqual(layout({ width: 0, height: 0 }, 3), neutral);
  assert.deepEqual(layout({ width: 1200, height: 0 }, 3), neutral);
  assert.deepEqual(layout({ width: 0, height: 800 }, 3), neutral);
  assert.deepEqual(layout(LANDSCAPE, 0), neutral);
  assert.deepEqual(layout({ width: NaN, height: NaN }, 3), neutral);
  assert.deepEqual(layout({ width: -100, height: -100 }, 3), neutral);
  assert.deepEqual(layout(LANDSCAPE, -1), neutral);
  assert.deepEqual(computeGridLayout(), neutral);
});

test('a proporção do tile é configurável sem quebrar o encaixe', () => {
  const box = { width: 1200, height: 600 };
  const square = layout(box, 4, { aspect: 1 });
  assert.equal(square.tileHeight, square.tileWidth);
  const usedHeight = square.rows * square.tileWidth + GRID_GAP * (square.rows - 1);
  assert.ok(usedHeight <= box.height, `altura usada ${usedHeight} excede ${box.height}`);
});

test('o resultado é estável sob variação de um pixel na largura', () => {
  // Sem o desempate por menor número de colunas a grade oscilaria entre
  // configurações equivalentes a cada pixel arrastado no resize.
  let previous = null;
  for (let width = 1590; width <= 1610; width += 1) {
    const { cols } = layout({ width, height: 800 }, 6);
    if (previous !== null) assert.equal(cols, previous, `oscilou em ${width}px`);
    previous = cols;
  }
});

/*
 * ---------------------------------------------------------------------------
 * Cobertura de QA
 *
 * Os casos acima fixam a forma da grade em palcos escolhidos a dedo. Os de
 * baixo atacam o mesmo contrato pelo lado das invariantes: em vez de conferir
 * "1600x800 com 3 tiles dá 2x2", varrem faixas inteiras de viewport e cobram a
 * propriedade que precisa valer em todas elas. É o que separa "passa nos
 * exemplos" de "não tem como estourar a caixa".
 * ---------------------------------------------------------------------------
 */

/** Viewports reais da faixa do critério de aceite (360x640 a 2560x1440). */
const VIEWPORTS = [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 640 },
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

/** A maior largura de tile alcançável em alguma configuração de colunas. */
function bestPossibleTileWidth(box, count, gap = GRID_GAP) {
  let best = 0;
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const byWidth = (box.width - gap * (cols - 1)) / cols;
    const byHeight = ((box.height - gap * (rows - 1)) / rows) * TILE_ASPECT;
    best = Math.max(best, Math.min(byWidth, byHeight));
  }
  return best;
}

test('a grade escolhida é a melhor possível — nenhuma outra contagem de colunas dá tile maior', () => {
  // O ganho de mover o cálculo para JS é exatamente este: escolher o número de
  // colunas que maximiza o tile *sujeito à altura*. Se a escolha não for ótima,
  // sobra espaço vazio no palco e o vídeo fica menor do que poderia.
  for (const box of VIEWPORTS) {
    for (let count = 1; count <= 8; count += 1) {
      const result = layout(box, count);
      if (result.overflow) continue; // aí o critério é o piso, não o ótimo
      const ceiling = bestPossibleTileWidth(box, count);
      // 0.5px de tolerância do desempate (que evita a grade piscar no resize)
      // + 1px do arredondamento para baixo.
      assert.ok(
        result.tileWidth >= ceiling - 1.5,
        `${count} tiles em ${box.width}x${box.height}: escolheu ${result.tileWidth}px, ` +
          `mas ${ceiling.toFixed(1)}px era possível`,
      );
    }
  }
});

test('em toda a faixa de viewport o conjunto cabe, ou declara estouro com o tile no piso', () => {
  // A dicotomia do contrato: ou a grade cabe nos dois eixos, ou ela assume o
  // estouro e para de encolher no piso de legibilidade. Não existe terceiro
  // caso — um tile menor que o piso sem `overflow: true` seria uma grade
  // ilegível que ninguém mandaria rolar.
  for (const box of VIEWPORTS) {
    for (let count = 1; count <= 8; count += 1) {
      const result = layout(box, count);
      const label = `${count} tiles em ${box.width}x${box.height}`;

      assert.ok(result.tileWidth >= MIN_TILE_WIDTH, `${label}: tile abaixo do piso de legibilidade`);
      assert.equal(result.rows, Math.ceil(count / result.cols), `${label}: rows inconsistente`);

      if (result.overflow) {
        assert.equal(result.tileWidth, MIN_TILE_WIDTH, `${label}: estouro deveria fixar o piso`);
      } else {
        assertFits(box, result, label);
      }
    }
  }
});

test('o gap informado é respeitado no encaixe, inclusive gap zero', () => {
  // O CSS lê o mesmo número via `--grid-gap`. Se o módulo ignorasse o gap, a
  // conta bateria aqui e estouraria alguns pixels no navegador — o tipo de erro
  // que só aparece com a sala cheia em janela apertada.
  for (const gap of [0, 24, 40]) {
    for (const box of VIEWPORTS) {
      for (let count = 1; count <= 8; count += 1) {
        const result = layout(box, count, { gap });
        if (result.overflow) continue;
        const usedWidth = result.cols * result.tileWidth + gap * (result.cols - 1);
        const usedHeight = result.rows * result.tileHeight + gap * (result.rows - 1);
        const label = `${count} tiles em ${box.width}x${box.height} com gap ${gap}`;
        assert.ok(usedWidth <= box.width + 0.001, `${label}: largura ${usedWidth} > ${box.width}`);
        assert.ok(usedHeight <= box.height + 0.001, `${label}: altura ${usedHeight} > ${box.height}`);
      }
    }
  }
});

test('aumentar o gap nunca aumenta o tile', () => {
  for (const box of VIEWPORTS) {
    for (let count = 2; count <= 8; count += 1) {
      const tight = layout(box, count, { gap: 0 });
      const loose = layout(box, count, { gap: 40 });
      if (tight.overflow || loose.overflow) continue;
      assert.ok(
        loose.tileWidth <= tight.tileWidth + 1,
        `${count} tiles em ${box.width}x${box.height}: gap 40 deu ${loose.tileWidth}px, ` +
          `mais que os ${tight.tileWidth}px de gap 0`,
      );
    }
  }
});

test('abrir o chat só encolhe o tile, e fechar devolve exatamente o tamanho anterior', () => {
  // Abrir o chat estreita o palco (o ResizeObserver mede menos largura). O tile
  // pode diminuir ou ficar igual — nunca crescer — e o fechamento tem que ser
  // reversível: o cálculo é função pura da caixa, então a mesma caixa devolve o
  // mesmo resultado, sem histerese.
  const CHAT_WIDTH = 320;
  for (const box of VIEWPORTS) {
    for (let count = 1; count <= 8; count += 1) {
      const closed = layout(box, count);
      const opened = layout({ width: box.width - CHAT_WIDTH, height: box.height }, count);
      const reclosed = layout(box, count);
      const label = `${count} tiles em ${box.width}x${box.height}`;

      if (!closed.overflow && !opened.overflow) {
        assert.ok(
          opened.tileWidth <= closed.tileWidth,
          `${label}: com o chat aberto o tile cresceu (${closed.tileWidth} → ${opened.tileWidth})`,
        );
      }
      assert.deepEqual(reclosed, closed, `${label}: fechar o chat não devolveu o layout anterior`);
    }
  }
});

test('estreitar a janela pixel a pixel nunca faz o tile crescer', () => {
  // Monotonicidade sob resize contínuo: o usuário arrastando a borda da janela
  // não pode ver o vídeo pular para cima enquanto encolhe o espaço.
  for (const count of [1, 3, 6]) {
    let previous = Infinity;
    for (let width = 1600; width >= 800; width -= 1) {
      const result = layout({ width, height: 900 }, count);
      if (result.overflow) break;
      assert.ok(
        result.tileWidth <= previous,
        `${count} tiles: tile cresceu de ${previous}px para ${result.tileWidth}px em ${width}px`,
      );
      previous = result.tileWidth;
    }
  }
});
