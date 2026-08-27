/**
 * A recusa no ato: um link de YouTube que **provadamente** não vai tocar não
 * entra na fila.
 *
 * O que está sob teste é o `addToQueue` de verdade, com o hook rodando — é lá
 * que a decisão vira efeito (aviso na tela, `false` de volta para o campo de
 * adicionar, nenhuma mensagem enviada à sala), e testar só as peças puras
 * deixaria de fora justamente a ligação entre elas.
 *
 * **Como um hook roda sem navegador.** O projeto testa com `node --test` puro,
 * sem jsdom e sem renderer; o dispatcher abaixo é o mesmo recurso já usado em
 * `settingsNoiseToggle.test.ts`, reduzido ao que este hook precisa. `useEffect`
 * só consome a posição do hook: sem DOM não há o que ele faça, e rodá-lo aqui
 * abriria `AudioContext` e timers. Nada disso participa de `addToQueue`.
 *
 * **A rede é o `globalThis.fetch`**, e não uma injeção: `addToQueue` chama
 * `fetchYouTubeOEmbed(videoId)` sem opções, de propósito (a flag e o prazo são o
 * padrão do próprio módulo). Trocar o `fetch` global é o que permite exercitar o
 * caminho inteiro — e o `assert` de que ele foi chamado exatamente uma vez é o
 * que guarda a promessa de "uma requisição por link".
 *
 * O que este arquivo **não** prova: que a recusa dispara num navegador de
 * verdade. O `fetch` daqui não implementa CORS, e se as respostas de erro do
 * oEmbed vierem sem `Access-Control-Allow-Origin` o status não chega legível ao
 * JavaScript. Ver o risco 7.1 do documento e o registro em `claude-progress.md`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const React = await import('react');
const { useMusicRoom } = await import('../src/lib/useMusicRoom.js');
const { SOURCE_ERRORS } = await import('../src/lib/musicSources.js');

import type { MusicMessage } from '../src/lib/musicProtocol.js';

/**
 * O dispatcher de hooks do React não tem tipo público — é por isso que o campo
 * se chama assim. O cast é a fronteira: daqui para baixo quem manda é o
 * dispatcher deste arquivo.
 */
const internals = (
  React.default as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: unknown };
    };
  }
).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

const YOUTUBE_LINK = 'https://youtu.be/dQw4w9WgXcQ';

/**
 * Roda o hook e mantém o resultado atualizado a cada `setState`, sem DOM e sem
 * renderer. Falha alto se aparecer um hook que este harness não suporta — é
 * preferível a devolver `undefined` e ver o teste falhar longe da causa.
 */
