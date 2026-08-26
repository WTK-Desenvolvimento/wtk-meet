/**
 * Seleção de dispositivos de mídia: normalização da lista, preferência salva e
 * construção de constraints.
 *
 * Este módulo é **puro**: não toca em `navigator.mediaDevices` nem em
 * `localStorage`. Ele recebe a lista crua de `MediaDeviceInfo` e um objeto
 * storage-like, e devolve estruturas. Quem faz I/O é o componente — o mesmo
 * padrão de `lib/gridLayout.js`, e o que permite testar dedup, rotulagem e
 * fallback em `node:test`, sem navegador.
 *
 * Exceção deliberada e delimitada à regra de zero persistência do produto: a
 * preferência de hardware é a **única** coisa que vai para `localStorage`. Ela
 * não é conteúdo nem metadado de chamada, nunca sai do navegador, e a
 * alternativa (reescolher o headset a cada chamada) é um custo recorrente
 * cobrado justamente de quem tem hardware melhor. Ver `ARCHITECTURE.md` §6.10.
 *
 * Pelo mesmo argumento mora aqui `startCameraOff`: é decisão da pessoa sobre o
 * próprio hardware, tomada uma vez e válida para as próximas salas. Não é
 * conteúdo, não sai do navegador, e o default (`true`) é o lado seguro — o que
 * ninguém decidiu entra desligado.
 */

export const STORAGE_KEY = 'wtk-meet:devices';

/** Os três `kind` de `MediaDeviceInfo` que este produto usa. */
export type DeviceKind = 'videoinput' | 'audioinput' | 'audiooutput';

/** As três chaves de preferência que guardam um `deviceId`. */
export type DeviceIdKey = 'videoInputId' | 'audioInputId' | 'audioOutputId';

/** O que fica em `localStorage` sob `wtk-meet:devices`. */
export interface DevicePreferences {
  videoInputId: string;
  audioInputId: string;
  audioOutputId: string;
  soundsEnabled: boolean;
  startCameraOff: boolean;
}

/** Uma opção de device já normalizada e rotulada, pronta para o `<select>`. */
export interface DeviceOption {
  deviceId: string;
  label: string;
  groupId: string;
}

export interface DeviceLists {
  videoInputs: DeviceOption[];
  audioInputs: DeviceOption[];
  audioOutputs: DeviceOption[];
}

/** Uma `Storage` mínima: só o que este módulo chama, e tudo opcional. */
export interface PreferenceStorage {
  getItem?(key: string): string | null;
  setItem?(key: string, value: string): void;
}

/** O ramo de `video`/`audio` de um `MediaStreamConstraints`, como este módulo o monta. */
export type MediaConstraint = boolean | Record<string, unknown>;

export const DEFAULT_PREFERENCES: DevicePreferences = {
  videoInputId: '',
  audioInputId: '',
  audioOutputId: '',
  soundsEnabled: true,
  // Negativo de propósito: com `true` como default, tanto a ausência da chave
  // quanto uma preferência gravada por versão anterior (que não tem o campo)
  // resolvem para o comportamento seguro — entrar sem transmitir vídeo.
  startCameraOff: true,
};

/** Rótulo da opção sintética de `deviceId: ''` — "siga o sistema". */
export const DEFAULT_DEVICE_LABEL = 'Padrão do sistema';

/**
 * Ids reservados do Chrome. Eles apontam para o mesmo hardware que já aparece
 * com o id real, então mostrá-los duplica cada microfone na lista. Pior: são
 * ids que **nunca** ficam inválidos, então o fallback abaixo jamais dispararia,
 * enquanto o hardware por trás deles muda sem aviso.
 */
const RESERVED_IDS = new Set(['default', 'communications']);

const KIND_LABEL: Record<DeviceKind, string> = {
  videoinput: 'Câmera',
  audioinput: 'Microfone',
  audiooutput: 'Saída',
};

