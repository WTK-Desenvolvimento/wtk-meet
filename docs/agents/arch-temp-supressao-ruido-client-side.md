# Supressão de ruído client-side com toggle nas Configurações — Documento de Arquitetura Técnica

> Gerado em: 2026-08-13
> Status: Rascunho
> Task: WTK-MEET-11 — Implementar supressão de ruído client-side com toggle nas Configurações
> Autor: Arquiteto

---

## 1. Contexto e Objetivo

### Problema atual

`buildConstraints` (`client/src/lib/devices.js:117-133`) monta apenas `deviceId: { ideal }`. Nenhuma
constraint de processamento de áudio é pedida em nenhum dos cinco `getUserMedia` do client
(`Room.jsx:262`, `Room.jsx:549`, `Room.jsx:614`, `Room.jsx:680`, `SettingsModal.jsx:113`), e não existe
nenhuma UI para ligar ou desligar processamento.

**Correção necessária à premissa da demanda.** A descrição diz que "o microfone vai cru para o mesh".
Isso não é verdade nos navegadores que o produto atinge: Chrome, Edge, Firefox e Safari ligam
`noiseSuppression`, `echoCancellation` e `autoGainControl` **por padrão** quando o `getUserMedia` pede
`audio: true` sem qualificar. O que existe hoje não é ausência de supressão — é **ausência de controle**:
o app não sabe o que o navegador fez, não consegue desligar, não consegue garantir nada onde o padrão
for outro, e não tem como dizer ao usuário o que está acontecendo.

Isso não diminui a entrega; **redefine o que ela precisa fazer**, e três consequências de projeto saem
diretamente daí:

1. O estado **desligado** do toggle tem que ser pedido **explicitamente** (`noiseSuppression: false`).
   Um toggle que só emite a constraint quando está ligado é um toggle inerte no navegador cujo padrão já
   é ligado — a pessoa desliga e nada muda.
2. O motor de fallback **não pode empilhar** em cima do processamento nativo. Duas supressões em série
   produzem bombeamento e voz metálica — pior que nenhuma. Logo, a decisão do motor precisa ser tomada
   **depois** do `getUserMedia`, olhando o que o navegador de fato entregou.
3. O valor entregue ao usuário é **controle e previsibilidade**, e é assim que a UI deve falar — não
   "agora seu áudio é limpo", e sim "supressão de ruído: ligada/desligada", com indicação de qual motor
   está ativo.

### Comportamento esperado após a entrega

- A supressão nasce **ligada**, inclusive para quem já tem `wtk-meet:devices` gravado de entregas
  anteriores (a chave ausente é lida como `true`).
- Um checkbox no modal de Configurações — o mesmo componente usado na Home, na tela de espera e na barra
  da sala — liga e desliga.
- Ligado, o navegador que suporta a constraint nativa aplica a supressão nativa. Onde ela não existe ou
  não é honrada, um `AudioWorklet` próprio assume, e o track processado substitui o cru **em todos os
  pontos**: senders do mesh, `localStreamRef` e medidor de fala.
- Ligar e desligar em chamada **não renegocia SDP** e, nos dois caminhos, **não troca o objeto do track**
  nos senders.
- Nada disso trafega: nenhum evento novo de sinalização, nenhum campo novo no data channel, nenhum áudio
  saindo da máquina além dos quatro canais de mídia que já existem.

### Vínculo com o produto

O produto se define por "chamada que funciona sem infraestrutura de terceiros". Todo concorrente resolve
ruído no servidor (SFU com processamento) ou com SDK proprietário — os dois caminhos estão vetados por
§1 do `ARCHITECTURE.md`. Resolver no navegador é a única forma coerente com a arquitetura, e é também a
mais barata: o processamento acontece na máquina de quem fala, escala com o número de participantes sem
custo de infraestrutura, e não dá ao operador nenhum acesso novo ao áudio. Esta entrega fecha, em §9 do
`ARCHITECTURE.md`, a limitação declarada de que "não há controle de `noiseSuppression`".

---

## 2. Escopo

**Dentro do escopo:**

- Chave nova `noiseSuppression` em `wtk-meet:devices`, com default `true` e leitura tolerante à ausência
  (`client/src/lib/devices.js`).
- `buildConstraints` passa a emitir constraints de processamento de áudio (§3.3).
- Módulo novo `client/src/lib/noiseSuppression.js`: decide o motor, monta e desmonta o grafo do
  `AudioWorklet`, expõe o pipeline do microfone com dono explícito.
- Arquivo novo `client/src/lib/noiseSuppressorWorklet.js`: o `AudioWorkletProcessor` **e** o DSP puro que
  ele usa, no mesmo arquivo, sem imports (§3.6), com teste em `node:test`.
- Checkbox "Reduzir ruído de fundo" no `SettingsModal`, com hint dizendo qual motor está ativo.
- `Room.jsx`: pipeline de microfone com dono (`micPipelineRef`), aplicação em chamada sem renegociação,
  e correção dos quatro pontos que hoje assumem "o track do mesh é o track do `getUserMedia`" (§4.3).
- Testes unitários novos (`client/test/noiseSuppression.test.mjs`) e atualização de
  `client/test/devices.test.mjs`, que hoje fixa `audio: true` por igualdade estrutural
  (`devices.test.mjs:169-189`).
- Bloco **T** novo em `e2e/run.mjs` e a instrumentação que ele exige em `e2e/harness.mjs` (§5.5).
- Atualização de `README.md` e `ARCHITECTURE.md` (nova §6.11 e ajuste da limitação em §9).

**Fora do escopo:**

- Qualquer mudança em `server/`. A entrega é **100% client-side**. Se durante a implementação parecer
  que o servidor precisa saber de algo, é erro de projeto — parar e revisar (§7.10).
- Controles de `echoCancellation` e `autoGainControl`. São constraints irmãs e caberiam no mesmo lugar,
  mas não estão pedidas, e cada uma tem armadilhas próprias (desligar AEC em quem usa alto-falante
  devolve eco para a sala inteira). Deixar declarado em §9 do `ARCHITECTURE.md` como próximo passo
  natural.
- Supressão de ruído nos streams **remotos**. O processamento é de quem fala, uma vez, não de cada
  ouvinte N vezes — e mexer no áudio recebido tornaria impossível saber se o problema é do emissor.
- Processamento do canal de **música** (`musicEngine.js:63`). O grafo da música tem destino próprio e
  passa longe deste caminho; suprimir ruído em música é degradá-la.
- Supressão no **preview** do modal quando o motor for o worklet (§3.9). O preview reflete o caminho
  nativo de graça; montar um segundo grafo de worklet só para o preview custa um `AudioContext` na Home
  e complexidade de ciclo de vida, para um ganho que a barra de nível quase não mostra.
