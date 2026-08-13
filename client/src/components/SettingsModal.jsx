import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createLevelMeter } from '../lib/audioLevels.js';
import {
  DEFAULT_PREFERENCES,
  buildConstraints,
  isSinkIdSupported,
  listDevices,
  resolvePreferredDevice,
} from '../lib/devices.js';
import { MODE, noiseConstraints } from '../lib/noiseSuppression.js';

const SINK_UNSUPPORTED_HINT =
  'Este navegador não permite escolher a saída de áudio pela página. ' +
  'Troque o dispositivo padrão no sistema operacional.';

/**
 * O hint não é decorativo. No modo `worklet` o preview mostra o sinal **cru**
 * (montar um segundo grafo de worklet só para o medidor custaria um
 * `AudioContext` na Home e um ciclo de vida inteiro, para uma diferença que uma
 * barra de RMS quase não mostra). Sem a frase, quem está no caminho de fallback
 * marca o toggle, não vê o medidor mudar e conclui que o recurso não funciona.
 */
const NOISE_HINT = {
  [MODE.NATIVE]: 'Usando a supressão nativa do navegador.',
  [MODE.WORKLET]:
    'Este navegador não tem supressão nativa: o wtk-meet processa o áudio na sua ' +
    'máquina, e nada é enviado para nenhum servidor. O medidor acima mostra o sinal ' +
    'sem processamento.',
  [MODE.UNSUPPORTED]:
    'Este navegador não oferece supressão de ruído nem AudioWorklet, então não há o ' +
    'que ligar aqui. Um headset com microfone perto da boca é o que mais ajuda.',
};

/**
 * Modal único de configurações de dispositivos, usado na Home, na tela de
 * espera e dentro da sala.
 *
 * Três decisões carregam o componente:
 *
 * 1. **Preview primeiro, `enumerateDevices` depois.** Sem permissão concedida, a
 *    enumeração devolve entradas sem `deviceId` e sem rótulo — uma lista
 *    inútil. É o `getUserMedia` do preview que concede a permissão, então ele
 *    vem antes. Dentro da sala a ordem é indiferente (a permissão já existe);
 *    o caso difícil é a primeira abertura na Home.
 * 2. **Nada aqui é aplicado nem persistido.** O componente devolve a seleção em
 *    `onSave`; quem grava e quem troca o track em chamada é o pai — só ele tem
 *    acesso ao mesh e ao stream local.
 * 3. **O `stop()` do preview mora no cleanup do efeito**, não no handler de
 *    clique: desmontar por navegação (escolher na Home e entrar na sala) limpa
 *    igual a fechar pelo botão. Por isso o pai monta com `{open && <Modal/>}`.
 */
