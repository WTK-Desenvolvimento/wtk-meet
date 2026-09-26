/**
 * Teste de caracterização do contrato de sinalização.
 *
 * `packages/extension/src/lib/signaling.ts` escreve pela segunda vez os nomes de
 * evento que `packages/client/src/lib/signaling.ts` e o servidor já usam (o
 * porquê está no cabeçalho daquele arquivo: importar o do client arrastaria
 * `config.ts`, que executa a telemetria do app no import).
 *
 * Duas listas iguais divergem no dia em que alguém renomeia um evento — e o
 * sintoma é a extensão fora da sala, **sem erro**: o socket conecta, o
 * `join-request` sai com um nome que ninguém escuta e o popup fica em
 * "entrando…" para sempre. Este teste não impede a mudança; ele faz alguém
 * *ver* que há dois lugares. Se falhar, o conserto é ir ao outro arquivo, não
 * atualizar esta lista sozinha.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { SIGNALING_EVENTS } from '../src/lib/signaling.ts';

const CLIENT_SIGNALING = fileURLToPath(
  new URL('../../client/src/lib/signaling.ts', import.meta.url),
);
const ROOM_PAGE = fileURLToPath(new URL('../../client/src/pages/Room.tsx', import.meta.url));

test('os eventos que a extensão emite são os mesmos que o client emite', () => {
  const fonte = readFileSync(CLIENT_SIGNALING, 'utf8');
  for (const evento of SIGNALING_EVENTS.out) {
    assert.ok(
      fonte.includes(`socket.emit('${evento}'`),
      `o client não emite mais '${evento}' — o contrato mudou em um lado só`,
    );
  }
});

test('os eventos que a extensão escuta são os mesmos que a sala do app escuta', () => {
  const fonte = readFileSync(ROOM_PAGE, 'utf8');
  for (const evento of SIGNALING_EVENTS.in) {
    assert.ok(
      fonte.includes(`socket.on('${evento}'`),
      `o app não escuta mais '${evento}' — o contrato mudou em um lado só`,
    );
  }
});

test('a lista não tem duplicata nem nome vazio', () => {
  for (const lista of [SIGNALING_EVENTS.out, SIGNALING_EVENTS.in]) {
    assert.equal(new Set(lista).size, lista.length);
    for (const nome of lista) assert.ok(nome.length > 0);
  }
});