- Modelos de ML (RNNoise/WASM, `@shiguredo/noise-suppression`, etc.). Justificativa em §3.7.
- Ajuste fino de intensidade (leve/médio/agressivo). Um booleano é o que a task pede; o parâmetro existe
  no DSP e pode virar UI depois sem mudar contrato.
- Retuning dos limiares de fala de `audioLevels.js:16-17`. Eles estão fixados em teste; mudar por
  suspeita é perder a rede de proteção (§7.6).

---

## 3. Decisões Arquiteturais

### 3.1 A supressão é uma preferência de dispositivo, não um estado de sessão

**Decisão:** `noiseSuppression: boolean` entra no objeto já persistido em `localStorage` sob
`wtk-meet:devices`, junto de `videoInputId`, `audioInputId`, `audioOutputId` e `soundsEnabled`.
`DEFAULT_PREFERENCES` (`devices.js:20-25`) ganha `noiseSuppression: true`.

**Motivação:** a exceção à regra de zero persistência já foi nomeada e delimitada em WTK-MEET-9
(`ARCHITECTURE.md` §6.10): o que pode ser gravado é *preferência de hardware do próprio equipamento*.
"Meu ambiente é barulhento" é exatamente isso — não é conteúdo, não é metadado de chamada, não diz com
quem se falou nem quando, e nunca sai do navegador. Não há exceção nova a justificar; há uma chave a
mais dentro de uma exceção existente. O documento e o README precisam passar de "quatro chaves" para
"cinco chaves" (§4.5) — a delimitação vale enquanto for descrita com precisão.

**Consequência que decide o default:** `sanitize` (`devices.js:135-143`) descarta chaves de tipo errado
e cai no default. Quem já tem `wtk-meet:devices` gravado **não tem** a chave nova; ela cai em `true`, que
é exatamente o "ligada por padrão" pedido. Nenhuma migração, nenhum número de versão.

**Alternativa descartada:** estado só de sessão (React state, sem persistir). Obrigaria a religar a cada
chamada quem mais precisa do recurso — o mesmo argumento que sustentou a persistência da escolha de
headset.

### 3.2 O toggle desligado é uma constraint explícita, não a ausência dela

**Decisão:** `buildConstraints` emite `noiseSuppression: { ideal: <valor da preferência> }` **sempre**
que pede áudio — inclusive quando o valor é `false`.

**Motivação:** o padrão dos navegadores atuais é ligado (§1). Omitir a constraint quando o toggle está
desligado entrega um controle que não controla nada, e o bug é invisível: o áudio continua sendo
processado, ninguém vê erro, e a queixa chega como "o toggle não faz nada" semanas depois.

**`ideal`, nunca `exact`:** mesma regra de `ARCHITECTURE.md` §6.10. Com `exact`, um navegador que não
suporta a constraint devolve `OverconstrainedError` e derruba a aquisição de mídia inteira — a pessoa
entraria na sala **sem áudio nenhum** por causa de uma preferência de qualidade. Com `ideal`, uma
constraint desconhecida é simplesmente ignorada pelo navegador, e quem responde "o que aconteceu de
fato?" é `track.getSettings()`.

**Anti-pattern a evitar:** ramificar `buildConstraints` por feature detection
(`if (getSupportedConstraints().noiseSuppression)`). Isso quebra a pureza do módulo — `devices.js` é
declaradamente sem DOM e sem `navigator` (`devices.js:5-9`), e é essa pureza que torna
`devices.test.mjs` executável em `node:test`.

### 3.3 O motor é escolhido **depois** do `getUserMedia`, pelo que o track reporta

**Decisão:** a escolha do motor não é feita por feature detection prévia; é feita lendo
`track.getSettings().noiseSuppression` do track recém-adquirido, com
`navigator.mediaDevices.getSupportedConstraints()` servindo apenas de desempate.

| Preferência | `getSettings().noiseSuppression` | `getSupportedConstraints().noiseSuppression` | Motor |
|---|---|---|---|
| ligada | `true` | — | **`native`** — nada a fazer, o track cru já é o processado |
| ligada | `false` | — | **`worklet`** — pedimos e o navegador recusou |
| ligada | `undefined` | `true` | **`native`** (confiança) — o navegador diz que suporta e não reporta o setting |
| ligada | `undefined` | ausente/`false` | **`worklet`** |
| desligada | qualquer | — | **`off`** — track cru, nenhum grafo montado |

**Motivação:** é a mesma disciplina de `reconcilePreferences` (`devices.js:189-218`) — *pedir com `ideal`,
verificar com `getSettings`, agir sobre a verdade*. E é o único jeito de garantir a regra de §1.2: nada
de empilhar worklet em cima de supressão nativa. A linha `undefined` + suporte declarado existe porque
alguns navegadores aplicam a constraint sem espelhá-la em `getSettings()`; tratar `undefined` como
"não aplicou" faria justamente o empilhamento que precisamos evitar. Na dúvida, **prefira o nativo**:
ele é mais barato, mais testado e não tem risco de silenciar ninguém.

**Anti-pattern a evitar:** decidir por *user agent string*. Além de frágil, erra exatamente nos casos que
importam (WebViews, navegadores com flags alteradas, builds corporativos).

### 3.4 O pipeline do microfone passa a ter dono explícito

**Decisão:** `createMicPipeline` devolve um objeto opaco com ciclo de vida próprio:

```
{ track, rawTrack, engine, setEnabled(bool), stop() }
```

`track` é o que vai para o mesh, para o `localStreamRef` e para o monitor. `rawTrack` é o que veio do
`getUserMedia`. No motor `native`/`off` os dois são **o mesmo objeto**; no motor `worklet` são objetos
diferentes. O `Room` guarda o objeto em `micPipelineRef` e é o único dono.

**Motivação:** hoje o código do `Room` assume, em quatro lugares, que "o track de áudio do
`localStreamRef` é o track que o `getUserMedia` devolveu". Com o worklet ativo isso deixa de ser verdade,
e cada uma das quatro suposições falha **em silêncio**:

| Lugar | Suposição | O que quebra sem o pipeline |
|---|---|---|
| `Room.jsx:480-481` (cleanup) | parar os tracks do `localStreamRef` apaga o LED do mic | para só o track do destino; **o microfone continua aberto depois de sair da sala** |
| `Room.jsx:163-167` + `:660-664` (`ended`) | o track do stream avisa quando o device some | o track do destino nunca dispara `ended`; a recuperação de microfone arrancado **nunca roda** |
| `Room.jsx:293-296` (reconciliação) | `getSettings().deviceId` do track do stream diz qual device abriu | o track do destino não tem `deviceId`; a preferência para de se autocorrigir |
| `Room.jsx:183-188` (`installAudioTrack`) | `old.stop()` encerra a captura anterior | encerra o destino e deixa o `getUserMedia` anterior vivo — **vaza um microfone por troca de device** |

