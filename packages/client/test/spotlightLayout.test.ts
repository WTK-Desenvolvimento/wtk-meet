/**
 * Testes do cálculo do palco em modo destaque.
 *
 * O modo destaque existe para que o conteúdo compartilhado fique legível, e a
 * única forma de provar isso sem navegador é fixar a aritmética: a coluna
 * respeita as travas do 80/20, o destaque cabe na caixa em qualquer proporção de
 * janela (inclusive achatada), o modo estreito vira na largura certa e nada
 * arredonda para cima. O E2E prova que isso se traduz em ausência de scroll no
 * browser de verdade; a conta fica provada aqui.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GRID_GAP, TILE_ASPECT } from '../src/lib/gridLayout.js';
import {
  computeSpotlightLayout,
  MIN_THUMB_WIDTH,
  NARROW_STAGE_WIDTH,
  orderRailItems,
  RAIL_GUTTER,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  RAIL_TARGET_RATIO,
  resolveSpotlightScreen,
} from '../src/lib/spotlightLayout.js';

import type {
  RailItem,
  ScreenLike,
  SpotlightLayout,
  SpotlightLayoutInput,
} from '../src/lib/spotlightLayout.js';

/** A caixa do palco, como as fixtures abaixo a descrevem. */
type Caixa = { width: number; height: number };

/** Palco típico de desktop. */
const LANDSCAPE = { width: 1600, height: 800 };
/** Faixa larga e baixa: janela achatada verticalmente. */
const WIDE_SHORT = { width: 1600, height: 220 };
/** Palco espremido pelo chat aberto num laptop. */
const SQUEEZED = { width: 1024, height: 700 };
/** Abaixo do limiar: modo estreito. */
const NARROW = { width: 420, height: 900 };

const layout = (box: Caixa, count: number, extra: SpotlightLayoutInput = {}) =>
  computeSpotlightLayout({ ...box, count, ...extra });

/** Nada pode exceder a caixa do palco, em nenhum eixo. */
function assertFits(box: Caixa, result: SpotlightLayout, label: string) {
  const gap = result.rail.width > 0 ? GRID_GAP : 0;
  assert.ok(
    result.spotlight.width <= box.width - result.rail.width - gap + 0.001,
    `${label}: destaque de ${result.spotlight.width}px + coluna de ${result.rail.width}px excede ${box.width}px`,
  );
  assert.ok(
    result.spotlight.height <= box.height + 0.001,
    `${label}: destaque de ${result.spotlight.height}px excede a altura ${box.height}px`,
  );
}

/** O destaque é 16:9, arredondado para baixo nos dois eixos. */
function assertAspect(result: SpotlightLayout, label: string) {
  const { width, height } = result.spotlight;
  assert.equal(width, Math.floor(width), `${label}: largura deve ser inteira`);
  assert.equal(height, Math.floor(width / TILE_ASPECT), `${label}: altura fora de 16:9`);
  assert.ok(height <= width / TILE_ASPECT, `${label}: arredondou para cima`);
}

test('em palco largo a coluna persegue 20% da largura, presa entre o piso e o teto', () => {
  for (const width of [720, 900, 1024, 1280, 1600, 1920, 2560, 3840]) {
    const result = layout({ width, height: 900 }, 4);
    const label = `palco de ${width}px`;

    assert.equal(result.mode, 'spotlight', label);
    assert.ok(
      result.rail.width >= RAIL_MIN_WIDTH && result.rail.width <= RAIL_MAX_WIDTH,
      `${label}: coluna de ${result.rail.width}px fora de [${RAIL_MIN_WIDTH}, ${RAIL_MAX_WIDTH}]`,
    );
    // Dentro da faixa em que o alvo cabe entre as travas, ele é respeitado.
    const target = Math.floor(width * RAIL_TARGET_RATIO);
    if (target >= RAIL_MIN_WIDTH && target <= RAIL_MAX_WIDTH) {
      assert.equal(result.rail.width, target, `${label}: alvo de 20% não foi respeitado`);
    }
  }
});

