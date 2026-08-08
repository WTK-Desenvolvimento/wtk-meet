import test from 'node:test';
import assert from 'node:assert/strict';

import { installEnv } from './helpers/fake-env.js';

/**
 * Uma chamada inteira, de ponta a ponta, com `src/main.js` de verdade.
 *
 * Os outros arquivos testam cada modulo isolado. Este testa o CABEAMENTO — que
 * e onde moram os bugs de integracao: o aviso que toca para si mesmo, o
 * compartilhamento que ao parar nao devolve a camera, o `publishState` que nao
 * sai. Nada aqui e stub do proprio app: sao os modulos reais falando entre si,
 * com navegador e servidor falsos nas pontas.
 *
 * E um unico `test` com subtestes em sequencia de proposito: `main.js` e um
 * modulo com estado (uma sala, uma conexao), e a historia so faz sentido em
 * ordem — entrar, alguem chega, compartilhar, sair.
 */

const env = installEnv();

// ------------------------------------------------------- palco: index.html ---

// A tag importa em pelo menos um ponto: o atalho de teclado precisa saber que
// o foco esta num campo de texto para nao roubar a tecla de quem esta digitando.
const ids = {
  lobby: 'section',
  'lobby-form': 'form',
  name: 'input',
  room: 'input',
  call: 'main',
  tiles: 'div',
  'btn-mic': 'button',
  'btn-cam': 'button',
  'btn-share': 'button',
  'btn-chat': 'button',
  'btn-sound': 'button',
  'btn-leave': 'button',
  'chat-panel': 'aside',
  'chat-log': 'ol',
  'chat-form': 'form',
  'chat-input': 'textarea',
  'chat-count': 'span',
  'chat-badge': 'span',
  'chat-close': 'button',
  toasts: 'div',
  'modal-root': 'div',
  'modal-title': 'h2',
  'modal-body': 'p',
  'modal-ok': 'button',
};

const dom = new Map();
for (const [id, tag] of Object.entries(ids)) {
  const el = env.el(tag);
  el.id = id;
  dom.set(id, el);
}
// Os botoes da barra tem um <span class="label"> que o app reescreve.
for (const id of ['btn-mic', 'btn-cam', 'btn-share', 'btn-chat', 'btn-sound', 'btn-leave']) {
  const label = env.el('span');
  label.className = 'label';
  dom.get(id).appendChild(label);
}
// O que nasce escondido no HTML.
for (const id of ['call', 'chat-panel', 'modal-root', 'chat-badge']) dom.get(id).hidden = true;

env.document.getElementById = (id) => dom.get(id) ?? null;

const $ = (id) => dom.get(id);

// ------------------------------------------------- servidor de signaling ----

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.last = this;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.fire('close', {});
  }

  fire(type, props = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...props });
  }

  /** Uma mensagem vinda do servidor. */
  receive(msg) {
    this.fire('message', { data: JSON.stringify(msg) });
  }

  ofType(type) {
    return this.sent.filter((m) => m.t === type);
  }
}

const location = { protocol: 'http:', host: 'localhost:5173', reloads: 0, reload() {
  this.reloads += 1;
} };

Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, writable: true, configurable: true });
Object.defineProperty(globalThis, 'location', { value: location, writable: true, configurable: true });

await import('../src/main.js');

// ------------------------------------------------------------------ ajuda ---

