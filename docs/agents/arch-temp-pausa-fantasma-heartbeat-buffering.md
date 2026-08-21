# Pausa fantasma da sala durante buffering — Documento de Arquitetura Técnica

> Gerado em: 2026-08-21
> Status: Rascunho
> Task: WTK-MEET-15 — "Corrigir a pausa fantasma da sala quando o heartbeat do
> dono cai durante buffering"
> Branch: `agent/wtk-meet-15-corrigir-a-pausa-fantasma-da-sala-quando`

---

## 1. Contexto e Objetivo

### O sintoma

A música congela como "pausada" para **todos** na sala. Não pula de faixa, não
mostra erro, ninguém clicou em nada. É distinto do bug do pulo com aviso
(WTK-MEET-13): aqui a faixa simplesmente para.

### A causa, na ordem em que acontece

1. Enquanto a sala está tocando e eu sou o dono da faixa, um temporizador de 5s
   republica o estado autoritativo de reprodução
   (`client/src/lib/useMusicRoom.js:437-454`):

   > `if (player.loading) return;`
   > `publishPlayback({ positionSec: player.positionSec, playing: player.playing !== false });`

2. `playing`, no `YouTubeTrackPlayer` (`client/src/lib/youtubePlayer.js:358-360`),
   é `ready && getPlayerState() === 1`. O estado 1 é **PLAYING**. O estado 3 é
   **BUFFERING** — e para ele o mesmo arquivo tem um getter dedicado logo abaixo
   (`youtubePlayer.js:362-364`). Durante um engasgo de rede, portanto,
   `player.playing` é `false`.

3. A guarda cobre `loading`, não `buffering`. Um tique que caia no meio do
   engasgo publica `playing: false` **como estado autoritativo da sala**.

4. `publishPlayback` incrementa `version`, grava localmente e envia
   (`useMusicRoom.js:195-211`). Em todos os clientes, `applyPlayback` aceita a
   versão maior e o efeito que segue `session.playback.playing`
   (`useMusicRoom.js:426-435`) chama `player.pause()`. A sala inteira obedece a
   um "pausado" que só existiu porque o buffer esvaziou por um instante.

5. Ninguém desfaz. Quando o buffering termina, o dono já não está mais publicando
   heartbeat — o efeito depende de `session.playback.playing`, que agora é
   `false`, e ele mesmo se desliga. Só um clique humano em **Tocar** recupera a
   sala. É por isso que o sintoma é "parou e ficou parado", não "engasgou".

### A observação que decide o desenho

O heartbeat é o **único** lugar do arquivo que tira `playing` de um getter do
player. Todos os outros publicadores usam a intenção conhecida da sala:

| Origem | O que publica em `playing` | Linha |
|---|---|---|
| Pausa/retomada do dono | `false` / `true` explícitos | `useMusicRoom.js:798`, `:808` |
| Pedido de pausa/retomada de um peer | `false` / `true` explícitos | `:841`, `:844` |
| Seek (dono e pedido) | `playback.playing` — a intenção corrente | `:820`, `:849` |
| Troca de faixa (`planAdvance`) | decidido pelo módulo puro | `musicSession.js:445+` |
| **Heartbeat de posição** | **`player.playing !== false`** | **`:451`** |