Os quatro têm a mesma causa e a mesma correção: perguntar ao pipeline, não ao stream. O objeto existe
para tornar impossível esquecer um deles.

**Alternativa descartada:** manter o track cru dentro do `localStreamRef` junto do processado. O
`localStreamRef` alimenta o `VideoTile` local e o monitor de nível; dois tracks de áudio no mesmo stream
fariam o `AnalyserNode` somar os dois (medindo o áudio não processado) e `toggleMute`
(`Room.jsx:522-531`) mutaria os dois — funcionaria por acidente, e quebraria no primeiro refactor.

### 3.5 Ligar e desligar em chamada não troca o track e não renegocia

**Decisão:** o toggle **nunca** passa por `replaceTrack` quando o pipeline já está montado:

| Motor ativo | Ação ao alternar |
|---|---|
| `native` | `rawTrack.applyConstraints({ noiseSuppression: { ideal: v } })`, e reler `getSettings()` para confirmar |
| `worklet` | `pipeline.setEnabled(v)` → `port.postMessage` para o processador, que passa a aplicar ganho 1.0 |
| `off` → ligar, e `applyConstraints` rejeita ou não é honrado | aí sim: reaquisição via `getUserMedia` + `installAudioTrack` (caminho já existente e testado) |

**Motivação:** os dois caminhos rápidos evitam de uma vez o `getUserMedia` concorrente (§7.7 do documento
de WTK-MEET-9), a janela de frames em que o mute pode vazar (`Room.jsx:178-181`), o `detach`/`attach` do
monitor (`audioLevels.js:203-209`) e qualquer chance de renegociação. Um checkbox de qualidade não pode
ter o mesmo custo e o mesmo risco de trocar de microfone.

**Nota sobre o bypass do worklet:** desligar **não** desmonta o grafo e **não** volta ao track cru. O
processador continua no caminho, com ganho fixo 1.0 e a mesma latência de overlap-add. Desmontar
mudaria o objeto do track (renegociação zero, mas `replaceTrack` em todos os peers) e reconectar
introduziria um clique audível na transição. Ganho fixo é mais barato em todos os sentidos que importam.

**Anti-pattern a evitar:** "simplificar" chamando `installAudioTrack` sempre, para ter um caminho só.
Cada `installAudioTrack` é um `getUserMedia` a mais sobre o mesmo hardware, um `replaceTrack` por peer e
uma chance de desmutar alguém que não pediu.

### 3.6 O worklet é um arquivo autocontido que também exporta o DSP puro

**Decisão:** `client/src/lib/noiseSuppressorWorklet.js` contém, no mesmo arquivo e **sem nenhum
`import`**:

1. as funções puras de DSP, exportadas com `export`;
2. a classe do processador, derivada de uma base resolvida em runtime
   (`typeof AudioWorkletProcessor === 'function' ? AudioWorkletProcessor : class {}`);
3. a chamada de `registerProcessor`, guardada por `typeof registerProcessor === 'function'`.

O app carrega o arquivo por URL (`import workletUrl from './noiseSuppressorWorklet.js?url'`) e o teste
`node:test` o importa diretamente, como um módulo comum.

**Motivação:** o projeto separa aritmética verificável de efeito colateral (`gridLayout.js`,
`audioLevels.js`, `devices.js`), e um DSP é o caso mais extremo dessa regra — errar um índice de FFT não
gera exceção, gera voz metálica. Mas o escopo global do `AudioWorklet` é isolado: **um `import` no
arquivo do worklet não sobrevive** ao `?url` do Vite (que copia o arquivo sem resolver dependências) e
não é confiável no escopo de worklet dos navegadores. As duas restrições só se satisfazem
simultaneamente com um arquivo único, sem dependências, que se comporta como módulo normal fora do
worklet — e as duas guardas de runtime acima são o que torna isso possível sem `try/catch` nem
duplicação de código.

**Alternativa descartada:** DSP em `lib/noiseGateDsp.js` + worklet fino importando dele. É o desenho mais
limpo no papel e o mais quebradiço na prática: exige que o bundler resolva imports dentro de um módulo de
worklet, o que muda entre `vite dev` e `vite build`. Duas cópias do mesmo DSP (uma testável, outra
embarcada) é ainda pior — `ARCHITECTURE.md` §6.10 já registra a regra: duas cópias divergem.

**Servir o arquivo:** `?url` emite o arquivo em `/assets/` com hash, coberto pelo bloco
`location ^~ /assets/` do `client/nginx.conf` — que tem `try_files $uri =404`, e é isso que garante que
uma URL errada devolva **404** em vez do `index.html` do SPA fallback. Esse detalhe é o que separa um
erro diagnosticável de um `addModule` que rejeita com erro de sintaxe em HTML. Se por qualquer motivo o
`?url` não servir o arquivo corretamente em `vite dev`, a alternativa é
`client/public/worklets/noise-suppressor.js` (servido verbatim nos dois modos, sem hash) — decidir por
verificação, não por suposição (§9.3).

### 3.7 O algoritmo: porta espectral com piso de ruído adaptativo

**Decisão:** supressão por **ganho espectral tipo Wiener** sobre STFT, com estimativa contínua do piso de
ruído por bin. Sem dependências, sem WASM, sem modelo.

**Pseudológica (não escrever código a partir daqui sem ler §5.3):**

```
janela        512 amostras (Hann), hop 128 = 1 render quantum → 75% de overlap
por quantum:  empurra 128 amostras no buffer circular de entrada
              quando o buffer completa uma janela:
                 x  ← janela * Hann
                 X  ← FFT real de 512 → 257 bins
                 m  ← |X| por bin
                 piso ← seguidor assimétrico por bin:
                          sobe devagar   (τ ≈ 1.5 s)   ← não deixa a fala virar "ruído"
                          desce rápido   (τ ≈ 80 ms)   ← acompanha o ambiente ficando mais silencioso
                 snr  ← m / (piso + ε)
                 g    ← clamp( (snr - 1) / snr , gMin , 1 )        # gMin ≈ 0.12  (≈ -18 dB)
                 g    ← média móvel de 3 bins (frequência)         # mata "musical noise"
                 g    ← suavização de 1ª ordem no tempo (τ ≈ 30 ms)
                 Y    ← X * g
                 y    ← IFFT(Y) * Hann
                 overlap-add em y no buffer de saída
              consome 128 amostras do buffer de saída → output[0]
bypass:       tudo igual, com g ≡ 1.0 (mesma latência, sem clique na transição)
```

**Motivação de cada escolha não óbvia:**

- **`gMin` ≈ −18 dB, nunca zero.** Um gate que fecha até o silêncio absoluto faz a pessoa soar cortada,
  mata as caudas de reverberação naturais da fala e — efeito colateral concreto neste código — derruba o
  RMS a zero, apagando o anel de fala de `audioLevels.js` durante as pausas.
