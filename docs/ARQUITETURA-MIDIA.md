# wtk-meet — Arquitetura de mídia

Documento de referência das cinco features de chamada: onde cada uma vive, por
que foi feita assim e onde mexer para estendê-la.

---

## 1. Fase de descoberta — o que foi encontrado

A tarefa exigia identificar a stack de tempo real antes de qualquer decisão. O
levantamento foi conclusivo:

| Verificação | Resultado |
|---|---|
| Conteúdo de `main` | Um arquivo: `README.md`, uma linha |
| Histórico | Um commit (`93cc774`), só o README |
| Todas as branches (`main` + 7 `agent/*`) | Mesmo commit, nenhum código |
| Remoto `github.com/WTK-Desenvolvimento/wtk-meet` | Inacessível — token do ambiente rejeitado (`Invalid username or token`) |
| Stack de tempo real preexistente | **Nenhuma** |
| Toggle de câmera preexistente | **Nenhum** |

**Conclusão: o wtk-meet é greenfield.** Não existia app para "melhorar". A
análise arquitetural que precedeu esta implementação está em
[`architecture.md`](./architecture.md) — ela avaliou os dois cenários (app
existente vs. greenfield) e este documento registra o caminho efetivamente
seguido.

O sintoma citado na tarefa — "a imagem fica preta mas o LED continua aceso" — é
a assinatura de `track.enabled = false`. Não era um bug a corrigir aqui; virou
um **requisito de projeto**: a seção 6 descreve como o app evita nascer com ele.

### 1.1 Stack escolhida

**WebRTC nativo em malha (mesh) + servidor de signaling próprio em Node/`ws`.**

Por que não um SFU gerenciado (LiveKit/Daily/Agora), que a análise prévia
recomendava para greenfield: o SFU compensa quando o gargalo é escala de sala.
Ele traz, junto, uma conta a pagar, um serviço a operar e uma credencial que
este ambiente não tem. Para salas pequenas — o caso do wtk-meet hoje — mesh
entrega as cinco features sem nada disso, e o app roda com `npm install &&
npm run dev`.

O ponto de virada é conhecido e está registrado na seção 9: acima de ~5
participantes simultâneos, o upload de cada cliente satura e a migração para SFU
passa a valer. O contrato de slots da seção 3 foi desenhado para que essa
migração troque `rtc.js` e nada mais.

---

## 2. Mapa dos arquivos

```
server/
  index.js          servidor HTTP + WebSocket: relay de SDP/ICE, chat, presença, trava de tela
  rooms.js          registro de salas em memória (sem persistência) + rate limit do chat
src/
  main.js           fio condutor — liga todos os módulos
  signaling.js      cliente WebSocket
  rtc.js            malha de RTCPeerConnection e o contrato de slots
  media.js          câmera, microfone e tela locais  ← feature 4 vive aqui
  audio-meter.js    AnalyserNode + agendador rAF/ocioso  ← feature 1
  speaking-ring.js  ondas e partículas em canvas  ← feature 1
  tiles.js          grade de participantes; escreve `--level` no DOM
  chat.js           painel de chat efêmero  ← feature 3
  notifications.js  modal, toasts e sons  ← feature 5
  lib/level.js      matemática do medidor (pura, testada)
  lib/text.js       normalização e tokenização de texto (pura, testada)
  lib/presence.js   agrupamento e debounce de entrada/saída (pura, testada)
  lib/share-lock.js política de um-compartilhamento-por-vez (pura, testada)
test/
  helpers/fake-env.js  navegador falso: DOM mínimo + getUserMedia,
                       getDisplayMedia, RTCPeerConnection e AnalyserNode falsos
  *.test.js            165 testes: lógica pura, protocolo contra o servidor
                       real, módulos de navegador e uma chamada ponta a ponta
```

Regra que organiza tudo isso: **o que é lógica pura mora em `src/lib/`**, e o que
toca DOM ou WebRTC fica fino o bastante para ser dirigido por doubles.

O `test/helpers/fake-env.js` é o que permite testar a parte de navegador sem
navegador. Ele não é um jsdom pobre: é um conjunto de doubles que **registram o
que o app fez** — quantas vezes cada `MediaStreamTrack.stop()` foi chamado, o que
passou por cada `sender.replaceTrack()`, quais nós entraram no DOM, quantos
`requestAnimationFrame` ficaram agendados. É isso que transforma "o LED apaga" e
"não gasta CPU em silêncio" em asserções, em vez de comentários de código.
Ver `docs/TESTE-MANUAL.md` para o mapa item-do-DoD → teste.