Ou seja: o heartbeat de **posição** virou, sem que ninguém decidisse isso, um
segundo canal de autoridade sobre **play/pause** — alimentado por um getter que
descreve o transporte ("está soando agora?"), não a intenção ("a sala mandou
tocar?"). Buffering é apenas o caso em que os dois divergem com mais frequência;
não é o único.

### Comportamento esperado após a entrega

- Um engasgo de rede no dono não muda o `playing` da sala. Quem estava ouvindo
  continua ouvindo; quem está em `local` continua recebendo referência de posição.
- Uma pausa **deliberada** — do dono ou pedida por um peer — continua chegando a
  todos imediatamente, sem atraso adicional.
- A guarda de `loading` continua valendo: trocar de faixa continua não publicando
  posição.

---

## 2. Escopo

**Dentro do escopo:**

- Tornar o tique de heartbeat incapaz de rebaixar `playing` por conta de estado
  de transporte (buffering, engasgo, estado intermediário do iframe).
- Manter a publicação de `positionSec` durante buffering, com o cuidado de não
  publicar leitura que o player ainda não tem.
- Extrair a decisão do tique para uma função **pura**, para que ela seja testável
  sem navegador e sem renderer React.
- Cobertura unitária: buffering no formato `YouTubeTrackPlayer`, buffering no
  formato `MusicEngine`, `loading` na troca de faixa, e regressão da pausa real.
- Atualizar `ARCHITECTURE.md` §6.9 (bullet "Posição") e `claude-progress.md`.

**Fora do escopo:**

- **Propagar "áudio bloqueado" como pausa da sala.** Hoje o autoplay bloqueado no
  dono é sinalizado por `audioBlocked` → faixa de aviso em `MusicPanel.jsx:85`.
  Depois desta entrega o heartbeat não vai mais rebaixar `playing` nesse caso
  (ver §7, R1). Se a sala quiser um comportamento diferente, ele tem que nascer
  do evento de bloqueio, não de polling — é outra entrega.
- **Mexer no laço de correção de deriva** (`useMusicRoom.js:456-475`). Ele já
  ignora `buffering` e `loading` do lado de quem recebe, e a correção aqui é do
  lado de quem publica (item 6 do escopo da task).
- **Mexer nos getters `playing`/`buffering`** de qualquer um dos dois players
  (ver §3, D2 — a alternativa foi avaliada e descartada).
- Mudar `POSITION_PUBLISH_MS`, `SYNC_THRESHOLD_SEC` ou `SYNC_MIN_INTERVAL_MS`.
- Mudar o protocolo `music-playback` (`musicProtocol.js`) ou o formato do
  snapshot. Nenhum campo novo trafega nesta entrega.
- Teste e2e. O DoD não pede, e o cenário (engasgo de rede reprodutível em três
  navegadores) não é estável o bastante para virar gate.

---

## 3. Decisões Arquiteturais

### D1 — O heartbeat publica a **intenção da sala**, não a leitura do player

- **Decisão:** o tique de 5s passa a publicar
  `playing: <playback.playing corrente>`, nunca um valor derivado de
  `player.playing`. O heartbeat volta a ser o que o nome diz: um heartbeat de
  **posição**.
- **Motivação:** é a correção da causa, não do sintoma. `player.playing` responde
  "está soando neste milissegundo?" — pergunta legítima para a UI, resposta
  errada para "qual é o estado autoritativo da sala". Buffering é só o caso mais
  frequente em que ela divergem; estados intermediários do iframe, autoplay
  bloqueado e a janela entre `onReady` e o primeiro frame divergem do mesmo
  jeito. Além disso, alinha o heartbeat com os outros cinco publicadores
  (tabela da §1), inclusive com o seek, que já usa `playback.playing`.
- **Por que isso não perde informação:** as transições reais de play/pause têm
  publicadores próprios e síncronos — `requestPause`/`requestResume`,
  `applyCommand` e `planAdvance` para `ended`/`error`/`skipped`/`owner-left`. O
  heartbeat nunca foi a fonte de nenhuma delas; ele apenas ecoava. Um eco que só
  erra não vale a pena manter.
- **Alternativa descartada — `if (player.loading || player.buffering) return;`:**
  resolve o falso "pausado", e é a mudança de uma palavra. Foi descartada por
  três motivos. (a) Em `MusicEngine`, `buffering` é `readyState < 3`
  (`musicEngine.js:255-257`), que é verdadeiro em situações banais — logo depois
  de um seek, e de forma recorrente numa URL servida com banda apertada. Uma
  faixa nessa condição faria o dono **parar de publicar posição indefinidamente**,
  sem sintoma visível, até a deriva de quem está em `local` ficar audível: troca
  um bug barulhento por um silencioso. (b) Contraria o item 4 do escopo da task,
  que pede que buffering prolongado não deixe `local` sem referência.
  (c) Continuaria deixando `player.playing` no caminho — qualquer estado futuro
  que não seja 1 traria o mesmo bug de volta.
- **Alternativa descartada — corrigir o getter `playing` para aceitar o estado 3:**
  faria `playing` mentir para todo o resto (barra de progresso, indicador de
  "tocando"), tornaria `buffering` e `playing` simultaneamente verdadeiros e
  contraditórios, e quebraria o contrato que `youtubePlayer.test.mjs` já fixa.
  O getter está certo; quem o usa como intenção é que está errado.

### D2 — Continuar publicando posição durante buffering, com guarda de leitura

- **Decisão:** buffering **não** interrompe a publicação de `positionSec`. A única
  condição que impede a publicação continua sendo `loading` — acrescida de uma
  guarda estreita: se o player está em buffering e devolve posição `0` enquanto a
  sala já sabe de uma posição maior que zero, o tique é pulado.
- **Motivação:** `positionSec` é confiável em buffering nos dois players. Em
  `MusicEngine` é `element.currentTime`, que é exatamente a posição do áudio,
  engasgado ou não. No YouTube, `getCurrentTime()` durante o estado 3 devolve a
  posição em que a reprodução vai retomar. O estado em que a leitura **não** é do
  player é `loading` — e é exatamente o que a guarda existente já cobre, pelo
  motivo já escrito no comentário de `useMusicRoom.js:444-448`. A guarda extra
  cobre a janela curta entre `onReady` (quando `loading` já é `false`) e o
  primeiro frame, em que o iframe pode responder `0`: publicar esse `0` com
  `playing: true` mandaria a sala inteira para o começo da faixa — o mesmo dano
  que o comentário existente descreve, por um caminho diferente.
- **Sobre a deriva:** publicar a posição congelada do dono durante o engasgo faz
  quem está em `local` corrigir **para trás**, até a posição real do dono. Isso
  é o comportamento correto do modelo: o dono é a autoridade, e o áudio dele
  perdeu aqueles segundos de verdade. Não publicar apenas adia esse mesmo acerto
  para o primeiro tique depois do engasgo — não o evita.
- **Alternativa descartada — publicar posição extrapolada durante o engasgo**
  (fingir que o dono não travou): faria o dono divergir de si mesmo e, na entrega
  `stream`, o estado anunciado descolaria do áudio que a sala está literalmente
  ouvindo do dono.
- **Alternativa descartada — publicar a última posição conhecida da sala**
  (`playback.positionSec`) no lugar da leitura: `receivedAt` novo com posição
  velha faz todo mundo rebobinar. Pular o tique é estritamente melhor.

### D3 — A decisão do tique vira função pura em `musicSession.js`

- **Decisão:** criar `planPositionHeartbeat` em `client/src/lib/musicSession.js`,
  exportada, pura, no mesmo formato de `planAdvance`: recebe estado, devolve o
  que fazer. O efeito no hook fica com duas linhas — chamar e agir.
- **Motivação:** o DoD pede quatro testes unitários sobre o comportamento do
  tique, e o projeto **não tem renderer React nem dependência de teste de
  componente** (`client/package.json`: `node --test "test/*.test.mjs"`). Sem a
  extração, os testes ou não existem ou exigem uma dependência nova — e a
  segunda opção é grande demais para o tamanho desta correção. É o mesmo
  argumento, palavra por palavra, que já justificou `planAdvance` ser puro
  (`musicSession.js:418-426`).
- **Por que em `musicSession.js` e não num módulo novo:** é a política de
  publicação do dono, exatamente a família de `planAdvance`, `estimatePosition` e
  `isNewerPlayback`. Um arquivo novo para uma função de dez linhas custaria mais
  atenção do que economiza.
- **Efeito colateral desejado:** com a política fora do hook, o efeito não tem
  mais nenhuma regra dentro. Qualquer volta do `player.playing !== false` fica
  visível numa linha só.

### D4 — O laço de correção de deriva não muda

- **Decisão:** `useMusicRoom.js:456-475` fica como está.
- **Motivação:** ele é o lado do receptor e já faz a coisa certa — ignora
  `buffering` e `loading` do player **local** antes de comparar posições, com o
  motivo escrito no comentário. O bug desta task é do lado de quem publica.
  Depois de D1/D2 o receptor recebe mais publicações válidas, não menos, e a
  trava de `SYNC_MIN_INTERVAL_MS` continua sendo o que impede o loop
  seek→buffering→deriva→seek.

---

## 4. Componentes Afetados

### Frontend — módulo puro

**`client/src/lib/musicSession.js`**
- **O que muda:** ganha `planPositionHeartbeat`, exportada. Contrato na §5.
- **Por quê:** torna a política do tique verificável sem navegador (D3).

### Frontend — hook de orquestração

**`client/src/lib/useMusicRoom.js`** (efeito do `POSITION_PUBLISH_MS`, ~437-454)
- **O que muda:** o corpo do `setInterval` deixa de conter regra. Lê o player
  ativo e o `playback` corrente de `sessionRef`, chama `planPositionHeartbeat` e
  publica se o plano mandar. O import de `planPositionHeartbeat` entra na lista
  já existente de `musicSession.js`.
- **Por quê:** é o ponto exato onde a pausa fantasma nasce.
- **O comentário existente** (`:444-448`) explica por que `loading` não publica.
  Ele deve ser **preservado e estendido**, não substituído: o raciocínio novo é o
  de D1 (intenção ≠ transporte), e ele precisa ficar escrito no lugar onde a
  próxima pessoa vai ser tentada a reintroduzir o getter.

### Frontend — testes

**`client/test/musicSession.test.mjs`**
- **O que muda:** novo bloco para `planPositionHeartbeat`, com players falsos
  (objetos literais com as propriedades que o contrato lê). Quatro casos do DoD
  mais os de borda listados na §8.
- **Por quê:** a função nova mora neste módulo; a suíte segue um arquivo por
  módulo. Se o bloco passar de ~120 linhas, um `client/test/musicHeartbeat.test.mjs`
  dedicado é aceitável — mas não crie o arquivo por antecipação.

**`client/test/musicTransitions.test.mjs`**, **`client/test/youtubePlayer.test.mjs`**,
**`client/test/musicEngine.test.mjs`**
- **O que muda:** nada esperado. Devem passar sem edição; se algum quebrar, a
  causa é regressão real e não expectativa desatualizada — investigue antes de
  ajustar asserção.

### Documentação

**`ARCHITECTURE.md` §6.9**, bullet "Posição" (linha ~468)
- **O que muda:** uma frase registrando que o heartbeat publica posição e
  **repete a intenção corrente**, sem inferir play/pause do estado de transporte
  do player.
- **Por quê:** é o documento que descreve a regra de convergência; sem isso, a
  próxima leitura do código pode "otimizar" o eco de volta.

**`claude-progress.md`**
- **O que muda:** entrada da WTK-MEET-15 com verificação critério a critério do
  DoD, como nas entregas anteriores.

### Não afetados (verificado)

`musicProtocol.js` (nenhum campo novo), `musicVote.js`, `webrtcMesh.js`,
`MusicPanel.jsx`, `Room.jsx`, servidor, e2e. Sem schema de banco, sem endpoint,
sem evento novo.

---

## 5. Contratos de Interface

### Função pura nova

`planPositionHeartbeat({ playback, player })` — `client/src/lib/musicSession.js`

**Entrada**

| Campo | Tipo | Origem | Observações |
|---|---|---|---|
| `playback` | objeto | `sessionRef.current.playback` | Usa `playing` e `positionSec` |
| `player` | objeto ou `null` | `activePlayer()` | Lê `loading`, `buffering`, `positionSec`. **Não lê `playing`** — é o ponto da correção |

O parâmetro `player` é lido como um punhado de propriedades; qualquer objeto com
elas serve, e é isso que permite o teste com player falso nos dois formatos
(`YouTubeTrackPlayer` e `MusicEngine`) sem instanciar nenhum dos dois.

**Saída**

| Campo | Tipo | Significado |
|---|---|---|
| `publish` | objeto ou `null` | `null` = pular este tique. Objeto = patch para `publishPlayback`, com `positionSec` e `playing` |

**Pseudológica** (avaliada em ordem; a primeira que casar decide)

| # | Condição | Resultado | Por quê |
|---|---|---|---|
| 1 | `player` ausente | `publish: null` | Não há o que republicar |
| 2 | `playback.playing` falso | `publish: null` | Heartbeat só existe enquanto a sala toca; deixa a função segura de chamar em qualquer contexto |
| 3 | `player.loading` | `publish: null` | Posição não é do player ainda; publicar `0` manda a sala para o começo da faixa |
| 4 | `player.buffering` **e** leitura não é um número finito maior que `0` **e** `playback.positionSec > 0` | `publish: null` | Janela entre `onReady` e o primeiro frame: o iframe responde `0` sem saber de nada |
| 5 | caso contrário | `publish: { positionSec: <leitura>, playing: playback.playing }` | Posição real do dono, intenção corrente da sala |

**Invariante que o teste deve fixar:** nenhuma linha da tabela produz
`playing: false` enquanto `playback.playing` é verdadeiro. A regra 2 é a única
que envolve `playing: false`, e ela não publica nada.

### Chamada no hook (pseudológica)

Dentro do `setInterval` de `POSITION_PUBLISH_MS`: montar o plano com o player
ativo e o `playback` de `sessionRef.current`; se `plan.publish` existir, passá-lo
a `publishPlayback`. Nenhuma outra condição no corpo do intervalo. As guardas de
entrada do efeito (só o dono, só com a sala tocando) e o `clearInterval` do
cleanup permanecem como estão.

### Protocolo

Sem mudança. `music-playback` continua carregando os mesmos campos, e
`sanitizePlayback`/`isNewerPlayback` não mudam. Sem endpoint REST, sem evento
novo, sem schema de banco.

---

## 6. Dependências e Ordem de Implementação

1. **`planPositionHeartbeat` em `musicSession.js`** — fundação; não depende de
   nada.
2. **Testes da função pura** em `musicSession.test.mjs` — depende de (1). Escreva
   os quatro casos do DoD antes de tocar no hook: eles são a especificação.
3. **Ligar o hook** (`useMusicRoom.js`) — depende de (1). Import, chamada,
   comentário estendido, remoção de `player.playing !== false`.
4. **Documentação** — `ARCHITECTURE.md` §6.9 e `claude-progress.md`; depende de
   (3) estar decidido, pode ser escrita em paralelo a (2).
5. **Verificação** — `npm test --prefix client` e `npm run lint --prefix client`.
6. **PR** com causa raiz e justificativa da abordagem (§9).

(2) e (4) rodam em paralelo entre si. Nada aqui depende de servidor ou de e2e.

---

## 7. Riscos e Armadilhas

**R1 — A sala fica "tocando" enquanto o áudio do dono está bloqueado**
- **Risco:** com autoplay bloqueado no dono, `player.playing` é falso de forma
  duradoura. Hoje o heartbeat acabava rebaixando a sala para pausado; depois da
  correção, não. Na entrega `stream`, isso significa a sala em silêncio com o
  estado dizendo "tocando".
- **Mitigação:** o caminho já existe e é melhor — `play()` devolvendo `false`
  liga `audioBlocked`, e `MusicPanel.jsx:85` mostra a faixa de aviso para o dono
  agir. Aviso dirigido a quem pode resolver vale mais que uma pausa silenciosa
  para todos, e nenhum dos dois é regressão do outro: hoje o usuário recebe os
  dois, com a pausa chegando 5s depois.
- **Anti-pattern a evitar:** "então deixa o heartbeat publicar `playing: false`
  só quando não estiver em buffering". Polling não distingue bloqueado de
  engasgado — é exatamente a inferência que produziu este bug. Se a propagação
  for desejada, ela nasce do evento de bloqueio, em outra task.

**R2 — Publicar `0` e mandar a sala para o começo da faixa**
- **Risco:** entre `onReady` (que zera `loading`) e o primeiro frame, o iframe
  pode responder `getCurrentTime() === 0`. Com `playing: true` e `receivedAt`
  novo, todo mundo rebobina.
- **Mitigação:** regra 4 do contrato (§5).
- **Anti-pattern a evitar:** trocar o `null` por `playback.positionSec` "para não
  perder o tique". Posição velha com carimbo novo é rebobinada garantida; pular
  o tique custa 5 segundos de nada.

**R3 — Silenciar o heartbeat por buffering**
- **Risco:** a correção de uma palavra (`|| player.buffering` na guarda) parece
  certa e é o que a leitura rápida da causa raiz sugere. Com `MusicEngine`,
  `buffering` é `readyState < 3` — comum e recorrente. Uma URL com banda apertada
  pararia de publicar posição por minutos, e a deriva de quem está em `local`
  cresceria sem correção e sem sintoma.
- **Mitigação:** D1 + D2. O tique publica; o que muda é de onde sai `playing`.
- **Anti-pattern a evitar:** tratar `buffering` como sinônimo de "leitura
  inválida". Ele significa "não está soando agora" — a posição continua correta.

**R4 — Mexer no getter `playing`**
- **Risco:** parece tentador fazer `playing` incluir o estado 3 e resolver tudo
  na origem. Isso faria `playing` e `buffering` verdadeiros ao mesmo tempo,
  mentiria para a UI e quebraria contrato coberto em `youtubePlayer.test.mjs`.
- **Mitigação:** nenhum arquivo de player é tocado nesta entrega (§2).

**R5 — Testar o hook**
- **Risco:** tentar cobrir o efeito do `setInterval` diretamente, o que exigiria
  renderer React — dependência que o projeto não tem e que esta correção não
  justifica.
- **Mitigação:** D3. O que se testa é a função pura; o hook fica sem regra.
- **Anti-pattern a evitar:** duplicar a condição no hook "por segurança". Se a
  regra existir nos dois lugares, o teste passa a provar a cópia errada.

**R6 — Fake player que não parece com nenhum dos dois**
- **Risco:** um objeto de teste com `playing: true` e `buffering: true` ao mesmo
  tempo (impossível no YouTube) prova pouco.
- **Mitigação:** os falsos devem espelhar os formatos reais — YouTube em
  buffering: `{ loading: false, buffering: true, playing: false, positionSec: N }`;
  `MusicEngine` engasgado: `{ loading: false, buffering: true, playing: true,
  positionSec: N }` (o `element` não está `paused`, então o getter real devolve
  `true` — ver R7).

**R7 — Concluir que `MusicEngine` não precisa de teste**
- **Risco:** em `MusicEngine`, `playing` é `!paused && !ended`, que continua
  verdadeiro durante um engasgo. Ou seja: o bug **não se manifesta** por esse
  player hoje, e é fácil concluir que o teste é redundante e pular o item 3 do
  DoD.
- **Mitigação:** o teste existe para fixar a **invariante**, não para provar a
  correção de um sintoma. Ele é o que impede uma mudança futura no getter (ou a
  adoção da guarda de `buffering` de R3) de reintroduzir o problema pelo outro
  caminho. Escreva-o.

**R8 — Commit tardio**
- **Risco:** o worktree desta sessão pode ser recolhido antes do fim, e o
  auto-commit do harness pode fotografar uma edição pela metade.
- **Mitigação:** commitar cedo e em passos pequenos, na ordem da §6.

---

## 8. Critérios de Aceite Técnicos

Comportamento do sistema, na ordem em que vale a pena verificar:

1. **Buffering no YouTube não pausa a sala.** Com a sala tocando, o dono ativo e
   o player reportando buffering (leitura de posição válida), o tique produz uma
   publicação com `playing: true` e a posição lida. Em nenhuma circunstância com
   `playback.playing` verdadeiro o tique publica `playing: false`.
2. **Buffering no `MusicEngine` idem.** Mesmo resultado com um player no formato
   `readyState < 3`.
3. **Pausa deliberada continua propagando na hora.** O dono pausando publica
   `playing: false` imediatamente, sem esperar tique; a partir daí o heartbeat
   não republica nada (o efeito não roda com a sala pausada, e a função pura
   também devolve `null`).
4. **Pedido de pausa de um peer** produz o mesmo estado — mesmo caminho de
   publicação, sem regressão.
5. **`loading` continua não publicando.** Na troca de faixa, com o player
   carregando, o tique não publica — nem posição, nem `playing`. É o que impede
   `{ positionSec: 0, playing: false }` de ir para a sala.
6. **Leitura `0` em buffering com a sala já em posição maior que zero não
   publica.** A sala não rebobina por causa de um tique caído na janela entre
   `onReady` e o primeiro frame.
7. **Sem player ativo, nada é publicado.**
8. **Buffering prolongado não interrompe a referência de posição:** com o player
   em buffering e leitura válida por vários tiques seguidos, todos publicam — o
   modo `local` continua com base fresca para corrigir deriva.
9. **A correção de deriva do receptor não muda de comportamento** —
   `useMusicRoom.js:456-475` permanece idêntico e a suíte existente passa.
10. `npm test --prefix client` passa inteiro (incluindo `musicSession.test.mjs` e
    `musicTransitions.test.mjs`) e `npm run lint --prefix client` sem erros.

---

## 9. Notas para os Agentes de Implementação

**Quem assume:** um único agente de desenvolvimento frontend. A entrega é pequena
e concentrada em dois arquivos de código; dividir custaria mais coordenação do
que trabalho.

**Ordem de execução:** §6, sem atalhos. Os testes da função pura antes da ligação
no hook — eles são a especificação e, escritos depois, tendem a codificar o que a
implementação faz em vez do que ela deve fazer.

**Pitfalls desta demanda que não estão na documentação geral:**

- `player.playing` **não pode sobrar** no efeito do heartbeat. Depois da mudança,
  `grep -n "player.playing" client/src/lib/useMusicRoom.js` não deve devolver
  nada.
- O comentário de `useMusicRoom.js:444-448` é bom e explica metade do problema.
  Estenda-o com a outra metade (intenção ≠ transporte); não o apague.
- Preserve o contrato de `publishPlayback`: ele faz merge sobre o `playback`
  corrente e incrementa `version`. O patch do heartbeat continua carregando só
  `positionSec` e `playing` — não acrescente `entryId`, `delivery` ou
  `endedReason`, que fariam o tique reafirmar decisões que não são dele.
- Ler o `playback` de `sessionRef.current` dentro do intervalo, nunca da closure
  do efeito: o efeito não é recriado a cada mudança de posição, e a closure
  envelhece.
- Comentários e documentação em português, como o resto do projeto.

**Validação, em ordem:** `npm test --prefix client` →
`npm run lint --prefix client` → releitura do diff procurando regra duplicada
entre o hook e o módulo puro.

**No PR, obrigatoriamente** (item do DoD): a causa raiz — getter `playing`
devolve `false` no estado BUFFERING e a guarda cobria só `loading` — e a
justificativa da escolha entre pular o tique e preservar a intenção. A
justificativa está em §3 D1/D2: pular o tique silenciaria a referência de posição
de quem está em `local`, de forma frequente no `MusicEngine`
(`buffering = readyState < 3`), e trocaria um bug audível por um silencioso.

**Registro:** entrada em `claude-progress.md` com a verificação critério a
critério do DoD, no formato das entregas anteriores.