- **Suavização em frequência e no tempo.** Ganho calculado por bin, aplicado cru, produz *musical
  noise*: tons aleatórios entrando e saindo. É o artefato clássico da subtração espectral e o motivo de
  a versão ingênua soar pior que não fazer nada.
- **Ataque lento do piso.** É o que impede que uma fala longa seja incorporada ao piso de ruído e passe
  a ser suprimida.
- **Hop = 128 = um render quantum.** Alinha o processamento ao ritmo do `AudioWorklet`: uma FFT a cada
  chamada de `process`, sem acumular latência de agendamento. Latência algorítmica: 512 − 128 = 384
  amostras ≈ **8 ms** a 48 kHz. Custo: ~375 FFTs de 512 pontos por segundo, em um único stream — ordem
  de grandeza abaixo do que já custam os encoders da chamada.
- **Mono.** O canal de voz do mesh é mono na prática. Entrada estéreo é rebaixada por `(L+R)/2` antes do
  processamento, e a saída é mono. Descartar o canal direito em vez de rebaixar perderia metade da
  captação de um mic estéreo.

**Alternativas descartadas:**

- **RNNoise via WASM** (ou qualquer wrapper npm equivalente). Qualidade superior, sem discussão. Mas
  acrescenta uma dependência binária de terceiros a um produto cuja tese é não depender de terceiros,
  ~500 KB no bundle, e a política de CSP/COOP passa a importar. O caminho nativo já cobre praticamente
  todo o parque real de navegadores; gastar uma dependência binária no caminho **raro** é a troca errada.
  Se um dia o fallback virar o caminho comum, esta decisão deve ser revista — e aí com medição, não com
  suposição.
- **Noise gate de banda larga** (RMS vs. limiar, sem FFT). Trivial de escrever e inútil para o caso de
  uso: não faz **nada** contra ventilador, ar-condicionado ou ruído de rua *enquanto a pessoa fala*, que
  é o problema. Só corta o silêncio entre frases — e o `enabled`/mute já cobre isso melhor.
- **`DynamicsCompressorNode` + filtros nativos.** Não é supressão de ruído; é dinâmica. Tende a
  *amplificar* o ruído de fundo nas pausas.

### 3.8 O `AudioContext` continua sendo um por aba, e o worklet não engata suspenso

**Decisão:** o grafo do worklet usa o contexto compartilhado de `client/src/lib/audioContext.js:23`.
Além disso, o pipeline **só entrega o track processado quando `ctx.state === 'running'`**; com o contexto
suspenso, ele devolve o track cru e re-tenta o engate no primeiro gesto do usuário
(`resumeAudioContextOnGesture`, `audioContext.js:45`, já registrado pelo `Room` em `Room.jsx:309`).

**Motivação — duas falhas silenciosas, ambas graves:**

1. Um `new AudioContext()` novo derruba a checagem **B2** do E2E (`e2e/run.mjs:323-324`,
   `AudioContexts === 1`), que existe para proteger um custo real. Afrouxá-la para acomodar código novo
   é perder o teste (mesmo argumento de §7.4 do documento de WTK-MEET-9).
2. Um `MediaStreamAudioDestinationNode` em contexto **suspenso** produz um track `live` que só emite
   silêncio. A pessoa entra na sala, o ícone de mic aparece normal, o anel de fala não acende e
   **ninguém a ouve** — sem erro no console, sem nada na tela. É a pior falha possível desta entrega, e a
   política de autoplay dos navegadores torna o contexto suspenso o estado **normal** antes do primeiro
   clique.

**Anti-pattern a evitar:** chamar `ctx.resume()` e seguir em frente assumindo sucesso. `resume()` devolve
uma promise que **fica pendente** até haver gesto; não rejeita. Quem espera por ela trava a entrada na
sala.

### 3.9 O preview do modal reflete o caminho nativo, e só ele

**Decisão:** o preview do `SettingsModal` continua exatamente como está: `getUserMedia` com
`buildConstraints(pending, …)` (`SettingsModal.jsx:113-115`). Como as constraints agora carregam
`noiseSuppression`, o preview passa a refletir a escolha **de graça** onde o motor é nativo. Onde o motor
é o worklet, o preview mostra o sinal cru, e o modal diz isso em um hint.

**Motivação:** montar o grafo do worklet no preview exigiria um `AudioContext` na Home (onde
`SettingsModal` recebe `audioContext={null}`, `Home.jsx:238`), um segundo ciclo de vida de grafo dentro
de um efeito que já reinicia a cada mudança de seleção (`SettingsModal.jsx:101-154`), e teardown correto
em quatro saídas diferentes. Em troca de uma diferença que a barra de nível quase não mostra — o
medidor mede RMS, e a supressão mexe principalmente no que **não** é fala.

**O hint não é opcional.** Sem ele, alguém no caminho de fallback conclui que o toggle não funciona,
porque o preview não muda. Uma linha de texto abaixo do checkbox resolve.

### 3.10 Nada disso chega ao servidor nem à rede

**Decisão:** zero mudança em `server/`. Nenhum evento novo de sinalização, nenhum campo em
`mesh.localState` (`Room.jsx:374-379`), nenhuma mensagem no data channel.

**Motivação:** a supressão é uma propriedade do áudio que o peer já recebe — ele ouve o resultado, que é
a única coisa que lhe interessa. Publicar "fulano está com supressão ligada" seria criar metadado de
chamada novo, no produto que se define por não ter nenhum, para alimentar um ícone que ninguém pediu.

**Anti-pattern a evitar:** exibir um badge de supressão nos tiles remotos. Exigiria transmitir o estado
e contradiz §5 do `ARCHITECTURE.md`.

---

## 4. Componentes Afetados

### 4.1 Camada de lógica pura (`client/src/lib/`)

**`devices.js` — MODIFICADO**
- **O que muda:** `DEFAULT_PREFERENCES` ganha `noiseSuppression: true`; `sanitize` valida a chave como
  boolean (qualquer outra coisa → `true`); `constraintFor`/`buildConstraints` passam a montar o objeto de
  constraints de áudio de §5.1. O módulo **continua puro** — nenhuma feature detection entra aqui.
- **Por quê:** §3.1 e §3.2. É o único ponto por onde passam todos os `getUserMedia` do app.

**`noiseSuppressorWorklet.js` — NOVO**
- **O que muda:** arquivo único, sem imports, com o DSP puro exportado e o `AudioWorkletProcessor`
  registrado sob guarda (§3.6). Contrato em §5.3.
- **Por quê:** é o motor de fallback e a única parte da entrega cuja correção não é observável a olho nu.

