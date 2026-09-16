/**
 * A fila e o transporte do motor — o que acontece depois que a faixa entra.
 *
 * `messaging.test.ts` prova que as abas veem a mesma fila; este arquivo cobre o
 * que a fila **faz**, e em especial as saídas que o §8 do documento de
 * arquitetura chama de inegociáveis:
 *
 * - **recusa com mensagem, nunca com silêncio** (critérios 11 e 15): faixa que
 *   não carrega, sonda de CORS que nunca responde, reprodução bloqueada pela
 *   política de autoplay. Num motor sem tela, "não tocou e não disse nada" é
 *   indistinguível de "tocou e a sala não ouviu" — são horas de depuração em
 *   dois lugares errados;
 * - **snapshot completo para quem chega no meio da faixa** (critério 4);
 * - **o arquivo local sobrevive à página que o escolheu** (critério 14): o que
 *   anda entre contextos é o `fileId` do IndexedDB, porque `Blob` não atravessa
 *   mensagem de extensão e object URL morre com o documento que o criou.
 *
 * O último teste é de **caracterização**, e não de requisito: a fila do motor
 * herda o `MAX_PER_PEER` do client, então ela para em 10 faixas. Está escrito
 * aqui para que o teto seja uma decisão visível, e não uma descoberta de quem
 * montou uma playlist de 30.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_PER_PEER } from '../../client/src/lib/musicSession.ts';
import { SOURCE_ERRORS } from '../../client/src/lib/musicSources.ts';
import { SOUNDBOARD_ERRORS } from '../../client/src/lib/soundboard.ts';
import { EngineCore } from '../src/engine/core.ts';
import type { QueueEntry } from '../../client/src/lib/musicSession.ts';
import { FakeAudio, FakePort, FakeRoom, MemoryStorage, relogio } from './engineDoubles.ts';

/**
 * O teto de tempo da sonda de CORS, em `engine/core.ts`. Escrito aqui porque a
 * constante é privada daquele módulo; se divergir, o teste avisa ao não passar.
 */
const PROBE_TIMEOUT_MS = 8_000;

/** Um lado de áudio que sabe falhar — o `FakeAudio` sempre carrega. */
class AudioQueFalha extends FakeAudio {
  /** Razão de `SOURCE_ERRORS` para `loadTrack` recusar, ou `null`. */
  falhaAoCarregar: string | null = null;
  /**
   * Títulos que recusam ao carregar — o resto carrega normalmente.
   *
   * Existe porque `falhaAoCarregar` é global e permanente: num teste de cascata
   * (a faixa do meio é ruim, as vizinhas são boas) ele derrubaria *todas* as
   * faixas, e o teste continuaria vermelho mesmo com o motor corrigido —
   * provando nada. Aqui só a faixa nomeada recusa.
   */
  falhasPorTitulo = new Map<string, string>();
  /** Quando `true`, `play()` devolve `false` (política de autoplay). */
  bloqueado = false;
  /** Quando `true`, a sonda de CORS nunca responde. */
  sondaMuda = false;

  override async loadTrack(entry: QueueEntry): Promise<{ ok: true } | { ok: false; reason: string }> {
    const porTitulo = this.falhasPorTitulo.get(entry.title);
    if (porTitulo) return { ok: false, reason: porTitulo };
    if (this.falhaAoCarregar) return { ok: false, reason: this.falhaAoCarregar };
    return super.loadTrack(entry);
  }

  override async play(): Promise<boolean> {
    if (this.bloqueado) return false;
    return super.play();
  }

  override async probe(): Promise<boolean> {
    if (this.sondaMuda) return new Promise<boolean>(() => {});
    return super.probe();
  }
}

function motor() {
  const audio = new AudioQueFalha();
  const room = new FakeRoom();
  const storage = new MemoryStorage();
  const clock = relogio(1000);
  const core = new EngineCore({ audio, room, storage, now: clock.agora, engineId: 'eng-fila' });
  core.init();
  const aba = new FakePort('A');
  core.attach(aba);
  return { core, audio, room, aba };
}