test('o destaque fica com toda a largura que sobra da coluna, em 16:9', () => {
  const result = layout(LANDSCAPE, 3);
  const expectedWidth = Math.min(
    LANDSCAPE.width - result.rail.width - GRID_GAP,
    LANDSCAPE.height * TILE_ASPECT,
  );
  assert.equal(result.spotlight.width, Math.floor(expectedWidth));
  assertAspect(result, 'palco de desktop');
  assertFits(LANDSCAPE, result, 'palco de desktop');
});

test('o destaque nunca excede a caixa — inclusive em janela achatada', () => {
  // 1600x220 é o caso em que a largura disponível é generosa e quem manda é a
  // altura: sem esta trava o destaque em 16:9 estouraria o palco para baixo e
  // empurraria os controles para fora da tela.
  for (const box of [LANDSCAPE, WIDE_SHORT, SQUEEZED, NARROW, { width: 900, height: 260 }]) {
    for (let count = 0; count <= 8; count += 1) {
      const result = layout(box, count);
      const label = `${count} miniaturas em ${box.width}x${box.height}`;
      assertFits(box, result, label);
      assertAspect(result, label);
    }
  }

  const flat = layout(WIDE_SHORT, 4);
  assert.equal(flat.spotlight.height, Math.floor(Math.floor(220 * TILE_ASPECT) / TILE_ASPECT));
  assert.ok(flat.spotlight.height <= WIDE_SHORT.height);
});

test('o destaque nunca é menor que uma miniatura', () => {
  for (const box of [LANDSCAPE, WIDE_SHORT, SQUEEZED, NARROW, { width: 721, height: 400 }]) {
    for (let count = 1; count <= 6; count += 1) {
      const result = layout(box, count);
      assert.ok(
        result.spotlight.width >= result.rail.thumbWidth,
        `${count} miniaturas em ${box.width}x${box.height}: destaque ${result.spotlight.width}px ` +
          `menor que a miniatura ${result.rail.thumbWidth}px`,
      );
    }
  }
});

test('sem miniaturas a coluna desaparece e o destaque toma o palco inteiro', () => {
  // Acontece de verdade: um participante sozinho compartilhando a própria tela
  // tem a câmera dele na coluna, mas o caso de contagem 0 precisa degradar em
  // vez de reservar uma faixa vazia.
  const result = layout(LANDSCAPE, 0);
  assert.equal(result.rail.width, 0);
  assert.equal(result.rail.thumbWidth, 0);
  assert.equal(result.rail.thumbHeight, 0);
  assert.equal(result.rail.scrolls, false);
  assert.equal(
    result.spotlight.width,
    Math.floor(Math.min(LANDSCAPE.width, LANDSCAPE.height * TILE_ASPECT)),
  );
});

test('a miniatura é 16:9 e cabe na coluna, com folga para a barra de rolagem', () => {
  for (const width of [800, 1280, 1920]) {
    const result = layout({ width, height: 900 }, 5);
    const label = `palco de ${width}px`;
    assert.equal(result.rail.thumbWidth, result.rail.width - RAIL_GUTTER, label);
    assert.ok(result.rail.thumbWidth < result.rail.width, `${label}: miniatura sem folga`);
    assert.equal(result.rail.thumbHeight, Math.floor(result.rail.thumbWidth / TILE_ASPECT), label);
  }
});

test('a coluna sinaliza rolagem só quando a pilha de miniaturas não cabe na altura', () => {
  const short = { width: 1600, height: 400 };
  const { thumbHeight } = layout(short, 1).rail;
  // Quantas miniaturas cabem exatamente na altura do palco.
  const fitting = Math.floor((short.height + GRID_GAP) / (thumbHeight + GRID_GAP));

  assert.equal(layout(short, fitting).rail.scrolls, false, `${fitting} miniaturas deveriam caber`);
  assert.equal(layout(short, fitting + 1).rail.scrolls, true, 'a pilha excedente deveria rolar');
  // Rolar é da coluna: o destaque não muda de tamanho por causa disso.
  assert.deepEqual(layout(short, fitting).spotlight, layout(short, fitting + 1).spotlight);
});