**`noiseSuppression.js` — NOVO**
- **O que muda:** orquestração com WebAudio — decide o motor pela tabela de §3.3, carrega o módulo do
  worklet (uma vez por contexto, memoizado), monta `source → worklet → destination`, e devolve o objeto
  de pipeline de §3.4/§5.2. Todo caminho de falha (`addModule` rejeitando, contexto suspenso, worklet
  indisponível) degrada para o track cru — **nunca** para ausência de áudio.
- **Por quê:** §3.4. Concentra num lugar a única parte da entrega que toca em `AudioContext`, deixando o
  `Room` com plumbing e o worklet com aritmética.

**`audioLevels.js` / `audioContext.js` — SEM MUDANÇA**
- Verificar, não alterar: o monitor recebe o stream do `localStreamRef`, que passa a conter o track
  processado sem que nada no monitor precise saber disso. `getAudioContext()` já é o acessor único.

**`webrtcMesh.js` — SEM MUDANÇA**
- `setAudioTrack` já faz `replaceTrack` em todos os peers e já atualiza `localAudioTrack`
  (`webrtcMesh.js:90`), que é a fonte para quem entra depois. Confirmar, não "melhorar".

### 4.2 Componentes (`client/src/components/`)

**`SettingsModal.jsx` — MODIFICADO**
- **O que muda:** um `.settings-check` novo (classe já existe, `styles.css:1166`), irmão do de avisos
  sonoros (`SettingsModal.jsx:257-266`), com rótulo "Reduzir ruído de fundo" e um `.settings-hint`
  (`styles.css:1161`) dizendo qual motor está ativo. Nova prop opcional `noiseEngine`.
- **Por quê:** a demanda pede o toggle exatamente aqui, e o componente já é o mesmo nos três pontos de
  entrada — nada precisa ser duplicado.

### 4.3 Páginas (`client/src/pages/`)

**`Room.jsx` — MODIFICADO** (a maior parte da entrega)
- `micPipelineRef` novo; `setup()` monta o pipeline a partir do track de áudio do `getLocalStream()`
  (`Room.jsx:253-268`) e coloca **o track processado** no `localStreamRef`.
- Reconciliação (`Room.jsx:292-299`) passa a receber o **track cru** de áudio, não o do stream (§3.4).
- `watchLocalTrack` passa a observar o **track cru** de áudio; `handleLocalTrackEnded`
  (`Room.jsx:660-664`) reconhece o track cru do pipeline além dos tracks do stream — hoje ele descarta
  qualquer track que não esteja no `localStreamRef`, e é aí que a recuperação morreria.
- `installAudioTrack` (`Room.jsx:173-200`) passa a receber um **pipeline**, não um track: instala
  `pipeline.track`, e o `stop()` do pipeline anterior substitui o `old.stop()`.
- `applyDeviceSelection` (`Room.jsx:589-654`) ganha o ramo do toggle: se só `noiseSuppression` mudou,
  segue a tabela de §3.5 e **não** entra no caminho de `getUserMedia`/`cameraBusyRef`.
- Cleanup (`Room.jsx:468-494`): `micPipelineRef.current?.stop()` antes de `closeAudioContext()`. Sem
  isso, o microfone fica aberto depois de sair da sala.
- Estado `noiseEngine` para alimentar o hint do modal.
- **Por quê:** é o único lugar com acesso ao mesh, ao `localStreamRef` e ao monitor.

**`Home.jsx` — MODIFICADO (mínimo)**
- **O que muda:** nada estrutural. `writePreferences` (`Home.jsx:243`) já grava o objeto inteiro, então a
  chave nova persiste sem código novo. Verificar e registrar; não refatorar.

### 4.4 Testes

**`client/test/devices.test.mjs` — MODIFICADO:** os casos de `buildConstraints` (linhas 169-189) fixam
`audio: true` e `video: true` por igualdade estrutural e **vão falhar** — é o sinal esperado, não uma
regressão. Atualizar para o contrato de §5.1, preservando a asserção de que nenhum `exact` aparece
(linha 185-189), que continua valendo e agora cobre mais superfície.

**`client/test/noiseSuppression.test.mjs` — NOVO:** DSP puro e tabela de decisão de motor. Casos em §8.

### 4.5 Estilos, E2E e documentação

**`styles.css`:** nenhuma classe nova esperada — `.settings-check` e `.settings-hint` já existem.
**`e2e/harness.mjs` — MODIFICADO:** instrumentação de §5.5.
**`e2e/run.mjs` — MODIFICADO:** bloco **T** (as letras A, B, C, D, E, F, N e S já estão em uso).
**`README.md` — MODIFICADO:** o bloco da linha ~144 passa de quatro para **cinco** chaves em
`wtk-meet:devices`, e ganha a descrição do toggle.
**`ARCHITECTURE.md` — MODIFICADO:** nova **§6.11 Supressão de ruído**; §6.10 passa a citar cinco chaves;
a limitação de §9 ("não há controle de `echoCancellation`, `noiseSuppression`, ganho…") é reescrita para
manter apenas o que continua verdadeiro (AEC, AGC, ganho de entrada, resolução de câmera).

---

## 5. Contratos de Interface

Nenhum endpoint REST novo. **Nenhum evento de sinalização novo ou alterado.** Nenhuma mudança de schema —
não há banco. Os contratos desta entrega são de módulo, de worklet e de armazenamento local.

### 5.1 `devices.js` — mudanças de contrato

| Export | Antes | Depois |
|---|---|---|
| `DEFAULT_PREFERENCES` | 4 chaves | 5 chaves; `noiseSuppression: true` |
| `readPreferences` | valida 4 | valida 5; chave ausente ou de tipo errado → `true` |
| `writePreferences` | merge de 4 | merge de 5; chaves desconhecidas continuam descartadas |
| `buildConstraints(prefs, { video, audio })` | `audio: true \| { deviceId: { ideal } }` | ver abaixo |

**Novo formato do ramo de áudio de `buildConstraints`:**

| `audio` pedido | `audioInputId` | Resultado |
|---|---|---|
| `false` | — | `false` |
| `true` | `''` | `{ noiseSuppression: { ideal: <pref> } }` |
| `true` | `'mic-1'` | `{ deviceId: { ideal: 'mic-1' }, noiseSuppression: { ideal: <pref> } }` |

O ramo de vídeo **não muda**. Nenhum `exact` em lugar nenhum. A constraint é emitida também quando a
preferência é `false` (§3.2).

### 5.2 `noiseSuppression.js` — contrato de interface

