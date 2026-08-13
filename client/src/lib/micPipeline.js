/**
 * O grafo de áudio do microfone: `source → worklet → destination`.
 *
 * Mora fora de `noiseSuppression.js` de propósito. O DoD da WTK-MEET-11 exige
 * que aquele módulo seja puro (sem `navigator`, sem `AudioContext`, sem
 * `localStorage`), e é aqui que todo o efeito colateral se concentra: este é o
 * único arquivo da entrega que encosta em WebAudio.
 *
 * O que ele existe para resolver, e que nenhuma outra camada consegue: com o
 * worklet ativo, **o track que vai para o mesh não é o track que o
 * `getUserMedia` devolveu**. Quatro lugares do `Room` assumiam que os dois eram
 * a mesma coisa, e as quatro suposições falhavam em silêncio — microfone que
 * continua aberto depois de sair da sala, recuperação de device arrancado que
 * nunca dispara, preferência que para de se autocorrigir, captura vazada a cada
 * troca de microfone. Por isso o pipeline tem dono explícito e expõe os dois
 * tracks separadamente.
 */

import workletUrl from './noiseSuppressorWorklet.js?url';
import { MODE, PROCESSOR_NAME, decideCapabilityMode } from './noiseSuppression.js';

/**
 * Pergunta ao navegador o que ele sabe fazer e devolve o modo.
 *
 * A leitura de `navigator` e de `AudioWorkletNode` mora aqui, e não no módulo
 * puro, para que a matriz de decisão continue testável sem navegador. É também
 * o ponto por onde o E2E força o caminho de fallback: basta o harness devolver
 * um `getSupportedConstraints()` sem `noiseSuppression`.
 */
export function detectNoiseMode() {
  let supportedConstraints = null;
  try {
    supportedConstraints = navigator.mediaDevices?.getSupportedConstraints?.() || null;
  } catch {
    supportedConstraints = null;
  }
  const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  const audioWorkletSupported =
    typeof AudioWorkletNode === 'function' && !!Ctor && 'audioWorklet' in Ctor.prototype;
  return decideCapabilityMode({ supportedConstraints, audioWorkletSupported });
}

/**
 * `addModule` uma vez por contexto. Um `WeakMap` (e não um booleano de módulo)
 * porque o `AudioContext` da sala é fechado e recriado a cada entrada: um flag
 * global faria a segunda sala pular o `addModule` num contexto que nunca o
 * recebeu, e o `AudioWorkletNode` falharia com "unknown processor".
 */
const moduleLoads = new WeakMap();

function ensureModule(context) {
  let load = moduleLoads.get(context);
  if (!load) {
    // A rejeição é tratada aqui e vira `false`: uma promise rejeitada solta
    // dentro de um efeito vira `unhandledrejection`, e a checagem G do E2E
    // reprova a suíte inteira com qualquer erro de console.
    load = context.audioWorklet
      .addModule(workletUrl)
      .then(() => true)
      .catch((err) => {
        console.warn('[micPipeline] addModule falhou; seguindo sem supressão:', err);
        return false;
      });
    moduleLoads.set(context, load);
  }
  return load;
}

/**
 * Pipeline degenerado: o track cru é o track de saída. É o que se entrega no
 * modo nativo (o navegador já processou), com o toggle desligado, e em
 * **qualquer** caminho de erro.
 */
function passthrough(rawTrack, mode) {
  let stopped = false;
  const pipeline = {
    mode,
    processing: false,
    track: rawTrack,
    rawTrack,
    release: () => pipeline,
    stop() {
      if (stopped) return;
      stopped = true;
      rawTrack?.stop();
    },
  };
  return pipeline;
}

/**
 * Monta (ou não) o grafo e devolve o pipeline.
 *
 * **Nunca rejeita e nunca devolve um track morto.** Qualquer falha — contexto
 * suspenso, `addModule` rejeitando, `AudioWorkletNode` indisponível — degrada
 * para o track cru. A alternativa seria a pior falha possível desta entrega:
 * um `MediaStreamAudioDestinationNode` em contexto suspenso produz um track
 * `live` que só emite **silêncio**, e o sintoma é a pessoa entrar na sala com o
 * ícone de microfone normal, o anel de fala apagado e ninguém a ouvindo — sem
 * um erro sequer no console.
 */
export async function createMicPipeline({ rawTrack, enabled, mode, context } = {}) {
  if (!rawTrack) return passthrough(null, mode);
  // No modo nativo o navegador já entregou o áudio processado; montar o grafo
  // aqui empilharia duas supressões em série.
  if (mode !== MODE.WORKLET || !enabled) return passthrough(rawTrack, mode);
  if (!context || typeof context.audioWorklet?.addModule !== 'function') {
    return passthrough(rawTrack, mode);
  }
  // Política de autoplay: antes do primeiro gesto o contexto está suspenso, e
  // esse é o estado **normal** na entrada da sala. Quem chama re-tenta no gesto.
  if (context.state !== 'running') return passthrough(rawTrack, mode);

  const loaded = await ensureModule(context);
  if (!loaded) return passthrough(rawTrack, mode);

  let source = null;
  let node = null;
  let destination = null;
  try {
    source = context.createMediaStreamSource(new MediaStream([rawTrack]));
    node = new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { enabled: true },
    });
    destination = context.createMediaStreamDestination();
    source.connect(node);
    node.connect(destination);
  } catch (err) {
    console.warn('[micPipeline] grafo indisponível; seguindo sem supressão:', err);
    try {
      source?.disconnect();
      node?.disconnect();
    } catch {
      // já desconectado
    }
    return passthrough(rawTrack, mode);
  }

  const processed = destination.stream.getAudioTracks()[0] || null;
  // Invariante: nunca entregar um track morto. Sem track no destino, o cru é a
  // resposta certa — pior que não suprimir é não ter áudio.
  if (!processed || processed.readyState !== 'live') {
    try {
      source.disconnect();
      node.disconnect();
    } catch {
      // já desconectado
    }
    return passthrough(rawTrack, mode);
  }

  // O mute vive no track que vai para o mesh; o destino nasce habilitado e quem
  // instala ajusta antes do `replaceTrack`.
  let stopped = false;
  const teardown = () => {
    try {
      source.disconnect();
      node.disconnect();
      destination.disconnect();
    } catch {
      // já desconectado
    }
  };

  return {
    mode,
    processing: true,
    track: processed,
    rawTrack,
    /**
     * Desmonta o grafo e devolve um pipeline sobre o **mesmo track cru**, que
     * continua vivo.
     *
     * É o desligamento do toggle em chamada: quem chama faz o `replaceTrack`
     * para o track cru **antes**, e só então chama isto. Parar o processado
     * primeiro abriria uma janela de silêncio audível para todos os peers.
     */
    release() {
      if (stopped) return passthrough(rawTrack, mode);
      stopped = true;
      teardown();
      processed.stop();
      return passthrough(rawTrack, mode);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      teardown();
      // Os **dois**: parar só o destino deixaria o `getUserMedia` vivo, com o
      // LED do microfone aceso depois de sair da sala.
      processed.stop();
      rawTrack.stop();
      // O `AudioContext` é do `Room` — o grafo da música e o medidor de fala
      // vivem nele. Fechá-lo aqui mataria os dois em silêncio.
    },
  };
}
