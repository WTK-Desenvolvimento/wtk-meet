# Roteiro de teste manual — 2+ navegadores

> **Status desta execução:** roteiro **escrito e não executado**. O ambiente
> onde o código foi implementado é headless: não há navegador, câmera, alto-
> falante nem LED de dispositivo. Os itens abaixo exigem hardware real e
> continuam **pendentes de verificação humana**. O que *foi* verificado por
> automação está na seção final.

## Preparação

```bash
npm install
npm run dev          # http://localhost:5173
```

Abra duas abas (ou dois navegadores) em `http://localhost:5173`, entre com nomes
diferentes na **mesma sala**. `localhost` é origem segura, então câmera e
microfone funcionam sem HTTPS. Para uma terceira máquina, ponha um proxy TLS na
frente — sem HTTPS o navegador não entrega os dispositivos.

Deixe o **console aberto nas duas abas** durante todo o roteiro (item 20 do DoD:
nenhum warning novo) e `chrome://webrtc-internals` numa terceira aba.

---

## 1. Halo de fala reativo ao volume

| # | Passo | Esperado |
|---|---|---|
| 1.1 | Fale baixinho na aba A | Halo azul fino no seu tile |
| 1.2 | Fale alto | Halo visivelmente mais largo e brilhante — a variação é contínua, não liga/desliga |
| 1.3 | Observe a aba B | O tile de A na aba B mostra o mesmo comportamento |
| 1.4 | Fale uma frase inteira | O halo não pisca entre sílabas (hangover de 500 ms) |
| 1.5 | Observe as ondas | Contornos crescendo e desvanecendo + partículas percorrendo a borda |
| 1.6 | Fique em silêncio, todo mundo | Halo some suavemente; ponto do microfone volta ao cinza |
| 1.7 | Silêncio + aba Performance do DevTools, 10 s | Sem atividade de rAF; CPU do frame ~0 |
| 1.8 | Fale de novo | Animação retoma em até ~250 ms |
| 1.9 | Performance com 2+ pessoas falando | ~60 fps, sem long tasks |
| 1.10 | DevTools → Rendering → Emulate `prefers-reduced-motion: reduce`, recarregue, fale | Contorno **estático** cuja opacidade ainda acompanha o volume; sem ondas nem partículas |
| 1.11 | Mute o microfone e fale | Ponto do microfone vermelho, halo não reage |

## 2. Compartilhamento de tela

| # | Passo | Esperado |
|---|---|---|
| 2.1 | Aba A → "Compartilhar tela" → escolher uma janela | Tile largo "Sua tela" em A |
| 2.2 | Olhe a aba B | O conteúdo compartilhado aparece, legível |
| 2.3 | Teste também "aba" e "tela inteira" | Todos funcionam |
| 2.4 | Com A compartilhando, clique em "Compartilhar tela" em B | Botão desabilitado, `title` diz quem está compartilhando; se clicar, toast de aviso |
| 2.5 | Encerre pelo **botão nativo do Chrome** ("Parar compartilhamento") | O tile some nas duas abas, o botão do app volta a "Compartilhar tela", a câmera de A continua exibida |
| 2.6 | Compartilhe de novo e pare pelo **botão do app** | Mesmo resultado |
| 2.7 | Com a câmera **desligada**, compartilhe e pare | Volta ao estado "câmera desligada" (avatar), não a um quadro congelado |
| 2.8 | Abra o seletor e clique em "Cancelar" | Nenhum tile criado; B consegue compartilhar em seguida (trava devolvida) |
| 2.9 | Feche a aba de quem compartilha | A trava libera; o outro consegue compartilhar |
| 2.10 | Safari no iOS (se for alvo) | Botão nasce desabilitado, com o motivo no `title` |

## 3. Chat efêmero