---

## 3. O contrato de slots — a decisão que sustenta as features 2 e 4

Cada `RTCPeerConnection` nasce com **três transceivers fixos, sempre nesta
ordem**:

```
slot 0 → áudio        slot 1 → vídeo da câmera        slot 2 → vídeo da tela
```

`src/rtc.js:offerTo()` cria os três de uma vez, antes de existir qualquer track.

Consequências, e é por elas que a decisão existe:

- Ligar/desligar câmera ou tela vira **`sender.replaceTrack(track | null)`**.
  Nenhuma renegociação no meio da chamada.
- Sem renegociação, **não existe glare** — e portanto não precisamos de perfect
  negotiation, polite/impolite peer, nem fila de estados de sinalização.
- O receptor sabe o que chegou pelo **índice do transceiver**
  (`pc.getTransceivers().indexOf(event.transceiver)`), sem convenção de nome de
  stream.
- Quem já estava na sala envia a oferta; quem chega responde. Regra fixa, sem
  decisão em tempo de execução.

**Armadilha coberta** (`src/rtc.js:handleSignal`): transceivers criados a partir
de uma oferta remota nascem `recvonly`. Sem promovê-los explicitamente para
`sendrecv` antes do `createAnswer`, o `replaceTrack` posterior não envia nada e o
outro lado vê tela preta — com todo o resto do código aparentemente correto.

**Ponto de extensão:** um quarto slot (segunda câmera, tradução, etc.) é
adicionar um `addTransceiver` no fim da lista e uma constante em `SLOT`. Ordem
existente não pode mudar — ela é o contrato entre as pontas.

---

## 4. Feature 1 — Halo azul reativo ao volume

**Arquivos:** `src/audio-meter.js`, `src/lib/level.js`, `src/speaking-ring.js`,
`src/tiles.js`, `src/styles.css` (`.tile`).

Pipeline: `AnalyserNode` (fftSize 512, smoothing 0.8) → RMS do domínio do tempo →
dBFS → normalização para 0..1 → suavizador com ataque rápido / liberação lenta e
hangover de 500 ms.

**Por que não é on/off:** o nível contínuo é escrito na custom property CSS
`--level` do tile, e o `box-shadow` calcula raio, opacidade e blur a partir dela.
Falar baixo dá um halo fino; falar alto dá um halo largo e brilhante.

```css
box-shadow:
  0 0 0 calc(1px + var(--level) * 5px) rgb(var(--azul) / calc(0.25 + var(--level) * 0.55)),
  0 0 calc(var(--level) * 42px) calc(var(--level) * 10px) rgb(var(--azul) / calc(var(--level) * 0.45));
```

**Por que roda a 60 fps sem travar:** nada é re-renderizado. O tick escreve uma
custom property e desenha num canvas. Não há framework no caminho quente.

**Por que não consome CPU em silêncio:** o `requestAnimationFrame` é
**desligado** quando todos os níveis zeram; entra uma sondagem de 250 ms que
custa uma passada de 512 amostras por participante, 4 vezes por segundo. Ao
detectar som, volta ao rAF. Estados observáveis em `meter.mode`:
`'active' | 'idle' | 'stopped'`.

**Ondas e partículas** (`speaking-ring.js`): contornos arredondados que crescem e
desvanecem (um a cada ~320 ms, mais rápido quanto mais alto o volume) e até 14
partículas percorrendo o perímetro, com quantidade e brilho proporcionais ao
nível. Não têm loop próprio — são desenhadas pelo mesmo tick do medidor.

**`prefers-reduced-motion`:** troca a animação por um contorno estático cuja
espessura e opacidade ainda acompanham o volume. A informação permanece; o
movimento não. Detectado uma vez no carregamento do módulo.

**Acessibilidade:** cor não é o único canal. O `.mic-dot` na plaquinha de nome
acende junto (`[data-speaking="true"]`) e fica vermelho com o microfone mudo.

**Pegadinha do Chrome já tratada:** um `AnalyserNode` alimentado por stream
*remoto* só produz dados se o mesmo stream estiver anexado a um elemento de mídia
vivo no DOM. Os tiles fazem isso — por isso o medidor é alimentado a partir do
track que já está no `<video>`.

---

## 5. Feature 2 — Compartilhamento de tela

