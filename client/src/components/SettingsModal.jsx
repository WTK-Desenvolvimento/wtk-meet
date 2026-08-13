import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_PREFERENCES,
  buildConstraints,
  isSinkIdSupported,
  listDevices,
  resolvePreferredDevice,
} from '../lib/devices.js';
import { createLevelMeter } from '../lib/audioLevels.js';

const NO_SINK_HINT =
  'Este navegador não permite escolher a saída de áudio pela página. Use a configuração do sistema.';

const FIELDS = [
  { key: 'videoInputId', list: 'videoInputs', kind: 'videoinput', id: 'settings-camera', label: 'Câmera' },
  { key: 'audioInputId', list: 'audioInputs', kind: 'audioinput', id: 'settings-mic', label: 'Microfone' },
  { key: 'audioOutputId', list: 'audioOutputs', kind: 'audiooutput', id: 'settings-out', label: 'Saída de áudio' },
];

/**
 * Modal único de configurações de dispositivos — o mesmo componente na Home, na
 * tela de espera e dentro da sala.
 *
 * O componente **não persiste nada**: ele devolve a seleção em `onSave` e quem
 * grava (e aplica na chamada em andamento) é o pai. Isso mantém a única cópia
 * das preferências e do `localStorage` num lugar só.
 *
 * Ordem de inicialização deliberada (preview antes de enumerar): sem permissão
 * concedida, `enumerateDevices` devolve entradas sem rótulo e sem id — uma lista
 * inútil. O `getUserMedia` do preview é o que concede a permissão, e só depois
 * dele a listagem tem rótulos reais. Dentro da sala a permissão já existe e a
 * ordem é indiferente; o caso difícil é o da Home.
 *
 * O pai monta este componente condicionalmente (`{open && <SettingsModal/>}`):
 * é o desmonte que para o stream de preview, então fechar por botão, por `Esc`
 * ou navegando para a sala limpam pelo mesmo caminho.
 */