export default function SettingsModal({
  preferences = DEFAULT_PREFERENCES,
  noiseSuppression = true,
  noiseMode = MODE.NATIVE,
  onSave,
  onClose,
  audioContext = null,
  videoPreview = true,
  onDeviceLost,
  busy = false,
}) {
  // A supressão entra no mesmo objeto pendente das preferências de hardware,
  // ainda que more em outra chave de storage: o modal devolve uma seleção só, e
  // é o pai quem separa o que vai para cada chave.
  const [pending, setPending] = useState(() => ({
    ...DEFAULT_PREFERENCES,
    ...preferences,
    noiseSuppression,
  }));
  const noiseUnsupported = noiseMode === MODE.UNSUPPORTED;
  const [devices, setDevices] = useState(() => listDevices([]));
  const [level, setLevel] = useState(0);
  const [previewError, setPreviewError] = useState('');

  const videoRef = useRef(null);
  const firstFieldRef = useRef(null);
  const streamRef = useRef(null);
  const meterRef = useRef(null);
  // Espelho para uso dentro de handlers registrados uma única vez.
  const onDeviceLostRef = useRef(onDeviceLost);
  onDeviceLostRef.current = onDeviceLost;

  const sinkSupported = useMemo(() => isSinkIdSupported(), []);

  /**
   * Reenumera e reconcilia a seleção pendente. Um device que sumiu vira "Padrão
   * do sistema" no seletor — deixar o `<select>` apontando para uma `<option>`
   * que não existe mais o faria exibir o primeiro item sem que o estado mudasse.
   */
  const refreshDevices = useCallback(async () => {
    let raw = [];
    try {
      raw = await navigator.mediaDevices.enumerateDevices();
    } catch {
      raw = [];
    }
    const lists = listDevices(raw);
    setDevices(lists);

    setPending((prev) => {
      const next = { ...prev };
      let lostLabel = '';
      const check = (key, list, label) => {
        if (!prev[key]) return;
        if (resolvePreferredDevice(list, prev[key]).fellBack) {
          next[key] = '';
          if (!lostLabel) lostLabel = label;
        }
      };
      check('videoInputId', lists.videoInputs, 'a câmera');
      check('audioInputId', lists.audioInputs, 'o microfone');
      check('audioOutputId', lists.audioOutputs, 'a saída de áudio');
      if (!lostLabel) return prev;
      onDeviceLostRef.current?.(
        `Perdemos ${lostLabel} que estava selecionada. Voltamos para o padrão do sistema.`,
      );
      return next;
    });
  }, []);

  // Com a câmera desligada o preview é só de áudio, então trocar de câmera não
  // muda nada do que está sendo capturado: entrar na dep abaixo faria a seleção
  // pedir um `getUserMedia` novo para reabrir exatamente o mesmo stream de mic.
  const previewVideoId = videoPreview ? pending.videoInputId : '';

  // Preview: reinicia a cada mudança da seleção pendente de entrada. A saída de
  // áudio e o toggle de sons não entram nas deps — trocá-los não muda o que a
  // câmera e o microfone estão capturando.
  useEffect(() => {
    let cancelled = false;
    // Copiado aqui (e não lido do ref na limpeza): o efeito roda depois do
    // commit, então o elemento já existe, e o cleanup precisa limpar o MESMO
    // elemento que recebeu este stream.
    const videoEl = videoRef.current;
    setPreviewError('');
    setLevel(0);

    (async () => {
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia(
          buildConstraints(pending, {
            video: videoPreview,
            audio: true,
            // De graça no modo nativo: o preview passa a refletir a escolha sem
            // nenhum grafo extra. No modo worklet a constraint é ignorada pelo
            // navegador, e é disso que o hint abaixo do checkbox avisa.
            audioProcessing: noiseConstraints(pending),
          }),
        );
      } catch {
        try {
          // Câmera indisponível (ocupada, negada, sumida) não pode custar o
          // medidor do microfone — que é metade do que o modal serve para fazer.
          stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
          if (!cancelled) setPreviewError('Não foi possível abrir a câmera selecionada.');
        } catch {
          if (!cancelled) setPreviewError('Não foi possível acessar câmera e microfone.');
        }
      }

      if (cancelled) {
        stream?.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;
      if (videoEl) videoEl.srcObject = stream;
      if (stream) {
        meterRef.current = createLevelMeter({
          stream,
          context: typeof audioContext === 'function' ? audioContext() : audioContext,
          onLevel: setLevel,
        });
      }
      // Só agora a lista tem rótulos reais: a permissão acabou de ser concedida.
      await refreshDevices();
    })();

    return () => {
      cancelled = true;
      meterRef.current?.stop();
      meterRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoEl) videoEl.srcObject = null;
    };
    // `noiseSuppression` entra aqui, ao contrário da saída de áudio e dos
    // avisos sonoros: no modo nativo ela muda de fato o que está sendo
    // capturado, e um medidor que não acompanha a escolha é pior que nenhum.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewVideoId, pending.audioInputId, pending.noiseSuppression, videoPreview, refreshDevices]);

  // Conectar/desconectar hardware com o modal aberto: só reenumera. Reiniciar o
  // preview aqui faria a câmera piscar — um headset USB dispara vários
  // `devicechange` seguidos (mic e saída aparecem em momentos diferentes).
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return undefined;
    const handler = () => {
      refreshDevices();
    };
    md.addEventListener('devicechange', handler);
    return () => md.removeEventListener('devicechange', handler);
  }, [refreshDevices]);

  // Foco entra no modal ao abrir e volta para quem o abriu ao fechar. O opener
  // pode ter saído do DOM nesse meio tempo (a barra de controles muda de rótulo).
  useEffect(() => {
    const opener = document.activeElement;
    firstFieldRef.current?.focus();
    return () => {
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  // Esc fecha. Sem captura, de propósito: se o modal de aprovação estiver
  // aberto, o handler dele (que é em captura) atende primeiro — quem tem alguém
  // esperando do outro lado tem prioridade.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose?.();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const select = (key) => (event) => {
    const { value } = event.target;
    setPending((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    onSave?.({ ...pending });
  };

  const renderSelect = (key, label, list, extra = {}) => (
    <label className="settings-field">
      <span>{label}</span>
      <select
        value={pending[key]}
        onChange={select(key)}
        ref={key === 'videoInputId' ? firstFieldRef : null}
        {...extra}
      >
        {list.map((device) => (
          <option key={device.deviceId || 'default'} value={device.deviceId}>
            {device.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="modal-backdrop settings" onMouseDown={() => onClose?.()}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="settings-title">Configurações</h2>

        <div className="settings-preview">
          {videoPreview ? (
            <video ref={videoRef} autoPlay playsInline muted className="mirrored" />
          ) : (
            <p className="settings-preview-off">
              Câmera desligada. A câmera escolhida será usada quando você ligá-la.
            </p>
          )}
        </div>

        {/* Redundante com o preview para quem enxerga, e ruidoso para leitor de
            tela: a informação útil já está no rótulo do dispositivo. */}
        <div className="mic-meter" style={{ '--mic-level': level.toFixed(2) }} aria-hidden="true">
          <span className="mic-meter-fill" />
        </div>

        {previewError && <p className="warning">{previewError}</p>}

        {renderSelect('videoInputId', 'Câmera', devices.videoInputs)}
        {renderSelect('audioInputId', 'Microfone', devices.audioInputs)}
        {renderSelect('audioOutputId', 'Saída de áudio', devices.audioOutputs, {
          disabled: !sinkSupported,
        })}
        {/* Desabilitado com explicação, nunca escondido: sumir com o seletor faz
            quem viu o recurso em outro navegador procurar o que não existe. */}
        {!sinkSupported && <p className="settings-hint">{SINK_UNSUPPORTED_HINT}</p>}

        {/* Desabilitado com explicação, nunca escondido — mesmo princípio do
            seletor de saída acima: sumir com o controle faz quem viu o recurso
            em outro navegador procurar o que não existe. */}
        <label className="settings-check">
          <input
            type="checkbox"
            checked={pending.noiseSuppression}
            disabled={noiseUnsupported}
            onChange={(event) =>
              setPending((prev) => ({ ...prev, noiseSuppression: event.target.checked }))
            }
          />
          <span>Supressão de ruído</span>
        </label>
        <p className="settings-hint">{NOISE_HINT[noiseMode] || NOISE_HINT[MODE.NATIVE]}</p>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={pending.soundsEnabled}
            onChange={(event) =>
              setPending((prev) => ({ ...prev, soundsEnabled: event.target.checked }))
            }
          />
          <span>Avisos sonoros de entrada e saída</span>
        </label>

        <div className="settings-actions">
          <button type="button" onClick={() => onClose?.()}>
            Cancelar
          </button>
          <button type="button" className="primary" onClick={handleSave} disabled={busy}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