const KIND_TO_PREF: Record<string, DeviceIdKey | undefined> = {
  videoinput: 'videoInputId',
  audioinput: 'audioInputId',
  audiooutput: 'audioOutputId',
};

const ID_KEYS: DeviceIdKey[] = ['videoInputId', 'audioInputId', 'audioOutputId'];

function defaultOption(): DeviceOption {
  return { deviceId: '', label: DEFAULT_DEVICE_LABEL, groupId: '' };
}

function normalizeKind(raw: readonly unknown[], kind: DeviceKind): DeviceOption[] {
  const seenIds = new Set<string>();
  const seenSignatures = new Set<string>();
  const out: DeviceOption[] = [];

  for (const bruto of raw) {
    // Vem de `enumerateDevices`, mas o teste injeta objetos crus: nada é assumido.
    const device = bruto as Partial<MediaDeviceInfo> | null;
    if (!device || device.kind !== kind) continue;
    const deviceId = typeof device.deviceId === 'string' ? device.deviceId : '';
    // Sem permissão concedida, `enumerateDevices` devolve entradas vazias:
    // lista inútil, e um id vazio colidiria com a opção "Padrão do sistema".
    if (!deviceId || RESERVED_IDS.has(deviceId)) continue;
    if (seenIds.has(deviceId)) continue;

    const groupId = typeof device.groupId === 'string' ? device.groupId : '';
    const label = typeof device.label === 'string' ? device.label.trim() : '';
    // Segunda barreira contra duplicata. Só vale com groupId e rótulo reais:
    // deduplicar por rótulo sozinho colapsaria duas webcams idênticas em uma,
    // e o usuário perderia acesso a metade do hardware.
    const signature = groupId && label ? `${groupId}|${label}` : '';
    if (signature && seenSignatures.has(signature)) continue;

    seenIds.add(deviceId);
    if (signature) seenSignatures.add(signature);
    out.push({ deviceId, label, groupId });
  }

  return [
    defaultOption(),
    ...out.map((device, index) => ({
      ...device,
      // Rótulo real quando existe; posição na lista do próprio kind quando não.
      label: device.label || `${KIND_LABEL[kind]} ${index + 1}`,
    })),
  ];
}

/**
 * Normaliza a saída de `enumerateDevices`: descarta entradas sem id e os
 * aliases reservados, deduplica, rotula e prepende "Padrão do sistema" às três
 * listas.
 */
export function listDevices(raw: unknown): DeviceLists {
  const list: readonly unknown[] = Array.isArray(raw) ? raw : [];
  return {
    videoInputs: normalizeKind(list, 'videoinput'),
    audioInputs: normalizeKind(list, 'audioinput'),
    audioOutputs: normalizeKind(list, 'audiooutput'),
  };
}

/**
 * Responde "o que usar?" para um kind. `deviceId: ''` significa "sem restrição
 * — default do sistema"; `fellBack` diz que o id salvo não existe mais e
 * autoriza quem chamou a regravar a preferência.
 */
export function resolvePreferredDevice(
  list: unknown,
  savedId: unknown,
): { deviceId: string; fellBack: boolean } {
  if (!savedId || typeof savedId !== 'string') return { deviceId: '', fellBack: false };
  const candidatos: readonly unknown[] = Array.isArray(list) ? list : [];
  const found = candidatos.some(
    (d) => !!d && (d as { deviceId?: unknown }).deviceId === savedId,
  );
  return found ? { deviceId: savedId, fellBack: false } : { deviceId: '', fellBack: true };
}

