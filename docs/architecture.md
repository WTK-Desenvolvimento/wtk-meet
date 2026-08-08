# wtk-meet — Arquitetura das melhorias de UX e mídia na chamada

**Status:** Fase 1 (descoberta) concluída — **bloqueada por ausência de código-fonte**.
**Autor:** Winston (Arquiteto de Software)
**Data:** 2026-08-08
**Escopo:** halo de fala reativo ao volume, compartilhamento de tela, chat efêmero, encerramento real do track de câmera, avisos de entrada/saída.

---

## 1. Resultado da Fase 1 — Descoberta

A descoberta era pré-requisito obrigatório das demais fases. O resultado foi conclusivo e negativo:

| Verificação | Resultado |
|---|---|
| Conteúdo do repositório (`main`) | 1 arquivo: `README.md`, com uma linha (`# wtk-meet`) |
| Histórico Git | 1 commit (`93cc774`, "first commit", 2026-08-06) — adiciona apenas o `README.md` |
| Demais branches (`main` + 7 branches `agent/*`) | Todas apontam para o mesmo commit `93cc774`. Nenhum código em nenhuma delas. |
| Stashes / refs soltos | Nenhum |
| Remoto (`github.com/WTK-Desenvolvimento/wtk-meet`) | Inacessível — o token de acesso do ambiente foi rejeitado (`Invalid username or token`). Não foi possível verificar se existem branches remotas adicionais. |
| Busca por `project-context.md` no ambiente | Não encontrado |

**Conclusão:** não existe código de aplicação para inspecionar. Por consequência, as três perguntas centrais da fase 1 permanecem **sem resposta**:

1. **Onde vive o código do app?** (outro repositório, outra organização, ou ainda não versionado)
2. **Qual é a stack de tempo real?** (WebRTC "puro" com signaling próprio vs. SDK — LiveKit, Daily, Agora, Twilio, Jitsi)
3. **Como o toggle de câmera está implementado hoje?** — esta é a pergunta que define diretamente o item 4 do escopo.

O sintoma descrito no item 4 ("imagem fica preta mas o LED continua aceso") é, na prática, um **diagnóstico**: é o comportamento assinatura de `track.enabled = false`. Isso é forte indício de implementação existente, mas o código não está aqui.

### 1.1 O que destrava a fase 2

Precisamos de **uma** das duas coisas:

- **(a)** O repositório/caminho correto do código do app (e um token de acesso válido, se for remoto); **ou**
- **(b)** A confirmação de que o wtk-meet é greenfield — o que muda a natureza do trabalho de "cinco melhorias" para "construir o app com estas cinco capacidades desde o início".

### 1.2 Checklist de descoberta (para rodar assim que houver código)

Responde as três perguntas em ~10 minutos:

```bash
# Stack de tempo real
cat package.json | grep -iE "livekit|daily|agora|twilio|jitsi|mediasoup|janus|peerjs|simple-peer|socket.io|ws"
grep -rniE "RTCPeerConnection|createOffer|new Room\(|DailyIframe|AgoraRTC" src/ --include=*.{ts,tsx,js,jsx} -l

# Como a câmera é ligada/desligada  ← determina o item 4
grep -rnE "getUserMedia|getDisplayMedia|\.enabled\s*=|\.stop\(\)|replaceTrack|setCameraEnabled|setMicrophoneEnabled" src/ -n

# Signaling / transporte de eventos (destrava chat e avisos de entrada/saída)
grep -rniE "io\(|new WebSocket|publishData|DataChannel|emit\(" src/ -n
```

---

## 2. Recomendação de stack (aplicável se o cenário for greenfield)

Se a resposta a 1.1 for **(b) greenfield**, a decisão mais consequente do projeto é: **SFU gerenciado (LiveKit) em vez de mesh WebRTC caseiro.**

Racional, em termos de valor entregue:

