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
import test from 'node:test';


const React = await import('react');
const { createElement } = React;
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: SettingsModal } = await import('../src/components/SettingsModal.js');
const { MODE } = await import('../src/lib/noiseSuppression.js');

import type { PendingPreferences } from '../src/components/SettingsModal.js';

/**
 * O dispatcher de hooks do React não tem tipo público — é por isso que o campo
 * se chama assim. O cast é a fronteira: daqui para baixo quem manda é o
 * dispatcher deste arquivo.
 */
const internals = (
  React.default as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
      H: unknown;
    };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/** Um elemento da árvore, do ponto de vista de quem só a percorre. */
interface NoDaArvore {
  type: unknown;
  props: { children?: unknown; [campo: string]: unknown };
}

/**
 * Renderiza um componente de função e mantém o resultado atualizado a cada
 * `setState`, sem DOM e sem renderer.
 *
 * `useEffect` e `useLayoutEffect` apenas consomem a posição do hook: sem DOM não
 * há o que eles façam, e rodá-los aqui chamaria `navigator.mediaDevices`.
 */
function shallowRender<P>(Component: (props: P) => unknown, props: P) {
  const hooks: unknown[] = [];
  let cursor = 0;
  let tree: unknown = null;

  const dispatcher = {
    useState(initial: unknown) {
      const slot = cursor;
      cursor += 1;
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
      const setState = (value: unknown) => {
        hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value;
        render();
      };
      return [hooks[slot], setState];
    },
    useRef(initial: unknown) {
      const slot = cursor;
      cursor += 1;
      if (!(slot in hooks)) hooks[slot] = { current: initial };
      return hooks[slot];
    },
    useMemo(factory: () => unknown) {
      const slot = cursor;
      cursor += 1;
      if (!(slot in hooks)) hooks[slot] = factory();
      return hooks[slot];
    },
    useCallback(fn: unknown) {
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
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      tree = Component(props);
    } finally {
      internals.H = previous;
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
function findAll(
  node: unknown,
  predicate: (node: NoDaArvore) => boolean,
  found: NoDaArvore[] = [],
): NoDaArvore[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (!node || typeof node !== 'object' || !('props' in node) || !node.props) return found;
  const elemento = node as NoDaArvore;
  if (predicate(elemento)) found.push(elemento);
  findAll(elemento.props.children, predicate, found);
  return found;
}

const isTag = (tag: string) => (node: NoDaArvore) => node.type === tag;

/** O `<label>` cujo texto visível é `text`. */
function labelled(tree: unknown, text: string) {
  return findAll(tree, (node) => {
    if (node.type !== 'label') return false;
    return findAll(node, (child) => child.type === 'span' && child.props.children === text).length > 0;
  })[0];
}

const checkboxIn = (label: unknown) => findAll(label, isTag('input'))[0]!;

/**
 * Um handler da árvore renderizada. Os `props` são `unknown` porque a árvore é
 * percorrida sem tipo de componente; o cast diz o que aquele nó é.
 */
const handler = <A extends unknown[]>(no: NoDaArvore, nome: string) =>
  no.props[nome] as (...args: A) => void;

const renderModal = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(SettingsModal, { onSave: () => {}, onClose: () => {}, ...props }),
  );

// ------------------------------------------------------------- estrutura

test('o checkbox reflete a preferência ligada e a desligada', () => {
  const ligado = renderModal({ noiseSuppression: true, noiseMode: MODE.NATIVE });
  const desligado = renderModal({ noiseSuppression: false, noiseMode: MODE.NATIVE });

  const supressao = /<input type="checkbox"([^>]*)\/><span>Supressão de ruído<\/span>/;
  assert.match(ligado.match(supressao)![1]!, /checked/);
  assert.doesNotMatch(desligado.match(supressao)![1]!, /checked/);
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

  const input = html.match(/<input type="checkbox"([^>]*)\/><span>Supressão de ruído<\/span>/)![1]!;
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
  const saved: Record<string, unknown>[] = [];
  const rendered = shallowRender(SettingsModal, {
    preferences: { videoInputId: 'cam-1', audioInputId: 'mic-1', audioOutputId: '', soundsEnabled: true },
    noiseSuppression: true,
    noiseMode: MODE.WORKLET,
    onSave: (selection: PendingPreferences) => saved.push(selection as unknown as Record<string, unknown>),
    onClose: () => {},
  });

  const toggle = checkboxIn(labelled(rendered.tree, 'Supressão de ruído'));
  handler(toggle, 'onChange')({ target: { checked: false } });

  const salvar = findAll(rendered.tree, (node) => node.type === 'button' && node.props.children === 'Salvar')[0];
  handler(salvar, 'onClick')();

  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.noiseSuppression, false);
  // A seleção de hardware continua inteira no mesmo payload: quem separa as
  // duas chaves de storage é o pai.
  assert.equal(saved[0]!.videoInputId, 'cam-1');
  assert.equal(saved[0]!.audioInputId, 'mic-1');
  assert.equal(saved[0]!.soundsEnabled, true);
});

test('salvar sem mexer em nada devolve a preferência que entrou', () => {
  const saved: Record<string, unknown>[] = [];
  const rendered = shallowRender(SettingsModal, {
    noiseSuppression: false,
    noiseMode: MODE.NATIVE,
    onSave: (selection: PendingPreferences) => saved.push(selection as unknown as Record<string, unknown>),
    onClose: () => {},
  });

  handler(
    findAll(rendered.tree, (node) => node.type === 'button' && node.props.children === 'Salvar')[0]!,
    'onClick',
  )();

  assert.equal(saved[0]!.noiseSuppression, false);
});

test('o toggle de avisos sonoros continua independente do de supressão', () => {
  const saved: Record<string, unknown>[] = [];
  const rendered = shallowRender(SettingsModal, {
    noiseSuppression: true,
    noiseMode: MODE.NATIVE,
    onSave: (selection: PendingPreferences) => saved.push(selection as unknown as Record<string, unknown>),
    onClose: () => {},
  });

  handler(checkboxIn(labelled(rendered.tree, 'Avisos sonoros de entrada e saída')), 'onChange')({
    target: { checked: false },
  });
  handler(
    findAll(rendered.tree, (node) => node.type === 'button' && node.props.children === 'Salvar')[0]!,
    'onClick',
  )();

  assert.equal(saved[0]!.soundsEnabled, false);
  assert.equal(saved[0]!.noiseSuppression, true);
});
