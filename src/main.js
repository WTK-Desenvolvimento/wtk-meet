import { createSignaling } from './signaling.js';
import { createLocalMedia, SUPPORTS_SCREEN_SHARE } from './media.js';
import { createPeerHub, SLOT } from './rtc.js';
import { createAudioMeter } from './audio-meter.js';
import { createTileGrid } from './tiles.js';
import { createChat } from './chat.js';
import { createNotifier } from './notifications.js';
import { createPresenceTracker, describeBatch } from './lib/presence.js';
import { normalizeName } from './lib/text.js';

/** Fio condutor: liga signaling, midia, WebRTC, medidor de voz, chat e avisos. */

const $ = (id) => document.getElementById(id);

const el = {
  lobby: $('lobby'),
  lobbyForm: $('lobby-form'),
  name: $('name'),
  room: $('room'),
  call: $('call'),
  tiles: $('tiles'),
  btnMic: $('btn-mic'),
  btnCam: $('btn-cam'),
  btnShare: $('btn-share'),
  btnChat: $('btn-chat'),
  btnSound: $('btn-sound'),
  btnLeave: $('btn-leave'),
};

const signaling = createSignaling();
const media = createLocalMedia();
const tiles = createTileGrid(el.tiles);

const notifier = createNotifier({
  toastContainer: $('toasts'),
  modalRoot: $('modal-root'),
  modalTitle: $('modal-title'),
  modalBody: $('modal-body'),
  modalOk: $('modal-ok'),
});

const meter = createAudioMeter({
  onUpdate(results) {
    for (const [id, state] of results) tiles.setLevel(id, state);
  },
});

// Ids de conexao mudam a cada socket; o nome e o que o usuario reconhece — e
// portanto o que casa "saiu" com "voltou" apos uma oscilacao de rede.
const presence = createPresenceTracker({ keyOf: (peer) => peer.name.toLowerCase() });

const hub = createPeerHub({
  signaling,
  getLocalTracks: () => media.raw,
  onRemoteTrack: handleRemoteTrack,
});

const chat = createChat({
  panel: $('chat-panel'),
  log: $('chat-log'),
  form: $('chat-form'),
  input: $('chat-input'),
  counter: $('chat-count'),
  badge: $('chat-badge'),
  toggleButton: el.btnChat,
  closeButton: $('chat-close'),
  onSend: (text) => signaling.send({ t: 'chat', text }),
});

const self = { id: null, name: '' };
/** @type {{id:string, name:string}|null} */
let sharer = null;
let presenceTimer = null;

// ---------------------------------------------------------------- lobby ----

el.lobbyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = normalizeName(el.name.value);
  const room = el.room.value.trim() || 'wtk';

  notifier.unlock(); // o gesto do usuario e a unica chance de liberar audio
  try {
    await media.startMic();
  } catch {
    notifier.toast('Sem acesso ao microfone. Você entra, mas ninguém te ouve.', 'warn');
  }

  self.name = name;
  el.lobby.hidden = true;
  el.call.hidden = false;
  signaling.connect({ room, name });
  presenceTimer = setInterval(drainPresence, 300);
});

// ------------------------------------------------------------ signaling ----

signaling.on('welcome', (msg) => {
  self.id = msg.self.id;
  sharer = msg.sharer;

  tiles.ensure(self.id, { name: self.name, local: true });
  const micStream = media.micStream();
  if (micStream) meter.add(self.id, micStream);
  tiles.setMic(self.id, media.snapshot().micOn);

  for (const peer of msg.peers) {
    tiles.ensure(peer.id, { name: peer.name });
    tiles.setMic(peer.id, peer.state.mic);
    // Quem ja estava na sala oferta; nos apenas respondemos.
  }

  publishState();
  updateShareButton();
  chat.system(
    msg.peers.length === 0
      ? 'Você é a primeira pessoa na sala.'
      : `Você entrou. ${msg.peers.length} pessoa(s) na chamada.`,
  );
  // Sem som nem modal para a propria entrada.
});

