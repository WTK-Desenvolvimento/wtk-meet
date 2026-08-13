/**
 * Testes de QA da coluna de miniaturas e do palco em destaque — o que o módulo
 * puro (`spotlightLayout.test.mjs`) não consegue provar sozinho: que a lista
 * renderizada contém todo mundo, e que a miniatura de tela é um controle de
 * verdade para quem usa teclado ou leitor de tela.
 *
 * O E2E (`e2e/run.mjs`, checagens C5–C11) é quem prova isso no navegador, mas o
 * Chromium não sobe neste sandbox. Renderizar em HTML estático com o
 * `react-dom/server` que já é dependência cobre a estrutura — elemento,
 * `aria-pressed`, ordem de tabulação — sem navegador e sem dependência nova. O
 * JSX é transformado pelo esbuild que vem com o Vite (ver `jsxLoader.mjs`).
 *
 * O que este arquivo **não** cobre, por não haver DOM: o clique em si e a
 * medição do `ResizeObserver` (portanto o modo estreito). Essas duas ficam com
 * o E2E; a aritmética por trás delas está em `spotlightLayout.test.mjs`.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./jsxLoader.mjs', import.meta.url);

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: ThumbnailRail } = await import('../src/components/ThumbnailRail.jsx');
const { default: SpotlightStage } = await import('../src/components/SpotlightStage.jsx');

const camera = (key, extra = {}) => ({ key, audioId: key, label: key, ...extra });
const screenOf = (key, owner) => ({
  key,
  screenId: key,
  owner,
  label: `${owner} — tela`,
  badge: 'Tela',
  contain: true,
});

const renderRail = (props) =>
  renderToStaticMarkup(
    createElement(ThumbnailRail, { audioLevels: {}, onSelectScreen: () => {}, ...props }),
  );

/** Rótulos visíveis, na ordem em que aparecem na coluna. */
const labels = (html) => [...html.matchAll(/<span class="video-label">([^<]*)</g)].map((m) => m[1]);

/** Cada `<button>` da coluna, com os atributos que importam para o teclado. */
function selectButtons(html) {
  return [...html.matchAll(/<button([^>]*)>/g)].map(([, attrs]) => ({
    attrs,
    pressed: /aria-pressed="([^"]*)"/.exec(attrs)?.[1],
    label: /aria-label="([^"]*)"/.exec(attrs)?.[1],
    type: /type="([^"]*)"/.exec(attrs)?.[1],
  }));
}

test('a coluna lista as câmeras de todos — local, remotos e quem compartilha', () => {
  const html = renderRail({
    items: [
      camera('local', { label: 'Ana (você)', local: true }),
      camera('peer-a', { label: 'Bruno', sharing: true }),
      camera('peer-b', { label: 'Carla' }),
    ],
    spotlightId: 'peer-a-screen',
  });

  assert.deepEqual(labels(html).sort(), ['Ana (você)', 'Bruno', 'Carla']);
});

test('a coluna mostra as telas compartilhadas que não estão em destaque', () => {
  const html = renderRail({
    items: [
      camera('local', { label: 'Ana (você)', local: true }),
      camera('peer-a', { label: 'Bruno', sharing: true }),
      screenOf('peer-a-screen', 'Bruno'),
    ],
    spotlightId: 'local-screen',
  });

  assert.ok(labels(html).includes('Bruno — tela'), 'a tela não destacada precisa estar na coluna');
  // E vem antes das câmeras: é o que o usuário pode querer trocar para o destaque.
  assert.equal(labels(html)[0], 'Bruno — tela');
});

test('miniatura de tela é um <button> de verdade: focável, com type e rótulo do dono', () => {
  const html = renderRail({
    items: [camera('local', { label: 'Ana (você)', local: true }), screenOf('peer-a-screen', 'Bruno')],
    spotlightId: 'local-screen',
  });

  const buttons = selectButtons(html);
  assert.equal(buttons.length, 1, 'só a tela é selecionável');
  // `<button>` traz Enter/Espaço e a ordem de tabulação do próprio navegador —
  // é justamente por isso que não é um `<div onClick>`.
  assert.equal(buttons[0].type, 'button');
  assert.match(buttons[0].label, /Bruno/);
  assert.ok(!/tabindex="-1"/.test(buttons[0].attrs), 'a miniatura de tela saiu da tabulação');
});

test('aria-pressed marca a tela em destaque e só ela', () => {
  const items = [
    camera('local', { label: 'Ana (você)', local: true }),
    // Com duas telas ativas, a em destaque continua na lista como marcador sem
    // stream — é o que dá a quem usa leitor de tela a informação "é esta que
    // você está vendo".
    { ...screenOf('local-screen', 'Ana (você)'), stream: null, spotlighted: true, badge: 'Em destaque' },
    screenOf('peer-a-screen', 'Bruno'),
  ];

  const pressedStates = (spotlightId) =>
    selectButtons(renderRail({ items, spotlightId })).map((b) => b.pressed);

  assert.deepEqual(pressedStates('local-screen'), ['true', 'false']);
  // Trocar o destaque move o `aria-pressed`, sem mudar o conjunto de botões:
  // o foco continua onde estava em vez de sumir com a miniatura.
  assert.deepEqual(pressedStates('peer-a-screen'), ['false', 'true']);
  assert.equal(
    selectButtons(renderRail({ items, spotlightId: 'peer-a-screen' })).length,
    selectButtons(renderRail({ items, spotlightId: 'local-screen' })).length,
  );
});

