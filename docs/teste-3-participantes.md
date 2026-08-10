# Teste com 3 participantes — roteiro, execução e resultados

Roteiro de validação das cinco melhorias com **3 participantes em navegadores
Chromium distintos**: falar (anel azul), compartilhar tela, trocar mensagens,
desligar/religar câmera e sair da sala.

O roteiro está automatizado em `e2e/run.mjs` e foi executado; a seção final
lista o que só uma passada em hardware real cobre.

## Como o teste automatizado é montado

```bash
# dependências de sistema do Chromium (uma vez)
cd e2e && npm install && npx playwright install chromium && npx playwright install-deps chromium

node e2e/run.mjs
```

O script sobe tudo sozinho:

| Peça | Por quê |
|---|---|
| **TURN local** (`node-turn` em `127.0.0.1`) | O client usa `iceTransportPolicy: 'relay'`. Sem um TURN alcançável, nenhum candidato é gerado e nenhuma conexão fecha — nem em loopback. |
| **Servidor de sinalização** em porta sorteada | Isola execuções concorrentes e evita `EADDRINUSE` de uma rodada anterior mal encerrada. |
| **Build do client** apontando para essa porta | `SIGNALING_URL` é resolvido em tempo de build (`import.meta.env`), não em runtime. |
| **3 `BrowserContext` isolados** | Cada participante tem storage e permissões próprios — equivalente a três janelas anônimas separadas. |
| `--use-fake-device-for-media-stream` | Câmera e microfone sintéticos, sem hardware. |
| `--auto-select-desktop-capture-source` | `getDisplayMedia` sem diálogo de escolha de tela. |
| Interceptação de `**/turn-credentials` | Injeta o ICE server local **sem tocar no código de produção**. |
| Wrappers de `WebSocket`/`XMLHttpRequest` | Registram cada frame trocado com o servidor — é a evidência direta de que o chat não passa por lá. |

## Resultados — 41/41 verificações, 4 execuções consecutivas limpas

### A. Mesh com 3 participantes

| # | Verificação | Resultado |
|---|---|---|
| A1 | 3 participantes, 2 `RTCPeerConnection` `connected` cada | ✅ |
| A2 | Por conexão: 1 áudio + 2 vídeo em cada sentido | ✅ `["audio:sendonly","video:sendonly","video:sendonly","audio:recvonly","video:recvonly","video:recvonly"]` |
| A3 | Grade com 3 tiles | ✅ |

### B. Indicador de fala

| # | Verificação | Resultado |
|---|---|---|
| B1 | Anel azul acende a partir do áudio (local e remoto) | ✅ |
| B2 | Um único `AudioContext` para a sala inteira | ✅ `AudioContexts=1` |
| B3 | Um único loop `requestAnimationFrame` | ✅ 30–55 chamadas/s com 3 tiles (um loop por tile daria ~3×) |
| B4 | Religar o microfone acende o anel de novo (5 ciclos) | ✅ |
| B5 | Apaga dentro da janela de histerese, nunca instantaneamente | ✅ release observado 182–574ms |
| B6 | Nenhum nível de áudio transmitido pela aplicação | ✅ 0 payloads |

Sobre B5: os limites exatos (**<200ms para acender, ~500ms para apagar**) são
verificados de forma determinística em `client/test/audioLevels.test.mjs`, com
relógio e analisador controlados. No navegador não dá para cravá-los: o
dispositivo de áudio falso do Chromium emite bipes curtos e esparsos em vez de
um tom contínuo, e o Chrome não entrega o áudio de uma track a um segundo
`AudioContext` — então não há como instalar uma sonda independente que marque o
instante real em que o silêncio começou. O maior release observado (≈570ms) é
consistente com a janela de 500ms mais o throttle de emissão de 50ms; os valores
menores são cliques que caíram numa pausa entre bipes.

### C. Compartilhamento de tela e glare

| # | Verificação | Resultado |
|---|---|---|
| C1 | Bob e Carol compartilham quase ao mesmo tempo | ✅ |
| C2 | Nenhuma conexão cai durante o glare | ✅ |
| C3 | `signalingState` volta a `stable` em todas as conexões | ✅ |
| C4 | Compartilhar tela **não** renegocia SDP | ✅ `setLocalDescription: 5 → 5` |
| C5 | Grade cresce para 5 tiles (3 câmeras + 2 telas) | ✅ |
| C6 | Sair do compartilhamento remove a track e restaura a grade | ✅ |

C4 é a razão de os transceivers serem pré-criados: o canal de tela já existe
negociado desde o início, então entrar em compartilhamento é um `replaceTrack()`
e não gera SDP novo. O perfect negotiation continua sendo exercido pela
negociação inicial simétrica — e C1–C3 confirmam que ofertas cruzadas não
quebram nada.

### D. Chat P2P