| Export | Assinatura (conceitual) | Comportamento |
|---|---|---|
| `decideEngine({ track, supported })` | `→ 'native' \| 'worklet' \| 'off'` | Função **pura**: implementa literalmente a tabela de §3.3. `track` entra como `{ getSettings() }` para ser testável com um duplo. É a única parte deste módulo coberta por unitário. |
| `createMicPipeline({ rawTrack, enabled, context, supported })` | `→ Promise<pipeline>` | Decide o motor e, se for `worklet`, monta o grafo. **Nunca rejeita**: qualquer falha (contexto suspenso, `addModule` rejeitando, `AudioWorkletNode` indisponível) degrada para `{ engine: 'off', track: rawTrack }`. |
| `pipeline.track` | `MediaStreamTrack` | O que vai para o mesh, o `localStreamRef` e o monitor. |
| `pipeline.rawTrack` | `MediaStreamTrack` | O que veio do `getUserMedia`. É dele que se lê `getSettings()` e é nele que se observa `ended`. |
| `pipeline.engine` | string | `'native'`, `'worklet'` ou `'off'`. Alimenta o hint do modal. |
| `pipeline.setEnabled(v)` | `→ Promise<boolean>` | `native` → `applyConstraints` + releitura de `getSettings`; `worklet` → `postMessage`; `off` → `false`. Devolve se o estado pedido foi atingido — `false` manda quem chamou usar o caminho de reaquisição (§3.5). **Nunca rejeita.** |
| `pipeline.stop()` | `→ void` | Idempotente. Desconecta os nós, para o track do destino **e** o `rawTrack`. Não fecha o `AudioContext` — o dono dele é o `Room` (`audioContext.js:57-65`). |

**Invariante que o implementador deve preservar:** `pipeline.track.readyState === 'live'` sempre que
`rawTrack` estiver `live` e o pipeline não tiver sido parado. Se em algum caminho de erro a função for
devolver um track morto, ela deve devolver o `rawTrack` em vez disso.

### 5.3 `noiseSuppressorWorklet.js` — contrato

**Nome do processador:** `'wtk-noise-suppressor'`.

**Exports puros (é o que o `node:test` importa):**

| Export | Assinatura | Contrato |
|---|---|---|
| `FFT_SIZE`, `HOP_SIZE` | `512`, `128` | Constantes; o teste ancora nelas em vez de repetir números. |
| `createState(sampleRate)` | `→ state` | Aloca janelas, buffers e o piso de ruído. `sampleRate` entra por parâmetro — o global `sampleRate` do escopo de worklet não existe no Node. |
| `pushQuantum(state, input, output, { enabled })` | `→ void` | Consome 128 amostras de `input` e preenche 128 em `output`. Com `enabled: false`, aplica ganho 1.0 pelo **mesmo** caminho de overlap-add (§3.5). |
| `updateNoiseFloor(floor, mags, { attack, release })` | `→ void` | Seguidor assimétrico, in-place. |
| `computeGains(mags, floor, { gMin })` | `→ Float32Array` | Ganho de Wiener por bin, com clamp em `[gMin, 1]`. |
| `smoothGains(gains, previous, { span, alpha })` | `→ void` | Média móvel em frequência e suavização de 1ª ordem no tempo, in-place. |
| `fftReal(re, im)` / `ifftReal(re, im)` | `→ void` | Radix-2 in-place. |

**Protocolo do `port`** (main thread → worklet, unidirecional):

| Mensagem | Efeito |
|---|---|
| `{ type: 'enabled', value: boolean }` | Liga/desliga o ganho. Aplicado no início do próximo `process`. |

Não há mensagens do worklet para a main thread. O nível de áudio já é medido por `audioLevels.js`; um
segundo canal de telemetria seria uma fonte de verdade concorrente.

**Regras de escopo (as três que causam falha silenciosa):**

1. `process()` deve **retornar `true`**. Retornar `false` faz o navegador coletar o nó, e o áudio some
   sem erro nenhum.
2. Nenhuma alocação dentro de `process()` — todos os buffers nascem no construtor. Alocar por quantum
   convida o GC para a thread de áudio e produz glitches.
3. `inputs[0]` pode chegar **vazio** (`[]`) quando não há fonte conectada em um quantum. Escrever silêncio
   e retornar `true` é o comportamento correto; indexar direto lança dentro da thread de áudio.

### 5.4 Formato persistido (`wtk-meet:devices`)

| Campo | Tipo | Default | Observação |
|---|---|---|---|
| `videoInputId` | string | `''` | inalterado |
| `audioInputId` | string | `''` | inalterado |
| `audioOutputId` | string | `''` | inalterado |
| `soundsEnabled` | boolean | `true` | inalterado |
| `noiseSuppression` | boolean | `true` | **novo**; ausência = `true` (§3.1) |

Sem número de versão, pela mesma razão de WTK-MEET-9: o formato é plano e os defaults absorvem qualquer
campo ausente.

### 5.5 Instrumentação de E2E — contrato

| Símbolo | Tipo | Contrato |
|---|---|---|
| `window.__wtkCounters.gumRequests[i].audioProcessing` | objeto \| `null` | O que foi **pedido** em processamento de áudio: `{ noiseSuppression: <valor de ideal> }`. Hoje `gumRequests` só registra `deviceId` (`harness.mjs:533`). |
| `window.__wtkForceWorkletNs` | boolean | Quando `true`: `getSupportedConstraints()` devolve o objeto **sem** `noiseSuppression`, a constraint é removida antes de delegar ao `getUserMedia` original, e `getSettings()` reporta `noiseSuppression: false`. É o único jeito de exercitar o fallback em Chromium, que suporta a constraint nativa. |
| `window.__wtkApplyConstraints` | array | `{ kind, constraints }` por chamada de `track.applyConstraints`. Prova o caminho rápido de §3.5 sem depender de o Chromium honrar a mudança em um device falso. |
| `window.__wtkTrackStates()` | já existe (`harness.mjs:588`) | Usado **sem mudança** para provar que nenhum track de áudio fica `live` depois de sair da sala. |

O `stripDeviceId` (`harness.mjs:517-528`) já preserva as demais constraints — a única mudança é registrar
o que foi pedido e, sob a flag, remover `noiseSuppression`.

---

## 6. Dependências e Ordem de Implementação

1. **`lib/noiseSuppressorWorklet.js` + a parte de DSP de `test/noiseSuppression.test.mjs`** — fundação,
   sem dependência de nada. Escrever os dois juntos: a correção do DSP não é observável a olho nu, e
   depurá-lo dentro da thread de áudio depois de integrado é ordens de grandeza mais caro.
2. **`lib/devices.js` (5 chaves + constraints) + atualização de `test/devices.test.mjs`** — independente
   do passo 1, pode correr em paralelo.
3. **`lib/noiseSuppression.js` + `decideEngine` no teste** — depende de 1 e 2.
4. **`components/SettingsModal.jsx`** (checkbox + hint) — depende de 2. Pode correr em paralelo com 3.
5. **`pages/Room.jsx`** — depende de 3 e 4. O passo mais delicado: seguir a tabela de §3.4 item por item
   e a de §3.5 literalmente.
6. **`e2e/harness.mjs`** (§5.5) → **`e2e/run.mjs`** (bloco T). Depende de 5.
7. **`README.md` + `ARCHITECTURE.md`** — por último, descrevendo o que de fato foi construído.