test('abaixo do limiar o palco vira estreito: destaque em largura cheia, coluna fora do fluxo', () => {
  for (const width of [320, 480, 640, NARROW_STAGE_WIDTH - 1]) {
    const result = layout({ width, height: 900 }, 4);
    const label = `palco de ${width}px`;
    assert.equal(result.mode, 'spotlight-narrow', label);
    assert.equal(result.rail.width, 0, `${label}: a coluna não pode ocupar o fluxo`);
    assert.equal(result.spotlight.width, Math.min(width, Math.floor(900 * TILE_ASPECT)), label);
    // As miniaturas continuam existindo — elas vivem no painel sob demanda.
    assert.ok(result.rail.thumbWidth > 0, `${label}: o painel ficaria sem geometria`);
  }

  // No limiar exato ainda é modo largo: a comparação é estrita.
  assert.equal(layout({ width: NARROW_STAGE_WIDTH, height: 900 }, 4).mode, 'spotlight');
});

test('o limiar do modo estreito é configurável e continua consistente', () => {
  const relaxed = layout({ width: 500, height: 700 }, 3, { narrowWidth: 400 });
  assert.equal(relaxed.mode, 'spotlight');
  assert.ok(relaxed.rail.width > 0);
  assertFits({ width: 500, height: 700 }, relaxed, 'limiar relaxado');
  // Mesmo com o limiar afrouxado até um palco minúsculo, o destaque continua
  // maior que a miniatura e nada estoura a caixa.
  const tiny = layout({ width: 260, height: 400 }, 3, { narrowWidth: 100, railMin: 0 });
  assert.ok(tiny.spotlight.width >= tiny.rail.thumbWidth);
  assertFits({ width: 260, height: 400 }, tiny, 'palco minúsculo');
});

test('a miniatura não desce do piso de legibilidade: quem engorda é a coluna', () => {
  const box = { width: 1600, height: 900 };
  // Alvo minúsculo e sem piso de coluna: quem segura a barra é o piso da
  // miniatura, não a coluna — o inverso deixaria uma faixa colorida ilegível.
  const skinny = layout(box, 3, { railRatio: 0.02, railMin: 0 });
  assert.equal(skinny.rail.width, MIN_THUMB_WIDTH + RAIL_GUTTER);
  assert.equal(skinny.rail.thumbWidth, MIN_THUMB_WIDTH);

  // Um teto explícito continua tendo a última palavra: é decisão de quem chama.
  assert.equal(layout(box, 3, { railRatio: 0.02, railMin: 0, railMax: 100 }).rail.width, 100);

  // E o piso é configurável como os demais.
  const roomy = layout(box, 3, { railRatio: 0.02, railMin: 0, minThumbWidth: 200 });
  assert.equal(roomy.rail.thumbWidth, 200);

  // No caminho padrão o piso nunca chega a ser acionado: a menor coluna
  // possível (o piso de 160px) já entrega uma miniatura confortável.
  for (const width of [NARROW_STAGE_WIDTH, 1024, 1920]) {
    assert.ok(layout({ width, height: 800 }, 3).rail.thumbWidth >= MIN_THUMB_WIDTH);
  }
});

test('as travas da coluna são configuráveis', () => {
  const box = { width: 1600, height: 900 };
  assert.equal(layout(box, 3, { railMin: 0, railMax: 4000 }).rail.width, 320, 'sem teto, 20% puro');
  assert.equal(layout(box, 3, { railMax: 200 }).rail.width, 200);
  assert.equal(layout({ width: 800, height: 900 }, 3, { railMin: 300 }).rail.width, 300);
});

test('antes da primeira medição devolve resultado neutro, sem lançar', () => {
  const neutral = {
    mode: 'spotlight',
    spotlight: { width: 0, height: 0 },
    rail: { width: 0, thumbWidth: 0, thumbHeight: 0, scrolls: false },
  };

  assert.deepEqual(layout({ width: 0, height: 0 }, 3), neutral);
  assert.deepEqual(layout({ width: 1600, height: 0 }, 3), neutral);
  assert.deepEqual(layout({ width: 0, height: 800 }, 3), neutral);
  assert.deepEqual(layout({ width: NaN, height: NaN }, 3), neutral);
  assert.deepEqual(layout({ width: -100, height: -100 }, 3), neutral);
  assert.deepEqual(computeSpotlightLayout(), neutral);
  // Contagem inválida não é entrada não medida: o palco continua pintável.
  assert.equal(layout(LANDSCAPE, -3).rail.width, 0);
  assert.ok(layout(LANDSCAPE, NaN).spotlight.width > 0);
});

