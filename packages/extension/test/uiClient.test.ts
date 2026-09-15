/**
 * O lado da UI da porta — e a corrida que ele existe para não perder.
 *
 * `start()` é assíncrono: ele pede ao service worker que garanta o motor e só
 * então abre a porta. Uma página é clicável antes disso, e o caminho ingênuo
 * (`this.port?.postMessage`) **descarta o comando em silêncio** — um botão que
 * não faz nada, sem erro, que foi exatamente o que apareceu no E2E da sala: a
 * página `manager` adicionava uma faixa à fila e a fila continuava vazia.
 *
 * O dublê de `chrome` é montado antes do import porque os módulos leem o global
 * no topo, como acontece no navegador.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

interface PortaDublê {
  name: string;
  recebidas: unknown[];
  postMessage(message: unknown): void;
  onMessage: { addListener(cb: (m: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
  disconnect(): void;
}

const portas: PortaDublê[] = [];
const pedidosAoSw: unknown[] = [];
/** Resolve quando o teste mandar — é o que permite "clicar antes de conectar". */
let liberarEnsure: (() => void) | null = null;

function criaPorta(name: string): PortaDublê {
  const porta: PortaDublê = {
    name,
    recebidas: [],
    postMessage(message) {
      porta.recebidas.push(message);
    },
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
    disconnect() {},
  };
  portas.push(porta);
  return porta;
}

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    id: 'teste',
    getURL: (p: string) => `chrome-extension://teste/${p}`,
    connect: ({ name }: { name: string }) => criaPorta(name),
    sendMessage: async (message: unknown) => {
      pedidosAoSw.push(message);
      const { type } = message as { type: string };
      if (type === 'ensure-engine') {
        await new Promise<void>((resolve) => {
          liberarEnsure = resolve;
        });
        return { ok: true };
      }
      if (type === 'prefill') {
        return { target: 'ui', type: 'prefill', value: 'sala-x', fromMeet: false, notice: 'nada' };
      }
      return undefined;
    },
    onConnect: { addListener() {} },
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
  },
  storage: {
    local: { async get() { return {}; }, async set() {}, async remove() {} },
    onChanged: { addListener() {} },
  },
};

const { EngineClient } = await import('../src/ui/engineClient.ts');
const { PORT_NAME } = await import('../src/lib/protocol.ts');

test('um comando disparado antes de a porta abrir **não** se perde', async () => {
  const cliente = new EngineClient({ onState() {}, onNotice() {}, onLost() {} });

  // A página é clicável enquanto `start()` ainda espera o service worker.
  const start = cliente.start();
  cliente.send({
    target: 'engine',
    type: 'queue-add',
    source: { kind: 'url', sourceRef: 'https://cdn.example/a.mp3' },
  });
  assert.equal(portas.length, 0, 'a porta ainda nem existe');

  liberarEnsure?.();
  await start;

  const porta = portas.at(-1);
  assert.equal(porta?.name, PORT_NAME);
  assert.deepEqual(porta?.recebidas, [
    {
      target: 'engine',
      type: 'queue-add',
      source: { kind: 'url', sourceRef: 'https://cdn.example/a.mp3' },
    },
  ]);
});

test('a ordem dos comandos enfileirados é preservada', async () => {
  const cliente = new EngineClient({ onState() {}, onNotice() {}, onLost() {} });
  const start = cliente.start();
  cliente.send({ target: 'engine', type: 'transport', action: 'play' });
  cliente.send({ target: 'engine', type: 'transport', action: 'pause' });
  liberarEnsure?.();
  await start;

  const porta = portas.at(-1);
  assert.deepEqual(
    porta?.recebidas.map((m) => (m as { action: string }).action),
    ['play', 'pause'],
  );
});

test('o `ensure-engine` vem antes da porta — e é endereçado ao service worker', async () => {
  pedidosAoSw.length = 0;
  const cliente = new EngineClient({ onState() {}, onNotice() {}, onLost() {} });
  const start = cliente.start();
  liberarEnsure?.();
  await start;

  assert.deepEqual(pedidosAoSw[0], { target: 'sw', type: 'ensure-engine' });
});

test('o prefill é pedido ao service worker, que é quem enxerga a aba ativa', async () => {
  const resposta = await EngineClient.prefill();
  assert.equal(resposta.value, 'sala-x');
  assert.equal(resposta.fromMeet, false);
  assert.equal(resposta.notice, 'nada');
});