/** Deixa as promessas pendentes (getUserMedia, replaceTrack) resolverem. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const socket = () => FakeWebSocket.last;
const tilesDo = () => $('tiles').children;
const tilePorTexto = (trecho) => tilesDo().find((t) => t.textContent.includes(trecho));
const osciladores = () => env.audioContexts.flatMap((c) => c.oscillators);

const EU = { id: 'eu-1', name: 'Nicolas' };
const ANA = { id: 'p-ana', name: 'Ana', state: { mic: true, cam: false, screen: false } };
const BRUNO = { id: 'p-bruno', name: 'Bruno', state: { mic: true, cam: false, screen: false } };

test('uma chamada de ponta a ponta', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });

  /**
   * Anda com o relogio em passos curtos.
   *
   * Um `tick(4000)` unico leva o relogio direto para o fim e SO ENTAO dispara
   * os timers acumulados — todos enxergando o mesmo "agora". O drenador de
   * presenca depende de instantes intermediarios (promove a saida num tick,
   * fecha a janela de agrupamento no seguinte), entao com um tick unico ele
   * nunca emitiria. Em passos, o relogio avanca como no navegador.
   */
  const avancar = (ms, passo = 150) => {
    for (let restante = ms; restante > 0; restante -= passo) {
      t.mock.timers.tick(Math.min(passo, restante));
    }
  };

  await t.test('entrar na sala abre o microfone e anuncia o estado', async () => {
    $('name').value = '  Nicolas  ';
    $('room').value = 'wtk';

    $('lobby-form').fire('submit');
    await flush();

    assert.equal($('lobby').hidden, true);
    assert.equal($('call').hidden, false);
    assert.equal(env.mediaDevices.userMediaCalls.filter((c) => c.audio).length, 1);
    assert.equal(env.mediaDevices.userMediaCalls.filter((c) => c.video).length, 0, 'camera so sob demanda');

    socket().fire('open');
    const [join] = socket().ofType('join');
    assert.deepEqual(join, { t: 'join', room: 'wtk', name: 'Nicolas' });
  });

  await t.test('a propria entrada NAO toca som nem abre modal', async () => {
    socket().receive({ t: 'welcome', self: EU, peers: [], sharer: null });
    await flush();
    avancar(1000); // deixa o drenador de presenca rodar

    assert.equal($('modal-root').hidden, true, 'nao se avisa a pessoa da propria chegada');
    assert.equal(osciladores().length, 0, 'e muito menos com som');
    assert.equal(tilesDo().length, 1, 'so o proprio tile');
    assert.ok(tilePorTexto('(você)'));
    assert.deepEqual(socket().ofType('state').at(-1).patch, { cam: false, mic: true, screen: false });
  });

  await t.test('quem entra depois vira modal com som e uma conexao nova', async () => {
    socket().receive({ t: 'peer-join', peer: ANA });
    await flush();
    avancar(1000);

    assert.equal($('modal-root').hidden, false, 'entrada exige acao explicita');
    assert.equal($('modal-body').textContent, 'Ana entrou na chamada');
    assert.equal(osciladores().length, 1, 'um som curto de entrada');

    // A malha WebRTC: quem ja estava oferta.
    assert.equal(env.peers.length, 1);
    const oferta = socket().ofType('signal').at(-1);
    assert.equal(oferta.to, ANA.id);
    assert.equal(oferta.data.description.type, 'offer');

    $('modal-ok').fire('click');
    assert.equal($('modal-root').hidden, true);
  });

  await t.test('a camera liga, publica o estado e aparece no tile', async () => {
    $('btn-cam').fire('click');
    await flush();
    await flush();

    assert.equal(env.mediaDevices.userMediaCalls.filter((c) => c.video).length, 1);
    assert.equal($('btn-cam').getAttribute('aria-pressed'), 'true');
    assert.equal(tilePorTexto('(você)').dataset.video, 'on');
    assert.equal(socket().ofType('state').at(-1).patch.cam, true);

    const camSender = env.peers[0].getSenders()[1];
    assert.ok(camSender.track, 'o track precisa chegar ao sender da camera');
  });

  await t.test('desligar a camera fecha o dispositivo e limpa o sender', async () => {
    const camTrack = env.allTracks.find((tk) => tk.kind === 'video');

    $('btn-cam').fire('click');
    await flush();
    await flush();

    assert.equal(camTrack.stopCount, 1, 'stop() de verdade — o LED apaga');
    assert.equal(camTrack.readyState, 'ended');
    assert.equal(env.peers[0].getSenders()[1].track, null, 'o outro lado nao pode ficar com quadro preso');
    assert.equal(tilePorTexto('(você)').dataset.video, 'off');
    assert.equal(socket().ofType('state').at(-1).patch.cam, false);
    assert.ok($('toasts').children.some((el) => el.textContent.includes('Câmera encerrada')));
  });

  await t.test('cinco ciclos de camera nao deixam track vivo nem quebram a conexao', async () => {
    const pcAntes = env.peers.length;
    for (let i = 0; i < 5; i += 1) {
      $('btn-cam').fire('click');
      await flush();
      await flush();
      $('btn-cam').fire('click');
      await flush();
      await flush();
    }

    assert.equal(env.liveTracks.filter((tk) => tk.kind === 'video').length, 0, 'nenhum track de video orfao');
    assert.equal(env.peers.length, pcAntes, 'nenhuma conexao nova: sem renegociacao');
    assert.equal(env.peers[0].closed, false, 'a conexao continua de pe');
    assert.equal($('btn-cam').disabled, false, 'o botao volta a ficar clicavel');
  });

  await t.test('compartilhar tela pede a trava antes de abrir o seletor', async () => {
    $('btn-share').fire('click');
    await flush();

    assert.equal(socket().ofType('share-request').length, 1);
    assert.equal(env.mediaDevices.displayMediaCalls.length, 0, 'nada de seletor antes do "sim"');
  });

  await t.test('com a trava concedida, a tela e capturada e vira um tile', async () => {
    socket().receive({ t: 'share-granted' });
    await flush();
    await flush();

    assert.equal(env.mediaDevices.displayMediaCalls.length, 1);
    assert.ok(tilePorTexto('Sua tela'), 'a propria tela aparece na grade');
    assert.equal($('tiles').dataset.screen, 'true');
    assert.equal(socket().ofType('state').at(-1).patch.screen, true);
    assert.ok(env.peers[0].getSenders()[2].track, 'a tela vai pelo slot 2');
    assert.equal($('btn-share').querySelector('.label').textContent, 'Parar de compartilhar');
  });

  await t.test('parar pelo botao nativo do navegador restaura a chamada', async () => {
    // Liga a camera antes, para provar que ela volta intacta.
    $('btn-cam').fire('click');
    await flush();
    await flush();
    const camTrack = env.liveTracks.find((tk) => tk.kind === 'video' && tk.label === 'Camera');

    const telaTrack = env.allTracks.find((tk) => tk.label === 'Tela 1');
    telaTrack.fire('ended'); // a barrinha "Parar de compartilhar" do Chrome
    await flush();
    await flush();

    assert.equal(tilePorTexto('Sua tela'), undefined, 'o tile da tela some');
    assert.equal($('tiles').dataset.screen, 'false');
    assert.equal(env.peers[0].getSenders()[2].track, null);
    assert.equal(socket().ofType('share-stop').length, 1, 'a trava precisa voltar para a sala');
    assert.equal(socket().ofType('state').at(-1).patch.screen, false);

    // E a camera: intacta, ainda emitindo.
    assert.equal(camTrack.readyState, 'live');
    assert.equal(camTrack.stopCount, 0);
    assert.equal(env.peers[0].getSenders()[1].track, camTrack);
    assert.equal(tilePorTexto('(você)').dataset.video, 'on');
  });

  await t.test('quando outra pessoa esta compartilhando, o botao trava com aviso', async () => {
    socket().receive({ t: 'share-state', holder: { id: ANA.id, name: 'Ana' } });
    await flush();

    assert.equal($('btn-share').disabled, true);
    assert.match($('btn-share').title, /Ana está compartilhando/);

    socket().receive({ t: 'share-denied', holder: { id: ANA.id, name: 'Ana' } });
    await flush();
    assert.ok($('toasts').children.some((el) => el.textContent.includes('Ana já está compartilhando')));

    socket().receive({ t: 'share-state', holder: null });
    await flush();
    assert.equal($('btn-share').disabled, false, 'liberou, o botao volta');
  });

  await t.test('o chat troca mensagens e conta as nao lidas', async () => {
    $('chat-input').value = 'bom dia a todos';
    $('chat-form').fire('submit');
    await flush();

    assert.deepEqual(socket().ofType('chat').at(-1), { t: 'chat', text: 'bom dia a todos' });

    // O servidor devolve para todos, inclusive para o remetente.
    socket().receive({ t: 'chat', from: EU, text: 'bom dia a todos' });
    socket().receive({ t: 'chat', from: ANA, text: 'bom dia!' });
    await flush();

    const linhas = $('chat-log').children;
    assert.ok(linhas.some((l) => l.textContent.includes('bom dia!')));
    assert.equal($('chat-badge').hidden, false, 'painel fechado: badge aparece');
    assert.equal($('chat-badge').textContent, '2');

    $('btn-chat').fire('click');
    assert.equal($('chat-panel').hidden, false);
    assert.equal($('chat-badge').hidden, true, 'abrir zera o badge');
  });

  await t.test('mensagem com HTML chega como texto', async () => {
    socket().receive({ t: 'chat', from: ANA, text: '<script>alert(1)</script>' });
    await flush();

    const ultima = $('chat-log').children.at(-1);
    assert.equal(ultima.descendants().filter((el) => el.tagName === 'SCRIPT').length, 0);
    assert.match(ultima.textContent, /<script>alert\(1\)<\/script>/);
  });

  await t.test('saida de participante gera toast com som, sem modal', async () => {
    const antes = osciladores().length;
    $('toasts').replaceChildren(); // limpa os avisos das cenas anteriores
    socket().receive({ t: 'peer-leave', peer: ANA });
    await flush();
    // Debounce de 2 s (reconexao) + janela de agrupamento de 600 ms.
    avancar(4000);

    assert.ok(
      $('toasts').children.some((el) => el.textContent === 'Ana saiu da chamada'),
      'saida e discreta: toast, nao modal',
    );
    assert.equal($('modal-root').hidden, true);
    assert.equal(osciladores().length, antes + 1, 'som curto de saida');
    assert.equal(env.peers[0].closed, true, 'a conexao com quem saiu e fechada');
  });

  await t.test('saidas simultaneas sao agrupadas em um aviso so', async () => {
    socket().receive({ t: 'peer-join', peer: BRUNO });
    socket().receive({ t: 'peer-join', peer: { ...ANA, id: 'p-ana-2' } });
    await flush();
    avancar(1000);
    $('modal-ok').fire('click');
    $('modal-ok').fire('click');

    $('toasts').replaceChildren();
    socket().receive({ t: 'peer-leave', peer: BRUNO });
    socket().receive({ t: 'peer-leave', peer: { ...ANA, id: 'p-ana-2' } });
    await flush();
    avancar(4000);

    const novos = $('toasts').children;
    assert.equal(novos.length, 1, 'duas saidas juntas = um aviso, nao dois');
    assert.match(novos[0].textContent, /saíram da chamada/);
  });

  await t.test('silenciar os avisos cala os sons e mantem os toasts', async () => {
    $('btn-sound').fire('click');
    assert.equal($('btn-sound').getAttribute('aria-pressed'), 'false');
    assert.equal(env.localStorage.getItem('wtk-meet:sons'), 'off');

    const antes = osciladores().length;
    socket().receive({ t: 'peer-join', peer: { ...ANA, id: 'p-ana-3' } });
    await flush();
    avancar(1000);

    assert.equal(osciladores().length, antes, 'nenhum som novo');
    assert.equal($('modal-root').hidden, false, 'o aviso visual continua');
    $('modal-ok').fire('click');

    $('btn-sound').fire('click'); // devolve ao padrao
  });

  await t.test('atalhos de teclado operam os controles', async () => {
    const antesMic = $('btn-mic').getAttribute('aria-pressed');
    env.document.fire('keydown', { key: 'm', target: $('call') });
    await flush();
    assert.notEqual($('btn-mic').getAttribute('aria-pressed'), antesMic);
    env.document.fire('keydown', { key: 'm', target: $('call') });
    await flush();

    // Digitar no chat nao pode acionar atalho.
    const painelAntes = $('chat-panel').hidden;
    env.document.fire('keydown', { key: 'c', target: $('chat-input') });
    assert.equal($('chat-panel').hidden, painelAntes);
  });

  await t.test('sair da sala nao deixa nada aberto', async () => {
    $('btn-cam').fire('click');
    await flush();
    await flush();
    assert.ok(env.liveTracks.length > 0, 'controle: havia midia aberta');

    $('btn-leave').fire('click');
    await flush();

    assert.equal(
      env.liveTracks.length,
      0,
      `nenhum dispositivo pode sobreviver a saida — abertos: ${env.liveTracks.map((tk) => tk.label)}`,
    );
    assert.ok(
      env.peers.every((pc) => pc.closed),
      'todas as conexoes fechadas',
    );
    assert.equal($('chat-log').children.length, 0, 'o historico do chat morre aqui');
    assert.equal($('tiles').children.length, 0);
    assert.equal(socket().readyState, FakeWebSocket.CLOSED);
    assert.equal(location.reloads, 1);
  });
});