test('o resultado é puro: mesma entrada, mesma saída, sem estado compartilhado', () => {
  const first = layout(LANDSCAPE, 4);
  const mutated = layout(LANDSCAPE, 4);
  mutated.spotlight.width = -1;
  mutated.rail.width = -1;
  assert.deepEqual(layout(LANDSCAPE, 4), first, 'uma chamada contaminou a seguinte');
});

test('estreitar o palco pixel a pixel nunca faz o destaque crescer', () => {
  // Monotonicidade sob resize contínuo, dentro de cada modo: arrastar a borda da
  // janela não pode fazer o vídeo pular para cima enquanto o espaço encolhe.
  let previous = Infinity;
  for (let width = 2000; width >= NARROW_STAGE_WIDTH; width -= 1) {
    const { spotlight } = layout({ width, height: 900 }, 4);
    assert.ok(
      spotlight.width <= previous,
      `destaque cresceu de ${previous}px para ${spotlight.width}px em ${width}px de palco`,
    );
    previous = spotlight.width;
  }
});

test('o modo não oscila em torno do limiar', () => {
  // Um pixel de arrasto não pode alternar entre dois layouts completamente
  // diferentes mais de uma vez: a virada acontece exatamente uma vez na faixa.
  let flips = 0;
  let previous = null;
  for (let width = NARROW_STAGE_WIDTH - 40; width <= NARROW_STAGE_WIDTH + 40; width += 1) {
    const { mode } = layout({ width, height: 800 }, 4);
    if (previous !== null && mode !== previous) flips += 1;
    previous = mode;
  }
  assert.equal(flips, 1, `o modo virou ${flips} vezes na faixa do limiar`);
});