test('miniatura de câmera não é clicável nem entra na ordem de tabulação', () => {
  const html = renderRail({
    items: [camera('local', { label: 'Ana (você)', local: true }), camera('peer-a', { label: 'Bruno' })],
    spotlightId: 'peer-a-screen',
  });

  assert.equal(selectButtons(html).length, 0, 'fixar câmera está fora do escopo');
  assert.ok(!/tabindex/.test(html), 'nenhum tabindex artesanal na coluna');
  assert.ok(!/aria-pressed/.test(html));
});

test('a coluna renderizada respeita a prioridade de quem está falando', () => {
  const html = renderRail({
    items: [
      camera('local', { label: 'Ana (você)', local: true }),
      camera('peer-a', { label: 'Bruno' }),
      camera('peer-b', { label: 'Carla' }),
    ],
    audioLevels: { 'peer-b': { speaking: true, level: 0.8 } },
    spotlightId: 'local-screen',
  });

  assert.equal(labels(html)[0], 'Carla');
  // E o anel de fala continua sendo alimentado pelo mesmo mapa de níveis.
  assert.match(html, /class="video-tile speaking compact"/);
  assert.match(html, /--speak-level:0\.80/);
});

test('a coluna aplica a classe de rolagem quando o módulo puro diz que a pilha não cabe', () => {
  const items = [camera('local', { label: 'Ana (você)', local: true })];
  assert.match(renderRail({ items, spotlightId: 'x', scrolls: true }), /class="thumb-rail scrolling"/);
  assert.match(renderRail({ items, spotlightId: 'x', scrolls: false }), /class="thumb-rail"/);
});

test('no painel do modo estreito é a mesma lista, só muda o container', () => {
  const items = [camera('local', { label: 'Ana (você)', local: true }), screenOf('peer-a-screen', 'Bruno')];
  const rail = renderRail({ items, spotlightId: 'local-screen' });
  const panel = renderRail({ items, spotlightId: 'local-screen', className: 'thumb-rail in-panel' });

  assert.match(panel, /class="thumb-rail in-panel"/);
  assert.deepEqual(labels(panel), labels(rail));
  assert.equal(selectButtons(panel).length, selectButtons(rail).length);
});

test('o palco em destaque monta o tile de destaque e a coluna no mesmo container', () => {
  const html = renderToStaticMarkup(
    createElement(SpotlightStage, {
      spotlight: { key: 'peer-a-screen', screenId: 'peer-a-screen', label: 'Bruno — tela', badge: 'Tela', contain: true },
      thumbnails: [camera('local', { label: 'Ana (você)', local: true }), camera('peer-a', { label: 'Bruno' })],
      audioLevels: {},
      onSelectScreen: () => {},
    }),
  );

  assert.match(html, /class="video-stage spotlight-stage"/);
  assert.match(html, /class="spotlight-main"/);
  assert.match(html, /class="thumb-rail/);
  assert.ok(labels(html).includes('Bruno — tela'), 'o destaque precisa aparecer');
  assert.ok(labels(html).includes('Ana (você)'), 'a câmera local precisa estar na coluna');

  // Primeiro render, antes de o ResizeObserver medir: os tiles ficam montados
  // (o `<video>` já existe) mas o palco não é pintado com um tamanho errado.
  assert.match(html, /spotlight-layout spotlight unmeasured/);
  assert.match(html, /--spot-w:0px/);
});

test('sem miniaturas o palco não renderiza coluna nenhuma', () => {
  const html = renderToStaticMarkup(
    createElement(SpotlightStage, {
      spotlight: { key: 'local-screen', screenId: 'local-screen', label: 'Ana — sua tela', contain: true },
      thumbnails: [],
      audioLevels: {},
      onSelectScreen: () => {},
    }),
  );

  assert.ok(!/thumb-rail/.test(html), 'coluna vazia não pode reservar faixa');
  assert.ok(!/participants-toggle/.test(html), 'sem lista, não há painel a abrir');
});

test('todo <video> do palco em destaque é muted — o som sai pelo sink dedicado', () => {
  // Regressão que este layout poderia introduzir: mover o tile entre containers
  // remonta o `<video>`, e se fosse ele a tocar o áudio, o som do peer cortaria
  // a cada início de compartilhamento e a cada troca de destaque.
  const html = renderToStaticMarkup(
    createElement(SpotlightStage, {
      spotlight: { key: 'peer-a-screen', screenId: 'peer-a-screen', label: 'Bruno — tela', contain: true },
      thumbnails: [camera('local', { label: 'Ana (você)', local: true }), camera('peer-a', { label: 'Bruno' })],
      audioLevels: {},
      onSelectScreen: () => {},
    }),
  );

  const videos = [...html.matchAll(/<video([^>]*)>/g)].map(([, attrs]) => attrs);
  assert.ok(videos.length >= 3, `esperava destaque + 2 miniaturas, veio ${videos.length}`);
  for (const attrs of videos) {
    assert.match(attrs, /muted/, `<video ${attrs}> deixaria o áudio preso ao layout`);
  }
});
