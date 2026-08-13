/**
 * Testes da seleção de dispositivos de mídia.
 *
 * O que está aqui é justamente o que o E2E não alcança de forma confiável: a
 * normalização da lista crua do navegador (que difere entre Chrome e Firefox), a
 * resolução de uma preferência salva que aponta para hardware que não existe
 * mais, e a leitura de um `localStorage` corrompido. Tudo é entrada→saída, então
 * roda em `node:test` sem navegador, sem jsdom e sem mock de `navigator`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DEVICE_LABEL,
  DEFAULT_PREFERENCES,
  STORAGE_KEY,
  buildConstraints,
  isSinkIdSupported,
  listDevices,
  preferenceKeyForKind,
  readPreferences,
  reconcilePreferences,
  resolvePreferredDevice,
  writePreferences,
} from '../src/lib/devices.js';

/** `localStorage` de mentira, com gatilhos de falha por operação. */
function fakeStorage(initial = {}, { failGet = false, failSet = false } = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key) {
      if (failGet) throw new DOMException('SecurityError');
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (failSet) throw new DOMException('QuotaExceededError');
      data.set(key, value);
    },
  };
}

const device = (kind, deviceId, label = '', groupId = '') => ({ kind, deviceId, label, groupId });

// --------------------------------------------------------------- listagem

test('listDevices separa os três kinds e prepende "Padrão do sistema" em cada um', () => {
  const { videoInputs, audioInputs, audioOutputs } = listDevices([
    device('videoinput', 'cam-1', 'Webcam USB', 'g1'),
    device('audioinput', 'mic-1', 'Headset', 'g2'),
    device('audiooutput', 'spk-1', 'Alto-falantes', 'g3'),
  ]);

  for (const list of [videoInputs, audioInputs, audioOutputs]) {
    assert.equal(list.length, 2);
    assert.deepEqual(list[0], { deviceId: '', label: DEFAULT_DEVICE_LABEL, groupId: '' });
  }
  assert.equal(videoInputs[1].label, 'Webcam USB');
  assert.equal(audioInputs[1].deviceId, 'mic-1');
  assert.equal(audioOutputs[1].groupId, 'g3');
});

test('listDevices tolera entrada ausente, nula ou não-array', () => {
  for (const input of [undefined, null, 'nada', 42, {}]) {
    const lists = listDevices(input);
    assert.deepEqual(Object.keys(lists), ['videoInputs', 'audioInputs', 'audioOutputs']);
    for (const list of Object.values(lists)) {
      assert.equal(list.length, 1);
      assert.equal(list[0].deviceId, '');
    }
  }
});

test('listDevices descarta entradas sem deviceId (lista de antes da permissão)', () => {
  const { videoInputs } = listDevices([
    device('videoinput', '', ''),
    device('videoinput', 'cam-1', 'Webcam'),
  ]);
  assert.deepEqual(
    videoInputs.map((d) => d.deviceId),
    ['', 'cam-1'],
  );
});

test('listDevices descarta os aliases reservados do Chrome (default/communications)', () => {
  // É exatamente a lista que o Chrome devolve: o mesmo microfone três vezes.
  const { audioInputs } = listDevices([
    device('audioinput', 'default', 'Padrão - Microfone (Realtek)', 'g1'),
    device('audioinput', 'communications', 'Comunicações - Microfone (Realtek)', 'g1'),
    device('audioinput', 'abc123', 'Microfone (Realtek)', 'g1'),
  ]);
  assert.deepEqual(
    audioInputs.map((d) => d.deviceId),
    ['', 'abc123'],
  );
});

test('listDevices deduplica por deviceId (primeiro vence) e por (groupId, label)', () => {
  const { videoInputs } = listDevices([
    device('videoinput', 'cam-1', 'Webcam', 'g1'),
    device('videoinput', 'cam-1', 'Webcam (cópia)', 'g1'),
    device('videoinput', 'cam-2', 'Webcam', 'g1'),
  ]);
  assert.deepEqual(
    videoInputs.map((d) => `${d.deviceId}:${d.label}`),
    [':' + DEFAULT_DEVICE_LABEL, 'cam-1:Webcam'],
  );
});

test('listDevices NÃO colapsa duas webcams idênticas de grupos diferentes', () => {
  // Mesmo modelo, mesmo rótulo, hardware distinto: deduplicar por rótulo faria
  // o usuário perder acesso a metade do hardware.
  const { videoInputs } = listDevices([
    device('videoinput', 'cam-1', 'Logitech C920', 'g1'),
    device('videoinput', 'cam-2', 'Logitech C920', 'g2'),
  ]);
  assert.deepEqual(
    videoInputs.map((d) => d.deviceId),
    ['', 'cam-1', 'cam-2'],
  );
});