function constraintFor(
  wanted: boolean,
  deviceId: string,
  extra: Record<string, unknown> | null = null,
): MediaConstraint {
  if (!wanted) return false;
  // `ideal`, nunca `exact`: um device que sumiu entre o enumerateDevices e o
  // getUserMedia daria OverconstrainedError com `exact`, e a aplicação teria que
  // capturar, interpretar e reexecutar. Com `ideal` o navegador entrega o melhor
  // disponível e `getSettings()` diz qual foi (ver `reconcilePreferences`).
  const hasExtra = extra && typeof extra === 'object' && Object.keys(extra).length > 0;
  if (!deviceId && !hasExtra) return true;
  return {
    ...(deviceId ? { deviceId: { ideal: deviceId } } : null),
    ...(hasExtra ? extra : null),
  };
}

/**
 * Constraints de `getUserMedia` a partir das preferências.
 *
 * `audioProcessing` é injetado por quem chama, e não lido daqui, porque a
 * preferência de supressão mora em outra chave de storage e este módulo é puro
 * (ver `lib/noiseSuppression.js`). Ramificar aqui por feature detection —
 * `if (getSupportedConstraints().noiseSuppression)` — quebraria justamente a
 * pureza que torna `devices.test.mjs` executável em `node:test`.
 */
export function buildConstraints(
  // `Partial`: o lobby chama com `{ videoInputId }` só, e é legítimo — os
  // outros campos não participam da montagem das constraints.
  prefs: Partial<DevicePreferences> | null | undefined,
  {
    video = false,
    audio = false,
    audioProcessing = null,
  }: { video?: boolean; audio?: boolean; audioProcessing?: Record<string, unknown> | null } = {},
): { video: MediaConstraint; audio: MediaConstraint } {
  const safe = prefs || DEFAULT_PREFERENCES;
  return {
    video: constraintFor(video, safe.videoInputId ?? ''),
    audio: constraintFor(audio, safe.audioInputId ?? '', audioProcessing),
  };
}

/**
 * O plano de mídia da **entrada** na sala: o que pedir, nesta ordem, e com que
 * estado a UI nasce.
 *
 * Existe como função pura, e não como um `if` dentro do efeito de setup do
 * `Room`, porque é a única forma de cobrir a cadeia de constraints em
 * `node:test` — o componente inteiro é intestável sem DOM. `audioProcessing`
 * é injetado por quem chama pelo mesmo motivo que em `buildConstraints`: a
 * preferência de supressão mora em outra chave de storage.
 *
 * A cadeia **encolhe** quando a pessoa entra sem vídeo: com `video: false`, a
 * primeira e a segunda tentativa de antes viravam a mesma requisição, e um
 * `getUserMedia` repetido numa falha é meio segundo de espera que ninguém
 * entende. São duas tentativas, não três com uma repetida.
 *
 * A última tentativa ignora a preferência de microfone de propósito, nos dois
 * ramos: sem ela, um headset que ficou em outra máquina faria a pessoa entrar
 * sem áudio nenhum — e nada disso pode virar erro na tela.
 */
export function initialMediaPlan(
  prefs: DevicePreferences | null | undefined,
  { audioProcessing = null }: { audioProcessing?: Record<string, unknown> | null } = {},
): { wantsVideo: boolean; cameraOff: boolean; attempts: { video: MediaConstraint; audio: MediaConstraint }[] } {
  const safe = prefs || DEFAULT_PREFERENCES;
  // Só um `false` explícito pede vídeo. Preferência ausente, gravada por versão
  // anterior ou com tipo errado já chegou aqui como `true` via `sanitize`.
  const wantsVideo = safe.startCameraOff === false;
  const withPreference = (video: boolean) =>
    buildConstraints(safe, { video, audio: true, audioProcessing });

  return {
    wantsVideo,
    cameraOff: !wantsVideo,
    attempts: [
      ...(wantsVideo ? [withPreference(true)] : []),
      withPreference(false),
      { video: false, audio: true },
    ],
  };
}

