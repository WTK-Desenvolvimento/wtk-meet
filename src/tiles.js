import { createSpeakingRing } from './speaking-ring.js';

/**
 * Grade de participantes.
 *
 * O nivel de voz e escrito direto na custom property `--level` do elemento.
 * Nenhum re-render de framework a 60 fps — essa e a diferenca entre 60 fps e
 * uma UI travada com oito pessoas na sala.
 */

export function createTileGrid(container) {
  /** @type {Map<string, object>} */
  const tiles = new Map();

  function ensure(id, { name, local = false, screen = false }) {
    let tile = tiles.get(id);
    if (tile) return tile;

    const el = document.createElement('div');
    el.className = `tile${screen ? ' screen' : ''}`;
    el.dataset.video = 'off';
    el.dataset.speaking = 'false';
    el.dataset.mic = 'on';

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = local; // sem isso, o proprio audio volta como eco
    el.appendChild(video);

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initials(name);
    el.appendChild(avatar);

    const canvas = document.createElement('canvas');
    canvas.className = 'waves';
    canvas.setAttribute('aria-hidden', 'true');
    el.appendChild(canvas);

    const plate = document.createElement('div');
    plate.className = 'nameplate';
    const dot = document.createElement('span');
    dot.className = 'mic-dot';
    const label = document.createElement('span');
    label.textContent = local ? `${name} (você)` : name;
    plate.append(dot, label);
    el.appendChild(plate);

    container.appendChild(el);
    tile = { id, el, video, avatar, label, stream: new MediaStream(), ring: createSpeakingRing(canvas), screen };
    tiles.set(id, tile);
    reflow();
    return tile;
  }

  function setTrack(id, kind, track) {
    const tile = tiles.get(id);
    if (!tile) return;
    for (const existing of tile.stream.getTracks()) {
      if (existing.kind === kind) tile.stream.removeTrack(existing);
    }
    if (track) tile.stream.addTrack(track);
    if (tile.video.srcObject !== tile.stream) tile.video.srcObject = tile.stream;
    if (kind === 'video') {
      tile.el.dataset.video = track ? 'on' : 'off';
    }
    // play() pode ser rejeitado por politica de autoplay; o audio ja esta no
    // elemento e volta assim que houver interacao.
    tile.video.play?.().catch(() => {});
  }

  function setName(id, name) {
    const tile = tiles.get(id);
    if (!tile) return;
    tile.label.textContent = name;
    tile.avatar.textContent = initials(name);
  }

  function setMic(id, on) {
    const tile = tiles.get(id);
    if (tile) tile.el.dataset.mic = on ? 'on' : 'off';
  }

  /** Chamado a cada quadro pelo medidor. Caminho quente: manter barato. */
  function setLevel(id, state) {
    const tile = tiles.get(id);
    if (!tile) return;
    tile.el.style.setProperty('--level', state.level.toFixed(3));
    const speaking = String(state.speaking);
    if (tile.el.dataset.speaking !== speaking) tile.el.dataset.speaking = speaking;
    tile.ring.render(state);
  }

  function remove(id) {
    const tile = tiles.get(id);
    if (!tile) return;
    tile.ring.clear();
    tile.video.srcObject = null;
    tile.el.remove();
    tiles.delete(id);
    reflow();
  }

  function reflow() {
    container.dataset.screen = String([...tiles.values()].some((t) => t.screen));
  }

  return {
    ensure,
    setTrack,
    setName,
    setMic,
    setLevel,
    remove,
    has: (id) => tiles.has(id),
    ids: () => [...tiles.keys()],
    clear() {
      for (const id of [...tiles.keys()]) remove(id);
    },
  };
}

function initials(name) {
  return String(name ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
}
