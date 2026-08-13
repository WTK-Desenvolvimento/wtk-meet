# Modal de configurações de câmera, microfone e saída de áudio — Documento de Arquitetura Técnica

> Gerado em: 2026-08-13
> Status: Rascunho
> Task: WTK-MEET-9 — Implementar modal de configurações de câmera, microfone e saída de áudio
> Autor: Arquiteto

---

## 1. Contexto e Objetivo

### Problema atual

`client/src/pages/Room.jsx:108` chama `navigator.mediaDevices.getUserMedia({ video: true, audio: true })` sem
nenhuma restrição de `deviceId`. O mesmo vale para a reaquisição de câmera em `toggleCamera`
(`Room.jsx:363`, `{ video: true }`). Consequências:

- O navegador sempre entrega o **device default do sistema**. Quem usa webcam ou microfone USB fica preso ao
  hardware embutido do notebook, sem nenhuma forma de trocar dentro da aplicação — a única saída é mudar o
  default no sistema operacional e recarregar a página.
- Não existe **seleção de saída de áudio**. Todo mundo ouve pelo dispositivo default; um headset conectado
  depois de aberta a aba não passa a receber o áudio da chamada.
- Não há **preview**: a pessoa só descobre que a câmera errada está ativa quando já está na sala, visível para
  os outros.
- O toggle de avisos sonoros ocupa um slot na barra `.controls` (`Room.jsx:606-611`), que é um espaço escasso —
  a barra já tem 6 botões e o layout de altura fixa entregue em WTK-MEET-5 depende de ela não crescer.

### Comportamento esperado após a entrega

- Um **único** modal de configurações, alcançável em três pontos: Home, tela de espera/conexão e barra de
  controles da sala.
- O modal lista todas as entradas de vídeo, entradas de áudio e saídas de áudio disponíveis, com rótulos reais,
  sem duplicatas, e reflete conexão/desconexão de hardware enquanto está aberto.
- Preview de vídeo ao vivo e medidor de nível do microfone refletem a seleção **pendente** (ainda não salva).
- "Salvar" aplica a troca **em chamada ativa**, via `replaceTrack`, sem renegociar SDP.
- "Cancelar", `Esc` e clique no backdrop descartam a seleção e param o preview.
- A preferência sobrevive a reload e a fechar/reabrir o navegador (`localStorage`, chave `wtk-meet:devices`).
- Se o device salvo não existir mais, a aplicação cai no default **sem erro visível** e corrige a preferência.

### Vínculo com o produto

O produto se define por "chamada que funciona sem infraestrutura de terceiros". Uma chamada em que a pessoa não
consegue usar o próprio headset não funciona — o custo aparece como áudio ruim e câmera errada, que é
exatamente a percepção de qualidade que a arquitetura mesh + TURN próprio existe para sustentar. Isto não é
polimento: é o caminho mais barato de elevar a qualidade percebida da chamada sem tocar em mídia, codec ou
topologia.

---

## 2. Escopo

**Dentro do escopo:**

- Módulo puro novo de dispositivos e preferências (`client/src/lib/devices.js`), sem dependência de DOM, com
  teste unitário em `node:test`.
- Componente novo `client/src/components/SettingsModal.jsx`: listagem, seleção pendente, preview de vídeo,
  medidor de mic, seletor de saída de áudio, toggle de avisos sonoros, salvar/cancelar.
- Ponto de entrada do modal em `Home.jsx`, na fase `WAITING_APPROVAL`/`CONNECTING` e na barra `.controls` da
  sala.
- Aplicação da preferência no **primeiro** `getUserMedia` da sala e na reaquisição de câmera do `toggleCamera`.
- Troca de device em chamada ativa via `mesh.setCameraTrack` / `mesh.setAudioTrack` (ambos já existem e já
  usam `replaceTrack`).
- Roteamento de saída via `setSinkId` nos elementos de mídia dos tiles (`VideoTile.jsx`).
- Medidor de nível **isolado** para o preview, em `client/src/lib/audioLevels.js`, sem passar pelo registro do
  `AudioLevelMonitor` da sala (razão em §3.5).
- Persistência em `localStorage` sob `wtk-meet:devices`, com as quatro chaves do DoD.
- Recuperação quando o device em uso desaparece (`devicechange` + `track.onended`).
- Migração do toggle de avisos sonoros da barra `.controls` para dentro do modal, preservando o
  comportamento do bipe.
- Simulação de múltiplos dispositivos no harness de E2E (§3.9) e um bloco novo de checagens em `e2e/run.mjs`.
- Atualização de `README.md` e `ARCHITECTURE.md` (nova §6.8, ajuste das afirmações de zero persistência).

**Fora do escopo:**

- Qualquer mudança em `server/`. Esta entrega é **100% client-side** — nenhum evento novo, nenhum campo novo
  na sinalização. Ao contrário de WTK-MEET-5, aqui não existe requisito que force o servidor.
- Renegociação de SDP, mudança no layout de transceivers, ou qualquer alteração no protocolo do mesh
  (`ARCHITECTURE.md` §6.1). `setAudioTrack`/`setCameraTrack` são usados como estão.
- Seleção de dispositivo para **compartilhamento de tela** (`getDisplayMedia` tem seu próprio seletor nativo do
  navegador; duplicá-lo é redundante e não é pedido).
- Controles de processamento de áudio: `echoCancellation`, `noiseSuppression`, `autoGainControl`, ganho de
  entrada, resolução/framerate de câmera. São constraints de qualidade, não de seleção de hardware — demanda
  separada.
- Teste de saída de áudio ("tocar um som de teste no dispositivo selecionado"). Cabe bem no modal, mas não está
  no DoD; ver §9.4 se houver folga.
- Persistir o nome de exibição em `localStorage`. Continua em `sessionStorage` — a decisão anterior não muda,
  e ampliá-la seria escopo vazado num ponto sensível (identidade, não hardware).