Paralelizável: (1 ‖ 2), depois (3 ‖ 4). Tudo o mais é sequencial.

**Ponto de verificação obrigatório entre 3 e 5:** carregar o worklet em `vite dev` **e** em
`vite build` + `vite preview` (§3.6). Se o `?url` falhar em um dos dois, a alternativa de `public/` deve
ser adotada **antes** de o `Room` ser tocado — descobrir isso depois custa retrabalho nos dois lados.

---

## 7. Riscos e Armadilhas

### 7.1 O microfone continua aberto depois de sair da sala

- **Risco:** o cleanup (`Room.jsx:480-481`) para os tracks do `localStreamRef`, que com o worklet ativo
  contém apenas o track do **destino**. O `getUserMedia` original fica vivo: LED aceso, indicador do
  sistema operacional ligado, e o próximo `getUserMedia` podendo falhar com `NotReadableError`.
- **Mitigação:** `micPipelineRef.current?.stop()` no cleanup, e `stop()` do pipeline para os **dois**
  tracks (§5.2).
- **Anti-pattern:** confiar em `ctx.close()` para encerrar a captura. Fechar o contexto derruba o grafo,
  não o device — e nesta arquitetura quem fecha o contexto é o `Room`, depois do monitor.

### 7.2 A recuperação de microfone arrancado deixa de existir

- **Risco:** `watchLocalTrack` (`Room.jsx:163-167`) observa `ended` nos tracks do stream. O track do
  destino **nunca** dispara `ended` — quando o mic é arrancado, o worklet passa a processar silêncio e o
  track segue `live` para sempre. Pior: mesmo que o listener estivesse no lugar certo,
  `handleLocalTrackEnded` (`Room.jsx:664`) descarta qualquer track que não esteja no `localStreamRef`.
- **Mitigação:** observar o `rawTrack`, e alargar a guarda para aceitar `micPipelineRef.current.rawTrack`.
- **Anti-pattern:** detectar a perda por RMS zerado no monitor. Confunde "mic arrancado" com "pessoa
  calada" e com "pessoa mutada".

### 7.3 A preferência de microfone para de se autocorrigir

- **Risco:** `reconcilePreferences` (`Room.jsx:292-296`) recebe `localStream.getTracks()`. O track do
  destino não tem `deviceId`. O código atual não quebra (`devices.js:208` ignora id vazio), então a falha
  é **silenciosa**: uma preferência apontando para hardware que sumiu nunca mais se conserta.
- **Mitigação:** passar `[cameraTrack, pipeline.rawTrack]` explicitamente.

### 7.4 Cada troca de microfone vaza uma captura

- **Risco:** `installAudioTrack` faz `old.stop()` (`Room.jsx:185-188`). Com o worklet, `old` é o destino;
  o `getUserMedia` anterior continua vivo. Trocar de mic três vezes deixa três capturas abertas.
- **Mitigação:** `installAudioTrack` opera sobre pipelines; o `stop()` do pipeline anterior substitui o
  `old.stop()`.
- **Anti-pattern:** parar o `rawTrack` **antes** do `replaceTrack`. Abre uma janela de silêncio audível
  para todos os peers; a ordem correta é a que já está no código (`replaceTrack` → `stop` do antigo).

### 7.5 Entrar na sala em silêncio total por causa do `AudioContext` suspenso

- **Risco:** §3.8. Destino em contexto suspenso = track `live` emitindo silêncio, sem erro em lugar
  nenhum. É a falha mais grave e a mais fácil de não notar em teste manual (quem testa já clicou em
  coisas antes).
- **Mitigação:** só engatar com `ctx.state === 'running'`; caso contrário, entregar o track cru e
  re-tentar no gesto.
- **Anti-pattern:** `await ctx.resume()` no caminho de entrada. A promise **fica pendente** sem gesto —
  não rejeita — e a entrada na sala trava.

### 7.6 Supressão demais mata o anel de fala

- **Risco:** os limiares de `audioLevels.js:16-17` (`SPEAKING_ON = 0.035`) foram calibrados no sinal cru.
  Um `gMin` agressivo derruba o RMS e o anel para de acender — sintoma que aparece como "o indicador de
  fala quebrou", não como "a supressão está agressiva demais".
- **Mitigação:** `gMin` ≈ −18 dB (§3.7) e verificação explícita no critério 9 de §8.
- **Anti-pattern:** baixar `SPEAKING_ON` para compensar. Os limiares estão fixados em
  `audioLevels.test.mjs` e valem para os streams **remotos** também — que não passam por supressão
  nenhuma. Mexer neles conserta o local e quebra os remotos.

### 7.7 Empilhar worklet em cima da supressão nativa

- **Risco:** tratar `getSettings().noiseSuppression === undefined` como "não aplicou" liga os dois
  motores em série em qualquer navegador que aplique a constraint sem reportá-la. Resultado: bombeamento
  e voz metálica — e a conclusão errada de que o DSP está com bug.
- **Mitigação:** a linha de desempate por `getSupportedConstraints()` na tabela de §3.3.

### 7.8 O worklet não carrega em produção

- **Risco:** URL errada + SPA fallback = `addModule` recebendo `index.html` e rejeitando com erro de
  sintaxe. O bloco `location ^~ /assets/` do `nginx.conf` protege **se** o arquivo sair em `/assets/`;
  fora dali, o `location /` devolve o `index.html` com 200.
- **Mitigação:** §3.6 e o ponto de verificação de §6. Falha de `addModule` degrada para `engine: 'off'`
  com o track cru — o áudio **nunca** para por causa disso.
- **Anti-pattern:** deixar a rejeição de `addModule` sem `catch`. Uma promise rejeitada dentro de um
  efeito vira `unhandledrejection`, e a checagem **G** do E2E falha a suíte inteira por erro de console.

### 7.9 Glitches por trabalho demais na thread de áudio

- **Risco:** alocar dentro de `process()`, ou rodar a FFT em quantums em que ela não é necessária,
  produz cliques e falhas que não aparecem em máquina de desenvolvimento e aparecem em notebook fraco com
  6 participantes.
- **Mitigação:** buffers pré-alocados no construtor; uma FFT por quantum (hop = 128); nenhum
  `console.log` no `process` (formatar string na thread de áudio é caro o bastante para causar dropout).

### 7.10 Escopo vazado para o servidor ou para a rede

- **Risco:** repetir o desvio de WTK-MEET-5 (evento novo em `server/`) para "avisar" que a supressão está
  ligada.
- **Mitigação:** §3.10. Nenhum item da demanda exige servidor; se parecer que exige, é erro de projeto.

### 7.11 Os testes de `buildConstraints` vão falhar — e isso é o esperado

