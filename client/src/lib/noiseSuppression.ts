/**
 * Preferência, capacidade e decisão de modo da supressão de ruído.
 *
 * Este módulo é **puro**, no mesmo padrão de `devices.js` e `gridLayout.js`: não
 * toca em `navigator`, em `AudioContext` nem em `localStorage`. Ele recebe o
 * objeto storage-like, o resultado cru de `getSupportedConstraints()` e um
 * booleano de suporte a `AudioWorklet`, e devolve estruturas. Quem faz I/O é o
 * componente; quem monta o grafo de áudio é `lib/micPipeline.js`.
 *
 * É essa pureza que torna a matriz de decisão testável em `node:test` sem
 * navegador — e a matriz é justamente a parte cuja correção não é observável a
 * olho nu: escolher `native` onde o navegador não suporta a constraint entrega
 * um toggle inerte, e escolher `worklet` onde o navegador já está suprimindo
 * empilha duas supressões em série (bombeamento e voz metálica, pior que
 * nenhuma).
 *
 * ---
 * **Divergência declarada — chave própria de storage.**
 * `docs/agents/arch-temp-supressao-ruido-client-side.md` §3.1/§5.4 especifica
 * esta preferência como uma **quinta chave** dentro de `wtk-meet:devices`. O
 * DoD da WTK-MEET-11 (itens 2 e 15) exige o contrário: chave própria
 * `wtk-meet:audio`. Seguimos o DoD, que é o gate que fecha a task.
 *
 * O argumento a favor da separação, que é o que o DoD-15 manda documentar:
 * `wtk-meet:devices` responde "que hardware usar" — três `deviceId` que só
 * fazem sentido na máquina em que foram gravados, e que `reconcilePreferences`
 * reescreve sozinho quando o hardware some. Supressão de ruído não é escolha de
 * hardware: é uma propriedade do **ambiente** de quem fala, vale para qualquer
 * microfone e nunca é reescrita por reconciliação. Misturar as duas faria a
 * autocorreção de device passar por cima de um campo que ela não deveria nem
 * enxergar. Ver `ARCHITECTURE.md` §6.11.
 */

export const AUDIO_STORAGE_KEY = 'wtk-meet:audio';

/** Nasce **ligada**: quem tem ambiente barulhento não deveria precisar descobrir o toggle. */
/** A preferência de áudio, inteira — hoje um campo só. */
export interface AudioPreferences {
  noiseSuppression: boolean;
}

export const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = {
  noiseSuppression: true,
};

/**
 * Modos possíveis. `unsupported` é uma capacidade do navegador, não o estado do
 * toggle: significa "esta máquina não consegue suprimir de jeito nenhum", e é o
 * que desabilita o controle no modal com explicação.
 */
export const MODE = {
  NATIVE: 'native',
  WORKLET: 'worklet',
  UNSUPPORTED: 'unsupported',
} as const;

/** Um dos três valores de `MODE`. */
export type NoiseMode = (typeof MODE)[keyof typeof MODE];

/** O que o navegador consegue fazer, normalizado. */
export interface NoiseCapabilities {
  native: boolean;
  worklet: boolean;
}

/** Os dois valores crus que `detectCapabilities` recebe do chamador. */
export interface RawCapabilities {
  supportedConstraints?: { noiseSuppression?: boolean } | null;
  audioWorkletSupported?: boolean;
}

/** Uma `Storage` mínima: só o que este módulo chama, e tudo opcional. */
export interface PreferenceStorage {
  getItem?(key: string): string | null;
  setItem?(key: string, value: string): void;
}

/**
 * Nome sob o qual o `AudioWorkletProcessor` é registrado.
 *
 * O arquivo do worklet não pode importar nada (ver o cabeçalho dele), então o
 * mesmo literal existe lá também. Um teste unitário prende os dois: é a única
 * defesa possível contra a divergência silenciosa entre uma cópia e outra —
 * renomear só um lado dá "unknown processor" em runtime, no navegador, no
 * caminho de fallback que quase ninguém exercita.
 */
export const PROCESSOR_NAME = 'wtk-noise-suppressor';