**Arquivos:** `src/media.js:startScreen/stopScreen`, `src/main.js`
(`share-granted`, `stopSharing`, `updateShareButton`), `src/lib/share-lock.js`,
`server/index.js` (`share-request` / `share-stop`).

- Captura por `getDisplayMedia`, publicada no **slot 2** — tela e câmera coexistem
  em tiles separados, ninguém precisa escolher entre mostrar o rosto e mostrar o
  código.
- `contentHint = 'detail'` e `degradationPreference = 'maintain-resolution'`:
  slide e terminal continuam legíveis quando a banda aperta.
- **Encerrar pelo botão nativo do navegador funciona.** `track.addEventListener
  ('ended')` chama o mesmo `stopSharing()` do botão do app. Este é o bug número
  um de implementações caseiras: sem ele a UI mente sobre o que está sendo
  transmitido.
- **Um por vez, com autoridade no servidor.** A trava é pedida *antes* de abrir o
  seletor — ninguém escolhe a janela para só então ouvir "não". Se o seletor for
  cancelado, a trava é devolvida. Se quem compartilha cair, o servidor libera
  sozinho (testado).
- **Sem suporte → botão desabilitado**, com o motivo no `title`
  (`SUPPORTS_SCREEN_SHARE`, feature detection real). Safari do iOS não tem
  `getDisplayMedia`.
- Áudio da aba é pedido (`audio: true`) mas tratado como melhor esforço: só o
  Chromium entrega, e só para certas fontes.

---

## 6. Feature 4 — Encerramento real do track de câmera

**Arquivo:** `src/media.js`. É o módulo com a regra mais importante do app:

> Desligar a câmera **fecha o dispositivo** (`track.stop()`).
> Nunca `track.enabled = false`.

`enabled = false` apenas substitui os quadros por preto. O dispositivo continua
aberto e o LED continua aceso — comportamento correto do navegador, promessa
quebrada para quem está do outro lado da câmera. Este é um problema de
privacidade percebida, não de renderização.

Ao **desligar** (`disableCamera`):
1. `track.stop()` — libera o hardware, o LED apaga;
2. o track sai do estado local;
3. `sender.replaceTrack(null)` via `hub.republish()` — o transceiver permanece,
   então religar não exige renegociação;
4. `{ t: 'state', patch: { cam: false } }` é anunciado. **Obrigatório**:
   `replaceTrack(null)` não dispara evento confiável no receptor, e sem o anúncio
   os outros ficariam com o último quadro congelado no lugar do avatar. Consertar
   o LED e criar um bug visual não é conserto.

Ao **religar** (`enableCamera`):
1. `getUserMedia` com o **`deviceId` guardado** da última seleção — sem isso o
   navegador pode abrir outra câmera;
2. `replaceTrack(novoTrack)` em todas as conexões;
3. anúncio de `cam: true`.

Detalhes que separam isto de uma implementação ingênua:

- **Corrida por duplo clique:** guarda `busy` no módulo *e* botão desabilitado
  durante a transição. Alternar rápido não deixa dois tracks vivos.
