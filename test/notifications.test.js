import test from 'node:test';
import assert from 'node:assert/strict';

import { installEnv } from './helpers/fake-env.js';

/** Itens 16, 17 e 18 do DoD: modal de entrada, toast de saida e som opcional. */

const env = installEnv();
const { createNotifier } = await import('../src/notifications.js');

function montar() {
  const toastContainer = env.el('div');
  const modalRoot = env.el('div');
  modalRoot.hidden = true; // como no index.html
  const modalTitle = env.el('h2');
  const modalBody = env.el('p');
  const modalOk = env.el('button');
  const notifier = createNotifier({ toastContainer, modalRoot, modalTitle, modalBody, modalOk });
  return { notifier, toastContainer, modalRoot, modalTitle, modalBody, modalOk };
}

test.beforeEach(() => {
  env.localStorage.clear();
  env.audioContexts.length = 0;
});

test('entrada abre um modal com acao explicita e o foco vai para o botao', () => {
  const { notifier, modalRoot, modalTitle, modalBody, modalOk } = montar();

  notifier.showModal('Alguém entrou', 'Ana entrou na chamada');

  assert.equal(modalRoot.hidden, false);
  assert.equal(modalTitle.textContent, 'Alguém entrou');
  assert.equal(modalBody.textContent, 'Ana entrou na chamada');
  assert.equal(env.document.activeElement, modalOk, 'o botao precisa receber o foco');
});

test('o modal so fecha com o clique — nao some sozinho', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { notifier, modalRoot, modalOk } = montar();
  notifier.showModal('Alguém entrou', 'Ana entrou na chamada');

  t.mock.timers.tick(60_000);
  assert.equal(modalRoot.hidden, false, 'nenhum timer pode fechar o modal');

  modalOk.fire('click');
  assert.equal(modalRoot.hidden, true);
});

test('modais em rajada aparecem um de cada vez, cada um exigindo acao', () => {
  const { notifier, modalRoot, modalBody, modalOk } = montar();

  notifier.showModal('Alguém entrou', 'Ana entrou na chamada');
  notifier.showModal('Alguém entrou', 'Bruno entrou na chamada');

  assert.equal(modalBody.textContent, 'Ana entrou na chamada');

  modalOk.fire('click');
  assert.equal(modalRoot.hidden, false, 'ainda ha um aviso na fila');
  assert.equal(modalBody.textContent, 'Bruno entrou na chamada');

  modalOk.fire('click');
  assert.equal(modalRoot.hidden, true);
});

test('Escape tambem fecha o modal', () => {
  const { notifier, modalRoot } = montar();
  notifier.showModal('Alguém entrou', 'Ana entrou');

  modalRoot.fire('keydown', { key: 'Escape' });

  assert.equal(modalRoot.hidden, true);
});

test('o texto do modal entra como texto, nunca como marcacao', () => {
  const { notifier, modalBody } = montar();
  notifier.showModal('Alguém entrou', '<img src=x onerror=alert(1)> entrou na chamada');

  assert.equal(modalBody.children.length, 0);
  assert.match(modalBody.textContent, /^<img src=x onerror=alert\(1\)>/);
});

test('saida gera toast discreto com o texto certo', () => {
  const { notifier, toastContainer } = montar();
  notifier.toast('Ana saiu da chamada');

  assert.equal(toastContainer.children.length, 1);
  assert.equal(toastContainer.children[0].textContent, 'Ana saiu da chamada');
  assert.equal(toastContainer.children[0].classList.contains('warn'), false);
});

test('toast de aviso ganha a variante warn', () => {
  const { notifier, toastContainer } = montar();
  notifier.toast('Permissão de câmera negada.', 'warn');
  assert.equal(toastContainer.children[0].classList.contains('warn'), true);
});

test('rajada de toasts empilha ate o limite e nao cobre a chamada', () => {
  const { notifier, toastContainer } = montar();
  for (let i = 1; i <= 8; i += 1) notifier.toast(`aviso ${i}`);

  assert.equal(toastContainer.children.length, 4, 'no maximo 4 na tela');
  assert.deepEqual(
    toastContainer.children.map((el) => el.textContent),
    ['aviso 5', 'aviso 6', 'aviso 7', 'aviso 8'],
    'os mais recentes e que interessam',
  );
});

test('o toast some sozinho depois do tempo', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { notifier, toastContainer } = montar();
  notifier.toast('Ana saiu da chamada');
  assert.equal(toastContainer.children.length, 1);

  t.mock.timers.tick(4200);

  assert.equal(toastContainer.children.length, 0);
});

test('o texto do toast entra como texto, nunca como marcacao', () => {
  const { notifier, toastContainer } = montar();
  notifier.toast('<b>Ana</b> saiu');
  assert.equal(toastContainer.children[0].children.length, 0);
  assert.equal(toastContainer.children[0].textContent, '<b>Ana</b> saiu');
});

test('por padrao os sons de entrada e saida tocam', () => {
  const { notifier } = montar();
  assert.equal(notifier.enabled, true);

  notifier.playSound('join');
  notifier.playSound('leave');

  const ctx = env.audioContexts[env.audioContexts.length - 1];
  assert.equal(ctx.oscillators.length, 2);
  assert.ok(ctx.oscillators.every((o) => o.started && o.stopped));
});

test('silenciar impede o som — o aviso visual continua', () => {
  const { notifier, toastContainer } = montar();
  notifier.playSound('join');
  const ctx = env.audioContexts[env.audioContexts.length - 1];
  const antes = ctx.oscillators.length;

  notifier.setEnabled(false);
  notifier.playSound('join');
  notifier.playSound('leave');
  notifier.toast('Ana saiu da chamada');

  assert.equal(notifier.enabled, false);
  assert.equal(ctx.oscillators.length, antes, 'nenhum som novo');
  assert.equal(toastContainer.children.length, 1, 'o toast continua aparecendo');
});

test('a preferencia de silenciar sobrevive a um novo carregamento', () => {
  const primeiro = montar().notifier;
  primeiro.setEnabled(false);
  assert.equal(env.localStorage.getItem('wtk-meet:sons'), 'off');

  const segundo = montar().notifier;
  assert.equal(segundo.enabled, false, 'a sala nao pode voltar a apitar sozinha');

  segundo.setEnabled(true);
  assert.equal(montar().notifier.enabled, true);
});

test('som so toca quando o app pede — nada e disparado sozinho', () => {
  montar();
  assert.equal(env.audioContexts.length, 0, 'criar o notifier nao pode abrir audio');
});

test('unlock prepara o audio no gesto do usuario', () => {
  const { notifier } = montar();
  notifier.unlock();
  assert.equal(env.audioContexts.length, 1);
  assert.equal(env.audioContexts[0].state, 'running');
});
