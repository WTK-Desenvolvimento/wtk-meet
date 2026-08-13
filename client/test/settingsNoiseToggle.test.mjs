/**
 * Testes de QA do toggle de supressão de ruído no modal de Configurações.
 *
 * Duas técnicas, por duas razões diferentes:
 *
 * 1. **Marcação estática** (`react-dom/server`), como nos demais testes de
 *    componente do projeto, para o que é estrutura: o checkbox existe, reflete a
 *    preferência, aparece nas três aberturas e fica desabilitado com explicação
 *    onde o navegador não sabe suprimir.
 * 2. **Render raso com dispatcher próprio**, para o que é comportamento: marcar
 *    o checkbox e apertar "Salvar" precisa emitir `noiseSuppression` no
 *    `onSave`. Não há DOM neste ambiente (o projeto testa com `node --test`
 *    puro, sem jsdom, e o Chromium do E2E não sobe aqui), então o clique não
 *    existe — mas os handlers existem, e invocá-los prova a mesma coisa que o
 *    clique provaria. O harness abaixo tem ~40 linhas, suporta só os hooks que
 *    este componente usa e falha alto se algum outro aparecer.
 *
 * O que fica de fora e é do E2E: o efeito de preview (que depende de
 * `navigator.mediaDevices`) e o foco. `useEffect` não roda aqui, de propósito.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./jsxLoader.mjs', import.meta.url);

const React = await import('react');
const { createElement } = React;
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: SettingsModal } = await import('../src/components/SettingsModal.jsx');
const { MODE } = await import('../src/lib/noiseSuppression.js');

const internals = React.default.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

/**
 * Renderiza um componente de função e mantém o resultado atualizado a cada
 * `setState`, sem DOM e sem renderer.
 *
 * `useEffect` e `useLayoutEffect` apenas consomem a posição do hook: sem DOM não
 * há o que eles façam, e rodá-los aqui chamaria `navigator.mediaDevices`.
 */
function shallowRender(Component, props) {
  const hooks = [];
  let cursor = 0;
  let tree = null;

  const dispatcher = {
    useState(initial) {
      const slot = cursor;
      cursor += 1;
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
      const setState = (value) => {
        hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value;
        render();
      };
      return [hooks[slot], setState];
    },
    useRef(initial) {
      const slot = cursor;
      cursor += 1;
      if (!(slot in hooks)) hooks[slot] = { current: initial };
      return hooks[slot];
    },
    useMemo(factory) {
      const slot = cursor;
      cursor += 1;
      if (!(slot in hooks)) hooks[slot] = factory();
      return hooks[slot];
    },
    useCallback(fn) {
      cursor += 1;
      return fn;
    },
    useEffect() {
      cursor += 1;
    },
    useLayoutEffect() {
      cursor += 1;
    },
    useContext: () => undefined,
    useDebugValue: () => {},
    useId: () => 'test-id',
  };

  function render() {
    cursor = 0;
    const previous = internals.ReactCurrentDispatcher.current;
    internals.ReactCurrentDispatcher.current = dispatcher;
    try {
      tree = Component(props);
    } finally {
      internals.ReactCurrentDispatcher.current = previous;
    }
  }

  render();
  return {
    get tree() {
      return tree;
    },
  };
}

/** Todos os elementos da árvore que satisfazem o predicado, em ordem. */
function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (!node || typeof node !== 'object' || !node.props) return found;
  if (predicate(node)) found.push(node);
  findAll(node.props.children, predicate, found);
  return found;
}

const isTag = (tag) => (node) => node.type === tag;

/** O `<label>` cujo texto visível é `text`. */
function labelled(tree, text) {
  return findAll(tree, (node) => {
    if (node.type !== 'label') return false;
    return findAll(node, (child) => child.type === 'span' && child.props.children === text).length > 0;
  })[0];
}

const checkboxIn = (label) => findAll(label, isTag('input'))[0];

const renderModal = (props) =>
  renderToStaticMarkup(
    createElement(SettingsModal, { onSave: () => {}, onClose: () => {}, ...props }),
  );

// ------------------------------------------------------------- estrutura

test('o checkbox reflete a preferência ligada e a desligada', () => {
  const ligado = renderModal({ noiseSuppression: true, noiseMode: MODE.NATIVE });
  const desligado = renderModal({ noiseSuppression: false, noiseMode: MODE.NATIVE });

  const supressao = /<input type="checkbox"([^>]*)\/><span>Supressão de ruído<\/span>/;
  assert.match(ligado.match(supressao)[1], /checked/);
  assert.doesNotMatch(desligado.match(supressao)[1], /checked/);
});

