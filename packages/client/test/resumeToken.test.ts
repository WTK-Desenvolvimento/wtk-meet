/**
 * O ciclo do token de retorno do lado do client, sem navegador.
 *
 * São três momentos, e eles só valem juntos: o `join-approved` **grava** o
 * token da sala, o `join-request` seguinte o **reenvia**, e a saída pela UI o
 * **apaga**. Quebrar qualquer um deles não produz erro nenhum — produz uma sala
 * que volta a pedir aprovação a cada F5, que é exatamente o problema que esta
 * entrega existe para resolver, e que nenhum teste de tipo pega.
 *
 * Roda em `node --test` puro, sem jsdom, no padrão de
 * `joinRequestSignaling.test.ts`: o que torna isso possível é a `Storage` ser
 * injetada em `createSignalingClient` e o módulo `lib/resumeToken.ts` ser puro.
 * `config.js` e `socket.io-client` são dublados por inteiro — o primeiro lê
 * `import.meta.env`, que não existe fora do Vite; o segundo abriria uma conexão
 * de verdade, e o que está sob teste aqui é o que o client **diz**, não o que o
 * servidor responde (isso é `server/test/signaling.test.ts`).
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
  RESUME_KEY_PREFIX,
  clearResumeToken,
  readResumeToken,
  resumeKey,
  writeResumeToken,
} from '../src/lib/resumeToken.js';

/** Um `sessionStorage` de mentira, com o mesmo contrato do de verdade. */
class FakeStorage {
  items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.has(key) ? this.items.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** O `sessionStorage` do modo privado: existe, e lança em tudo. */
const storageQueLanca = {
  getItem(): string | null {
    throw new Error('SecurityError');
  },
  setItem(): void {
    throw new Error('QuotaExceededError');
  },
  removeItem(): void {
    throw new Error('SecurityError');
  },
};

/** Um socket que só anota o que foi dito e deixa o teste responder por ele. */
class FakeSocket {
  connected = false;
  listeners = new Map<string, ((payload?: unknown) => void)[]>();
  emitted: { event: string; payload: unknown }[] = [];

  on(event: string, handler: (payload?: unknown) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, payload?: unknown): this {
    this.emitted.push({ event, payload });
    return this;
  }

  connect(): void {
    this.connected = true;
    this.receive('connect');
  }

  disconnect(): void {
    this.connected = false;
  }

  /** O servidor falando com este socket. */
  receive(event: string, payload?: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) handler(payload);
  }

  /** O último `join-request` que saiu no fio. */
  lastJoinRequest(): Record<string, unknown> | null {
    for (let i = this.emitted.length - 1; i >= 0; i -= 1) {
      const sent = this.emitted[i]!;
      if (sent.event === 'join-request') return sent.payload as Record<string, unknown>;
    }
    return null;
  }
}

/** O socket que o dublê de `io()` devolveu por último. */
let ultimoSocket: FakeSocket | null = null;

mock.module('../src/config.js', {
  exports: {
    SIGNALING_URL: 'http://localhost:0',
    MAX_PARTICIPANTS: 6,
    fetchIceServers: async () => [],
  },
});

mock.module('socket.io-client', {
  exports: {
    io: () => {
      ultimoSocket = new FakeSocket();
      return ultimoSocket;
    },
  },
});

const { createSignalingClient } = await import('../src/lib/signaling.js');

/** Um client de sinalização com storage próprio, e o socket que ele criou. */
function montar(storage?: unknown) {
  const client = createSignalingClient({ storage: storage as never });
  const socket = ultimoSocket!;
  socket.connect();
  return { client, socket };
}

const TOKEN = 'a'.repeat(64);
const OUTRO_TOKEN = 'b'.repeat(64);

// --------------------------------------------------------- 1. módulo puro

test('a chave é por sala, com o prefixo do produto', () => {
  assert.equal(RESUME_KEY_PREFIX, 'wtk-meet:resume:');
  assert.equal(resumeKey('sala-x'), 'wtk-meet:resume:sala-x');
  // Salas diferentes, chaves diferentes: é isto que impede o token da sala X de
  // ser apresentado na Y.
  assert.notEqual(resumeKey('sala-x'), resumeKey('sala-y'));
});

test('grava, lê e apaga o token de uma sala sem tocar na de outra', () => {
  const storage = new FakeStorage();

  writeResumeToken(storage, 'sala-x', TOKEN);
  writeResumeToken(storage, 'sala-y', OUTRO_TOKEN);
  assert.equal(readResumeToken(storage, 'sala-x'), TOKEN);
  assert.equal(readResumeToken(storage, 'sala-y'), OUTRO_TOKEN);

  clearResumeToken(storage, 'sala-x');
  assert.equal(readResumeToken(storage, 'sala-x'), null, 'a sala X perdeu o token');
  assert.equal(readResumeToken(storage, 'sala-y'), OUTRO_TOKEN, 'a sala Y não foi tocada');
});

test('a admissão seguinte sobrescreve o token — o servidor rotaciona', () => {
  const storage = new FakeStorage();
  writeResumeToken(storage, 'sala-x', TOKEN);
  writeResumeToken(storage, 'sala-x', OUTRO_TOKEN);
  assert.equal(readResumeToken(storage, 'sala-x'), OUTRO_TOKEN);
});