| # | Verificação | Resultado |
|---|---|---|
| D1 | Mensagem chega a todos em < 1s | ✅ 226–308ms |
| D2 | Exibe nome do autor e horário | ✅ `"Alice 11:44 PM mensagem-p2p-…"` |
| D3 | Conteúdo não aparece em nenhum frame trocado com o servidor | ✅ 32 frames inspecionados |
| D4 | Nenhum evento de chat no protocolo Socket.IO | ✅ |
| D5 | Nada de chat em `localStorage`/`sessionStorage` | ✅ (só `displayName`, que é do fluxo de entrada) |
| D6 | Recarregar a página apaga o histórico por completo | ✅ 0 mensagens |

Inventário completo dos eventos Socket.IO observados no fio durante a sessão
inteira:

```
["approve-join","join-approved","join-request","peer-joined","peer-left","signal"]
```

Exatamente os eventos de sinalização que já existiam. Nenhum evento de chat,
nenhum de presença extra, nenhum de nível de áudio.

### E. Câmera

| # | Verificação | Resultado |
|---|---|---|
| E1 | Desligar chama `track.stop()` (`readyState: "ended"`) | ✅ |
| E2 | `replaceTrack(null)` em todos os senders de vídeo | ✅ `[0,0]` |
| E3 | Peers remotos passam a mostrar placeholder | ✅ |
| E4 | A chamada não cai | ✅ |
| E5 | Áudio continua vivo com a câmera desligada | ✅ |
| E6 | Religar faz um novo `getUserMedia({video:true})` | ✅ `1 → 2` |
| E7 | Track novo aplicado a todos os senders do mesh | ✅ `[1,1]` |
| E8 | Ciclo completo **sem nenhuma renegociação de SDP** | ✅ `setLocalDescription: 6 → 6` |
| E9 | Áudio intacto no ciclo | ✅ |

`readyState: "ended"` é o estado que corresponde ao device fechado — é isso que
apaga o LED da webcam. O comportamento anterior (`track.enabled = false`) deixava
o track `"live"`, com o device aberto e o LED aceso.

### F. Presença e liberação de recursos

| # | Verificação | Resultado |
|---|---|---|
| F1 | Saída dispara toast com o nome | ✅ `"Carol saiu da sala"` |
| F2 | Toast é efêmero (some em ~4s) | ✅ |
| F3 | O aviso vem acompanhado de um bipe | ✅ osciladores `4 → 5` |
| F4 | "Silenciar avisos" cala o bipe e mantém o toast | ✅ osciladores `5 → 5`, toast presente |
| F5 | Ao sair, todos os tracks estão `ended` | ✅ 0 tracks vivas |
| F6 | Ao sair, todas as `RTCPeerConnection` (e data channels) fechadas | ✅ 0 abertas |
| F7 | Ao sair, o `AudioContext` é fechado | ✅ `["closed"]` |
| F8 | Ao sair, o loop de `requestAnimationFrame` é cancelado | ✅ 0 chamadas/s |
| F9 | A grade encolhe quando alguém sai | ✅ |

### G. Console

Nenhum erro de JavaScript no console de nenhum participante durante a sessão
completa.

## O que o teste automatizado não cobre

Estes pontos exigem uma passada manual em hardware real e ficam como checklist
para quem for validar em máquina:

1. **LED físico da webcam.** O teste prova o estado que o causa
   (`readyState === "ended"` em todos os tracks de vídeo, tanto ao desligar a
   câmera quanto ao sair da sala), mas o LED em si não é observável por software.
   Verificar: clicar em "Desligar câmera" e conferir que o LED apaga em até 1s; e
   que ele apaga também ao clicar em "Sair".
2. **`chrome://webrtc-internals`.** Confirmar visualmente, depois de sair da
   sala, que não sobrou nenhuma `PeerConnection` ativa.
3. **Barra "Parar compartilhamento" do navegador.** O teste cobre o caminho do
   código (o evento `ended` da track, que é o mesmo gatilho), mas a barra nativa
   não existe em headless. Verificar: compartilhar a tela, parar pela barra do
   Chrome e conferir que a grade volta ao normal nos três participantes.
4. **Diálogo de escolha de tela** do `getDisplayMedia` (janela × aba × tela
   inteira), incluindo o cancelamento pelo usuário — que não deve gerar erro
   visível na UI.
5. **Qualidade percebida**: legibilidade de texto na tela compartilhada (o
   `contentHint = 'detail'` prioriza nitidez sobre framerate) e se o bipe de
   entrada/saída está discreto o suficiente no volume real.
6. **Firefox e Safari.** Toda a validação rodou em Chromium. O layout de
   transceivers depende de a associação de m-lines remotas seguir a ordem das
   m-lines (comportamento especificado), e há um caminho de fallback por
   `track.kind` para navegadores que pareiem de outra forma — mas isso não foi
   exercitado.
