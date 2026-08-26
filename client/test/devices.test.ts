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
  initialMediaPlan,
  isSinkIdSupported,
  listDevices,
  preferenceKeyForKind,
  readPreferences,
  reconcilePreferences,
  resolvePreferredDevice,
  writePreferences,
} from '../src/lib/devices.js';

import type { DevicePreferences } from '../src/lib/devices.js';

/** `localStorage` de mentira, com gatilhos de falha por operação. */
function fakeStorage(
  initial: Record<string, string> = {},
  { failGet = false, failSet = false } = {},
) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem(key: string): string | null {
      if (failGet) throw new DOMException('SecurityError');
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      if (failSet) throw new DOMException('QuotaExceededError');
      data.set(key, value);
    },
  };
}

const device = (kind: string, deviceId: string, label = '', groupId = '') => ({ kind, deviceId, label, groupId });

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
    startCameraOff: true,
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
    startCameraOff: true,
  });
  assert.deepEqual(Object.keys(JSON.parse(storage.data.get(STORAGE_KEY)!)).sort(), [
    'audioInputId',
    'audioOutputId',
    'soundsEnabled',
    'startCameraOff',
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

const track = (kind: string, deviceId?: string) => ({ kind, getSettings: () => ({ deviceId }) });

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
  assert.equal(isSinkIdSupported({ setSinkId: async () => {} }), true);
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

// ------------------------------------------ preferência de entrada da câmera

/**
 * `startCameraOff` é a única preferência cujo default **não** é neutro: ele
 * decide se o LED da webcam acende ao abrir um link de sala. Por isso cada
 * caminho que pode produzir um valor — ausência, tipo errado, versão anterior
 * do app, merge parcial, reconciliação — tem um caso aqui.
 */

test('startCameraOff nasce `true`: o padrão de fábrica é entrar sem transmitir vídeo', () => {
  assert.equal(DEFAULT_PREFERENCES.startCameraOff, true);
  assert.equal(readPreferences(fakeStorage()).startCameraOff, true);
  assert.equal(readPreferences(undefined).startCameraOff, true);
});

test('startCameraOff: preferência gravada por versão anterior (sem o campo) resolve para `true`', () => {
  // Exatamente o que a v1 gravava: os três ids e o toggle de sons, sem o campo.
  const legado = JSON.stringify({
    videoInputId: 'cam-1',
    audioInputId: 'mic-1',
    audioOutputId: 'spk-1',
    soundsEnabled: false,
  });
  const prefs = readPreferences(fakeStorage({ [STORAGE_KEY]: legado }));

  assert.equal(prefs.startCameraOff, true, 'o campo ausente cai no lado seguro');
  // E o resto da preferência antiga continua de pé — o campo novo não invalida
  // a escolha de hardware que a pessoa já tinha feito.
  assert.equal(prefs.videoInputId, 'cam-1');
  assert.equal(prefs.audioInputId, 'mic-1');
  assert.equal(prefs.audioOutputId, 'spk-1');
  assert.equal(prefs.soundsEnabled, false);
});

test('startCameraOff só aceita boolean: valor inválido no storage cai no default seguro', () => {
  // `!'não'` é `false`, e `!0` é `true`: sem a checagem de tipo, metade destes
  // valores acenderia a câmera de alguém que nunca pediu isso.
  for (const invalido of ['sim', 'false', 0, 1, null, [], {}]) {
    const raw = JSON.stringify({ startCameraOff: invalido });
    assert.equal(
      readPreferences(fakeStorage({ [STORAGE_KEY]: raw })).startCameraOff,
      true,
      `valor inválido ${JSON.stringify(invalido)} deveria cair no default`,
    );
  }
  // `false` é o único valor que tira o default do lugar.
  assert.equal(
    readPreferences(fakeStorage({ [STORAGE_KEY]: JSON.stringify({ startCameraOff: false }) })).startCameraOff,
    false,
  );
});

test('startCameraOff: escrever a escolha não apaga as preferências de hardware já salvas', () => {
  const storage = fakeStorage();
  writePreferences(storage, { videoInputId: 'cam-1', audioInputId: 'mic-1' });

  // É isto que o clique no toggle do lobby faz: um patch de um campo só.
  const result = writePreferences(storage, { startCameraOff: false });

  assert.equal(result.startCameraOff, false);
  assert.equal(result.videoInputId, 'cam-1');
  assert.equal(result.audioInputId, 'mic-1');
  // E o que foi gravado é o que se lê de volta — a escolha vale para a próxima
  // sala mesmo se a aba for fechada antes de entrar nesta.
  assert.equal(readPreferences(storage).startCameraOff, false);

  // Voltar atrás também persiste (e não vira "campo ausente").
  assert.equal(writePreferences(storage, { startCameraOff: true }).startCameraOff, true);
  assert.equal(JSON.parse(storage.data.get(STORAGE_KEY)!).startCameraOff, true);
});

test('startCameraOff sobrevive a reconcilePreferences (que só itera os ids)', () => {
  // `reconcilePreferences` passa por `sanitize` e mexe apenas nas chaves de
  // device. Este teste existe porque quem mexer nele depois não vai saber que
  // um campo não-id depende de o sanitize preservá-lo.
  const { prefs, changed } = reconcilePreferences(
    { videoInputId: 'cam-antiga', startCameraOff: false },
    [track('video', 'cam-nova')],
  );
  assert.equal(changed, true);
  assert.equal(prefs.videoInputId, 'cam-nova');
  assert.equal(prefs.startCameraOff, false, 'a escolha de entrada não é efeito colateral da troca de câmera');
});

// -------------------------------------------- plano de mídia da entrada

test('initialMediaPlan: sem preferência gravada, nenhuma tentativa pede vídeo', () => {
  const plan = initialMediaPlan(readPreferences(fakeStorage()));

  assert.equal(plan.wantsVideo, false);
  assert.equal(plan.cameraOff, true, 'a UI nasce marcando a câmera como desligada');
  // O item verificável do DoD: nenhum `getUserMedia` com vídeo verdadeiro.
  for (const attempt of plan.attempts) {
    assert.equal(attempt.video, false);
  }
});

test('initialMediaPlan: entrar sem vídeo não repete requisição — são duas tentativas, não três', () => {
  // Com `video: false`, a primeira e a segunda tentativa da cadeia antiga
  // viravam a MESMA requisição. Um getUserMedia repetido numa falha é meio
  // segundo de espera que ninguém entende.
  const plan = initialMediaPlan({ ...DEFAULT_PREFERENCES, audioInputId: 'mic-1' });

  assert.equal(plan.attempts.length, 2);
  assert.deepEqual(plan.attempts[0], { video: false, audio: { deviceId: { ideal: 'mic-1' } } });
  // A última **sempre** ignora a preferência de microfone: um headset que ficou
  // em outra máquina não pode fazer a pessoa entrar sem áudio nenhum.
  assert.deepEqual(plan.attempts[1], { video: false, audio: true });
});

test('initialMediaPlan: com a câmera escolhida, a cadeia de três de hoje é preservada', () => {
  const plan = initialMediaPlan(
    { ...DEFAULT_PREFERENCES, startCameraOff: false, videoInputId: 'cam-1', audioInputId: 'mic-1' },
    { audioProcessing: { noiseSuppression: true } },
  );

  assert.equal(plan.wantsVideo, true);
  assert.equal(plan.cameraOff, false);
  assert.equal(plan.attempts.length, 3);
  assert.deepEqual(plan.attempts, [
    {
      video: { deviceId: { ideal: 'cam-1' } },
      audio: { deviceId: { ideal: 'mic-1' }, noiseSuppression: true },
    },
    { video: false, audio: { deviceId: { ideal: 'mic-1' }, noiseSuppression: true } },
    { video: false, audio: true },
  ]);
});

test('initialMediaPlan: o áudio é sempre pedido, nos dois estados da preferência', () => {
  // O microfone não é assunto desta preferência: entrar mutado é outra demanda.
  for (const startCameraOff of [true, false]) {
    const plan = initialMediaPlan({ ...DEFAULT_PREFERENCES, startCameraOff });
    assert.ok(plan.attempts.length > 0);
    for (const attempt of plan.attempts) {
      assert.notEqual(attempt.audio, false, 'nenhuma tentativa pode entrar sem áudio');
    }
  }
});

test('initialMediaPlan: preferência ausente, nula ou com tipo errado nunca pede vídeo', () => {
  // Defesa em profundidade: mesmo que alguém chame com um objeto cru que não
  // passou por `sanitize`, só um `false` explícito liga a câmera.
  for (const prefs of [undefined, null, {}, { startCameraOff: 'não' }, { startCameraOff: 0 }]) {
    // Cast deliberado: o caso é justamente chamar com o que o tipo proíbe.
    const plan = initialMediaPlan(prefs as DevicePreferences | null | undefined);
    assert.equal(plan.wantsVideo, false, `${JSON.stringify(prefs)} não deveria pedir vídeo`);
    assert.equal(plan.attempts.some((a) => a.video !== false), false);
  }
});