- **Quatro dos cinco itens do escopo são quase gratuitos com um SDK maduro.** Nível de áudio por participante, publicação de screen share como track separado, canal de dados para o chat e eventos de entrada/saída já vêm prontos e testados em produção. Em WebRTC puro, cada um vira um subsistema com bugs próprios (ver seções 3–7).
- **Mesh não escala.** Com N participantes, cada cliente sobe N-1 streams. Acima de ~4–5 pessoas, upload doméstico satura. Um SFU faz cada cliente subir uma vez só.
- **Tecnologia chata é uma vantagem.** LiveKit é open-source (fuga de fornecedor limitada — dá para auto-hospedar), tem SDK web de primeira linha e semântica explícita de mute vs. stop — exatamente o eixo do bug do item 4.

O custo real: uma dependência externa e um servidor de mídia a operar (ou uma fatura de serviço gerenciado). Vale a pena. O tempo economizado só nos itens 1 e 2 paga a conta.

**Se já existe WebRTC puro em produção,** não recomendo reescrever para entregar estas cinco melhorias — todas são viáveis sem SFU (seções abaixo trazem o caminho para os dois cenários). Migrar é uma decisão separada, guiada pelo tamanho típico das salas, não por este escopo.

---

## 3. Item 1 — Halo azul reativo ao volume

**Objetivo:** contorno azul no tile de quem está falando, com intensidade proporcional ao volume — não um on/off binário.

### 3.1 Cenário SDK (LiveKit)

Sem DSP próprio. `Participant.audioLevel` (0–1) e `Participant.isSpeaking` já são publicados pelo servidor, e `RoomEvent.ActiveSpeakersChanged` entrega a lista ordenada. Basta habilitar a detecção nas opções da sala e mapear o valor para o CSS.

### 3.2 Cenário WebRTC puro

Duas topologias possíveis:

- **(A) Análise local de cada stream remoto** — cada cliente cria um `AnalyserNode` sobre o `MediaStream` de cada peer. O áudio já está decodificado, o custo marginal é baixo. Zero tráfego extra, zero mudança no protocolo de signaling. **Recomendada para salas de até ~8 pessoas.**
- **(B) Cada cliente mede o próprio nível e transmite** (~10 Hz) por data channel/socket. Menos CPU do lado receptor, mas adiciona chatter constante à rede e um contrato novo no signaling. Só compensa em salas grandes.

**Armadilha conhecida:** no Chrome, um `AnalyserNode` alimentado por `MediaStream` remoto só produz dados se o mesmo stream também estiver anexado a um elemento `<audio>`/`<video>` vivo no DOM. Anexar o elemento (mesmo com volume gerenciado à parte) é obrigatório.

### 3.3 Parâmetros de DSP (ambos os cenários, para o áudio local)

| Parâmetro | Valor | Motivo |
|---|---|---|
| `fftSize` | 512 | Resolução suficiente para RMS; barato |
| `smoothingTimeConstant` | 0.8 | Evita tremulação quadro a quadro |
| Métrica | RMS do domínio do tempo → dBFS | Mais fiel à percepção que pico |
| Limiar de fala | ~ -50 dBFS | Calibrar com ruído de sala real |
| Ataque / liberação | imediato / *hangover* ~500 ms | Impede piscar entre sílabas |
| Cadência | `requestAnimationFrame` | **Nunca** `setInterval` — desperdiça bateria em aba oculta |

### 3.4 Renderização

Não re-renderizar React a 60 fps. Escrever direto numa *custom property* CSS via `ref`:

```
elemento.style.setProperty('--nivel', String(nivelSuavizado)); // 0..1
```

```css
.tile { box-shadow: 0 0 0 calc(2px + var(--nivel, 0) * 8px) rgba(59, 130, 246, .6); }
@media (prefers-reduced-motion: reduce) { .tile { transition: none; } }
```

O halo é informação visual: acompanhar com um indicador não-cromático (ícone de microfone ativo) para não depender só de cor.

---

## 4. Item 2 — Compartilhamento de tela

Base comum: `navigator.mediaDevices.getDisplayMedia({ video: { ... }, audio: true })`.

### 4.1 Cenário SDK (LiveKit)

`localParticipant.setScreenShareEnabled(true)`. Publica um track com `source: ScreenShare`, distinto de `Camera`. A UI deve tratar as duas fontes separadamente — um participante pode ter câmera **e** tela ao mesmo tempo.