function renderHook(props: Parameters<typeof useMusicRoom>[0]) {
  const hooks: unknown[] = [];
  let cursor = 0;
  let value: ReturnType<typeof useMusicRoom> | null = null;

  const dispatcher = {
    useState(initial: unknown) {
      const slot = cursor;
      cursor += 1;
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
      return [
        hooks[slot],
        (next: unknown) => {
          hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next;
          render();
        },
      ];
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
      // Sem comparação de deps: recalcular sempre é correto (só custa CPU), e
      // reusar sem comparar seria errado depois de um `setState`.
      hooks[slot] = factory();
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
    const previous = internals.ReactCurrentDispatcher.current;
    internals.ReactCurrentDispatcher.current = dispatcher;
    try {
      value = useMusicRoom(props);
    } finally {
      internals.ReactCurrentDispatcher.current = previous;
    }
  }

  render();
  return {
    get current() {
      return value;
    },
  };
}

/** Uma sala de um participante só, com o canal de dados sob observação. */
function makeRoom() {
  const sent: MusicMessage[] = [];
  // O cast das props: o hook pede o `meshRef` do `WebRTCMesh`, e o dublê tem o
  // único método que este roteiro exercita.
  const room = renderHook({
    meshRef: { current: { sendMusicMessage: (payload: MusicMessage) => sent.push(payload) } },
    participants: new Map(),
    getSelfId: () => 'self',
    displayName: 'Ana',
    pushToast: () => {},
  } as unknown as Parameters<typeof useMusicRoom>[0]);
  return { room, sent };
}

/** Troca o `fetch` global pela resposta combinada e conta as requisições. */
async function withOEmbed<T>(
  resposta: unknown,
  fn: (chamadas: string[]) => Promise<T> | T,
): Promise<T> {
  const original = globalThis.fetch;
  const chamadas: string[] = [];
  // O cast: o hook lê `ok`, `status` e `json()` da resposta, e nada mais.
  globalThis.fetch = (async (url: string) => {
    chamadas.push(url);
    if (typeof resposta === 'function') return resposta(url);
    return resposta;
  }) as unknown as typeof fetch;
  try {
    return await fn(chamadas);
  } finally {
    globalThis.fetch = original;
  }
}

const respondeCom = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// --------------------------------------------------------------------- recusa

test('AC1. vídeo removido ou privado (404) não entra na fila e diz por quê', async () => {
  const { room, sent } = makeRoom();

  await withOEmbed(respondeCom(404), async (chamadas) => {
    const ok = await room.current!.actions.addToQueue(YOUTUBE_LINK);

    assert.equal(ok, false, 'o campo de adicionar preserva o texto colado quando volta false');
    assert.equal(room.current!.notice, SOURCE_ERRORS['youtube-unavailable']);
    assert.equal(chamadas.length, 1, 'uma requisição por link, a mesma que já buscava o título');
  });

  assert.deepEqual(sent, [], 'nenhuma mensagem music-queue-add sai para a sala');
  assert.equal(room.current!.queue.length, 0, 'e nada entrou na fila deste cliente');
});

test('AC2. incorporação bloqueada pelo dono (401/403) recusa com mensagem diferente', async () => {
  for (const status of [401, 403]) {
    const { room, sent } = makeRoom();

    await withOEmbed(respondeCom(status), async () => {
      const ok = await room.current!.actions.addToQueue(YOUTUBE_LINK);

      assert.equal(ok, false, String(status));
      assert.equal(room.current!.notice, SOURCE_ERRORS['youtube-embed-blocked'], String(status));
      assert.notEqual(
        room.current!.notice,
        SOURCE_ERRORS['youtube-unavailable'],
        'insistir num vídeo bloqueado não adianta; num link errado, adianta — as saídas são diferentes',
      );
    });

    assert.deepEqual(sent, []);
    assert.equal(room.current!.queue.length, 0);
  }
});

test('AC4. a recusa não deixa nada para trás: sem entrada, sem lamport, sem hint de entrega', async () => {
  const { room } = makeRoom();
  const antes = room.current!.session;

  await withOEmbed(respondeCom(404), () => room.current!.actions.addToQueue(YOUTUBE_LINK));

  const depois = room.current!.session;
  assert.equal(depois.lamport, antes.lamport, 'nenhum lamport consumido');
  assert.deepEqual(depois.entries, antes.entries);
  assert.equal(room.current!.deliveryHint.current.size, 0);
});

// ------------------------------------------------------------------ fail-open

test('AC5. rede caída, timeout, 429 e 5xx enfileiram com o título de fallback', async () => {
  const casos = {
    'rede caída': () => {
      throw new TypeError('Failed to fetch');
    },
    'rate-limit': () => respondeCom(429),
    'erro da Google': () => respondeCom(503),
    'resposta que não é JSON': () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }),
  };

  for (const [label, resposta] of Object.entries(casos)) {
    const { room, sent } = makeRoom();

    await withOEmbed(resposta, async () => {
      assert.equal(await room.current!.actions.addToQueue(YOUTUBE_LINK), true, label);
    });

    assert.equal(room.current!.queue.length, 1, label);
    assert.equal(room.current!.queue[0].title, 'YouTube · dQw4w9WgXcQ', label);
    assert.equal(sent.length, 1, `${label}: a faixa é replicada para a sala como sempre foi`);
  }
});

// -------------------------------------------------------------- não-regressão

test('AC8. link válido entra na fila com o título real, como hoje', async () => {
  const { room, sent } = makeRoom();

  await withOEmbed(respondeCom(200, { title: 'Rick Astley - Never Gonna Give You Up' }), async () => {
    assert.equal(await room.current!.actions.addToQueue(YOUTUBE_LINK), true);
  });

  assert.equal(room.current!.queue.length, 1);
  assert.equal(room.current!.queue[0].title, 'Rick Astley - Never Gonna Give You Up');
  assert.equal(sent[0]?.type, 'music-queue-add');
  // O cast: `sent` guarda mensagens do protocolo, e o que se afirma é o título
  // que atravessou dentro da entrada.
  const adicionada = sent[0] as { entry?: { title?: string } };
  assert.equal(adicionada.entry?.title, 'Rick Astley - Never Gonna Give You Up');
});

test('AC9. 200 sem título legível enfileira com o fallback — não é recusa', async () => {
  const { room } = makeRoom();

  await withOEmbed(respondeCom(200, { author_name: 'só o autor' }), async () => {
    assert.equal(await room.current!.actions.addToQueue(YOUTUBE_LINK), true);
  });

  assert.equal(room.current!.queue[0].title, 'YouTube · dQw4w9WgXcQ');
});

test('AC13. o veredito nunca recusa origem que não seja YouTube', async () => {
  const { room } = makeRoom();

  // O oEmbed responde 404 o tempo todo, e um arquivo local não tem nada a ver
  // com isso: nenhuma requisição nasce e a faixa entra.
  await withOEmbed(respondeCom(404), async (chamadas) => {
    const ok = await room.current!.actions.addToQueue(null, { name: 'demo.mp3', type: 'audio/mpeg' } as unknown as File);

    assert.equal(ok, true);
    assert.equal(chamadas.length, 0, 'arquivo local não fala com a Google');
  });

  assert.equal(room.current!.queue[0].title, 'demo');
});