test('listDevices sintetiza rótulo por posição quando o navegador não dá um', () => {
  const { videoInputs, audioInputs, audioOutputs } = listDevices([
    device('videoinput', 'cam-1', ''),
    device('videoinput', 'cam-2', '   '),
    device('audioinput', 'mic-1', ''),
    device('audiooutput', 'spk-1', ''),
  ]);
  assert.deepEqual(videoInputs.slice(1).map((d) => d.label), ['Câmera 1', 'Câmera 2']);
  assert.equal(audioInputs[1].label, 'Microfone 1');
  assert.equal(audioOutputs[1].label, 'Saída 1');
});

test('listDevices preserva o rótulo real quando ele existe (permissão concedida)', () => {
  const { audioInputs } = listDevices([device('audioinput', 'mic-1', '  Jabra Evolve  ')]);
  assert.equal(audioInputs[1].label, 'Jabra Evolve');
});

// ------------------------------------------------- resolução da preferência

test('resolvePreferredDevice: id salvo presente na lista é usado como está', () => {
  const { audioInputs } = listDevices([device('audioinput', 'mic-1', 'Headset')]);
  assert.deepEqual(resolvePreferredDevice(audioInputs, 'mic-1'), {
    deviceId: 'mic-1',
    fellBack: false,
  });
});

test('resolvePreferredDevice: sem id salvo, usa o default sem marcar fallback', () => {
  const { audioInputs } = listDevices([device('audioinput', 'mic-1', 'Headset')]);
  for (const empty of ['', null, undefined, 0, 123]) {
    assert.deepEqual(resolvePreferredDevice(audioInputs, empty), { deviceId: '', fellBack: false });
  }
});

test('resolvePreferredDevice: id salvo que sumiu cai para o default e sinaliza fallback', () => {
  const { videoInputs } = listDevices([device('videoinput', 'cam-1', 'Webcam')]);
  assert.deepEqual(resolvePreferredDevice(videoInputs, 'cam-de-outra-maquina'), {
    deviceId: '',
    fellBack: true,
  });
  // Lista ausente é tratada como lista vazia — nunca lança.
  assert.deepEqual(resolvePreferredDevice(undefined, 'cam-1'), { deviceId: '', fellBack: true });
});

// ------------------------------------------------------------- constraints

test('buildConstraints: id vazio vira `true` (sem restrição), id preenchido vira ideal', () => {
  const prefs = { ...DEFAULT_PREFERENCES, videoInputId: 'cam-1' };
  assert.deepEqual(buildConstraints(prefs, { video: true, audio: true }), {
    video: { deviceId: { ideal: 'cam-1' } },
    audio: true,
  });
});

test('buildConstraints: mídia não pedida vira `false`, e prefs ausente usa os defaults', () => {
  assert.deepEqual(buildConstraints(null, { video: true, audio: false }), {
    video: true,
    audio: false,
  });
  assert.deepEqual(buildConstraints(DEFAULT_PREFERENCES, {}), { video: false, audio: false });
});

test('buildConstraints nunca usa `exact` (que exigiria tratar OverconstrainedError)', () => {
  const prefs = { ...DEFAULT_PREFERENCES, videoInputId: 'cam-1', audioInputId: 'mic-1' };
  const json = JSON.stringify(buildConstraints(prefs, { video: true, audio: true }));
  assert.ok(!json.includes('exact'), json);
});

// ------------------------------------------------------------ persistência

test('readPreferences devolve os defaults quando não há nada gravado', () => {
  assert.deepEqual(readPreferences(fakeStorage()), DEFAULT_PREFERENCES);
});