### 4.2 Cenário WebRTC puro

- **(A) `RTCRtpSender.replaceTrack(trackDaTela)` no sender de vídeo existente** — sem renegociação, entrega em horas. Custo: a câmera some enquanto compartilha; não há "tela + rosto" simultâneos.
- **(B) Segundo transceiver dedicado à tela** — tile separado, câmera preservada, experiência correta. Custo: exige que o app já lide com renegociação (`negotiationneeded` + glare). Se essa máquina de estados ainda não existe, ela é o trabalho real deste item, não o `getDisplayMedia`.

Recomendação: **(A) como MVP**, **(B)** se a renegociação já for suportada.

### 4.3 Requisitos obrigatórios (independem do cenário)

- **Parar pelo botão nativo do navegador.** O usuário quase sempre encerra pelo controle do Chrome, não pelo nosso botão. Sem `track.addEventListener('ended', ...)` revertendo o estado, a UI mente. **É o bug número um de implementações caseiras.**
- `track.contentHint = 'detail'` — prioriza nitidez sobre fluidez; código e slides ficam legíveis.
- `degradationPreference = 'maintain-resolution'` no sender.
- **Feature detection:** `getDisplayMedia` não existe no Safari do iOS. Esconder o botão em vez de deixá-lo falhar.
- Áudio da aba só é capturado no Chromium e apenas para abas/telas específicas — tratar como "melhor esforço", nunca como garantia.
- Política de concorrência: definir explicitamente se a sala aceita uma ou várias telas simultâneas. Sugestão: **uma**, com aviso de substituição.

---

## 5. Item 3 — Chat de texto efêmero

"Efêmero" define a arquitetura: **sem persistência, sem backend de histórico.** Estado em memória, limpo ao sair da sala. Quem entra depois não vê o que passou — por definição, não é um defeito.

### 5.1 Transporte

| Cenário | Recomendação |
|---|---|
| LiveKit | `localParticipant.publishData(payload, { reliable: true })` + `RoomEvent.DataReceived` |
| WebRTC puro **com** servidor de signaling | **Reaproveitar o socket existente.** Já está conectado, já autenticado, já conhece a lista da sala. É o caminho mais curto e o mais confiável. |
| WebRTC puro sem servidor | `RTCDataChannel` (ordered, reliable) por peer — só se o objetivo for não passar pelo servidor |

### 5.2 Requisitos

- **Renderizar como texto puro.** Jamais `dangerouslySetInnerHTML`. Linkificação, se houver, com `rel="noopener noreferrer nofollow"` e apenas esquemas `http(s)`.
- Limite de tamanho (ex.: 2 000 caracteres) e *rate limit* — no cliente **e** no servidor, se ele intermediar.
- Autoscroll apenas quando o usuário já está no fim da lista; caso contrário, badge de "novas mensagens".
- Contador de não-lidas quando o painel está fechado.
- Timestamps do relógio local do receptor (não confiar no do remetente).

---

## 6. Item 4 — Encerramento real do track de câmera

O item de maior valor do escopo: é um problema de **privacidade percebida**. O usuário vê o LED aceso e conclui, com razão, que continua sendo filmado.

### 6.1 Causa

`track.enabled = false` apenas substitui os quadros por preto no pipeline. O dispositivo continua aberto e o LED de hardware continua aceso — comportamento correto do navegador, expectativa errada do usuário.

### 6.2 Correção — WebRTC puro

Ao desligar:

1. `track.stop()` — libera o dispositivo, apaga o LED.
2. Remover o track do `MediaStream` local.
3. `sender.replaceTrack(null)` — **mantém o transceiver / a linha m=**, então religar não exige renegociação.

Ao religar:

4. `getUserMedia` de novo, **passando explicitamente o `deviceId` que o usuário havia escolhido** (guardado no estado) — sem isso o navegador pode voltar para outra câmera.
5. `sender.replaceTrack(novoTrack)`.

### 6.3 Correção — LiveKit

