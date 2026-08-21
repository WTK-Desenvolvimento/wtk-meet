import { useEffect, useRef, useState } from 'react';
import VideoTile from './VideoTile.jsx';
import { DEFAULT_PREFERENCES, buildConstraints } from '../lib/devices.js';

const PREVIEW_ERROR =
  'Não foi possível abrir a câmera para o preview. Você ainda pode entrar na sala — ' +
  'dá para ligar a câmera lá dentro.';

/**
 * Tela de pré-entrada (lobby): o último ponto antes de qualquer conexão.
 *
 * Três coisas carregam o componente:
 *
 * 1. **O preview é opt-in e só de vídeo.** Sem o toggle ligado, nenhum
 *    `getUserMedia` acontece aqui — é isso que faz o LED da webcam ficar apagado
 *    para quem só abriu o link. O microfone **não** é aberto no lobby: acender o
 *    indicador de captura do sistema antes da entrada é a mesma crítica que esta
 *    entrega faz à câmera, num device diferente. Quem quer conferir o microfone
 *    abre Configurações, que tem medidor.
 * 2. **O stream do lobby nunca é entregue à sala.** Ele morre no cleanup do
 *    efeito e o setup da sala faz o seu próprio `getUserMedia`. O dono único do
 *    `localStreamRef` continua sendo o efeito de setup do `Room` — e é o
 *    desmonte **deste componente** (não um handler de clique) que apaga o LED,
 *    então sair daqui por navegação, por Esc ou por entrar limpa igual.
 *    Ser um componente de verdade é o que garante essa ordem: o React roda
 *    todas as limpezas de um commit antes de qualquer efeito novo, então a
 *    câmera do lobby está fechada antes do `getUserMedia` da sala. Duas
 *    capturas simultâneas do mesmo device dão `NotReadableError` em parte das
 *    máquinas, e o sintoma seria "às vezes entro sem vídeo".
 * 3. **O toggle não tem estado próprio.** Ele renderiza `cameraOn` e devolve a
 *    escolha ao pai, que grava a preferência e atualiza o `cameraOff` da sala.
 *    Com dois estados existiria o caminho em que a pessoa vê o toggle ligado e
 *    entra desligada.
 *
 * O placeholder `Como te chamam` e o botão `Entrar na sala` são contrato com o
 * harness do E2E (`e2e/harness.mjs`): renomear qualquer um dos dois quebra
 * todos os cenários da suíte, inclusive os que nada têm a ver com o lobby.
 */
export default function PreJoin({
  preferences = DEFAULT_PREFERENCES,
  nameInput = '',
  onNameChange,
  cameraOn = false,
  onToggleCamera,
  previewPaused = false,
  onSubmit,
  onOpenSettings,
  onPreviewError,
}) {
  const [previewStream, setPreviewStream] = useState(null);
  const streamRef = useRef(null);
  // Espelho: usado dentro do efeito sem entrar nas deps dele — o pai passa uma
  // função nova a cada render, e reiniciar a câmera por isso faria o preview
  // piscar a cada tecla digitada no campo de nome.
  const onPreviewErrorRef = useRef(onPreviewError);
  onPreviewErrorRef.current = onPreviewError;

  // Pausar (modal de configurações aberto) é tratado como desligar: o
  // `SettingsModal` abre o próprio preview de câmera, e dois `getUserMedia` de
  // vídeo sobre o mesmo device na mesma aba é justamente o cenário de
  // `NotReadableError` em hardware de acesso exclusivo.
  const previewOn = cameraOn && !previewPaused;
  // Só o id entra nas deps: `preferences` é um objeto e a identidade dele muda
  // sem que a câmera pedida mude. É o único campo que `buildConstraints` usa
  // aqui, porque o áudio é fixo em `false`.
  const videoInputId = preferences?.videoInputId || '';

  useEffect(() => {
    if (!previewOn) return undefined;
    let cancelled = false;

    (async () => {
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia(
          buildConstraints({ videoInputId }, { video: true, audio: false }),
        );
      } catch {
        // Falha de preview **nunca** bloqueia a entrada: vira linha de aviso e
        // a pessoa continua podendo entrar (e ligar a câmera dentro da sala).
        if (!cancelled) onPreviewErrorRef.current?.(PREVIEW_ERROR);
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      setPreviewStream(stream);
      onPreviewErrorRef.current?.(null);
    })();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setPreviewStream(null);
    };
  }, [previewOn, videoInputId]);

  const trimmed = nameInput.trim();

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!trimmed) return;
    onSubmit?.(trimmed);
  };

  return (
    <main className="home prejoin">
      <h1>wtk-meet</h1>
      <p className="tagline">Você foi convidado para uma sala. Escolha um nome para entrar.</p>

      <div className="local-preview prejoin-preview">
        {/* `cameraOff` segue o preview, não o toggle: com o modal aberto o
            stream foi parado, e o tile precisa mostrar o placeholder — não o
            último quadro congelado. */}
        <VideoTile
          stream={previewStream}
          label={trimmed || 'Você'}
          mirrored
          cameraOff={!previewOn}
        />
      </div>

      <label className="prejoin-toggle">
        <input
          type="checkbox"
          checked={cameraOn}
          onChange={(event) => onToggleCamera?.(event.target.checked)}
        />
        Entrar com a câmera ligada
      </label>
      <p className="hint">
        Sua escolha fica gravada neste navegador. O padrão é entrar com a câmera desligada.
      </p>

      <form onSubmit={handleSubmit}>
        <label className="field">
          Seu nome
          <input
            value={nameInput}
            onChange={(e) => onNameChange?.(e.target.value)}
            placeholder="Como te chamam"
            maxLength={40}
            autoFocus
          />
        </label>
        <div className="actions">
          <button type="submit" disabled={!trimmed}>
            Entrar na sala
          </button>
          <button type="button" className="secondary" onClick={() => onOpenSettings?.()}>
            Configurações
          </button>
        </div>
      </form>
    </main>
  );
}
