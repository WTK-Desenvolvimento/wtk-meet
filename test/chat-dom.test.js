import test from 'node:test';
import assert from 'node:assert/strict';

import { installEnv } from './helpers/fake-env.js';

/**
 * Itens 9 a 12 do DoD, no nivel do DOM.
 *
 * `test/text.test.js` ja prova a matematica do texto (limite, escape, links).
 * O que falta provar e a PONTE: que o chat de fato monta os nos com
 * createTextNode/textContent e nunca com innerHTML. Um teste de string passaria
 * mesmo se o renderer fizesse `log.innerHTML += ...` — este nao.
 */

const env = installEnv();
const { createChat } = await import('../src/chat.js');
const { MAX_MESSAGE_LENGTH } = await import('../src/lib/text.js');

function montar() {
  const nodes = {
    panel: env.el('aside'),
    log: env.el('ul'),
    form: env.el('form'),
    input: env.el('textarea'),
    counter: env.el('span'),
    badge: env.el('span'),
    toggleButton: env.el('button'),
    closeButton: env.el('button'),
  };
  const enviadas = [];
  const chat = createChat({ ...nodes, onSend: (text) => enviadas.push(text) });
  return { chat, enviadas, ...nodes };
}

const msg = (text, name = 'Ana', id = 'p1') => ({ from: { id, name }, text });

/** O <div class="msg-text"> da ultima mensagem do log. */
function corpo(log) {
  const item = log.children[log.children.length - 1];
  return item.descendants().find((el) => el.classList.contains('msg-text'));
}

test('a mensagem mostra o nome de quem enviou e o horario', () => {
  const { chat, log } = montar();
  chat.append(msg('bom dia'));

  const item = log.children[0];
  const meta = item.descendants().find((el) => el.classList.contains('msg-meta'));
  assert.match(meta.textContent, /^Ana · \d{2}:\d{2}$/);
  assert.equal(corpo(log).textContent, 'bom dia');
});

test('a propria mensagem e marcada como minha', () => {
  const { chat, log } = montar();
  chat.append(msg('oi', 'Eu', 'meu-id'), { mine: true });
  assert.ok(log.children[0].classList.contains('mine'));
});

test('HTML na mensagem vira texto puro — nenhum elemento e criado', () => {
  const { chat, log } = montar();
  const ataque = '<img src=x onerror="alert(1)"><script>roubar()</script>';

  chat.append(msg(ataque));

  const body = corpo(log);
  assert.equal(body.children.length, 0, 'nenhum no de ELEMENTO pode nascer do texto do usuario');
  assert.equal(body.textContent, ataque, 'o texto aparece literal, como o usuario digitou');
  assert.equal(
    log.descendants().filter((el) => ['IMG', 'SCRIPT'].includes(el.tagName)).length,
    0,
  );
});

test('nome com HTML tambem e tratado como texto', () => {
  const { chat, log } = montar();
  chat.append(msg('oi', '<b>Ana</b>'));

  const meta = log.children[0].descendants().find((el) => el.classList.contains('msg-meta'));
  assert.equal(meta.children.length, 0);
  assert.match(meta.textContent, /^<b>Ana<\/b> · /);
});

test('link http vira <a> seguro; javascript: continua texto', () => {
  const { chat, log } = montar();
  chat.append(msg('veja https://exemplo.com/doc e nao clique em javascript:alert(1)'));

  const links = corpo(log).children.filter((el) => el.tagName === 'A');
  assert.equal(links.length, 1, 'apenas o http(s) pode virar link');
  assert.equal(links[0].href, 'https://exemplo.com/doc');
  assert.equal(links[0].rel, 'noopener noreferrer nofollow');
  assert.equal(links[0].target, '_blank');
  assert.match(corpo(log).textContent, /javascript:alert\(1\)/);
});

test('o badge conta as nao lidas com o painel fechado e zera ao abrir', () => {
  const { chat, badge, toggleButton } = montar();
  assert.equal(badge.hidden, true, 'sem mensagens, sem badge');

  chat.append(msg('uma'));
  chat.append(msg('duas'));
  chat.append(msg('tres'));

  assert.equal(chat.unread, 3);
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, '3');
  assert.match(badge.getAttribute('aria-label'), /3 mensagens/);

  toggleButton.fire('click');

  assert.equal(chat.isOpen(), true);
  assert.equal(chat.unread, 0);
  assert.equal(badge.hidden, true, 'abrir o painel precisa zerar o badge');
});