function adicionar(core: EngineCore, sourceRef: string, aba?: FakePort) {
  return core.handleCommand({ target: 'engine', type: 'queue-add', source: { kind: 'url', sourceRef } }, aba);
}

test('a aba que chega no meio da faixa recebe o estado inteiro, com a corrente preenchida', async () => {
  const { core, aba } = motor();
  await adicionar(core, 'https://cdn.example/uma.mp3', aba);

  const tardia = new FakePort('B');
  core.attach(tardia);

  // Uma aba que abre no meio de uma faixa não consegue montar a tela a partir
  // de um delta: o primeiro pacote tem que ser o estado inteiro.
  assert.equal(tardia.mensagens.length, 1);
  assert.equal(tardia.mensagens[0]?.type, 'state');
  assert.equal(tardia.estado.queue?.length, 1);
  assert.equal(tardia.estado.current?.entryId, aba.estado.current?.entryId);
  assert.equal(tardia.estado.current?.playing, true);
});

test('pular tira a faixa corrente da fila e começa a próxima', async () => {
  const { core, audio, aba } = motor();
  await adicionar(core, 'https://cdn.example/uma.mp3', aba);
  await adicionar(core, 'https://cdn.example/duas.mp3', aba);
  assert.equal(aba.estado.queue?.length, 2);
  const primeira = aba.estado.current?.entryId;

  await core.handleCommand({ target: 'engine', type: 'transport', action: 'skip' }, aba);

  assert.equal(aba.estado.queue?.length, 1, 'a pulada saiu da fila');
  assert.notEqual(aba.estado.current?.entryId, primeira);
  assert.deepEqual(audio.faixasCarregadas, ['uma', 'duas'], 'o título vem de titleFromUrl, sem a extensão');
});

test('remover a faixa corrente avança — a fila não fica parada com nada tocando', async () => {
  const { core, aba } = motor();
  await adicionar(core, 'https://cdn.example/uma.mp3', aba);
  await adicionar(core, 'https://cdn.example/duas.mp3', aba);
  const primeira = aba.estado.current!.entryId;

  await core.handleCommand({ target: 'engine', type: 'queue-remove', entryId: primeira }, aba);

  assert.equal(aba.estado.queue?.length, 1);
  assert.equal(aba.estado.current?.title, 'duas');
});

test('pular a última faixa deixa a fila vazia, sem corrente e sem erro', async () => {
  const { core, audio, aba } = motor();
  await adicionar(core, 'https://cdn.example/uma.mp3', aba);

  await core.handleCommand({ target: 'engine', type: 'transport', action: 'skip' }, aba);

  assert.equal(aba.estado.queue?.length, 0);
  assert.equal(aba.estado.current, null);
  assert.equal(audio.isPlaying(), false, 'o player parou junto');
  assert.deepEqual(aba.avisos, [], 'fila que acaba não é erro');
});

test('faixa que não carrega vira a mensagem do app e sai da fila — nunca silêncio', async () => {
  const { core, audio, aba } = motor();
  audio.falhaAoCarregar = 'not-audio';

  await adicionar(core, 'https://cdn.example/nao-e-audio.bin', aba);

  assert.equal(aba.estado.queue?.length, 0, 'a faixa que não toca não fica na fila');
  assert.equal(aba.estado.current, null);
  assert.equal(aba.avisos.at(-1), SOURCE_ERRORS['not-audio']);
});

test('uma faixa que não carrega não leva o resto da fila junto', async () => {
  const { core, audio, aba } = motor();
  await adicionar(core, 'https://cdn.example/boa.mp3', aba);
  await adicionar(core, 'https://cdn.example/ruim.mp3', aba);
  await adicionar(core, 'https://cdn.example/outra.mp3', aba);

  // Só a faixa do meio recusa ao carregar; as outras duas são boas. Marcar pelo
  // título (e não pelo `falhaAoCarregar` global, que é permanente) é o que deixa
  // a faixa seguinte carregável — sem isso o teste ficaria vermelho mesmo depois
  // do conserto, e não provaria defeito nenhum.
  audio.falhasPorTitulo.set('ruim', 'not-audio');
  await core.handleCommand({ target: 'engine', type: 'transport', action: 'skip' }, aba);

  // O client faz exatamente isto: erro de reprodução vira `advanceFrom(id,
  // 'error')` (`useMusicRoom.ts`), e a fila segue. Aqui a mensagem aparece — o
  // que evita o silêncio mudo —, mas a faixa seguinte nunca assume, e quem
  // montou a playlist fica olhando para duas faixas enfileiradas e nada tocando.
  assert.equal(aba.avisos.at(-1), SOURCE_ERRORS['not-audio'], 'a recusa é dita');
  assert.equal(aba.estado.current?.title, 'outra', 'a seguinte assume');
  assert.equal(audio.isPlaying(), true);
});