export default function SettingsModal({
  open = true,
  preferences,
  onSave,
  onClose,
  audioContext = null,
  onDeviceLost,
  busy = false,
}) {
  const [devices, setDevices] = useState(() => listDevices([]));
  const [pending, setPending] = useState(() => ({ ...DEFAULT_PREFERENCES, ...preferences }));
  const [level, setLevel] = useState(0);
  const [previewStream, setPreviewStream] = useState(null);
  const [notice, setNotice] = useState(null);

  const videoRef = useRef(null);
  const firstFieldRef = useRef(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  // Feature detect uma vez: o seletor de saída é renderizado desabilitado (com
  // explicação) onde não há `setSinkId`, nunca escondido — esconder faria o
  // usuário procurar um recurso que ele viu funcionando em outro navegador.
  const sinkSupported = useMemo(() => isSinkIdSupported(), []);

  const notifyLost = useCallback(
    (message) => {
      setNotice(message);
      onDeviceLost?.(message);
    },
    [onDeviceLost],
  );

  /**
   * Reenumera e, se algum device **selecionado** sumiu, volta aquele campo para
   * "Padrão do sistema" avisando. Não reinicia o preview por conta própria: um
   * headset USB dispara vários `devicechange` seguidos (mic e saída aparecem em
   * momentos diferentes) e a câmera piscaria a cada um.
   */
  const refresh = useCallback(async () => {
    let raw = [];
    try {
      raw = await navigator.mediaDevices.enumerateDevices();
    } catch {
      raw = [];
    }
    const lists = listDevices(raw);
    setDevices(lists);

    const current = pendingRef.current;
    const patch = {};
    const lost = [];
    for (const field of FIELDS) {
      const { fellBack } = resolvePreferredDevice(lists[field.list], current[field.key]);
      if (fellBack) {
        patch[field.key] = '';
        lost.push(field.label.toLowerCase());
      }
    }
    if (lost.length > 0) {
      setPending((prev) => ({ ...prev, ...patch }));
      notifyLost(
        `Dispositivo desconectado (${lost.join(', ')}). Voltamos para o padrão do sistema.`,
      );
    }
    return lists;
  }, [notifyLost]);

  // Preview + medidor. Reinicia a cada troca de entrada pendente — é o que faz o
  // preview refletir a seleção ainda não salva. A parada mora no cleanup (e não
  // no clique de "Cancelar") para que desmontar por navegação limpe igual.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    let stream = null;
    let meter = null;

    const stopAll = () => {
      meter?.stop();
      meter = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };

    (async () => {
      const prefs = pendingRef.current;
      const attempts = [
        buildConstraints(prefs, { video: true, audio: true }),
        buildConstraints(prefs, { video: false, audio: true }),
        buildConstraints(prefs, { video: true, audio: false }),
      ];
      for (const constraints of attempts) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          break;
        } catch {
          stream = null;
        }
      }
      if (cancelled) {
        stopAll();
        return;
      }
      if (!stream) {
        setNotice('Não foi possível abrir a câmera ou o microfone para o preview.');
      } else {
        setPreviewStream(stream);
        meter = createLevelMeter({ stream, context: audioContext, onLevel: setLevel });
      }
      // Só agora a lista tem rótulos reais (a permissão acabou de ser concedida).
      await refresh();
    })();

    return () => {
      cancelled = true;
      stopAll();
      setPreviewStream(null);
      setLevel(0);
    };
    // `audioContext` e `refresh` são estáveis; reiniciar por causa deles faria a
    // câmera piscar sem motivo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending.videoInputId, pending.audioInputId]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.srcObject = previewStream || null;
  }, [previewStream]);

  // Conectar/desconectar hardware com o modal aberto atualiza as listas.
  useEffect(() => {
    if (!open) return undefined;
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return undefined;
    const handler = () => {
      refresh();
    };
    media.addEventListener('devicechange', handler);
    return () => media.removeEventListener('devicechange', handler);
  }, [open, refresh]);

  // Foco entra no modal e volta para quem o abriu — mesmo padrão do modal de
  // pedidos de entrada.
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    firstFieldRef.current?.focus();
    return () => {
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose?.();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const select = (field) => (event) => {
    const value = event.target.value;
    setPending((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <div className="modal-backdrop settings" onMouseDown={() => onClose?.()}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="settings-title">Configurações de áudio e vídeo</h2>

        <div className="settings-preview">
          {/* Espelhado como o tile local: o preview tem que parecer com o que a
              pessoa já vê de si mesma na grade. */}
          <video ref={videoRef} autoPlay playsInline muted className="mirrored" />
          {!previewStream && <span className="settings-preview-empty">Sem preview</span>}
        </div>

        {/* Redundante com o preview para quem enxerga e ruidoso para leitor de
            tela — daí o aria-hidden. */}
        <div className="mic-meter" aria-hidden="true" style={{ '--mic-level': level.toFixed(2) }}>
          <span className="mic-meter-bar" />
        </div>

        {FIELDS.map((field, index) => {
          const disabled = field.key === 'audioOutputId' && !sinkSupported;
          return (
            <label className="settings-field" key={field.key} htmlFor={field.id}>
              {field.label}
              <select
                id={field.id}
                ref={index === 0 ? firstFieldRef : null}
                value={pending[field.key]}
                onChange={select(field.key)}
                disabled={disabled}
              >
                {devices[field.list].map((device) => (
                  <option key={device.deviceId || 'default'} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
                {/* Um id salvo que não está mais na lista não pode sumir do
                    <select> em silêncio: sem esta opção o campo mostraria outro
                    device como se fosse o escolhido. */}
                {pending[field.key] &&
                  !devices[field.list].some((d) => d.deviceId === pending[field.key]) && (
                    <option value={pending[field.key]}>Dispositivo salvo (indisponível)</option>
                  )}
              </select>
              {disabled && <span className="settings-hint">{NO_SINK_HINT}</span>}
            </label>
          );
        })}

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={pending.soundsEnabled}
            onChange={(event) =>
              setPending((prev) => ({ ...prev, soundsEnabled: event.target.checked }))
            }
          />
          Avisos sonoros de entrada e saída
        </label>

        {notice && <p className="warning">{notice}</p>}

        <div className="settings-actions">
          <button type="button" onClick={() => onClose?.()}>
            Cancelar
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => onSave?.({ ...pending })}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