signaling.on('peer-join', async (msg) => {
  const peer = msg.peer;
  tiles.ensure(peer.id, { name: peer.name });
  tiles.setMic(peer.id, peer.state.mic);
  presence.join(peer, Date.now());
  await hub.offerTo(peer.id);
});

signaling.on('peer-leave', (msg) => {
  // A limpeza tecnica e imediata; o AVISO e que espera o debounce.
  hub.close(msg.peer.id);
  meter.remove(msg.peer.id);
  tiles.remove(msg.peer.id);
  tiles.remove(screenTileId(msg.peer.id));
  presence.leave(msg.peer, Date.now());
});

signaling.on('signal', (msg) => {
  hub.handleSignal(msg.from, msg.data).catch((err) => {
    console.error('falha ao processar signaling', err);
  });
});

signaling.on('peer-state', (msg) => {
  tiles.setMic(msg.id, msg.state.mic);
  // `replaceTrack(null)` nao gera evento confiavel do outro lado — este anuncio
  // e o que evita o quadro congelado no lugar do avatar.
  if (!msg.state.cam) tiles.setTrack(msg.id, 'video', null);
  if (!msg.state.screen) tiles.remove(screenTileId(msg.id));
});

signaling.on('chat', (msg) => {
  chat.append(msg, { mine: msg.from.id === self.id });
});

signaling.on('chat-rejected', (msg) => {
  const texts = {
    'rate-limit': 'Devagar: muitas mensagens seguidas.',
    'muito-longa': 'Mensagem longa demais.',
    vazia: '',
  };
  if (texts[msg.reason]) notifier.toast(texts[msg.reason], 'warn');
});

signaling.on('share-state', (msg) => {
  sharer = msg.holder;
  updateShareButton();
});

signaling.on('share-denied', (msg) => {
  sharer = msg.holder;
  updateShareButton();
  notifier.toast(`${msg.holder?.name ?? 'Outra pessoa'} já está compartilhando a tela.`, 'warn');
});

signaling.on('disconnected', () => {
  notifier.toast('Conexão com a sala perdida.', 'warn');
});

// ------------------------------------------------------------- presenca ----

function drainPresence() {
  for (const batch of presence.tick(Date.now())) {
    const text = describeBatch(batch);
    if (batch.type === 'join') {
      notifier.playSound('join');
      notifier.showModal('Alguém entrou', text); // acao explicita, como pedido
    } else {
      notifier.playSound('leave');
      notifier.toast(text);
    }
    chat.system(text);
  }
}

// ----------------------------------------------------------- midia local ----

function handleRemoteTrack(peerId, slot, track) {
  if (slot === SLOT.AUDIO) {
    tiles.ensure(peerId, { name: peerId });
    tiles.setTrack(peerId, 'audio', track);
    // O analisador precisa do stream tambem anexado a um elemento vivo — o
    // tile ja faz isso, senao o Chrome entrega so zeros.
    meter.add(peerId, new MediaStream([track]));
    return;
  }
  if (slot === SLOT.CAMERA) {
    tiles.setTrack(peerId, 'video', track);
    track.addEventListener('mute', () => tiles.setTrack(peerId, 'video', null));
    return;
  }
  if (slot === SLOT.SCREEN) {
    const id = screenTileId(peerId);
    tiles.ensure(id, { name: 'Tela compartilhada', screen: true });
    tiles.setTrack(id, 'video', track);
    track.addEventListener('mute', () => tiles.remove(id));
  }
}

function screenTileId(peerId) {
  return `screen:${peerId}`;
}

function publishState() {
  const snap = media.snapshot();
  signaling.send({ t: 'state', patch: { cam: snap.camOn, mic: snap.micOn, screen: snap.sharing } });
}

el.btnMic.addEventListener('click', () => {
  const snap = media.toggleMic();
  el.btnMic.setAttribute('aria-pressed', String(snap.micOn));
  if (self.id) tiles.setMic(self.id, snap.micOn);
  publishState();
});

