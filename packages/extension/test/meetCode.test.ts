/**
 * A URL da aba ativa → o endereço da sala.
 *
 * O que estes casos protegem: um padrão frouxo casaria com `/lookup/<apelido>`,
 * `/new` e com qualquer rota futura da Google, e cada falso positivo vira uma
 * sala com nome de rota — criada por engano, e que ninguém consegue adivinhar de
 * volta. Do outro lado, ser estrito demais com `?authuser=` ou com caixa alta
 * faria a mesma reunião virar duas salas diferentes conforme quem abriu o popup.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MEET_REFUSALS, meetCodeFromUrl, prefillFromTab } from '../src/lib/meetCode.ts';

test('uma reunião do Meet vira o código normalizado, sem prefixo', () => {
  const result = meetCodeFromUrl('https://meet.google.com/abc-defg-hij');
  assert.deepEqual(result, { ok: true, code: 'abc-defg-hij', roomPath: 'abc-defg-hij' });
});

test('`?authuser=1` e outras queries não entram no endereço', () => {
  // A conta de quem abriu não pode mudar a sala: duas pessoas na mesma reunião,
  // com contas diferentes, precisam cair no mesmo lugar.
  const comAuthuser = meetCodeFromUrl('https://meet.google.com/abc-defg-hij?authuser=1');
  const semNada = meetCodeFromUrl('https://meet.google.com/abc-defg-hij');
  assert.deepEqual(comAuthuser, semNada);
});

test('o fragmento é ignorado — e nunca vira chave de coisa nenhuma', () => {
  const result = meetCodeFromUrl('https://meet.google.com/abc-defg-hij#pin=1234');
  assert.equal(result.ok && result.roomPath, 'abc-defg-hij');
});

test('caixa alta é normalizada: a mesma reunião não pode dar duas salas', () => {
  const result = meetCodeFromUrl('https://meet.google.com/ABC-DEFG-HIJ');
  assert.equal(result.ok && result.roomPath, 'abc-defg-hij');
});

test('barras repetidas de um link colado duas vezes não quebram a leitura', () => {
  const result = meetCodeFromUrl('https://meet.google.com//abc-defg-hij/');
  assert.equal(result.ok && result.roomPath, 'abc-defg-hij');
});

test('`/lookup/<apelido>` é recusado: apelido não é o código da reunião', () => {
  // Um apelido de `/lookup/` resolve para códigos diferentes a cada vez. Usá-lo
  // como endereço juntaria pessoas de reuniões distintas na mesma sala de áudio.
  const result = meetCodeFromUrl('https://meet.google.com/lookup/abcdefghij');
  assert.deepEqual(result, { ok: false, reason: 'no-code' });
});

test('`/new`, `/landing` e a raiz do Meet são recusados com `no-code`', () => {
  for (const path of ['/new', '/landing', '/', '']) {
    const result = meetCodeFromUrl(`https://meet.google.com${path}`);
    assert.deepEqual(result, { ok: false, reason: 'no-code' }, path || '(vazio)');
  }
});

test('código malformado é recusado — o padrão é 3-4-3, e só', () => {
  for (const code of ['ab-defg-hij', 'abc-def-hij', 'abcdefghij', 'abc-defg-hi1', 'abc_defg_hij']) {
    assert.deepEqual(meetCodeFromUrl(`https://meet.google.com/${code}`), {
      ok: false,
      reason: 'no-code',
    }, code);
  }
});

test('outro domínio, `http://` e `www.` não são o Meet', () => {
  for (const url of [
    'https://example.com/abc-defg-hij',
    'http://meet.google.com/abc-defg-hij',
    'https://www.meet.google.com/abc-defg-hij',
    'https://meet.google.com.evil.example/abc-defg-hij',
  ]) {
    assert.deepEqual(meetCodeFromUrl(url), { ok: false, reason: 'not-meet' }, url);
  }
});

test('`about:blank` e `chrome://extensions` não são o Meet', () => {
  assert.deepEqual(meetCodeFromUrl('about:blank'), { ok: false, reason: 'not-meet' });
  assert.deepEqual(meetCodeFromUrl('chrome://extensions'), { ok: false, reason: 'not-meet' });
});

test('aba sem URL legível devolve `no-url`, e não um erro', () => {
  // É o que `chrome.tabs.query` entrega quando não há permissão para aquela aba.
  for (const valor of [undefined, null, '', '   ', 42, {}]) {
    assert.deepEqual(meetCodeFromUrl(valor), { ok: false, reason: 'no-url' }, String(valor));
  }
});

test('string que não é URL nenhuma também é `no-url`', () => {
  assert.deepEqual(meetCodeFromUrl('isto não é uma url'), { ok: false, reason: 'no-url' });
});

// ------------------------------------------------------- o que o campo mostra

test('com o Meet ativo, o campo nasce com o código — e sem aviso', () => {
  const prefill = prefillFromTab('https://meet.google.com/abc-defg-hij', 'sala-antiga');
  assert.deepEqual(prefill, { value: 'abc-defg-hij', fromMeet: true, notice: null });
});

test('fora do Meet, o campo traz a última sala e **diz por que** não preencheu', () => {
  const prefill = prefillFromTab('https://example.com/qualquer', 'sala-antiga');
  assert.equal(prefill.value, 'sala-antiga');
  assert.equal(prefill.fromMeet, false);
  assert.equal(prefill.notice, MEET_REFUSALS['not-meet']);
});

test('sem última sala e fora do Meet, o campo abre vazio — com a razão na tela', () => {
  const prefill = prefillFromTab('chrome://newtab', null);
  assert.equal(prefill.value, '');
  assert.equal(prefill.notice, MEET_REFUSALS['not-meet']);
});

test('última sala inválida não é oferecida (ela não entraria em sala nenhuma)', () => {
  const prefill = prefillFromTab('https://example.com', '-- nada --');
  // `normalizeRoomPath` transforma em algo válido ou em vazio; o que não pode é
  // o campo oferecer um endereço que o servidor recusaria.
  assert.ok(prefill.value === '' || /^[a-z0-9][a-z0-9-]*$/.test(prefill.value));
});

test('no Meet sem código, o aviso é o de "ainda não é uma reunião"', () => {
  const prefill = prefillFromTab('https://meet.google.com/new', 'sala-antiga');
  assert.equal(prefill.value, 'sala-antiga');
  assert.equal(prefill.notice, MEET_REFUSALS['no-code']);
});