`setCameraEnabled(false)` já encerra o track por padrão. Se o bug existe num app LiveKit, a causa provável é o uso de `track.mute()` (que preserva o dispositivo) ou de uma `RoomOptions` que desabilita o stop no unpublish. A correção é de configuração/chamada, não de arquitetura.

### 6.4 Consequências a assumir explicitamente

- **Latência ao religar.** Reaquisição de câmera custa ~200–800 ms. Mitigação: estado de carregamento no botão. Este custo é aceitável — privacidade real vale a espera.
- **Corrida por duplo clique.** Alternar rápido pode vazar tracks ou deixar dois tracks vivos. Mitigação: guarda de estado (`aguardando`) que ignora comandos durante a transição.
- **Sinalizar o estado aos pares.** Com `replaceTrack(null)`, o lado remoto pode ficar com o último quadro congelado, sem disparar evento em alguns navegadores. É **obrigatório** emitir um evento explícito de "câmera desligada" para que os outros mostrem o avatar. Sem isso, a correção conserta o LED e cria um bug visual novo.
- **Dispositivo tomado por outro app.** Após o `stop()`, outro programa pode capturar a câmera e o religar falha. Tratar o erro do `getUserMedia` com mensagem clara em vez de falhar em silêncio.

### 6.5 Bug irmão, mesma raiz

Aplicar o mesmo encerramento no **encerramento da chamada e no desmonte do componente**: parar *todos* os tracks (áudio, vídeo, tela). Track vazado ao sair da sala é a variante mais comum — e mais grave — do mesmo defeito.

---

## 7. Item 5 — Avisos de entrada e saída

- **LiveKit:** `RoomEvent.ParticipantConnected` / `ParticipantDisconnected`.
- **WebRTC puro:** o servidor de signaling já conhece esses eventos; provavelmente basta expô-los.

### Requisitos de UX

- Toast com `aria-live="polite"` — o aviso precisa existir para leitores de tela, não só visualmente.
- Auto-dismiss em ~4 s; **agrupar rajadas** ("3 pessoas entraram") para evitar tempestade de toasts em entradas simultâneas.
- Suprimir o aviso da própria entrada.
- **Debounce de ~2 s na saída.** Uma oscilação de rede gera desconexão + reconexão; sem debounce, a sala vira um letreiro de "Fulano saiu / Fulano entrou". Este é o detalhe que separa a implementação ingênua da boa.
- Som opcional, desligável, respeitando preferência persistida.
- Se o chat (item 3) existir, escrever também uma linha de sistema nele — o mesmo evento serve aos dois, sem código novo.

---

## 8. Riscos e dependências entre os itens

| Risco | Impacto | Mitigação |
|---|---|---|
| Stack de tempo real ainda desconhecida | **Bloqueante** para todas as fases | Resolver 1.1 antes de qualquer implementação |
| Item 4 sem sinalização de estado aos pares | Conserta o LED, quebra o vídeo remoto | Item 4 depende do mesmo canal de eventos dos itens 3 e 5 — implementar o canal primeiro |
| Screen share sem tratar `ended` nativo | UI dessincronizada, percepção de app quebrado | Requisito obrigatório da seção 4.3 |
| Halo re-renderizando React a 60 fps | Queda de FPS visível com muitos tiles | Escrita direta em custom property (3.4) |
| Salas grandes em topologia mesh | Saturação de upload | Fora do escopo; reavaliar SFU (seção 2) |

**Ordem de implementação sugerida** (após destravar a descoberta): canal de eventos comum → item 5 → item 3 → item 4 → item 1 → item 2. Os três primeiros compartilham a mesma infraestrutura de mensageria; o item 4 a consome; os itens 1 e 2 são independentes e podem correr em paralelo.

---

## 9. Decisões em aberto

1. **Onde está o código do wtk-meet?** (bloqueante)
2. Greenfield ou app existente? (define se a seção 2 se aplica)
3. Tamanho típico e máximo de sala (define mesh vs. SFU e a topologia do item 1)
4. Matriz de navegadores suportados — em especial se o Safari do iOS é alvo (afeta o item 2)
5. O chat precisa mesmo ser 100% efêmero, ou haverá requisito de auditoria/compliance depois? (uma mudança dessa premissa reescreve a seção 5)