test('reprodução bloqueada pela política de autoplay diz o que fazer', async () => {
  const { core, audio, aba } = motor();
  await adicionar(core, 'https://cdn.example/uma.mp3', aba);
  audio.bloqueado = true;
  await core.handleCommand({ target: 'engine', type: 'transport', action: 'pause' }, aba);

  await core.handleCommand({ target: 'engine', type: 'transport', action: 'play' }, aba);

  // O documento offscreen não tem gesto do usuário para oferecer ao navegador:
  // sem esta mensagem, o sintoma é um botão "tocar" que não faz nada.
  assert.match(aba.avisos.at(-1) ?? '', /bloqueou/i);
});

test('o arquivo local entra na fila e o `fileId` do IndexedDB sobrevive', async () => {
  const { core, aba } = motor();

  await core.handleCommand(
    {
      target: 'engine',
      type: 'queue-add',
      source: { kind: 'file', fileId: 'idb-42', title: 'Do disco.mp3' },
    },
    aba,
  );

  const entrada = aba.estado.queue?.[0];
  assert.equal(entrada?.kind, 'file');
  assert.equal(entrada?.title, 'Do disco.mp3');
  // É isto que faz a faixa continuar tocando depois de a página `manager`
  // fechar: o conteúdo mora no IndexedDB, e o que a fila guarda é o endereço.
  assert.equal(core.fileIdOf(entrada!.entryId), 'idb-42');
});

test('remover a entrada de arquivo esquece também o `fileId`', async () => {
  const { core, aba } = motor();
  await core.handleCommand(
    {
      target: 'engine',
      type: 'queue-add',
      source: { kind: 'file', fileId: 'idb-42', title: 'Do disco.mp3' },
    },
    aba,
  );
  const entryId = aba.estado.queue![0]!.entryId;

  await core.handleCommand({ target: 'engine', type: 'queue-remove', entryId }, aba);

  assert.equal(core.fileIdOf(entryId), null, 'um `fileId` órfão é lixo que nunca é coletado');
});

test('sonda de CORS que nunca responde é recusada pelo teto de tempo', async (t) => {
  const { core, audio, aba } = motor();
  audio.sondaMuda = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pendente = adicionar(core, 'https://host-que-aceita-e-nao-responde/x.mp3', aba);
  t.mock.timers.tick(PROBE_TIMEOUT_MS);
  await pendente;

  // Sem o teto, o "adicionar" fica pendurado para sempre: sem fila, sem
  // mensagem, sem nada para olhar.
  assert.equal(aba.estado.queue?.length, 0);
  assert.equal(aba.avisos.at(-1), SOUNDBOARD_ERRORS['fetch-failed']);
});

test('a fila do motor para no limite por participante do client (caracterização)', async () => {
  const { core, aba } = motor();

  for (let i = 0; i < MAX_PER_PEER; i += 1) {
    await adicionar(core, `https://cdn.example/faixa-${i}.mp3`, aba);
  }
  assert.equal(aba.estado.queue?.length, MAX_PER_PEER);

  await adicionar(core, 'https://cdn.example/uma-a-mais.mp3', aba);

  // Todas as faixas do motor têm o mesmo autor (`extension`), então o teto de
  // flood por participante vale para a fila **inteira** da extensão. Não é bug —
  // é o limite do client valendo aqui, e a recusa usa a mensagem do app.
  assert.equal(aba.estado.queue?.length, MAX_PER_PEER, 'a 11ª não entrou');
  assert.equal(aba.avisos.at(-1), SOURCE_ERRORS['peer-limit']);
});