el.btnCam.addEventListener('click', async () => {
  if (el.btnCam.disabled) return;
  el.btnCam.disabled = true;
  el.btnCam.classList.add('busy');
  try {
    const wasOn = media.snapshot().camOn;
    const snap = await media.toggleCamera();
    await hub.republish();
    tiles.setTrack(self.id, 'video', snap.camTrack);
    el.btnCam.setAttribute('aria-pressed', String(snap.camOn));
    publishState();
    if (wasOn && !snap.camOn) {
      notifier.toast('Câmera encerrada — o indicador do dispositivo apaga.');
    }
  } catch (err) {
    const motivo =
      err?.name === 'NotAllowedError'
        ? 'Permissão de câmera negada.'
        : err?.name === 'NotReadableError'
          ? 'A câmera está em uso por outro aplicativo.'
          : 'Não foi possível abrir a câmera.';
    notifier.toast(motivo, 'warn');
  } finally {
    el.btnCam.disabled = false;
    el.btnCam.classList.remove('busy');
  }
});

el.btnShare.addEventListener('click', async () => {
  if (media.snapshot().sharing) {
    await stopSharing();
    return;
  }
  if (sharer && sharer.id !== self.id) {
    notifier.toast(`${sharer.name} já está compartilhando a tela.`, 'warn');
    return;
  }
  // Pede a trava antes de abrir o seletor: evita escolher a tela e ouvir "nao".
  signaling.send({ t: 'share-request' });
});

signaling.on('share-granted', async () => {
  try {
    const track = await media.startScreen(() => {
      // Encerrado pelo botao nativo do Chrome — o caminho mais comum.
      stopSharing();
    });
    await hub.republish();
    const id = screenTileId(self.id);
    tiles.ensure(id, { name: 'Sua tela', screen: true });
    tiles.setTrack(id, 'video', track);
    publishState();
    updateShareButton();
  } catch {
    // Seletor cancelado: devolver a trava, senao a sala fica travada por nada.
    signaling.send({ t: 'share-stop' });
    updateShareButton();
  }
});

async function stopSharing() {
  media.stopScreen();
  await hub.republish();
  tiles.remove(screenTileId(self.id));
  signaling.send({ t: 'share-stop' });
  publishState();
  updateShareButton();
}

function updateShareButton() {
  const sharing = media.snapshot().sharing;
  const blocked = Boolean(sharer && sharer.id !== self.id);
  el.btnShare.disabled = !SUPPORTS_SCREEN_SHARE || blocked;
  el.btnShare.setAttribute('aria-pressed', String(sharing));
  el.btnShare.querySelector('.label').textContent = sharing ? 'Parar de compartilhar' : 'Compartilhar tela';
  el.btnShare.title = !SUPPORTS_SCREEN_SHARE
    ? 'Este navegador não suporta compartilhamento de tela'
    : blocked
      ? `${sharer.name} está compartilhando`
      : 'Compartilhar tela';
}

el.btnSound.addEventListener('click', () => {
  notifier.setEnabled(!notifier.enabled);
  el.btnSound.setAttribute('aria-pressed', String(notifier.enabled));
  notifier.toast(notifier.enabled ? 'Sons de aviso ligados.' : 'Sons de aviso silenciados.');
});

el.btnLeave.addEventListener('click', leave);

function leave() {
  clearInterval(presenceTimer);
  hub.closeAll();
  meter.destroy();
  media.stopAll(); // nenhum track sobrevive a saida da sala
  chat.destroy(); // historico efemero morre aqui
  tiles.clear();
  signaling.close();
  location.reload();
}

// Atalhos: M microfone, V camera, C chat.
document.addEventListener('keydown', (event) => {
  if (el.call.hidden) return;
  if (event.target instanceof Element && event.target.matches('input, textarea')) return;
  const key = event.key.toLowerCase();
  if (key === 'm') el.btnMic.click();
  if (key === 'v') el.btnCam.click();
  if (key === 'c') el.btnChat.click();
});

window.addEventListener('pagehide', () => {
  media.stopAll();
  hub.closeAll();
});

media.subscribe((snap) => {
  el.btnMic.setAttribute('aria-pressed', String(snap.micOn));
  el.btnCam.setAttribute('aria-pressed', String(snap.camOn));
});

el.btnSound.setAttribute('aria-pressed', String(notifier.enabled));
updateShareButton();