test('abrir o chat só encolhe o destaque, e fechar devolve exatamente o layout anterior', () => {
  const CHAT_WIDTH = 320;
  for (const box of [LANDSCAPE, { width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
    for (let count = 1; count <= 6; count += 1) {
      const closed = layout(box, count);
      const opened = layout({ width: box.width - CHAT_WIDTH, height: box.height }, count);
      const label = `${count} miniaturas em ${box.width}x${box.height}`;
      assert.ok(
        opened.spotlight.width <= closed.spotlight.width,
        `${label}: com o chat aberto o destaque cresceu`,
      );
      assert.deepEqual(layout(box, count), closed, `${label}: fechar o chat não foi reversível`);
    }
  }
});

test('o gap informado é respeitado, inclusive gap zero', () => {
  for (const gap of [0, 24, 40]) {
    for (const box of [LANDSCAPE, SQUEEZED, WIDE_SHORT]) {
      const result = layout(box, 4, { gap });
      const used =
        result.spotlight.width + result.rail.width + (result.rail.width > 0 ? gap : 0);
      assert.ok(
        used <= box.width + 0.001,
        `gap ${gap} em ${box.width}x${box.height}: ${used}px excede o palco`,
      );
    }
  }
});

/*
 * ---------------------------------------------------------------------------
 * Qual tela fica em destaque
 *
 * A escolha é local e derivada a cada render: nada é corrigido por efeito, então
 * o que precisa ser provado é a função de resolução — zero, uma e várias telas,
 * mais o fallback quando a escolhida acaba no meio da reunião.
 * ---------------------------------------------------------------------------
 */

const screen = (id: string): ScreenLike & { key: string } => ({ key: id, screenId: id });

test('sem nenhum compartilhamento não há destaque — é o sinal de voltar para a grade', () => {
  assert.equal(resolveSpotlightScreen([], null), null);
  assert.equal(resolveSpotlightScreen([], 'local-screen'), null);
  assert.equal(resolveSpotlightScreen(undefined, null), null);
  assert.equal(resolveSpotlightScreen(null, 'peer-a-screen'), null);
});

test('com um único compartilhamento ele é o destaque, com ou sem escolha do usuário', () => {
  const screens = [screen('local-screen')];
  assert.equal(resolveSpotlightScreen(screens, null), screens[0]);
  assert.equal(resolveSpotlightScreen(screens, 'local-screen'), screens[0]);
  // Escolha apontando para uma tela que já não existe não deixa o palco em
  // branco: `pinnedScreenId` pode ficar "sujo" porque nunca é lido sem validação.
  assert.equal(resolveSpotlightScreen(screens, 'peer-b-screen'), screens[0]);
});

test('com vários compartilhamentos a escolha do usuário vence a ordem padrão', () => {
  const screens = [screen('local-screen'), screen('peer-a-screen'), screen('peer-b-screen')];
  assert.equal(resolveSpotlightScreen(screens, null), screens[0], 'sem escolha, a primeira');
  assert.equal(resolveSpotlightScreen(screens, 'peer-b-screen'), screens[2]);
});

test('uma tela nova entrando não rouba o destaque de quem já havia escolhido', () => {
  const before = [screen('local-screen'), screen('peer-a-screen')];
  const chosen = resolveSpotlightScreen(before, 'peer-a-screen');
  const after = [...before, screen('peer-b-screen')];
  assert.equal(resolveSpotlightScreen(after, 'peer-a-screen'), chosen);
});

test('quando a tela em destaque acaba, o destaque migra para outra ativa', () => {
  const screens = [screen('local-screen'), screen('peer-a-screen'), screen('peer-b-screen')];
  const pinned = 'peer-a-screen';
  assert.equal(resolveSpotlightScreen(screens, pinned)!.screenId, pinned);

  // O dono de peer-a para de compartilhar (ou sai da sala): sobram duas telas.
  const remaining = screens.filter((s) => s.screenId !== pinned);
  const next = resolveSpotlightScreen(remaining, pinned);
  assert.ok(next, 'não pode ficar sem destaque enquanto houver tela ativa');
  assert.equal(next.screenId, 'local-screen');

  // Só quando a última acaba o palco volta para a grade uniforme.
  assert.equal(resolveSpotlightScreen([], pinned), null);
});

/*
 * ---------------------------------------------------------------------------
 * Ordem da coluna lateral
 *
 * Quem compartilha e quem está falando sobem para o topo — mas a reordenação não
 * pode acontecer debaixo da mão de quem está rolando a coluna.
 * ---------------------------------------------------------------------------
 */

const camera = (key: string, extra: Partial<RailItem> = {}): RailItem => ({ key, audioId: key, ...extra });

test('as telas não destacadas vêm antes de qualquer câmera', () => {
  const items = [
    camera('local', { local: true }),
    camera('peer-a'),
    screen('peer-b-screen'),
    camera('peer-b', { sharing: true }),
  ];
  assert.equal(orderRailItems({ items })[0].key, 'peer-b-screen');
  // Inclusive quando alguém está falando: a outra tela compartilhada é o que o
  // usuário pode querer trocar para o destaque, e precisa estar ao alcance.
  assert.equal(orderRailItems({ items, speaking: ['peer-a'] })[0].key, 'peer-b-screen');
});

test('quem está falando sobe para o topo, acima de quem está calado', () => {
  const items = [
    camera('local', { local: true }),
    camera('peer-a'),
    camera('peer-b'),
    camera('peer-c'),
  ];
  assert.equal(orderRailItems({ items, speaking: ['peer-c'] })[0].key, 'peer-c');

  // Dois falando ao mesmo tempo mantêm entre si a ordem de chegada: nada de
  // trocarem de lugar a cada sílaba.
  assert.deepEqual(
    orderRailItems({ items, speaking: new Set(['peer-c', 'peer-a']) }).map((i) => i.key),
    ['peer-a', 'peer-c', 'local', 'peer-b'],
  );
});

test('quem compartilha fica acima do resto, e quem fala acima de quem compartilha', () => {
  const items = [
    camera('local', { local: true }),
    camera('peer-a'),
    camera('peer-b', { sharing: true }),
    camera('peer-c'),
  ];
  assert.deepEqual(
    orderRailItems({ items }).map((i) => i.key),
    ['peer-b', 'local', 'peer-a', 'peer-c'],
  );
  assert.deepEqual(
    orderRailItems({ items, speaking: ['peer-c'] }).map((i) => i.key),
    ['peer-c', 'peer-b', 'local', 'peer-a'],
  );
});

test('a ordem é estável: sem mudança de fala nem de telas, nada se mexe', () => {
  const items = [camera('local', { local: true }), camera('peer-a'), camera('peer-b')];
  assert.deepEqual(
    orderRailItems({ items, speaking: ['peer-b'] }).map((i) => i.key),
    orderRailItems({ items, speaking: ['peer-b'] }).map((i) => i.key),
  );
});

test('com a coluna congelada a ordem anterior é preservada — a rolagem não é sequestrada', () => {
  // O usuário rolou a coluna para olhar peer-c. Se peer-c começar a falar e a
  // lista reordenar, o item que ele está olhando salta para outro ponto do
  // scroll. Congelada, a ordem visível não muda.
  const items = [
    camera('local', { local: true }),
    camera('peer-a'),
    camera('peer-b'),
    camera('peer-c'),
  ];
  const previousOrder = ['local', 'peer-a', 'peer-b', 'peer-c'];

  assert.deepEqual(
    orderRailItems({ items, speaking: ['peer-c'], previousOrder, frozen: true }).map((i) => i.key),
    previousOrder,
  );
  // De volta ao topo, a prioridade volta a valer.
  assert.equal(
    orderRailItems({ items, speaking: ['peer-c'], previousOrder, frozen: false })[0].key,
    'peer-c',
  );
});

test('congelada, quem entra vai para o fim e quem sai apenas desaparece', () => {
  const items = [
    camera('local', { local: true }),
    camera('peer-b'),
    screen('peer-b-screen'),
    camera('peer-d'),
  ];
  const ordered = orderRailItems({
    items,
    previousOrder: ['local', 'peer-a', 'peer-b'],
    frozen: true,
  });
  assert.deepEqual(
    ordered.map((i) => i.key),
    // peer-a saiu; a tela de peer-b e peer-d entraram no fim, sem deslocar o que
    // já estava visível no topo.
    ['local', 'peer-b', 'peer-b-screen', 'peer-d'],
  );
});

test('sem ordem anterior o congelamento não tem o que preservar e a prioridade vale', () => {
  const items = [camera('local', { local: true }), camera('peer-a')];
  const ordered = orderRailItems({
    items,
    speaking: ['peer-a'],
    previousOrder: [],
    frozen: true,
  });
  assert.equal(ordered[0].key, 'peer-a');
});

test('a ordenação preserva o conjunto de miniaturas — ninguém some nem duplica', () => {
  const items = [
    camera('local', { local: true }),
    screen('peer-a-screen'),
    camera('peer-a', { sharing: true }),
    camera('peer-b'),
  ];
  for (const speaking of [[], ['peer-b'], ['local', 'peer-a']]) {
    const ordered = orderRailItems({ items, speaking });
    assert.equal(ordered.length, items.length);
    assert.deepEqual(
      ordered.map((i) => i.key).sort(),
      items.map((i) => i.key).sort(),
    );
  }
});

test('coluna vazia e entrada inválida não lançam', () => {
  assert.deepEqual(orderRailItems({ items: [] }), []);
  assert.deepEqual(orderRailItems({}), []);
  assert.deepEqual(orderRailItems(), []);
});

test('o destaque do modo destaque é muito maior que a miniatura — o ponto da entrega', () => {
  // O critério de aceite do produto em uma linha: a tela compartilhada não
  // divide o palco em partes iguais com as câmeras. Na grade uniforme com 5
  // tiles cada um ficava com ~1/3 da largura; aqui o destaque é várias vezes a
  // miniatura em qualquer palco de desktop.
  for (const box of [LANDSCAPE, SQUEEZED, { width: 1366, height: 768 }]) {
    const result = layout(box, 4);
    assert.ok(
      result.spotlight.width >= result.rail.thumbWidth * 3,
      `${box.width}x${box.height}: destaque ${result.spotlight.width}px vs miniatura ` +
        `${result.rail.thumbWidth}px`,
    );
  }
});