- **Risco:** `devices.test.mjs:169-189` compara o resultado por igualdade estrutural. A falha pode ser
  lida como regressão e "consertada" fazendo `buildConstraints` omitir a constraint quando o valor é
  `false` — que é exatamente o bug de §3.2.
- **Mitigação:** atualizar os casos para o contrato de §5.1, preservando a asserção de ausência de
  `exact`.

---

## 8. Critérios de Aceite Técnicos

1. Sem nada gravado em `localStorage`, entrar na sala emite um `getUserMedia` cujo ramo de áudio contém
   `noiseSuppression: { ideal: true }`, e o JSON de `wtk-meet:devices` passa a ter **cinco** chaves.
2. Com `wtk-meet:devices` contendo apenas as quatro chaves antigas, a leitura devolve
   `noiseSuppression: true` e nada é perdido das outras quatro.
3. Desmarcar o toggle e salvar emite `noiseSuppression: { ideal: false }` no próximo `getUserMedia`, ou
   um `applyConstraints` equivalente no track corrente — **nunca** a ausência da constraint.
4. Alternar o toggle em chamada com ≥1 peer: `__wtkCounters.setLocalDescription` e `setRemoteDescription`
   permanecem **iguais**, e o `sender.track` de áudio de todos os peers continua sendo **o mesmo objeto**
   de antes. Nenhum peer muda de `connectionState`.
5. Com o motor nativo indisponível (`__wtkForceWorkletNs`), o track do sender de áudio local é um objeto
   **diferente** do track devolvido pelo `getUserMedia`, `window.__wtkAudioContexts.length` continua
   `1`, e o peer remoto recebe áudio com energia diferente de zero.
6. No mesmo cenário, o `localStreamRef` e o `AudioLevelMonitor` observam **o mesmo track** que os senders
   — o anel de fala local acende quando há fala.
7. Sair da sala não deixa nenhum track de áudio com `readyState === 'live'`
   (`window.__wtkTrackStates()`), com ou sem o worklet ativo.
8. Com o worklet ativo, remover o microfone em uso (`__wtkRemoveDevice('mic-a')`) dispara a recuperação
   já existente: a preferência volta para o padrão do sistema e a mensagem aparece na tela.
9. Ruído branco estacionário aplicado ao DSP é atenuado em **pelo menos 10 dB** depois de 1 s de
   adaptação, enquanto um tom senoidal em nível de fala passa com atenuação **abaixo de 1 dB**; o RMS de
   um trecho de fala simulada permanece **acima** de `SPEAKING_ON` (`audioLevels.js:16`).
10. Com `enabled: false`, `pushQuantum` reconstrói o sinal de entrada com erro máximo por amostra abaixo
    de `1e-6` (overlap-add com ganho unitário é identidade, a menos da latência de 384 amostras).
11. `ifftReal(fftReal(x))` devolve `x` com erro máximo abaixo de `1e-6` para ruído aleatório de 512
    amostras.
12. `decideEngine` devolve exatamente o que a tabela de §3.3 manda, nas cinco linhas.
13. Trocar de microfone com o worklet ativo e estando **mutado**: o novo `sender.track` tem
    `enabled === false`, e nenhum track antigo (cru ou processado) fica `live`.
14. O modal exibe o checkbox nos três pontos de entrada, e o hint diz qual motor está ativo quando a
    página está em uma sala.
15. `npm --prefix client test`, `npm --prefix client run lint` e `npm --prefix client run build` passam.
16. `node e2e/run.mjs` passa integralmente — a suíte inteira, com o bloco **T** novo. Os blocos B
    (`AudioContext` único), G (console limpo) e S (dispositivos) são os que esta entrega tem mais chance
    de quebrar.
17. `README.md` e `ARCHITECTURE.md` descrevem cinco chaves em `wtk-meet:devices`, a §6.11 nova, e a
    limitação de §9 não afirma mais que não há controle de `noiseSuppression`.

---

## 9. Notas para os Agentes de Implementação

### 9.1 Divisão sugerida

Um único agente de desenvolvimento faz os passos 1–5 de §6: o DSP, a decisão de motor e o plumbing do
`Room` são um raciocínio só, e dividir custa retrabalho. Os passos 6 (E2E) e 7 (documentação) podem ir
para um segundo agente **depois** que o 5 estiver verde.

### 9.2 Pitfalls específicos desta demanda

- Os navegadores **já** ligam supressão por padrão; o toggle desligado precisa da constraint explícita —
  §3.2. É a armadilha conceitual da entrega inteira.
- Com o worklet ativo, **o track do mesh não é o track do `getUserMedia`**. Quatro pontos do `Room`
  dependem disso hoje, e os quatro falham em silêncio — a tabela de §3.4 é a lista de verificação.
- `process()` retornando `false` mata o áudio sem erro — §5.3.
- `AudioContext` suspenso produz um track `live` que só emite silêncio — §7.5.
- `ctx.resume()` sem gesto **fica pendente**, não rejeita — nunca fazer `await` dele no caminho de
  entrada.
- `AudioLevelMonitor.attach` é idempotente por (id, stream) (`audioLevels.js:207-209`): trocar o track
  dentro do mesmo `MediaStream` exige `detach` antes do `attach` — o `installAudioTrack` já faz isso
  (`Room.jsx:196-197`); não remover ao refatorar.
- `retainOnly` do `Room` (`Room.jsx:509`) detacha qualquer id que não seja peer — não registrar nada
  novo lá.
- A checagem **G** do E2E falha a suíte com qualquer erro de console; uma rejeição de `addModule` sem
  `catch` basta.

### 9.3 Ordem de validação após implementar

1. `npm --prefix client test` — o DSP primeiro, antes de qualquer integração.
2. `npm --prefix client run lint`.
3. `npm --prefix client run dev` — abrir o modal na Home, marcar e desmarcar; confirmar no console que o
   worklet **carrega** (é aqui que o `?url` de §3.6 é decidido).
4. `npm --prefix client run build` + `vite preview` — repetir o passo 3 no bundle. Os dois modos, sempre.
5. `node e2e/run.mjs` — a suíte inteira.
6. Conferência manual: entrar na sala **sem clicar em nada antes** (contexto suspenso, §7.5), falar, e
   confirmar que o outro lado ouve; sair da sala e confirmar que o indicador de microfone do sistema
   operacional apaga (§7.1).

> A receita de ambiente do E2E (libs em `/tmp/pwlibs`) está no fim de `claude-progress.md` e continua
> necessária a cada sessão nova.

### 9.4 Se houver folga (não fazer sem pedir)

Toggles de `echoCancellation` e `autoGainControl` no mesmo bloco do modal (o contrato de §5.1 já
comporta), e um seletor de intensidade (leve/médio/agressivo) mapeando para `gMin`. Ambos são baratos
sobre esta base e ambos estão **fora** do pedido — propor, não implementar por conta própria.
