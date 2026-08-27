/**
 * Testes do modelo de mensagem do chat. O conteúdo vem de outro navegador pelo
 * data channel, sem servidor no meio que possa validar nada — então a
 * sanitização do lado receptor é a única barreira e precisa valer para entradas
 * hostis, não só para as bem-comportadas.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// `globalThis.crypto` (Web Crypto) já existe no Node 18+, que é o mesmo objeto
// que o módulo usa no navegador — nada a estubar aqui.
const {
  MAX_HISTORY,
  MAX_MESSAGE_LENGTH,
  appendMessage,
  createChatMessage,
  parseChannelPayload,
  sanitizeIncomingMessage,
} = await import('../src/lib/chat.js');

import type { ChatMessage } from '../src/lib/chat.js';

/**
 * Mensagem mínima. Os casos de histórico exercitam o **teto** e a
 * **imutabilidade**, não a forma da mensagem — o cast diz isso em vez de
 * encher a fixture de campos que nenhuma asserção olha.
 */
const minima = (campos: Partial<ChatMessage>) => campos as ChatMessage;

test('createChatMessage recorta espaços e recusa mensagem vazia', () => {
  assert.equal(createChatMessage({ author: 'Ana', text: '   ' }), null);
  assert.equal(createChatMessage({ author: 'Ana', text: '' }), null);

  const message = createChatMessage({ author: 'Ana', text: '  olá  ' });
  assert.equal(message!.text, 'olá');
  assert.equal(message!.author, 'Ana');
  assert.ok(message!.id);
  assert.ok(Number.isFinite(message!.sentAt));
});

test('createChatMessage limita tamanho de texto e de nome', () => {
  const message = createChatMessage({ author: 'A'.repeat(200), text: 'x'.repeat(5000) });
  assert.equal(message!.text.length, MAX_MESSAGE_LENGTH);
  assert.equal(message!.author.length, 40);
});

test('sanitizeIncomingMessage rejeita payload que não é mensagem', () => {
  for (const bad of [null, undefined, 42, 'texto', [], {}, { text: '' }, { text: '   ' }, { text: 123 }]) {
    assert.equal(sanitizeIncomingMessage(bad), null, `deveria rejeitar ${JSON.stringify(bad)}`);
  }
});

test('sanitizeIncomingMessage regera o id: um peer não sobrescreve a linha de outro', () => {
  const forged = { id: 'id-fixo', author: 'Ana', text: 'oi', sentAt: 1 };
  const a = sanitizeIncomingMessage(forged);
  const b = sanitizeIncomingMessage(forged);
  assert.notEqual(a!.id, 'id-fixo');
  assert.notEqual(a!.id, b!.id);
});

test('sanitizeIncomingMessage cai no nome conhecido quando o peer não manda um válido', () => {
  assert.equal(sanitizeIncomingMessage({ text: 'oi' }, { fallbackAuthor: 'Bob' })!.author, 'Bob');
  assert.equal(sanitizeIncomingMessage({ author: '   ', text: 'oi' })!.author, 'Participante');
  assert.equal(sanitizeIncomingMessage({ author: 42, text: 'oi' })!.author, 'Participante');
});

test('sanitizeIncomingMessage substitui timestamp inválido', () => {
  for (const sentAt of ['ontem', NaN, Infinity, undefined]) {
    const message = sanitizeIncomingMessage({ author: 'Ana', text: 'oi', sentAt });
    assert.ok(Number.isFinite(message!.sentAt));
  }
});

test('parseChannelPayload nunca lança e exige um type de string', () => {
  assert.equal(parseChannelPayload('{ nao é json'), null);
  assert.equal(parseChannelPayload(new ArrayBuffer(8)), null);
  assert.equal(parseChannelPayload('null'), null);
  assert.equal(parseChannelPayload('[1,2,3]'), null);
  assert.equal(parseChannelPayload('{"sem":"type"}'), null);
  assert.equal(parseChannelPayload('{"type":123}'), null);
  assert.deepEqual(parseChannelPayload('{"type":"chat","message":{}}'), { type: 'chat', message: {} });
});

test('appendMessage respeita o teto de histórico em memória', () => {
  let history: ChatMessage[] = [];
  for (let i = 0; i < MAX_HISTORY + 50; i += 1) {
    history = appendMessage(history, minima({ id: String(i), text: String(i) }));
  }
  assert.equal(history.length, MAX_HISTORY);
  // Mantém as mais recentes, descarta as mais antigas.
  assert.equal(history.at(-1)!.id, String(MAX_HISTORY + 49));
  assert.equal(history[0].id, String(50));
});

test('appendMessage não muta o histórico anterior', () => {
  const before = [minima({ id: '1' })];
  const after = appendMessage(before, minima({ id: '2' }));
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
});