test('readPreferences nunca lança: storage ausente, getItem lançando, JSON corrompido', () => {
  assert.deepEqual(readPreferences(undefined), DEFAULT_PREFERENCES);
  assert.deepEqual(readPreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(readPreferences({}), DEFAULT_PREFERENCES);
  assert.deepEqual(readPreferences(fakeStorage({}, { failGet: true })), DEFAULT_PREFERENCES);
  assert.deepEqual(
    readPreferences(fakeStorage({ [STORAGE_KEY]: '{isso não é json' })),
    DEFAULT_PREFERENCES,
  );
  assert.deepEqual(readPreferences(fakeStorage({ [STORAGE_KEY]: '"uma string"' })), DEFAULT_PREFERENCES);
});

test('readPreferences valida tipos por campo e descarta chaves desconhecidas', () => {
  const stored = JSON.stringify({
    videoInputId: 'cam-1',
    audioInputId: 42,
    audioOutputId: null,
    soundsEnabled: 'sim',
    displayName: 'não deveria persistir',
  });
  assert.deepEqual(readPreferences(fakeStorage({ [STORAGE_KEY]: stored })), {
    videoInputId: 'cam-1',
    audioInputId: '',
    audioOutputId: '',
    soundsEnabled: true, // qualquer coisa que não seja boolean cai no comportamento atual
  });
});

test('writePreferences faz merge sobre o gravado, sob a chave wtk-meet:devices', () => {
  const storage = fakeStorage();
  writePreferences(storage, { videoInputId: 'cam-1' });
  const result = writePreferences(storage, { soundsEnabled: false });

  assert.deepEqual(result, {
    videoInputId: 'cam-1',
    audioInputId: '',
    audioOutputId: '',
    soundsEnabled: false,
  });
  assert.deepEqual(Object.keys(JSON.parse(storage.data.get(STORAGE_KEY))).sort(), [
    'audioInputId',
    'audioOutputId',
    'soundsEnabled',
    'videoInputId',
  ]);
});

test('writePreferences engole falha de escrita e devolve o valor efetivo da sessão', () => {
  const storage = fakeStorage({}, { failSet: true });
  assert.deepEqual(writePreferences(storage, { audioOutputId: 'spk-1' }), {
    ...DEFAULT_PREFERENCES,
    audioOutputId: 'spk-1',
  });
  assert.equal(storage.data.size, 0);
});

// ------------------------------------------------------------ reconciliação

const track = (kind, deviceId) => ({ kind, getSettings: () => ({ deviceId }) });

test('reconcilePreferences corrige o id quando o navegador abriu outro device', () => {
  const prefs = { ...DEFAULT_PREFERENCES, videoInputId: 'cam-que-sumiu', audioInputId: 'mic-1' };
  const { prefs: next, changed } = reconcilePreferences(prefs, [
    track('video', 'cam-real'),
    track('audio', 'mic-1'),
  ]);
  assert.equal(changed, true);
  assert.equal(next.videoInputId, 'cam-real');
  assert.equal(next.audioInputId, 'mic-1');
});

test('reconcilePreferences não marca mudança quando o pedido foi atendido', () => {
  const prefs = { ...DEFAULT_PREFERENCES, audioInputId: 'mic-1' };
  const { prefs: next, changed } = reconcilePreferences(prefs, [track('audio', 'mic-1')]);
  assert.equal(changed, false);
  assert.deepEqual(next, prefs);
});

test('reconcilePreferences não transforma "padrão do sistema" numa escolha concreta', () => {
  const { prefs, changed } = reconcilePreferences(DEFAULT_PREFERENCES, [
    track('video', 'cam-do-momento'),
    track('audio', 'mic-do-momento'),
  ]);
  assert.equal(changed, false);
  assert.deepEqual(prefs, DEFAULT_PREFERENCES);
});

test('reconcilePreferences trata os aliases reservados como "padrão do sistema"', () => {
  const prefs = { ...DEFAULT_PREFERENCES, audioInputId: 'mic-1' };
  const { prefs: next, changed } = reconcilePreferences(prefs, [track('audio', 'default')]);
  assert.equal(changed, true);
  assert.equal(next.audioInputId, '');
});

test('reconcilePreferences mantém o pedido quando o navegador não informa o id', () => {
  const prefs = { ...DEFAULT_PREFERENCES, audioInputId: 'mic-1' };
  const semSettings = { kind: 'audio' };
  const lancando = {
    kind: 'audio',
    getSettings() {
      throw new Error('sem suporte');
    },
  };
  for (const t of [track('audio', ''), track('audio', undefined), semSettings, lancando]) {
    const { prefs: next, changed } = reconcilePreferences(prefs, [t]);
    assert.equal(changed, false);
    assert.equal(next.audioInputId, 'mic-1');
  }
});

test('reconcilePreferences ignora tracks nulas e kinds desconhecidos', () => {
  const prefs = { ...DEFAULT_PREFERENCES, videoInputId: 'cam-1' };
  const { changed } = reconcilePreferences(prefs, [null, undefined, track('data', 'x')]);
  assert.equal(changed, false);
  assert.equal(reconcilePreferences(prefs, undefined).changed, false);
});

// ------------------------------------------------------------------ utilitários

test('isSinkIdSupported detecta a presença de setSinkId no protótipo', () => {
  assert.equal(isSinkIdSupported({ setSinkId() {} }), true);
  assert.equal(isSinkIdSupported({}), false);
  assert.equal(isSinkIdSupported(null), false);
  assert.equal(isSinkIdSupported(undefined), false); // sem HTMLMediaElement (node)
});

test('preferenceKeyForKind mapeia kind do navegador para chave de preferência', () => {
  assert.equal(preferenceKeyForKind('videoinput'), 'videoInputId');
  assert.equal(preferenceKeyForKind('audioinput'), 'audioInputId');
  assert.equal(preferenceKeyForKind('audiooutput'), 'audioOutputId');
  assert.equal(preferenceKeyForKind('teleporte'), null);
});