- Sincronizar a preferência entre abas (`storage` event). Cada aba é uma sessão de chamada independente.
- Redesign visual do modal. Reaproveitar as classes já existentes de `.modal-backdrop` (`styles.css:490`).

---

## 3. Decisões Arquiteturais

### 3.1 Exceção deliberada e delimitada à regra de zero persistência

**Decisão:** gravar `{ videoInputId, audioInputId, audioOutputId, soundsEnabled }` em `localStorage` sob a
chave `wtk-meet:devices`. Nenhum outro dado ganha persistência.

**Motivação:** a invariante do produto é *"nenhum conteúdo ou metadado de chamada é gravado"* — mídia, chat,
quem falou com quem, quando. Uma preferência de hardware não é nenhuma dessas coisas:

- Nunca sai do navegador: não é enviada ao servidor de sinalização nem trafega pelo data channel.
- Não contém conteúdo de chamada nem identidade — é a escolha de qual periférico do próprio equipamento usar.
- `deviceId` é **escopado à origem e ao perfil do navegador**, e é rotacionado quando os dados do site são
  limpos. Não é um identificador rastreável entre sites.
- A alternativa (reescolher o headset a cada chamada) é um custo real e recorrente, cobrado justamente de quem
  investiu em hardware melhor.

**Alternativas descartadas:**

- **`sessionStorage`** (o que já é usado para o nome): morre ao fechar a aba. O item 5 do DoD exige
  explicitamente sobrevivência a "fechar/reabrir o navegador" — `sessionStorage` não atende.
- **Não persistir, reler o default do sistema a cada entrada:** é o comportamento atual e é exatamente o
  problema que a task existe para resolver.
- **Persistir por `groupId` em vez de `deviceId`:** `groupId` sobrevive melhor a rotações de id, mas identifica
  um *grupo* físico (o mic e o alto-falante do mesmo headset), não um device — resolveria ambiguamente quando o
  grupo tem duas entradas. Descartado; o fallback para default de §3.4 já cobre o caso de id perdido.

**Obrigação que esta decisão cria:** as afirmações de zero persistência em `README.md:4`, `ARCHITECTURE.md:11`
e `ARCHITECTURE.md:189` passam a ser **imprecisas se não forem qualificadas**. Elas precisam ser reescritas na
mesma entrega (§4.4). Um documento que afirma "nenhum `localStorage`" num repositório que usa `localStorage` é
pior do que não ter documento.

### 3.2 A lógica de dispositivos vive num módulo puro, sem DOM

**Decisão:** `client/src/lib/devices.js` não chama `navigator.mediaDevices` nem toca em `localStorage`
diretamente. Ele **recebe** a lista crua de `MediaDeviceInfo` e um objeto storage-like, e devolve estruturas.
Quem faz I/O é o componente.

**Motivação:** é o mesmo padrão que já sustenta `lib/gridLayout.js` e `lib/audioLevels.js` — a aritmética
verificável fica separada do efeito colateral, e `client/test/devices.test.mjs` roda em `node:test` sem
navegador, sem jsdom e sem mock de `navigator`. O item 12 do DoD exige teste de listagem, dedup, rotulagem,
resolução da preferência e fallback: todos são funções de entrada→saída, e nenhum deles precisa de um browser.

**Alternativa descartada:** um hook `useDevices()` que encapsula tudo. Testar hook exige runtime de React e
uma dependência de teste nova (`@testing-library`), que o projeto não tem — e a parte interessante (dedup,
fallback) ficaria inacessível ao teste.

### 3.3 `deviceId: { ideal: … }`, nunca `{ exact: … }`

**Decisão:** as constraints usam `ideal`. A verdade sobre qual device foi de fato aberto vem de
`track.getSettings().deviceId`, lido **depois** do `getUserMedia`, e a preferência é reconciliada com esse
valor.