| # | Passo | Esperado |
|---|---|---|
| 3.1 | Envie de A | Chega em B em tempo real, com nome e HH:MM |
| 3.2 | Envie de B | Chega em A; a própria mensagem aparece destacada |
| 3.3 | Feche o painel em B e receba 3 mensagens | Badge com "3" no botão do chat |
| 3.4 | Abra o painel | Badge zera |
| 3.5 | Envie `<img src=x onerror=alert(1)>` | Aparece como **texto literal**; nenhum alerta, nenhum elemento criado |
| 3.6 | Envie `javascript:alert(1)` | Texto puro, não vira link |
| 3.7 | Envie `https://exemplo.com` | Vira link, abre em nova aba |
| 3.8 | Cole 3000 caracteres | Contador em vermelho, corte em 2000, aviso de sistema |
| 3.9 | Envie 6 mensagens em 1 s | A sexta é recusada com "Devagar: muitas mensagens seguidas." |
| 3.10 | Abra uma **terceira aba** e entre | O histórico anterior **não** aparece |
| 3.11 | Saia da sala e volte | Chat vazio |
| 3.12 | Suba o histórico e receba mensagem nova | A rolagem não é arrancada |

## 4. Encerramento real da câmera — o item de privacidade

| # | Passo | Esperado |
|---|---|---|
| 4.1 | Ligue a câmera em A | Vídeo em A e em B; **LED do dispositivo aceso** |
| 4.2 | **Desligue a câmera em A** | **O LED do dispositivo APAGA** (macOS: ponto verde some; Windows: LED apaga) |
| 4.3 | Olhe a aba B | Avatar com as iniciais — não um quadro preto nem congelado |
| 4.4 | `chrome://webrtc-internals` | O sender de vídeo fica sem track; a conexão continua `connected` |
| 4.5 | Religue a câmera | Vídeo volta em B em ~2 s, **mesma câmera** de antes |
| 4.6 | Com duas câmeras: escolha a secundária, desligue, religue | Volta a secundária, não a padrão |
| 4.7 | **Alterne on/off 5 vezes seguidas** | Nenhum erro no console; em `webrtc-internals` nenhum track órfão; a conexão nunca sai de `connected` |
| 4.8 | Clique no botão 3 vezes bem rápido | Botão fica desabilitado durante a transição; estado final coerente |
| 4.9 | Ligue a câmera, abra outro app que use a câmera, tente religar | Toast "A câmera está em uso por outro aplicativo" |
| 4.10 | Câmera USB: ligue e desconecte o cabo | UI volta para "câmera desligada" sozinha |
| 4.11 | Feche a aba com câmera e microfone ligados | Todos os LEDs apagam imediatamente |

## 5. Avisos de entrada e saída

| # | Passo | Esperado |
|---|---|---|
| 5.1 | Entre em uma sala vazia | **Nenhum** som e **nenhum** modal para você mesmo |
| 5.2 | Uma segunda pessoa entra | Modal "Alguém entrou" com botão "Entendi" + som curto ascendente |
| 5.3 | Clique em "Entendi" | Modal fecha; foco volta para onde estava |
| 5.4 | Duas pessoas entram quase juntas | **Um** modal: "X e Y entraram na chamada" |
| 5.5 | Três ou mais entram juntas | "X, Y e mais N entraram na chamada" |
| 5.6 | Alguém sai | Toast discreto + som descendente; some em ~4 s |
| 5.7 | Várias saídas simultâneas | Toasts empilham, no máximo 4 visíveis, sem cobrir os controles |
| 5.8 | Clique em "Avisos" (silenciar) e repita 5.2/5.6 | Modal e toast continuam; **nenhum som** |
| 5.9 | Recarregue e repita | A preferência de silêncio persiste |
| 5.10 | Derrube o Wi-Fi de uma aba por ~1 s e reconecte | **Nenhum** "saiu/entrou" (debounce de 2 s) |
| 5.11 | Leitor de tela ligado | Toast é anunciado (`aria-live="polite"`) |

## 6. Fechamento

| # | Passo | Esperado |
|---|---|---|
| 6.1 | Console das duas abas ao fim de tudo | Nenhum warning novo, nenhum erro |
| 6.2 | `chrome://webrtc-internals` | Sem `RTCPeerConnection` órfã depois de todo mundo sair |
| 6.3 | `npm run build && npm run lint && npm test` | Tudo verde |