/**
 * Normaliza as capacidades a partir do que o navegador reporta.
 *
 * Recebe os dois valores crus em vez de lê-los de `navigator` para manter o
 * módulo puro — e, de quebra, é o que permite ao E2E forçar o caminho de
 * fallback num Chromium que suporta a constraint nativa.
 */
export function detectCapabilities({
  supportedConstraints,
  audioWorkletSupported,
}: RawCapabilities = {}): NoiseCapabilities {
  return {
    native: !!(supportedConstraints && supportedConstraints.noiseSuppression),
    worklet: !!audioWorkletSupported,
  };
}

/**
 * A matriz de decisão, inteira.
 *
 * O nativo tem precedência sempre que existe: é mais barato, mais testado, não
 * gasta um `AudioWorklet` e não tem risco de silenciar ninguém. O worklet só
 * entra onde a constraint nativa **não existe** — que é exatamente a condição
 * que torna impossível empilhar as duas supressões.
 */
export function decideMode(capabilities?: Partial<NoiseCapabilities> | null): NoiseMode {
  const caps = capabilities || {};
  if (caps.native) return MODE.NATIVE;
  if (caps.worklet) return MODE.WORKLET;
  return MODE.UNSUPPORTED;
}

/** Atalho para o caminho real: das capacidades cruas direto ao modo. */
export function decideCapabilityMode(raw?: RawCapabilities): NoiseMode {
  return decideMode(detectCapabilities(raw));
}

/**
 * Constraints de processamento para o ramo de áudio do `getUserMedia`.
 *
 * A constraint é emitida **também quando a preferência é `false`**, e essa é a
 * decisão menos óbvia do módulo: Chrome, Edge, Firefox e Safari ligam
 * `noiseSuppression` por padrão quando se pede `audio: true` sem qualificar.
 * Omitir a constraint no estado desligado entregaria um toggle que não desliga
 * nada — e o bug seria invisível, porque não há erro: o áudio continua sendo
 * processado e a queixa chega semanas depois como "o toggle não faz nada".
 *
 * `ideal`, nunca `exact`: com `exact`, um navegador sem a constraint responde
 * `OverconstrainedError` e derruba a aquisição inteira — a pessoa entraria na
 * sala **sem áudio nenhum** por causa de uma preferência de qualidade.
 */
export function noiseConstraints(prefs?: Partial<AudioPreferences> | null): { noiseSuppression: { ideal: boolean } } {
  const safe = sanitize(prefs);
  return { noiseSuppression: { ideal: safe.noiseSuppression } };
}

function sanitize(candidate: unknown): AudioPreferences {
  const out: AudioPreferences = { ...DEFAULT_AUDIO_PREFERENCES };
  if (!candidate || typeof candidate !== 'object') return out;
  // Tipo errado cai no default (ligado), igual a chave ausente: o valor gravado
  // por uma versão futura não pode desligar a supressão por acidente.
  const bruto = candidate as { noiseSuppression?: unknown };
  if (typeof bruto.noiseSuppression === 'boolean') {
    out.noiseSuppression = bruto.noiseSuppression;
  }
  return out;
}

/**
 * Lê e valida a preferência. **Nunca lança**: storage ausente, `getItem`
 * lançando (modo privado), JSON inválido, chave inexistente ou tipos errados
 * caem todos no default. Chaves desconhecidas são descartadas.
 */
export function readAudioPreferences(storage?: PreferenceStorage | null): AudioPreferences {
  try {
    const raw = storage?.getItem?.(AUDIO_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AUDIO_PREFERENCES };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_AUDIO_PREFERENCES };
  }
}

/**
 * Faz merge do patch sobre o que já está gravado, valida, grava e devolve o
 * resultado efetivo. `setItem` lançando (cota, modo privado) é engolido: a
 * preferência simplesmente não persiste e a sessão corrente continua igual.
 */
export function writeAudioPreferences(
  storage: PreferenceStorage | null | undefined,
  patch?: Partial<AudioPreferences> | null,
): AudioPreferences {
  const next = sanitize({ ...readAudioPreferences(storage), ...(patch || {}) });
  try {
    storage?.setItem?.(AUDIO_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // sem persistência nesta sessão — não é motivo para quebrar a chamada
  }
  return next;
}