**Motivação:** com `exact`, um device que sumiu entre o `enumerateDevices` e o `getUserMedia` provoca
`OverconstrainedError` — um erro que a aplicação teria que capturar, interpretar e reexecutar. Com `ideal` o
navegador entrega o melhor disponível, o `getSettings()` diz qual foi, e o item 6 do DoD ("cai para o default
sem erro visível e a preferência é atualizada") é satisfeito pelo caminho feliz, sem tratamento de exceção.

**Anti-pattern a evitar:** assumir que `getSettings().deviceId` é sempre igual ao que foi pedido. É
precisamente por não ser que a reconciliação existe.

### 3.4 Fallback para default é uma decisão do módulo puro, não do componente

**Decisão:** `resolvePreferredDevice(list, savedId)` devolve `{ deviceId, fellBack }`. `deviceId: ''` significa
"sem restrição — default do sistema". Um id salvo que não está na lista devolve `{ deviceId: '', fellBack:
true }`, e é o `fellBack` que autoriza o componente a regravar a preferência.

**Motivação:** concentra num único lugar a pergunta "o que usar?" e torna o fallback um valor testável em vez
de um `if` espalhado por três chamadas de `getUserMedia`. A string vazia como sentinela de default é melhor que
`null` porque é o que vai direto para o `<select>` sem conversão, e melhor que a string `'default'` porque
`'default'` é um `deviceId` **real e reservado** do Chrome (§3.6).

### 3.5 O medidor do preview não usa o `AudioLevelMonitor` da sala

**Decisão:** `audioLevels.js` ganha uma função exportada nova, `createLevelMeter({ stream, context, onLevel })`,
que devolve `{ stop() }`. O preview do modal usa **ela**, não `monitor.attach()`. Quando existe um monitor na
página (dentro da sala), o modal repassa `monitor.ensureContext()` como `context`; na Home, o meter cria e é
dono do próprio `AudioContext`, fechando-o no `stop()`.

**Motivação — duas armadilhas concretas, ambas verificáveis:**

1. `Room.jsx:317-327` roda `monitor.retainOnly(valid)` a cada mudança em `participants`, onde `valid` contém
   só `'local'` e os ids de peers. Um `attach('settings-preview', …)` seria **silenciosamente detachado** na
   próxima entrada ou saída de alguém, e o medidor morreria no meio do uso — um bug intermitente, dependente
   de um evento de rede, que não aparece em teste manual rápido.
2. O `onUpdate` do monitor é único e pertence ao `Room` (`setAudioLevels`). O nível do preview entraria no
   mesmo snapshot que alimenta os anéis de fala dos tiles, acoplando modal e grade sem necessidade.

Repassar o `context` (em vez de deixar o meter criar o seu) preserva a invariante **um `AudioContext` por
aba** — que a checagem B2 do E2E (`e2e/run.mjs:288`) asserta com `AudioContexts === 1`. Um `new AudioContext()`
no modal quebra essa checagem, e o motivo não seria óbvio para quem for depurar.

**Alternativa descartada:** `monitor.attach(id, stream, { pinned: true })` com `retainOnly` respeitando
`pinned`. Funciona, mas adiciona um conceito ao monitor da sala para servir um caso que não é da sala.

**Obrigação:** a matemática de RMS→nível (`Math.sqrt(sum/n)`, `LEVEL_GAIN`) deve ser extraída para um helper
interno compartilhado entre `_tick` e `createLevelMeter`. Duas cópias divergem.

### 3.6 Normalização da lista: aliases do Chrome fora, opção "Padrão do sistema" dentro

**Decisão:** `listDevices(raw)` aplica, nesta ordem:

1. Descarta entradas com `deviceId` vazio (aparecem antes da permissão ser concedida).
2. Descarta os aliases reservados do Chrome — `deviceId === 'default'` e `deviceId === 'communications'`.
3. Deduplica por `deviceId` (primeiro vence); em seguida, por `(kind, groupId, label)`, como segunda barreira.
4. Rotula: se `label` for vazio, sintetiza `Câmera 1` / `Microfone 2` / `Saída 1` pela posição na lista do
   próprio `kind`.
5. Prepende, em cada uma das três listas, a opção sintética `{ deviceId: '', label: 'Padrão do sistema' }`.

**Motivação:** o Chrome devolve, para áudio, duas entradas extras que apontam para o mesmo hardware sob os ids
`'default'` e `'communications'`, tipicamente com rótulo prefixado ("Padrão - Microfone X"). Sem o passo 2 a
lista mostra o mesmo microfone três vezes — que é literalmente a duplicata que o item 2 do DoD proíbe. E salvar
`'default'` como preferência é uma armadilha: o id continua válido para sempre, então o fallback de §3.4 nunca
dispara, mas o hardware por trás dele muda sem aviso.

A opção sintética de `deviceId: ''` dá ao usuário uma forma explícita de dizer "siga o sistema", que é o
comportamento atual e precisa continuar alcançável.

**Anti-pattern a evitar:** deduplicar por `label`. Duas webcams idênticas do mesmo modelo têm o mesmo rótulo e
seriam colapsadas em uma — o usuário perderia acesso a metade do hardware.

### 3.7 Rotulagem exige permissão: preview primeiro, `enumerateDevices` depois

**Decisão:** ao abrir, o modal (a) inicia o stream de preview com a preferência corrente, e só (b) depois
chama `enumerateDevices`. Toda mudança de seleção pendente reinicia o preview; todo `devicechange` reexecuta
apenas o (b).

**Motivação:** sem permissão de câmera/mic concedida, `enumerateDevices` devolve entradas com `label: ''` e
`deviceId: ''` — uma lista inútil. O `getUserMedia` do preview é o que concede a permissão. Inverter a ordem
faz a primeira abertura do modal (na Home, antes de qualquer chamada) mostrar "Câmera 1 / Câmera 2" genéricos,
que é justamente o que o item 2 do DoD proíbe.

**Nota:** dentro da sala a permissão já foi concedida, então a ordem não muda nada — mas o código é o mesmo nos
três pontos de entrada, e o caso difícil é o da Home.

### 3.8 Troca em chamada: `replaceTrack`, e o estado de mute/câmera é preservado sem reacender hardware

**Decisão:** o handler de "Salvar" (`applyDeviceSelection`) segue exatamente estas regras:

| Situação | Ação |
|---|---|
| `videoInputId` mudou **e** câmera ligada | `getUserMedia({video:{deviceId:{ideal}}})` → `mesh.setCameraTrack(novo)` → `stop()` no antigo → troca no `localStreamRef` |
| `videoInputId` mudou **e** câmera desligada (`cameraOff`) | **Só grava a preferência.** Nenhum `getUserMedia`. O LED não acende. |
| `audioInputId` mudou | `getUserMedia({audio:{deviceId:{ideal}}})` → **`novo.enabled = !muted`** → `mesh.setAudioTrack(novo)` → `stop()` no antigo → troca no `localStreamRef` → `monitor.detach('local')` + `monitor.attach('local', stream)` |
| `audioOutputId` mudou | `setSinkId` em todos os elementos de mídia dos tiles |
| Nada de mídia mudou | Só grava a preferência e fecha |

**Motivação de cada ponto não óbvio:**

- **`enabled = !muted` antes do `setAudioTrack`** (item 7 do DoD): um track recém-adquirido nasce com
  `enabled = true`. Sem essa linha, trocar de microfone **desmuta a pessoa sem que ela peça** — o pior tipo de
  bug possível numa ferramenta de chamada. E precisa ser antes do `replaceTrack`, não depois, para não existir
  uma janela de frames em que o áudio vaza.
- **Câmera desligada só grava a preferência** (item 7): reacender a câmera para aplicar uma troca que a pessoa
  não pediu é acender o LED da webcam sem consentimento. A preferência fica guardada e é aplicada no próximo
  `toggleCamera` — que passa a ler a preferência em vez de pedir `{ video: true }`.
- **`detach` + `attach` do monitor local:** `AudioLevelMonitor.attach` é idempotente **por (id, stream)**
  (`audioLevels.js:87-89`) e o `MediaStream` local é o *mesmo objeto* depois da troca de track (só o track
  interno mudou). Um `attach` sozinho retorna cedo e o `MediaStreamAudioSourceNode` continua ligado ao track
  antigo, já parado — o anel de fala do tile local morre em silêncio. O `detach` prévio é obrigatório.

**Alternativa descartada:** derrubar o `localStream` inteiro e refazer um `getUserMedia({video,audio})` único.
Mais simples de escrever, mas troca os **dois** tracks quando só um mudou, e derruba momentaneamente o áudio de
quem só queria trocar de câmera.

### 3.9 O E2E precisa de um registro de dispositivos falsos no harness

**Decisão:** estender `INSTRUMENTATION` em `e2e/harness.mjs` com uma camada de simulação de dispositivos, e
não tentar obter múltiplos devices reais do Chromium.

**Motivação:** `--use-fake-device-for-media-stream` (`harness.mjs:139`) expõe **exatamente uma** câmera falsa e
**um** microfone falso. Não existe flag para uma segunda. Sem simulação, o item 13 do DoD — "trocar câmera e
mic" — é literalmente inexecutável, e a implementação seria entregue sem a cobertura que a task pede.

A camada precisa de quatro peças (contrato completo em §5.3):

1. `navigator.mediaDevices.enumerateDevices` sobrescrito, devolvendo um registro mutável de 2 `videoinput`,
   2 `audioinput` e 2 `audiooutput`.
2. `getUserMedia` já instrumentado (`harness.mjs:349`) passa a **registrar os `deviceId` pedidos** e a
   **remover a constraint de `deviceId`** antes de delegar ao original — o device falso real é um só, e manter
   a constraint tornaria o resultado dependente de como o Chromium trata um id desconhecido.
3. `HTMLMediaElement.prototype.setSinkId` sobrescrito para registrar as chamadas (o headless pode não
   implementá-lo, e a asserção do item 9 é sobre *ter chamado*, não sobre o áudio sair de fato).
4. Helpers `__wtkAddDevice(info)` / `__wtkRemoveDevice(deviceId)` que mutam o registro e disparam
   `devicechange` em `navigator.mediaDevices` — é o único jeito de cobrir o item 8 sem hardware.

**Anti-pattern a evitar:** afrouxar a asserção para "o `getUserMedia` foi chamado de novo". Isso passa mesmo se
o track novo não chegar aos senders. A asserção que importa é **identidade de objeto**: os `sender.track` de
antes e de depois têm que ser objetos diferentes, em *todos* os peers — que é o que prova que o `replaceTrack`
percorreu o mesh inteiro, e não só o primeiro peer.

### 3.10 Empilhamento: o modal de configurações fica **abaixo** do de aprovação

**Decisão:** o backdrop de configurações fica em `z-index: 28` — acima dos toasts (`styles.css:399`, 20) e
**abaixo** do backdrop de aprovação (`styles.css:493`, 30). Configurações fecha por `Esc` e por clique no
backdrop; aprovação continua não fechando por nenhum dos dois.

**Atenção ao reuso:** `.modal-backdrop` **já carrega** `z-index: 30`. Reusá-la crua empata os dois modais e a
ordem passa a depender da ordem de montagem no DOM — que não é estável, porque os dois vivem em ramos
diferentes do `Room`. O caminho correto é uma classe modificadora (`.modal-backdrop.settings { z-index: 28 }`)
que herda posicionamento e fundo e sobrescreve **só** a camada.

**Motivação:** a assimetria é intencional e já foi decidida em WTK-MEET-5 — fechar o modal de aprovação por
acidente deixa alguém esperando indefinidamente do outro lado. Fechar o de configurações por acidente custa
uma reabertura. Quando os dois estão abertos, quem tem prioridade visual é quem tem alguém esperando.

---

## 4. Componentes Afetados

### 4.1 Camada de lógica pura (`client/src/lib/`)

**`devices.js` — NOVO**
- **O que muda:** módulo sem DOM com normalização/dedup/rotulagem da lista, resolução da preferência salva com
  fallback, construção de constraints e leitura/escrita validada das preferências (via storage injetado).
  Contrato em §5.1.
- **Por quê:** é a superfície que o item 12 do DoD manda testar, e é onde as armadilhas de §3.4 e §3.6 ficam
  isoladas de React e de `navigator`.

**`audioLevels.js` — MODIFICADO**
- **O que muda:** exporta `createLevelMeter({ stream, context, onLevel })`, retornando `{ stop() }`. A
  aritmética de RMS→nível vira um helper interno compartilhado com `_tick`. `AudioLevelMonitor` **não muda de
  comportamento** — nenhuma assinatura existente é alterada, para não quebrar
  `client/test/audioLevels.test.mjs`.
- **Por quê:** §3.5 — o preview precisa de medição isolada do registro da sala, reusando o `AudioContext`.

**`webrtcMesh.js` — VERIFICAÇÃO, SEM MUDANÇA**
- **O que muda:** nada. `setAudioTrack` (`webrtcMesh.js:354-359`) já faz `replaceTrack` em todos os
  `rec.audioT.sender` e já atualiza `this.localAudioTrack`, que é a fonte da verdade para peers que entrem
  depois (`webrtcMesh.js:186`). `setCameraTrack` é simétrico.
- **Por quê:** o item 3 do DoD é satisfeito pelo que já existe. Quem implementar deve **confirmar** os dois
  pontos (broadcast a todos os peers + atualização do campo usado no `addPeer`) e registrar a verificação —
  não "melhorar" o método.

### 4.2 Componentes (`client/src/components/`)

**`SettingsModal.jsx` — NOVO**
- **O que muda:** modal controlado pelo pai. Props em §5.2. Estado interno: listas enumeradas, seleção
  pendente, stream de preview, nível do mic, suporte a `setSinkId`, aviso de device sumido. Efeitos: montar →
  preview + enumerar; mudança de seleção → reiniciar preview; `devicechange` → reenumerar; desmontar →
  `track.stop()` em tudo + `meter.stop()`.
- **Por quê:** todos os itens 1, 2, 4, 8, 9, 10 e 11 do DoD.

**`VideoTile.jsx` — MODIFICADO**
- **O que muda:** aceita `sinkId` e, num efeito, aplica `video.setSinkId(sinkId)` quando suportado, com
  `catch` silencioso. Sem suporte ou com id inválido: no-op.
- **Por quê:** item 9 — a saída de áudio se aplica por elemento de mídia, e os elementos vivem aqui.

### 4.3 Páginas (`client/src/pages/`)

**`Room.jsx` — MODIFICADO** (a maior mudança da entrega)
- Hidratar preferências no primeiro render; `soundsEnabled` passa a nascer delas.
- `getLocalStream()` usa `buildConstraints(prefs)`; cadeia de fallback preservada e estendida (§5.4).
- Reconciliação pós-`getUserMedia` via `getSettings().deviceId` (§3.3).
- `toggleCamera` passa a reaquirir com o `videoInputId` preferido, não `{ video: true }`.
- `applyDeviceSelection(next)` implementando a tabela de §3.8, protegido por um `deviceBusyRef` **compartilhado
  com `cameraBusyRef`** (uma pessoa apertando "Desligar câmera" e "Salvar" ao mesmo tempo dispara dois
  `getUserMedia` concorrentes sobre o mesmo hardware).
- Estado `settingsOpen` e botão "Configurações" na barra `.controls` e na fase `waiting`.
- Remoção do botão de avisos sonoros da barra (o estado continua no `Room`; só a UI muda de lugar).
- Listener de `devicechange` + `track.onended` nos tracks locais para recuperação com aviso (item 8).
- Passar `sinkId` aos `VideoTile` via a lista `tiles`.
- **Por quê:** é onde a sessão de mídia vive; nenhuma outra camada tem acesso ao mesh e ao `localStreamRef`.

**`Home.jsx` — MODIFICADO**
- Botão "Configurações" e render do `SettingsModal`. Salvar aqui **apenas persiste** — não há chamada ativa.
- **Por quê:** item 1, e é o ponto onde a escolha acontece *antes* de entrar, que é o momento certo.

### 4.4 Estilos e documentação

**`styles.css` — MODIFICADO:** `.settings-modal` sobre `.modal-backdrop.settings` (modificadora de camada,
§3.10), `.settings-field`,
`.settings-preview` (proporção 16:9, `object-fit: contain`, espelhado como o tile local), `.mic-meter`
(barra dirigida por custom property, como `--speak-level` já faz em `.video-tile`), estado `disabled` do
seletor de saída com texto de explicação. Respeitar `prefers-reduced-motion` (`styles.css:435`).

**`README.md` — MODIFICADO:** ajustar a linha 4 e o bloco de linha 73; documentar o fluxo de seleção e a chave
`wtk-meet:devices`.

**`ARCHITECTURE.md` — MODIFICADO:** nova **§6.8 Seleção de dispositivos de mídia**; qualificar a linha 11
("Nenhuma persistência") e a linha 189 (o parágrafo do chat continua verdadeiro — a qualificação é de escopo,
não de retratação); §9 (limitações) ganha o que ficou de fora por §2.

### 4.5 E2E

**`e2e/harness.mjs` — MODIFICADO:** camada de simulação de dispositivos (§3.9/§5.3) e um helper
`openSettings(page)` que abre o modal e espera ele estabilizar.
**`e2e/run.mjs` — MODIFICADO:** bloco novo **H** (§8.13).

---

## 5. Contratos de Interface

Nenhum endpoint REST novo. **Nenhum evento de sinalização novo ou alterado.** Nenhuma mudança de schema — não
há banco. Os contratos desta entrega são de módulo e de armazenamento local.

### 5.1 `client/src/lib/devices.js` — contrato de interface

| Export | Assinatura (conceitual) | Comportamento |
|---|---|---|
| `STORAGE_KEY` | `string` | `'wtk-meet:devices'` |
| `DEFAULT_PREFERENCES` | objeto | `{ videoInputId: '', audioInputId: '', audioOutputId: '', soundsEnabled: true }` |
| `listDevices(raw)` | `MediaDeviceInfo[] → { videoInputs, audioInputs, audioOutputs }` | Cada lista é `[{ deviceId, label, groupId }]`, já normalizada por §3.6, com a opção `deviceId: ''` na frente. Entrada `null`/`undefined` devolve as três listas contendo só a opção default. |
| `resolvePreferredDevice(list, savedId)` | `→ { deviceId, fellBack }` | §3.4. `savedId` falsy → `{ '', false }`. Encontrado → `{ savedId, false }`. Não encontrado → `{ '', true }`. |
| `buildConstraints(prefs, { video, audio })` | `→ MediaStreamConstraints` | `video`/`audio` são booleanos de "quero esta mídia". Um id vazio produz `true` (sem restrição); um id preenchido produz `{ deviceId: { ideal: id } }`. Se ambos forem `false`, devolve `{ video: false, audio: false }` — quem chama é responsável por não pedir um stream vazio. |
| `readPreferences(storage)` | `→ preferences` | Lê e valida. Storage ausente, `getItem` lançando (modo privado), JSON inválido, chave inexistente, tipos errados → `DEFAULT_PREFERENCES`. **Nunca lança.** Chaves desconhecidas são descartadas. |
| `writePreferences(storage, patch)` | `→ preferences` | Faz merge sobre o que já está gravado, valida, grava e devolve o resultado efetivo. `setItem` lançando (cota/modo privado) é engolido — a preferência simplesmente não persiste, e a sessão corrente continua funcionando. |
| `isSinkIdSupported(proto)` | `→ boolean` | `typeof proto?.setSinkId === 'function'`. Argumento default `globalThis.HTMLMediaElement?.prototype`, para ser chamável sem argumento no app e com um duplo no teste. |
| `reconcilePreferences(prefs, tracks)` | `→ { prefs, changed }` | Recebe os tracks efetivamente abertos, lê `getSettings().deviceId` de cada um e devolve as preferências corrigidas. `changed` diz se algo mudou (evita escrita desnecessária). |

**Regras de validação de `readPreferences`:** os três ids devem ser `string` (qualquer outra coisa → `''`);
`soundsEnabled` deve ser `boolean` (qualquer outra coisa → `true`, que é o comportamento atual).

### 5.2 `SettingsModal` — contrato de props

| Prop | Tipo | Significado |
|---|---|---|
| `open` | `boolean` | O pai controla. Fechado ⇒ o componente **não renderiza e não segura stream** (ver §7.1). |
| `preferences` | objeto | Preferências correntes, ponto de partida da seleção pendente. |
| `onSave(next)` | função | Recebe as quatro chaves. **O pai** persiste e aplica — o modal não escreve em `localStorage`. |
| `onClose()` | função | Cancelar / `Esc` / backdrop. O modal já parou tudo antes de chamar. |
| `audioContext` | `AudioContext \| null` | Repassado ao meter do preview (§3.5). `null` na Home. |
| `onDeviceLost(message)` | função, opcional | Chamada quando um device **em uso** some enquanto o modal está aberto — o pai decide entre `mediaError` e toast. |

**Acessibilidade (mesmo padrão de `JoinRequestModal`):** `role="dialog"`, `aria-modal="true"`, título
associado por `aria-labelledby`, foco inicial no primeiro `<select>`, foco devolvido ao botão que abriu.
Cada `<select>` tem `<label>` associado. O medidor tem `aria-hidden` (é redundante com o preview e ruidoso para
leitor de tela).

### 5.3 Instrumentação de E2E — contrato

| Símbolo | Tipo | Contrato |
|---|---|---|
| `window.__wtkFakeDevices` | array mutável | Registro corrente. Semeado com 2 `videoinput` (`cam-a`, `cam-b`), 2 `audioinput` (`mic-a`, `mic-b`), 2 `audiooutput` (`spk-a`, `spk-b`), todos com `label` preenchido. |
| `navigator.mediaDevices.enumerateDevices` | override | Devolve cópias do registro, cada uma com `toJSON()` (React/testes podem serializar). |
| `window.__wtkCounters.gumRequests` | `array` | Um item por `getUserMedia`: `{ video, audio }` com os `deviceId` pedidos (ou `null`). Prova **o que** foi pedido, não só quantas vezes. |
| `window.__wtkSinkIds` | `array` | `{ tag, sinkId }` por chamada de `setSinkId`. |
| `window.__wtkAddDevice(info)` / `__wtkRemoveDevice(deviceId)` | funções | Mutam o registro e disparam `devicechange`. Se o device removido estiver em uso, o helper também dispara `ended` no track correspondente — é o que o navegador faz de verdade. |

`getUserMedia` continua incrementando `__wtkCounters.getUserMedia` e registrando tracks em `__wtkLiveTracks`
como hoje; a única mudança é registrar o pedido e **remover `deviceId` das constraints** antes de delegar.

### 5.4 Cadeia de fallback do `getUserMedia` inicial (pseudológica)

```
1. tentar  buildConstraints(prefs, { video: true,  audio: true  })
2. senão   buildConstraints(prefs, { video: false, audio: true  })   // câmera indisponível/negada
3. senão   { audio: true }                                           // ignora a preferência de mic
4. senão   null                                                      // entra sem mídia (comportamento atual)
```

O passo 3 é novo e é o que garante o item 6 quando o **microfone** salvo sumiu: sem ele, a pessoa entraria sem
áudio nenhum por causa de uma preferência obsoleta. Depois de qualquer passo bem-sucedido, roda a reconciliação
de §3.3.

### 5.5 Formato persistido

Chave: `wtk-meet:devices`. Valor: JSON de objeto plano.

| Campo | Tipo | Default | Observação |
|---|---|---|---|
| `videoInputId` | string | `''` | `''` = default do sistema |
| `audioInputId` | string | `''` | idem |
| `audioOutputId` | string | `''` | idem |
| `soundsEnabled` | boolean | `true` | migrado da barra `.controls` |

Sem número de versão: o formato é plano, os defaults absorvem qualquer campo ausente, e a validação de §5.1
absorve qualquer campo estranho. Um `version` aqui seria cerimônia sem consumidor.

---

## 6. Dependências e Ordem de Implementação

1. **`lib/devices.js` + `test/devices.test.mjs`** — fundação, sem dependências. Escrever os dois juntos; o
   teste é o que fixa as decisões de §3.4 e §3.6 antes que qualquer UI dependa delas.
2. **`lib/audioLevels.js`: `createLevelMeter` + extração do helper de RMS** — independente do passo 1, pode
   correr em paralelo. Rodar `audioLevels.test.mjs` para confirmar não-regressão.
3. **`components/SettingsModal.jsx`** — depende de 1 e 2.
4. **`components/VideoTile.jsx`: prop `sinkId`** — independente, pode correr em paralelo com 3.
5. **`pages/Home.jsx`** — depende de 3. É o ponto de entrada mais simples (salvar só persiste) e serve de
   validação manual do modal antes de encostar na sala.
6. **`pages/Room.jsx`** — depende de 3, 4 e 5. O passo mais delicado; seguir a tabela de §3.8 literalmente.
7. **`styles.css`** — acompanha 3 e 6.
8. **`e2e/harness.mjs`** (simulação de devices) → **`e2e/run.mjs`** (bloco H). Depende de 6. A suíte inteira
   precisa continuar verde, não só o bloco novo.
9. **`README.md` + `ARCHITECTURE.md`** — por último, descrevendo o que de fato foi construído.

Paralelizável: (1 ‖ 2 ‖ 4). Tudo o mais é sequencial.

---

## 7. Riscos e Armadilhas

### 7.1 Stream de preview órfão segurando a câmera

- **Risco:** o preview mantém a câmera aberta. Se não for parado ao fechar o modal, o LED fica aceso e, em
  Windows/macOS, o `getUserMedia` seguinte da sala pode falhar com `NotReadableError` (device ocupado). O
  caminho mais provável de vazamento é abrir o modal na Home, escolher e **navegar para a sala** sem passar
  pelo `onClose`.
- **Mitigação:** o `stop()` mora no cleanup do `useEffect`, não no handler de clique — assim desmontar por
  navegação limpa igual a fechar por botão. O pai renderiza `{open && <SettingsModal …/>}` (desmonta de
  verdade) em vez de `<SettingsModal open={open} …/>` com um `return null` interno mantendo estado.
- **Anti-pattern:** parar o preview só no `onCancel`. "Salvar" também precisa parar — e o track do preview
  **não** deve ser reaproveitado como track da chamada (ele foi adquirido com constraints do preview e sua
  vida é gerenciada pelo modal; reusá-lo cria dois donos para o mesmo objeto).

### 7.2 Trocar de microfone desmuta a pessoa

- **Risco:** item 7 do DoD. Track novo nasce `enabled = true`.
- **Mitigação:** `novo.enabled = !muted` **antes** do `replaceTrack` (§3.8).
- **Anti-pattern:** confiar no `mesh.setLocalState({ micOff })` para "consertar" depois. Isso só atualiza o
  ícone na tela dos outros — o áudio real já vazou.

### 7.3 O anel de fala local morre depois de trocar o mic

- **Risco:** `attach` idempotente por (id, stream) + `MediaStream` reaproveitado = analisador preso ao track
  antigo (§3.8).
- **Mitigação:** `detach('local')` antes do `attach('local', stream)`.
- **Anti-pattern:** criar um `MediaStream` novo a cada troca. Resolve o analisador e quebra outra coisa: o
  `tiles` do `Room` referencia `localStreamRef.current`, e o `VideoTile` só reage a **mudança de identidade**
  do stream (`VideoTile.jsx:42`) — trocar o objeto força repintura em cascata sem necessidade.

### 7.4 Segundo `AudioContext` quebra o E2E

- **Risco:** o modal criando o próprio contexto dentro da sala derruba a checagem B2 (`AudioContexts === 1`).
- **Mitigação:** §3.5 — injetar `monitor.ensureContext()`.
- **Anti-pattern:** relaxar a checagem B2 para `<= 2`. Ela protege uma propriedade de custo real (um contexto
  por tile foi o problema que ela existe para impedir); afrouxá-la para acomodar código novo é perder o teste.

### 7.5 `setSinkId` indisponível ou rejeitando

- **Risco:** Firefox não implementa por padrão; em headless pode não existir; e mesmo quando existe, rejeita
  com `NotAllowedError` (sem permissão de mic) ou `NotFoundError` (id inválido). Uma rejeição não tratada dentro
  de um efeito vira `unhandledrejection` — e a checagem **G** do E2E falha a suíte por erro de console.
- **Mitigação:** feature-detect via `isSinkIdSupported()`; seletor renderizado `disabled` com explicação
  visível quando não há suporte (item 9); todo `setSinkId` embrulhado em `.catch()`. Rejeição no *save*
  reverte `audioOutputId` para `''` e avisa uma vez.
- **Anti-pattern:** esconder o seletor quando não há suporte. O item 9 pede **desabilitado com explicação** —
  esconder faz o usuário procurar um recurso que ele viu em outro navegador.

### 7.6 `devicechange` é ruidoso e chega em rajada

- **Risco:** conectar um headset USB dispara vários `devicechange` seguidos (mic e saída aparecem em momentos
  diferentes). Reenumerar e **reiniciar o preview** a cada um faz a câmera piscar.
- **Mitigação:** o handler de `devicechange` só reenumera. O preview só reinicia quando a *seleção pendente*
  muda, ou quando o device do preview corrente sumiu da lista.
- **Anti-pattern:** um `enumerateDevices` em `setInterval` como "garantia". `devicechange` é confiável; polling
  acorda a página sem motivo e mascara a ausência do listener.

### 7.7 `getUserMedia` concorrente sobre o mesmo hardware

- **Risco:** "Salvar" enquanto `toggleCamera` está em voo (o `toggleCamera` já se protege com
  `cameraBusyRef`, `Room.jsx:357`, mas o novo caminho não o respeitaria).
- **Mitigação:** **o mesmo ref** guarda os dois caminhos. Enquanto ocupado, o botão "Salvar" fica desabilitado
  em vez de descartar o clique em silêncio.

### 7.8 Preferência gravada aponta para hardware de outra máquina

- **Risco:** ids são estáveis por origem+perfil, mas o hardware muda (dock desconectada, outro monitor com
  webcam).
- **Mitigação:** §3.3 + §3.4 — fallback silencioso e reconciliação. O usuário nunca vê um erro por causa disso.
- **Anti-pattern:** mostrar "dispositivo não encontrado" na entrada da sala. Ninguém pode agir sobre isso no
  momento em que está entrando numa chamada; o item 6 pede explicitamente **sem erro visível**.

### 7.9 Documentação passa a mentir

- **Risco:** `README.md:4` e `ARCHITECTURE.md:11` afirmam ausência de persistência; `ARCHITECTURE.md:189`
  afirma "não há `localStorage`".
- **Mitigação:** item 15 do DoD. A linha 189 é sobre **chat** e continua verdadeira — a correção ali é de
  escopo ("o histórico de chat não usa…"), não de conteúdo. As linhas 4 e 11 precisam da qualificação de §3.1.
- **Anti-pattern:** apagar a afirmação de zero persistência. Ela continua sendo a propriedade central do
  produto; o que muda é que ela ganha uma exceção nomeada, justificada e delimitada.

### 7.10 Escopo vazado para o servidor

- **Risco:** repetir o desvio de WTK-MEET-5 (evento novo em `server/`).
- **Mitigação:** nenhum item do DoD exige servidor. Se durante a implementação parecer que exige, **é sinal de
  erro de projeto** — parar e revisar, não adicionar evento.

---

## 8. Critérios de Aceite Técnicos

Numerados em correspondência com o Definition of Done.

1. Existe um botão "Configurações" em três lugares — `main.home`, na fase de espera/conexão e na barra
   `.controls` da sala. Clicar em qualquer um deles renderiza um elemento com `role="dialog"` e o mesmo
   conteúdo.
2. Com permissão concedida, cada `<select>` do modal contém uma `<option>` para cada device do seu `kind`,
   com o rótulo real do sistema, sem `deviceId` repetido e sem os aliases `default`/`communications`. A
   primeira opção de cada lista é "Padrão do sistema".
3. Em chamada ativa com ≥1 peer: trocar câmera e microfone e salvar faz **todos** os `sender.track` de vídeo e
   de áudio, em **todos** os `RTCPeerConnection`, apontarem para objetos diferentes dos anteriores — enquanto
   `__wtkCounters.setLocalDescription` e `setRemoteDescription` permanecem **iguais** aos de antes da troca.
   Nenhum peer muda de `connectionState`.
4. Depois de mudar a seleção e sair por "Cancelar", `Esc` ou clique no backdrop: o modal some, os
   `deviceId` em uso são os de antes, as preferências gravadas não mudaram, e não resta nenhum track de preview
   com `readyState === 'live'`.
5. Recarregar a página, ou fechar e reabrir o navegador, e reabrir o modal mostra a seleção salva. O JSON em
   `localStorage['wtk-meet:devices']` contém exatamente as quatro chaves.
6. Com uma preferência salva apontando para um `deviceId` inexistente, entrar na sala abre mídia normalmente
   pelo default, **nenhuma mensagem de erro é exibida**, e a preferência gravada passa a refletir o device
   efetivamente aberto.
7. Mutado + trocar de mic ⇒ o novo `sender.track` de áudio tem `enabled === false` e o botão continua
   mostrando "Ativar mic". Câmera desligada + trocar de câmera ⇒ `__wtkCounters.getUserMedia` **não**
   incrementa, nenhum track de vídeo novo aparece, e a preferência gravada muda.
8. Com o modal aberto: adicionar um device faz a `<option>` correspondente aparecer sem reabrir o modal;
   remover o device **em uso** faz a aplicação passar ao default e exibir uma mensagem em `.warning` ou um
   toast.
9. Salvar uma saída de áudio dispara `setSinkId` com esse id em todos os elementos de mídia dos tiles. Onde
   `HTMLMediaElement.prototype.setSinkId` não existe, o `<select>` de saída renderiza com `disabled` e um texto
   explicativo, e os demais controles do modal continuam funcionais.
10. Mudar a seleção com o modal aberto atualiza o preview e o medidor **sem** alterar o que os peers recebem.
    Ao fechar (por qualquer via), nenhum track adquirido pelo modal permanece `live` e o meter foi parado.
11. A barra `.controls` não tem mais o botão de avisos sonoros; o toggle está dentro do modal; desligá-lo e
    salvar faz uma entrada/saída de participante **não** criar oscilador, e ligá-lo de volta restaura o bipe.
12. `npm --prefix client test` passa, incluindo `devices.test.mjs`, com casos de listagem, dedup, rotulagem
    sintética, resolução de preferência salva, fallback para default e leitura de storage corrompido.
13. `node e2e/run.mjs` passa integralmente, com o bloco H novo cobrindo: abrir modal → trocar câmera e mic →
    salvar → tracks novos em todos os senders → contadores de SDP inalterados.
14. `npm --prefix client run lint` sem erros novos.
15. `README.md` e `ARCHITECTURE.md` descrevem o fluxo de seleção e a exceção de `localStorage`, e nenhuma
    afirmação remanescente de "zero persistência" contradiz o código.

---

## 9. Notas para os Agentes de Implementação

### 9.1 Divisão sugerida

Um único agente de desenvolvimento faz os passos 1–7 de §6: o estado de mídia do `Room` é acoplado demais para
dividir sem retrabalho. Os passos 8 (E2E) e 9 (documentação) podem ir para um segundo agente **depois** que o
6 estiver verde.

### 9.2 Pitfalls específicos desta demanda (não estão na documentação geral)

- `AudioLevelMonitor.attach` é idempotente por (id, stream) — §7.3. É o erro mais provável desta entrega, e ele
  não gera exceção nenhuma.
- `enumerateDevices` **antes** da permissão devolve lixo — §3.7.
- O Chrome devolve `'default'` e `'communications'` como devices reais — §3.6.
- Track novo nasce `enabled = true` — §7.2.
- `cameraBusyRef` já existe e precisa cobrir o caminho novo — §7.7.
- `retainOnly` do `Room` detacha qualquer id que não seja peer — §3.5.
- A checagem **G** do E2E falha a suíte com qualquer erro de console; uma promise rejeitada de `setSinkId`
  basta — §7.5.

### 9.3 Ordem de validação após implementar

1. `npm --prefix client run lint`
2. `npm --prefix client test` (confirmar que `audioLevels.test.mjs` e `gridLayout.test.mjs` continuam passando —
   `audioLevels.js` foi tocado)
3. `npm --prefix client run build`
4. `node e2e/run.mjs` — **a suíte inteira**, não só o bloco H. Os blocos B (AudioContext único), E (ciclo de
   câmera) e G (console limpo) são os que esta entrega tem mais chance de quebrar.
5. Conferência manual dos itens 4, 8 e 10 do DoD, que dependem de temporização e não são inteiramente
   observáveis por asserção.

> A receita de ambiente do E2E (libs em `/tmp/pwlibs`) está no fim de `claude-progress.md` e continua
> necessária a cada sessão nova.

### 9.4 Se houver folga (não fazer sem pedir)

Botão "Testar saída" (toca um bipe pelo `AudioContext` no dispositivo selecionado) e "Restaurar padrões"
(limpa `wtk-meet:devices`). Ambos são baratos e melhoram o modal, mas estão fora do DoD — **não implementar
por conta própria**; propor.