---

## O que já foi verificado por automação

Executado neste ambiente, sem navegador: **165 testes** verdes (`npm test`),
**lint limpo** (`npm run lint`) e **build de produção** sem aviso
(`npm run build`, 15 módulos).

A suíte tem três camadas:

**1. Lógica pura** (`test/level|text|presence|share-lock|rooms.test.js`) — nível
de áudio contínuo e não binário, hangover, ataque/liberação, decaimento a zero,
rejeição de `javascript:`/`data:` na linkificação, escape de HTML, limites de
texto, agrupamento de avisos, debounce de reconexão, exclusividade da trava.

**2. Servidor real** (`test/signaling.test.js`) — sobe o servidor e conversa por
WebSocket: welcome com lista de participantes, anúncio de entrada e saída, relay
de SDP/ICE apenas ao destinatário, isolamento entre salas, chat entregue a todos,
**histórico não replicado para quem entra depois**, limite de tamanho, rate
limit, trava de tela exclusiva e sua liberação por queda, propagação de estado de
câmera/microfone. Mais o servidor HTTP: `index.html` 200, MIME correto, 404 para
asset inexistente, 403 para path traversal codificado.

**3. Navegador falso** (`test/helpers/fake-env.js` + `media-camera`,
`media-screen`, `rtc-slots`, `audio-meter`, `chat-dom`, `notifications`,
`tiles-ring`, `speaking-ring-reduced-motion`, `app-flow`) — doubles escritos à
mão para `getUserMedia`, `getDisplayMedia`, `RTCPeerConnection`, `AnalyserNode` e
um DOM mínimo. Isso torna verificável, sem hardware, a *causa* de vários itens
que antes só se via com o olho:

| Item do DoD | O que a automação prova |
|---|---|
| 2, 3 | `--level` recebe valores distintos e crescentes; o tile remoto acende igual |
| 4 | Com `prefers-reduced-motion` não há `arc`/`fill` (partículas), só contorno cuja espessura e opacidade seguem o volume |
| 5 | Em silêncio **nenhum `requestAnimationFrame` fica agendado** (sondagem de 250 ms); voz religa o rAF; silêncio devolve ao ocioso |
| 6, 7, 8 | `getDisplayMedia` chamado uma vez, `contentHint='detail'`, `ended` nativo limpa estado e devolve a trava, câmera sobrevive intacta ao compartilhamento, sem `getDisplayMedia` o módulo recusa |
| 9–12 | Badge conta/zera, `destroy()` esvazia o log, HTML vira nó de texto (zero elementos criados a partir do texto do usuário), limite aplicado antes da rede |
| 13 | **`track.stop()` chamado e `readyState === 'ended'`** — a causa direta do LED apagar |
| 14 | O segundo `getUserMedia` pede `deviceId: { exact: ... }`; queda para a câmera padrão quando o id sumiu |
| 15 | Cinco ciclos: 5 tracks criados, 5 parados, **zero vivos**, uma única `RTCPeerConnection`, nunca fechada |
| 16, 17, 18 | Modal um a um exigindo clique, toasts limitados a 4, saídas simultâneas agrupadas em um aviso, som suprimido quando silenciado, **nenhum som nem modal na própria entrada** |

`test/app-flow.test.js` executa `src/main.js` de verdade contra esse navegador
falso, numa chamada em ordem: entrar → alguém chega → câmera on/off ×5 →
compartilhar → parar pelo botão nativo → chat → saídas → sair. É onde os bugs de
cabeamento apareceriam.

**Ainda depende de humano com hardware:** o LED em si (4.2 — a automação prova o
`stop()`, não o fóton), fluidez percebida a 60 fps (1.9), CPU medida no perfilador
(1.7 — a automação prova que não há rAF agendado), o seletor real do
`getDisplayMedia` (2.x), sons audíveis, e o comportamento real de SDP/ICE/NAT
entre navegadores (todo o item 3 e `chrome://webrtc-internals`).