- **`deviceId` que sumiu** (câmera trocada de porta): `OverconstrainedError` /
  `NotFoundError` limpam a preferência e tentam o dispositivo padrão, uma vez.
  A retentativa acontece **dentro** da trava `busy` (`enableCamera` faz
  `return await openCamera()`, não `return openCamera()`): com o `return` sem
  `await`, o `finally` soltaria a trava assim que a promessa fosse criada, e um
  clique nesse intervalo abriria uma segunda câmera órfã — LED aceso, ninguém
  apontando para ela. Coberto por teste
  (`test/media-camera.test.js`, "a trava de concorrência continua valendo
  durante a retentativa de fallback").
- **Dispositivo tomado por outro app:** `NotReadableError` vira uma mensagem
  clara ("a câmera está em uso por outro aplicativo"), não uma falha silenciosa.
- **Câmera arrancada** (USB removido): o listener de `ended` do próprio track
  atualiza a UI.
- **Bug irmão, mesma raiz:** `stopAll()` encerra áudio, vídeo e tela ao sair da
  sala e no `pagehide`. Track vazado ao fechar a aba é a variante mais comum — e
  mais grave — do mesmo defeito.

**E o microfone?** Ali `enabled = false` é a escolha *certa*: mutar precisa ser
instantâneo (você corta o próprio espirro), e ~300 ms de reaquisição perderia a
próxima frase. A assimetria é deliberada e está comentada no código.

---

## 7. Feature 3 — Chat de texto efêmero

**Arquivos:** `src/chat.js`, `src/lib/text.js`, `server/index.js` (case `chat`),
`server/rooms.js`.

- **Transporte:** o mesmo WebSocket do signaling. Já está conectado, já conhece a
  sala. Um `RTCDataChannel` por par seria mais código para o mesmo resultado.
- **Efêmero de verdade:** o histórico existe num array em memória do cliente e em
  lugar nenhum do servidor. Sala vazia é destruída (`server/rooms.js:leave`).
  Quem entra depois não recebe nada — testado explicitamente, porque isso é
  requisito e não ausência de feature.
- **Sem caminho de injeção:** `src/chat.js` não tem uma única atribuição de
  `innerHTML`. Todo texto entra por `createTextNode`; links viram `<a>` com href
  vindo de `tokenize()`, que só reconhece `http(s)`. `javascript:`, `data:` e
  `vbscript:` permanecem texto puro — há teste para cada um. Links levam
  `rel="noopener noreferrer nofollow"`.
- **Limite de 2000 caracteres**, com contador ao vivo, validado no cliente **e**
  no servidor. Rate limit de 5 mensagens por 3 s, no servidor — cliente é
  território hostil.
- **Badge de não lidas** no botão do chat quando o painel está fechado; zera ao
  abrir. Mensagens de sistema não contam como não lidas.
- **Autoscroll só se já estava no fim**, para não arrancar a leitura de quem
  subiu o histórico.
- **Horário do relógio local do receptor** — o do remetente não é confiável.

---

## 8. Feature 5 — Avisos de entrada e saída

**Arquivos:** `src/notifications.js`, `src/lib/presence.js`, `src/main.js`
(`drainPresence`).

- **Entrada → modal com ação explícita** ("Entendi"), enfileirado: um modal por
  vez, o próximo abre quando o anterior é fechado. Foco vai para o botão e volta
  para onde estava; `Esc` fecha.
- **Saída → toast discreto** com auto-dismiss em 4,2 s, no máximo 4 empilhados —
  uma rajada não pode cobrir a chamada. `role="status"` + `aria-live="polite"`.
- **Agrupamento:** eventos do mesmo tipo dentro de 600 ms viram um aviso só
  ("Ana, Bruno e mais 2 entraram na chamada").
- **Debounce de 2 s na saída, casado pelo nome.** Uma oscilação de rede gera
  desconexão + reconexão; sem isso a sala vira um letreiro de "Fulano saiu /
  Fulano entrou". O id é por socket e muda na reconexão — por isso o casamento é
  pelo nome (`keyOf`), não pelo id. Há teste para exatamente esse cenário.
- **Sons sintetizados com WebAudio**, sem arquivo de asset: entrada sobe
  (440→660 Hz), saída desce (520→330 Hz), ~300 ms com envelope. Preferência de
  silenciar persistida em `localStorage` (a única coisa que este app guarda) e
  respeitada por ambos.
- **Nada toca para a própria entrada** — o `welcome` não passa pelo tracker.
- A limpeza técnica (fechar a `RTCPeerConnection`, remover o tile) é **imediata**;
  só o *aviso* espera o debounce.

---

## 9. Limites conhecidos

| Limite | Consequência | Quando encarar |
|---|---|---|
| Topologia mesh | Cada cliente envia N−1 streams; upload doméstico satura | Acima de ~5 participantes simultâneos → migrar `rtc.js` para SFU |
| Só STUN, sem TURN | Falha em redes corporativas com NAT simétrica | Antes de qualquer uso fora de LAN/rede doméstica |
| Sem autenticação de sala | Quem souber o nome entra | Antes de expor na internet |
| Sem HTTPS no servidor embutido | `getUserMedia` só funciona em `localhost` | Pôr atrás de um proxy TLS para testar em rede |
| Sem reconexão automática | Queda do WebSocket exige recarregar | Se a instabilidade de rede virar reclamação recorrente |

---

## 10. Como rodar

```bash
npm install
npm run dev      # http://localhost:5173 servindo o fonte
npm run preview  # build + servidor servindo dist/
npm test         # 165 testes
npm run lint
```

Duas abas em `localhost` bastam para exercitar tudo. Para testar entre máquinas é
preciso HTTPS — navegador não entrega câmera nem microfone em origem insegura.

Roteiro de verificação manual: [`TESTE-MANUAL.md`](./TESTE-MANUAL.md).
