# Baseline discovery — pontos de integração antes das cinco melhorias

Levantamento feito no commit `c0800d5` (branch `agent/3-implementar-cinco-melhorias-de-experi-nc`),
antes de qualquer alteração. Objetivo: confirmar, no código real, as premissas da task.

## 1. `toggleCamera` só desabilita o track (LED continua aceso)

`client/src/pages/Room.jsx` (linhas 189–197, versão baseline):

```js
const toggleCamera = useCallback(() => {
  const stream = localStreamRef.current;
  if (!stream) return;
  const next = !cameraOff;
  stream.getVideoTracks().forEach((t) => {
    t.enabled = !next;                 // <— só flag; o track continua "live"
  });
  setCameraOff(next);
}, [cameraOff]);
```

`track.enabled = false` mantém `track.readyState === 'live'`: o navegador continua
com o device aberto (frames pretos são enviados no lugar dos reais), portanto o
LED físico da webcam permanece aceso. Não há nenhuma chamada a `track.stop()` no
caminho do botão, nem re-aquisição via `getUserMedia` para religar.

**Confirmado.** Correção exige `stop()` + `replaceTrack(null)` no desligar e
`getUserMedia({video:true})` + `replaceTrack(novoTrack)` no religar.

## 2. Ausência de `onnegotiationneeded` em `webrtcMesh.js`

`grep -n "negotiation\|onnegotiationneeded\|rollback\|polite" client/src/lib/webrtcMesh.js`
→ **nenhum resultado** no baseline.

A negociação é one-shot, decidida pelo flag `initiator` em `addPeer()`:

```js
if (initiator) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  this.signaling.sendSignal(peerId, { type: 'offer', sdp: offer });
}
```

`handleSignal` trata apenas `offer` / `answer` / `ice-candidate` e sempre responde
a um offer com um answer — sem checagem de `signalingState`, sem rollback, sem
papel polite/impolite. Qualquer segunda negociação (ex.: entrar em compartilhamento
de tela) e qualquer glare (dois offers cruzados) quebrariam a conexão com
`InvalidStateError`.

Também não existe `pc.addTransceiver` — as tracks entram via `pc.addTrack` num
laço sobre `localStream`, ou seja, **uma única track de vídeo por peer**, sem
espaço para uma segunda (tela) sem renegociar.

**Confirmado.**

## 3. Eventos `peer-joined` / `peer-left` já existem no servidor

`server/src/index.js`:

- `admitToRoom()` (linha 132): `socket.to(roomId).emit('peer-joined', { peerId: socket.id, displayName })`
- `leaveCurrentRoom()` (linha 140): `socket.to(roomId).emit('peer-left', { peerId: socket.id })`
- `disconnect` (linha 115) também chama `leaveCurrentRoom()`, cobrindo saída por
  fechar aba/queda de rede.
- `join-approved` (linha 126) entrega `selfId` — hoje ignorado pelo client, mas é
  exatamente o identificador necessário para decidir o papel polite/impolite de
  forma determinística.

Conclusão: os avisos de entrada/saída (toast + bipe) **não exigem nenhum evento
novo** no servidor. `peer-left` não carrega o `displayName`, mas o client já
mantém o mapa `participants` (peerId → displayName) e resolve o nome localmente.

**Confirmado — `server/src/index.js` permanece intocado.**

## 4. Nenhum data channel em lugar nenhum

`grep -rn "createDataChannel\|ondatachannel\|RTCDataChannel" client/ server/`
→ **nenhum resultado**.

Não existe canal P2P de dados; consequentemente não existe chat de espécie
alguma (nem via servidor). O servidor Socket.IO expõe hoje apenas os eventos
`join-request`, `approve-join`, `deny-join`, `signal`, `leave-room`,
`join-approved`, `join-denied`, `peer-joined`, `peer-left` — nenhum deles carrega
conteúdo de usuário além do `displayName`.

**Confirmado.** O chat será construído do zero sobre `RTCDataChannel`
(`negotiated: true, id: 0`), sem tocar no servidor.

## 5. Indicadores de áudio

`grep -rn "AudioContext\|AnalyserNode\|getFloatTimeDomainData" client/`
→ **nenhum resultado**. Não há nenhuma análise de nível de áudio, nem local nem
remota, nem qualquer campo de volume nos payloads de sinalização.

**Confirmado.**

## Decisões de arquitetura derivadas do baseline

| Problema | Decisão |
|---|---|
| Segunda track de vídeo (tela) | Três transceivers pré-criados por peer, sempre na mesma ordem (`audio`, `video` câmera, `video` tela). A identificação no receptor é por **identidade de objeto do transceiver** (`event.transceiver === rec.camT`), não por `mid` nem por heurística de `label`. |
| Renegociação | Perfect negotiation completo (MDN), papel `polite = selfId < peerId` (comparação lexicográfica dos socket ids — determinística e oposta nos dois lados). |
| Estado câmera/tela do peer remoto | Enviado pelo **data channel**, não inferido de `track.muted` (que no Chromium demora segundos para disparar). |
| Chat | Mesmo data channel, `negotiated: true, id: 0` — os dois lados criam o canal com o mesmo id, sem `ondatachannel` e sem corrida. |
| Níveis de áudio | 100% local: um `AudioContext` compartilhado, um `AnalyserNode` por stream, um único loop `requestAnimationFrame`. Nada trafega pela rede. |