function sanitize(candidate: unknown): DevicePreferences {
  const out: DevicePreferences = { ...DEFAULT_PREFERENCES };
  if (!candidate || typeof candidate !== 'object') return out;
  // Vem do storage (ou de uma versão futura do produto): lido campo a campo.
  const bruto = candidate as Partial<Record<keyof DevicePreferences, unknown>>;
  for (const key of ID_KEYS) {
    const valor = bruto[key];
    if (typeof valor === 'string') out[key] = valor;
  }
  if (typeof bruto.soundsEnabled === 'boolean') out.soundsEnabled = bruto.soundsEnabled;
  // Só booleano de verdade. Copiar sem checar faria um `undefined` gravado
  // virar `undefined` lido, e `!undefined` acenderia a câmera — o oposto do
  // requisito.
  if (typeof bruto.startCameraOff === 'boolean') out.startCameraOff = bruto.startCameraOff;
  return out;
}

/**
 * Lê e valida as preferências. **Nunca lança**: storage ausente, `getItem`
 * lançando (modo privado), JSON inválido, chave inexistente ou tipos errados
 * caem todos nos defaults. Chaves desconhecidas são descartadas.
 */
export function readPreferences(storage?: PreferenceStorage | null): DevicePreferences {
  try {
    const raw = storage?.getItem?.(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Faz merge do patch sobre o que já está gravado, valida, grava e devolve o
 * resultado efetivo. `setItem` lançando (cota, modo privado) é engolido: a
 * preferência simplesmente não persiste e a sessão corrente continua igual.
 */
export function writePreferences(
  storage: PreferenceStorage | null | undefined,
  patch?: Partial<DevicePreferences> | null,
): DevicePreferences {
  const next = sanitize({ ...readPreferences(storage), ...(patch || {}) });
  try {
    storage?.setItem?.(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // sem persistência nesta sessão — não é motivo para quebrar a chamada
  }
  return next;
}

/** Feature detection de roteamento de saída de áudio. */
export function isSinkIdSupported(
  // `null` entra no tipo porque o `?.` abaixo já o trata e porque é o que o
  // chamador tem em mãos: um `prototype` que pode simplesmente não existir.
  proto: Partial<HTMLMediaElement> | null | undefined = globalThis.HTMLMediaElement?.prototype,
): boolean {
  return typeof proto?.setSinkId === 'function';
}

/**
 * Reconcilia a preferência com o que o navegador **de fato** abriu.
 *
 * Só corrige um id que foi pedido e não foi atendido — é assim que uma
 * preferência apontando para hardware que sumiu se conserta sozinha, sem erro
 * visível. Um id vazio (escolha explícita de "Padrão do sistema") nunca é
 * fixado no device do momento: isso transformaria "siga o sistema" em uma
 * escolha concreta pelas costas do usuário.
 */
export function reconcilePreferences(
  prefs: unknown,
  tracks: readonly (Partial<MediaStreamTrack> | null | undefined)[] | null | undefined,
): { prefs: DevicePreferences; changed: boolean } {
  const next = sanitize(prefs);
  let changed = false;

  for (const track of tracks || []) {
    if (!track) continue;
    const key: DeviceIdKey | null =
      track.kind === 'video' ? 'videoInputId' : track.kind === 'audio' ? 'audioInputId' : null;
    if (!key) continue;

    const wanted = next[key];
    if (!wanted) continue; // "padrão do sistema" continua sendo padrão do sistema

    let reported: string | undefined;
    try {
      reported = track.getSettings?.().deviceId;
    } catch {
      reported = undefined;
    }
    // Navegador que não expõe o id não permite concluir nada — manter o pedido.
    if (typeof reported !== 'string' || reported === '') continue;

    const actual = RESERVED_IDS.has(reported) ? '' : reported;
    if (actual !== wanted) {
      next[key] = actual;
      changed = true;
    }
  }

  return { prefs: next, changed };
}

/** Nome da chave de preferência correspondente a um `kind` de device. */
export function preferenceKeyForKind(kind: string): DeviceIdKey | null {
  return KIND_TO_PREF[kind] || null;
}