test('o que não é string não-vazia não vira token gravado', () => {
  const storage = new FakeStorage();
  for (const lixo of [undefined, null, '', 42, {}, [], true]) {
    writeResumeToken(storage, 'sala-x', lixo);
  }
  assert.equal(readResumeToken(storage, 'sala-x'), null);
  assert.equal(storage.items.size, 0, 'nada foi gravado');
});

test('storage que lança degrada para "sem token", e nunca para exceção', () => {
  // Modo privado e política de cookies de terceiros fazem isto. Nenhum deles
  // pode deixar alguém **fora** da sala por causa de um atalho.
  assert.doesNotThrow(() => writeResumeToken(storageQueLanca, 'sala-x', TOKEN));
  assert.doesNotThrow(() => clearResumeToken(storageQueLanca, 'sala-x'));
  assert.equal(readResumeToken(storageQueLanca, 'sala-x'), null);
  // E sem storage nenhum também não.
  assert.equal(readResumeToken(null, 'sala-x'), null);
  assert.doesNotThrow(() => writeResumeToken(null, 'sala-x', TOKEN));
});

// ------------------------------------------------ 2. o ciclo na sinalização

test('o join-approved grava o token da sala sob wtk-meet:resume:<roomId>', () => {
  const storage = new FakeStorage();
  const { client, socket } = montar(storage);

  client.requestJoin('sala-x', 'Bob');
  socket.receive('join-approved', { selfId: 's1', members: [], resumeToken: TOKEN });

  assert.equal(storage.items.get('wtk-meet:resume:sala-x'), TOKEN);
});

test('o join-request seguinte reenvia o token — é o F5 que não pede aprovação', () => {
  const storage = new FakeStorage();
  const { client, socket } = montar(storage);

  client.requestJoin('sala-x', 'Bob');
  assert.equal(socket.lastJoinRequest()!.resumeToken, undefined, 'o primeiro pedido não tem o que apresentar');

  socket.receive('join-approved', { selfId: 's1', members: [], resumeToken: TOKEN });
  // O F5: aba nova, socket novo, mesmo `sessionStorage`.
  const segunda = montar(storage);
  segunda.client.requestJoin('sala-x', 'Bob');

  assert.deepEqual(segunda.socket.lastJoinRequest(), {
    roomId: 'sala-x',
    displayName: 'Bob',
    resumeToken: TOKEN,
  });
});

test('o token da sala X não viaja num join-request da sala Y', () => {
  const storage = new FakeStorage();
  const primeira = montar(storage);
  primeira.client.requestJoin('sala-x', 'Bob');
  primeira.socket.receive('join-approved', { selfId: 's1', members: [], resumeToken: TOKEN });

  const segunda = montar(storage);
  segunda.client.requestJoin('sala-y', 'Bob');

  const pedido = segunda.socket.lastJoinRequest()!;
  assert.equal(pedido.resumeToken, undefined, 'a sala Y pede aprovação normal');
  assert.ok(!JSON.stringify(pedido).includes(TOKEN), 'o token de X não aparece em lugar nenhum do payload');
});

test('leaveRoom apaga a chave daquela sala — sair é sair', () => {
  const storage = new FakeStorage();
  const { client, socket } = montar(storage);

  client.requestJoin('sala-x', 'Bob');
  socket.receive('join-approved', { selfId: 's1', members: [], resumeToken: TOKEN });
  assert.equal(readResumeToken(storage, 'sala-x'), TOKEN);

  client.leaveRoom('sala-x');

  assert.equal(readResumeToken(storage, 'sala-x'), null, 'a chave sumiu');
  assert.ok(
    socket.emitted.some((e) => e.event === 'leave-room'),
    'e o servidor foi avisado',
  );
});

test('a limpeza fantasma do StrictMode não apaga o token de quem nem conectou', () => {
  // `React.StrictMode` monta → limpa → monta. Sem a guarda do `socket.connected`
  // a limpeza do meio apagaria o token **antes** de a segunda montagem o ler, e
  // a retomada funcionaria no build e falharia com `npm run dev`.
  const storage = new FakeStorage();
  writeResumeToken(storage, 'sala-x', TOKEN);

  const client = createSignalingClient({ storage: storage as never });
  // Socket ainda não conectado: é o estado da montagem que vai ser desfeita.
  client.leaveRoom('sala-x');

  assert.equal(readResumeToken(storage, 'sala-x'), TOKEN, 'o token sobreviveu à limpeza fantasma');
  assert.ok(
    !ultimoSocket!.emitted.some((e) => e.event === 'leave-room'),
    'e nenhum leave-room foi para o servidor',
  );
});

test('um join-approved sem token não apaga o que já estava guardado', () => {
  // Servidor antigo contra client novo: o campo é aditivo, e a ausência dele
  // não pode ser lida como "esqueça o que você tinha".
  const storage = new FakeStorage();
  const { client, socket } = montar(storage);

  client.requestJoin('sala-x', 'Bob');
  socket.receive('join-approved', { selfId: 's1', members: [], resumeToken: TOKEN });
  socket.receive('join-approved', { selfId: 's1', members: [] });

  assert.equal(readResumeToken(storage, 'sala-x'), TOKEN);
});