test('o toggle aparece nas três aberturas: Home, tela de espera e barra da sala', () => {
  // Home: sem AudioContext e sem preview de vídeo obrigatório; sala: com os dois.
  const aberturas = [
    { audioContext: null, videoPreview: true },
    { audioContext: null, videoPreview: false },
    { audioContext: {}, videoPreview: true },
  ];
  for (const abertura of aberturas) {
    const html = renderModal({ ...abertura, noiseSuppression: true, noiseMode: MODE.NATIVE });
    assert.match(html, /<span>Supressão de ruído<\/span>/, JSON.stringify(abertura));
  }
});

test('sem suporte nenhum o toggle fica desabilitado com explicação, nunca escondido', () => {
  // Mesmo princípio do seletor de saída sem setSinkId: sumir com o controle faz
  // quem viu o recurso em outro navegador procurar o que não existe.
  const html = renderModal({ noiseSuppression: true, noiseMode: MODE.UNSUPPORTED });

  const input = html.match(/<input type="checkbox"([^>]*)\/><span>Supressão de ruído<\/span>/)[1];
  assert.match(input, /disabled/);
  assert.match(html, /<span>Supressão de ruído<\/span>/);
  assert.match(html, /não oferece supressão de ruído nem AudioWorklet/);
});

test('o hint diz qual motor está ativo, e avisa que o medidor mostra o sinal cru no fallback', () => {
  const nativo = renderModal({ noiseSuppression: true, noiseMode: MODE.NATIVE });
  assert.match(nativo, /supressão nativa do navegador/i);

  // Sem esta frase, quem está no fallback marca o toggle, não vê o medidor
  // mudar e conclui que o recurso não funciona.
  const worklet = renderModal({ noiseSuppression: true, noiseMode: MODE.WORKLET });
  assert.match(worklet, /processa o áudio na sua máquina/);
  assert.match(worklet, /sinal sem processamento/);
});

// --------------------------------------------------------- comportamento

test('marcar o checkbox e salvar emite noiseSuppression no onSave', () => {
  const saved = [];
  const rendered = shallowRender(SettingsModal, {
    preferences: { videoInputId: 'cam-1', audioInputId: 'mic-1', audioOutputId: '', soundsEnabled: true },
    noiseSuppression: true,
    noiseMode: MODE.WORKLET,
    onSave: (selection) => saved.push(selection),
    onClose: () => {},
  });

  const toggle = checkboxIn(labelled(rendered.tree, 'Supressão de ruído'));
  toggle.props.onChange({ target: { checked: false } });

  const salvar = findAll(rendered.tree, (node) => node.type === 'button' && node.props.children === 'Salvar')[0];
  salvar.props.onClick();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].noiseSuppression, false);
  // A seleção de hardware continua inteira no mesmo payload: quem separa as
  // duas chaves de storage é o pai.
  assert.equal(saved[0].videoInputId, 'cam-1');
  assert.equal(saved[0].audioInputId, 'mic-1');
  assert.equal(saved[0].soundsEnabled, true);
});

test('salvar sem mexer em nada devolve a preferência que entrou', () => {
  const saved = [];
  const rendered = shallowRender(SettingsModal, {
    noiseSuppression: false,
    noiseMode: MODE.NATIVE,
    onSave: (selection) => saved.push(selection),
    onClose: () => {},
  });

  findAll(rendered.tree, (node) => node.type === 'button' && node.props.children === 'Salvar')[0]
    .props.onClick();

  assert.equal(saved[0].noiseSuppression, false);
});

test('o toggle de avisos sonoros continua independente do de supressão', () => {
  const saved = [];
  const rendered = shallowRender(SettingsModal, {
    noiseSuppression: true,
    noiseMode: MODE.NATIVE,
    onSave: (selection) => saved.push(selection),
    onClose: () => {},
  });

  checkboxIn(labelled(rendered.tree, 'Avisos sonoros de entrada e saída')).props.onChange({
    target: { checked: false },
  });
  findAll(rendered.tree, (node) => node.type === 'button' && node.props.children === 'Salvar')[0]
    .props.onClick();

  assert.equal(saved[0].soundsEnabled, false);
  assert.equal(saved[0].noiseSuppression, true);
});