test('com o painel aberto as mensagens ja chegam lidas', () => {
  const { chat, badge } = montar();
  chat.setOpen(true);

  chat.append(msg('oi'));

  assert.equal(chat.unread, 0);
  assert.equal(badge.hidden, true);
});

test('mensagens de sistema nao contam como nao lidas', () => {
  const { chat, badge } = montar();
  chat.system('Fulano entrou');
  assert.equal(chat.unread, 0);
  assert.equal(badge.hidden, true);
});

test('o badge satura em 99+', () => {
  const { chat, badge } = montar();
  for (let i = 0; i < 120; i += 1) chat.append(msg(`m${i}`));
  assert.equal(badge.textContent, '99+');
});

test('fechar o painel volta a acumular nao lidas', () => {
  const { chat, closeButton, badge } = montar();
  chat.setOpen(true);
  closeButton.fire('click');
  assert.equal(chat.isOpen(), false);

  chat.append(msg('perdi essa'));
  assert.equal(badge.textContent, '1');
});

test('o historico e efemero: destroy apaga tudo, sem sobra em lugar nenhum', () => {
  const { chat, log, badge } = montar();
  chat.append(msg('segredo 1'));
  chat.append(msg('segredo 2'));
  assert.equal(log.children.length, 2);

  chat.destroy();

  assert.equal(log.children.length, 0, 'o log precisa ficar vazio');
  assert.equal(chat.unread, 0);
  assert.equal(badge.hidden, true);
  assert.equal(chat.isOpen(), false);
  // E o unico armazenamento do app e a preferencia de som — nada de mensagem.
  assert.equal(env.localStorage.getItem('wtk-meet:chat'), null);
});

test('enviar limpa o campo e entrega o texto normalizado', () => {
  const { form, input, enviadas, counter } = montar();
  input.value = '  ola pessoal  ';

  form.fire('submit');

  assert.deepEqual(enviadas, ['ola pessoal']);
  assert.equal(input.value, '');
  assert.equal(counter.textContent, `0/${MAX_MESSAGE_LENGTH}`);
});

test('mensagem vazia nao e enviada', () => {
  const { form, input, enviadas } = montar();
  input.value = '   \n  ';
  form.fire('submit');
  assert.equal(enviadas.length, 0);
});

test('mensagem acima do limite nao sai e o usuario e avisado', () => {
  const { form, input, enviadas, log } = montar();
  input.value = 'x'.repeat(MAX_MESSAGE_LENGTH + 1);

  form.fire('submit');

  assert.equal(enviadas.length, 0, 'o limite tem que valer antes de ir para a rede');
  const aviso = log.children[log.children.length - 1];
  assert.ok(aviso.classList.contains('system'));
  assert.match(aviso.textContent, new RegExp(`${MAX_MESSAGE_LENGTH} caracteres`));
});

test('exatamente no limite a mensagem passa', () => {
  const { form, input, enviadas } = montar();
  input.value = 'x'.repeat(MAX_MESSAGE_LENGTH);
  form.fire('submit');
  assert.equal(enviadas.length, 1);
});

test('Enter envia, Shift+Enter quebra linha', () => {
  const { input, enviadas } = montar();
  input.value = 'primeira';

  const barrado = input.fire('keydown', { key: 'Enter', shiftKey: false });
  assert.deepEqual(enviadas, ['primeira']);
  assert.equal(barrado, true, 'o Enter precisa ser barrado para nao quebrar linha');

  input.value = 'segunda';
  const livre = input.fire('keydown', { key: 'Enter', shiftKey: true });
  assert.equal(enviadas.length, 1, 'Shift+Enter nao envia');
  assert.equal(livre, false);
});

test('o contador acompanha o que esta sendo digitado e avisa no limite', () => {
  const { input, counter } = montar();
  input.value = 'abc';
  input.fire('input');
  assert.equal(counter.textContent, `3/${MAX_MESSAGE_LENGTH}`);
  assert.equal(counter.classList.contains('over'), false);

  input.value = 'x'.repeat(MAX_MESSAGE_LENGTH);
  input.fire('input');
  assert.equal(counter.classList.contains('over'), true);
});

test('quebras de linha da mensagem sobrevivem como texto', () => {
  const { chat, log } = montar();
  chat.append(msg('linha 1\nlinha 2'));
  assert.equal(corpo(log).textContent, 'linha 1\nlinha 2');
});
