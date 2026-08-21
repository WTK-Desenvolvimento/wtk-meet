# Renovar a credencial de TURN, recuperar conexões caídas e garantir a segunda rodada de negociação — Documento de Arquitetura Técnica

> Gerado em: 2026-08-21
> Status: Rascunho
> Task: WTK-MEET-18 — Renovar a credencial de TURN, recuperar conexões caídas e garantir a segunda rodada de negociação na entrada
> Autor: Arquiteto

---

## 0. Como ler este documento

A task é **investigativa**: quatro hipóteses derivadas de leitura de código, nenhuma reproduzida. Este
documento não trata as quatro como iguais. A leitura do código mudou o peso de três delas, e a mudança
é o conteúdo mais importante daqui:

| Hipótese | Veredito da análise estática | O que fazer |
|---|---|---|
| **H1(a)** cache de credencial sem TTL | **Mecanismo íntegro e compatível com o sintoma.** É a única cujo padrão de falha reproduz "intermitente, num participante específico, com o resto da sala normal". | Corrigir. Prioridade máxima. |
| **H1(b)** fallback STUN + HTTP 200 com lista vazia | **Real, mas não é este sintoma.** Config ausente derruba a sala **inteira**, não um par. É um buraco de observabilidade que hoje disfarça H1(a) de "problema do usuário". | Corrigir — é o instrumento que torna H1(a) diagnosticável. |
| **H2** nada se recupera | **Real, e é o mesmo bug que H1(a).** Ver §1.3: `restartIce()` sozinho **não consegue** consertar credencial vencida. Isto liga H1 e H2 num só defeito. | Corrigir. Prioridade máxima. |
| **H3** segunda rodada de negociação | **Provavelmente refutada como causa.** A própria spec faz a segunda rodada disparar sozinha, e o E2E A2 já prova que ela acontece. Ver §1.4. | Não "consertar": **verificar**. Entregar a verificação + retry como rede de segurança, e registrar a refutação. |
| **H4** `state` enviado uma vez | **Parcialmente refutada.** As duas ordens de chegada já estão tratadas e o `onopen` já reenvia o estado inteiro. A exposição residual existe, mas é a de um canal que abre depois de um percalço — ou seja, **é um sub-caso de H2**. Ver §1.5. | Corrigir junto de H2, com um mecanismo barato. Sem timer periódico. |

Regra do DoD respeitada: **hipótese refutada se documenta e se pula**. §8 traz critérios separados para
"o fix funciona" e para "a hipótese se confirmou", e §9.4 diz o que escrever no progresso em cada caso.

---

## 1. Contexto e Objetivo

### 1.1 Problema atual

O sintoma relatado é: *"às vezes, quando um usuário entra na sala, ele não escuta a gente ou não vê a
tela sendo compartilhada"* — intermitente, normalmente contra **um** participante, com o resto da sala
funcionando.

O produto não tem como distinguir "conectado" de "conectando" de "morto": o tile do participante é
montado a partir da lista de membros do servidor de sinalização (`Room.jsx`, evento `peer-joined` /
`join-approved`), não do estado da `RTCPeerConnection`. `onPeerStateChange` (`webrtcMesh.js:178`) hoje
**não tem consumidor nenhum no client** — é um callback que dispara no vazio (a task irmã está
adicionando o consumidor). Portanto: **toda falha de conexão neste produto é hoje, por construção,
silenciosa.**

### 1.2 A restrição que amplifica tudo: `relay`-only

`webrtcMesh.js:130` fixa `iceTransportPolicy: 'relay'`. É decisão de privacidade documentada
(`webrtcMesh.js:6` e `:18`, `ARCHITECTURE.md` §2 e §5): nenhum IP local vaza entre participantes. A
consequência operacional é que **o TURN não é fallback, é o caminho único**. Sem TURN válido, o
navegador não gera **nenhum** candidato — nem host, nem srflx. O próprio harness de E2E registra isso
(`e2e/harness.mjs:5-7`).

Isto está fora de discussão nesta entrega. **Não afrouxar a política.** O objetivo é tornar o TURN
*renovável* e *observável*, não opcional.

### 1.3 Achado principal: H1 e H2 são o mesmo defeito

Este é o achado que reorganiza a entrega, e ele não está na descrição da task.

O caminho da credencial hoje:

1. `Room.jsx:336-338` chama `fetchIceServers()` **uma vez**, no setup da sala.
2. `config.js:5,13` guarda `cachedIceServers` num módulo-singleton **sem TTL** — vale pela sessão
   inteira da aba.
3. O array resultante é passado ao construtor do mesh (`Room.jsx:454`) e guardado em `this.iceServers`.
4. `addPeer` (`webrtcMesh.js:128-131`) usa `this.iceServers` para **toda** `RTCPeerConnection` nova,
   para sempre.
5. A credencial da Cloudflare expira segundo `CF_TURN_TTL`, default **86400s / 24h**
   (`turnCredentials.js:11`).

Uma aba aberta desde ontem cria conexões novas com credencial vencida. As conexões antigas seguem de pé
(a alocação de relay já existe); as novas, não. A assimetria bate: quem tem a aba velha é o incumbente,
quem sofre é o entrante — e só contra aquele incumbente.

**E agora o elo que fecha o argumento.** `webrtcMesh.js:181-187` reage a `iceConnectionState ===
'failed'` chamando `pc.restartIce()`. Mas `restartIce()` **reusa a configuração da `RTCPeerConnection`,
que foi congelada no construtor**. Se a credencial venceu, o restart gera uma nova geração de ICE com
*exatamente a mesma credencial vencida* e falha de novo, igual. Não há segunda tentativa
(`restartIce()` só roda no primeiro `failed`, e só no lado impolite), não há log, não há UI.

Ou seja: **a única recuperação que existe é, precisamente, incapaz de recuperar o modo de falha mais
provável.** Corrigir H1 sem corrigir H2 deixa de pé todas as conexões já quebradas; corrigir H2 sem
corrigir H1 produz um retry que repete o mesmo erro em loop. A correção é uma só, e tem uma forma
obrigatória:

> **Recuperar = renovar as credenciais → `pc.setConfiguration(...)` → `pc.restartIce()`.** Nessa ordem.
> `restartIce()` sem `setConfiguration` é um no-op caro.

### 1.4 Sobre H3: por que provavelmente está refutada

A descrição está correta na mecânica: os dois lados chamam `addPeer` quase juntos, os dois criam quatro
transceivers `sendonly`, os dois disparam `onnegotiationneeded` → **glare em toda entrada**. E é verdade
que a *answer* só espelha as m-lines da *offer*, e que transceivers de `addTransceiver()` nunca são
pareados implicitamente com m-lines remotas (a spec só pareia os criados por `addTrack()`) — o próprio
`webrtcMesh.js:36-43` documenta isso. Logo quem perde o glare **fica mesmo com quatro `sendonly` sem
`mid`** depois da primeira rodada.

O que a descrição não considera: **a spec faz a segunda rodada disparar sozinha.** O algoritmo de
"negotiation-needed" do JSEP retorna verdadeiro justamente quando existe um transceiver não associado
(`mid === null`). Assim que o lado perdedor volta a `stable` depois de enviar a answer, o navegador
dispara `onnegotiationneeded` de novo, e o `_enqueue` já existente serializa a segunda offer. Não é
sorte — é comportamento especificado.

Evidência empírica no próprio repositório: a checagem **A2** do E2E (`e2e/run.mjs:268`) — *"cada conexão
tem 4 canais por sentido, na ordem mic, câmera, tela, música"* — passa consistentemente com 3
participantes. Se a segunda rodada não acontecesse, A2 falharia em ~metade das entradas.

**Conclusão:** H3 não explica o sintoma. O que sobra é uma fragilidade legítima: essa segunda rodada
**não tem verificação nem retry**, e se ela estourar, o `_enqueue` (`webrtcMesh.js:229-234`) engole com
um `console.error` e a metade da mídia daquele par some para sempre, em silêncio. Vale entregar a
verificação — mas como **rede de segurança**, não como correção de causa raiz, e sem inventar uma
renegociação onde o navegador já faz uma.

### 1.5 Sobre H4: o que já está certo e o que sobra

O que a descrição elogia é real e deve ser preservado: as duas ordens de chegada (`ontrack` antes do
`state`, e `state` antes do `ontrack`) estão tratadas — `_handleTrack` consulta `rec.remoteScreenOn`
(`webrtcMesh.js:290`) e `_handleChannelMessage` consulta `rec.hasScreenTrack` (`webrtcMesh.js:518`).

E o `channel.onopen` (`webrtcMesh.js:195-198`) não envia um delta: envia **o estado inteiro corrente**
(`{...this.localState}`) mais o snapshot musical. Quem entra no meio de um compartilhamento recebe
`screenOn: true` no primeiro frame do canal. O caso "entrei depois e não vi a tela" está coberto no
caminho feliz.

O que sobra, então:

- **O canal que nunca abre**, porque a conexão está no modo de falha do §1.3. Aqui não há mensagem
  perdida — há conexão morta. É H2.
- **O canal que abre e a conexão depois é reconstruída.** Se uma recuperação futura (a que vamos
  introduzir) trocar a configuração e reiniciar o ICE, o estado anunciado precisa ser reafirmado, ou o
  par volta com áudio e sem a tela.
- **Assimetria de conhecimento entre os dois lados**, se por qualquer motivo um dos dois `onopen` correr
  e o outro não.

Isso não pede um heartbeat. Pede **reafirmação em transições** e um **pedido explícito de estado**
(idempotente, O(1) por par, zero tráfego em regime). Ver D7.

### 1.6 Achados adicionais (não estavam na descrição)

- **`fetchCloudflareIceServers` não tem timeout.** `turnCredentials.js:15` faz `fetch` na Cloudflare sem
  `AbortSignal`. Uma API que aceita a conexão e não responde prende a requisição HTTP do client
  indefinidamente — e o client (`config.js:14-25`) fica esperando dentro do `Promise.all` do
  `Room.jsx:336`, ou seja, **a sala não entra**. Vale um timeout curto agora que essa chamada passa a
  ocorrer periodicamente, e não uma vez por sessão.
- **`CF_TURN_TTL` default de 24h contradiz a arquitetura.** `docs/architecture.md` §7 especifica
  *"credenciais efêmeras … TTL curto, ex. 1h"*. O default de 86400 é 24× isso, e é exatamente o que dá
  a H1(a) sua janela. Ver D9.
- **O `/health` não diz nada sobre o TURN.** Um deploy sem `CF_TURN_TOKEN_ID`/`CF_TURN_API_TOKEN`
  responde `{"ok":true}` alegremente enquanto nenhuma chamada da instância consegue conectar.
- **Deriva de documentação.** `README.md` §3 e `docs/architecture.md` §7 descrevem **coturn
  self-hosted com TURN REST API**; o código em produção usa a **Cloudflare TURN API**
  (`turnCredentials.js:1`). `ARCHITECTURE.md` (o documento vivo) já reflete a Cloudflare. Quem for
  debugar TURN em produção seguindo o README vai procurar um `turnserver.conf` que não está no caminho.

### 1.7 Comportamento esperado após a entrega

1. **A credencial se renova sozinha.** Uma aba aberta há dias cria conexões novas com credencial válida,
   sem recarregar a página.
2. **A ausência de TURN é ruidosa nas três pontas.** No servidor (log + status HTTP + `/health` +
   aviso no boot), na resposta HTTP (código de erro, nunca 200 com lista vazia) e no client (log de
   erro explícito e `onPeerStateChange(peerId, 'failed')`, que a task irmã transforma em UI).
3. **Uma conexão que cai tenta voltar** — com credencial nova, várias vezes, com backoff, e com o estado
   de câmera/tela reafirmado quando ela volta.
4. **A segunda rodada de negociação é verificada**, não assumida: se sobrar transceiver local sem `mid`
   depois da poeira baixar, uma nova rodada é disparada, com teto de tentativas.
5. **Nenhuma das correções altera a assinatura de construção do mesh nem exige mudança em
   `Room.jsx`.**

---

## 2. Escopo

### Dentro do escopo

**Servidor**
- `/turn-credentials` passa a informar a validade da credencial e a **distinguir por status HTTP** os
  três desfechos: obtida, não configurada, erro na Cloudflare.
- Timeout na chamada à Cloudflare.
- Validação e clamp de `CF_TURN_TTL`; mudança do default para 1h (D9).
- `/health` passa a reportar se o TURN está configurado (booleano, sem vazar segredo).
- Aviso no boot quando as variáveis de TURN estão ausentes.

**Client — provedor de ICE servers**
- Cache com **TTL derivado do que o servidor informa**, com margem de renovação, coalescência de
  requisições concorrentes e intervalo mínimo entre tentativas após falha.
- Fim do fallback para STUN público sob política `relay`.
- Um status legível de "por que não há TURN".

**Client — mesh (`webrtcMesh.js`)**
- Renovação da credencial **antes de cada `RTCPeerConnection` nova**, não só na primeira.
- Detecção de "a lista não tem nenhum TURN" com reporte explícito.
- Recuperação unificada: `connectionState` **e** `iceConnectionState`, `failed` **e** `disconnected`
  (com carência), com `setConfiguration` + `restartIce`, backoff e teto de tentativas.
- **Uma única fonte de offers**, com coalescência — recuperação e verificação nunca disparam offer
  concorrente para o mesmo par.
- Verificação pós-negociação de transceivers locais não associados, com retry limitado.
- Reafirmação do estado (`state`) em recuperação, mais um `state-request` idempotente.

**Testes e documentação**
- Testes unitários novos em `client/test/` e um alvo de teste novo em `server/test/` (hoje inexistente).
- Bloco **V** no E2E.
- `docs/progress/WTK-MEET-18.md` (arquivo novo).
- Atualização de `README.md` §3 e `ARCHITECTURE.md` (§6.1 e uma subseção nova **dentro** de §6).

### Fora do escopo

- **Qualquer edição em `client/src/pages/Room.jsx`** e nos componentes de mídia (`PeerAudio.jsx`,
  `RemoteMusicAudio.jsx`, `VideoTile.jsx`, `VideoGrid.jsx`) — são da task irmã, em outra worktree.
- **Qualquer UI nova.** O canal de saída para a interface é o `onPeerStateChange` que já existe. A task
  irmã constrói a UI.
- **Afrouxar `iceTransportPolicy: 'relay'`**, mesmo como modo degradado opcional.
- **Cache da credencial no servidor** (compartilhar uma credencial entre clientes) — ver D8, alternativa
  descartada.
- **Migrar de Cloudflare TURN para coturn** ou reconciliar a arquitetura alvo. O documento apenas
  **registra** a deriva (§1.6) e corrige o README no ponto onde ele engana quem for debugar.
- **Reconexão do socket de sinalização** e re-entrada na sala. Esta entrega recupera a `RTCPeerConnection`
  de um par que já está na sala; não trata o caso "o servidor de sinalização caiu".
- **Rate limiting / autenticação em `/turn-credentials`.** O endpoint fica mais chamado do que era
  (uma vez por TTL por aba, em vez de uma por sessão) — o volume continua desprezível para salas de 6.
  Registrado em §7 como risco aceito.
- **Métricas/telemetria remota.** Observabilidade aqui é log de servidor e `console` do navegador. O
  produto não envia telemetria (é decisão de privacidade em `ARCHITECTURE.md` §5) e esta entrega não
  abre exceção.

---

## 3. Decisões Arquiteturais

### D1 — O servidor devolve **duração** (`ttl`), e o client calcula o vencimento com o próprio relógio

- **Decisão:** a resposta de `/turn-credentials` inclui `ttl` (segundos, **autoritativo**) e `expiresAt`
  (ISO-8601, **informativo, para log humano**). O client deriva seu prazo de
  `<instante da resposta> + ttl`, e **ignora `expiresAt` para fins de decisão**.
- **Motivação:** o relógio do navegador não é confiável e não está sincronizado com o do servidor. Uma
  máquina com relógio adiantado em algumas horas trataria uma credencial recém-emitida como vencida
  (renovação em loop); atrasada, usaria credencial morta para sempre. Duração é imune a offset de
  relógio; instante absoluto não é. `expiresAt` fica na resposta porque é o que serve num log ou numa
  aba de rede aberta às 3h da manhã.
- **Alternativas descartadas:**
  - *Só `expiresAt`* — rejeitado pelo motivo acima.
  - *Client assume um TTL fixo em constante* — rejeitado: repete no client uma configuração que vive no
    servidor (`CF_TURN_TTL`), e as duas divergem no primeiro deploy que mexer numa e não na outra.
  - *Ler o `expires` de dentro do username do TURN (convenção `timestamp:user`)* — rejeitado: é a
    convenção do TURN REST API/coturn, não um contrato da Cloudflare, e depende de parsear credencial.

### D2 — Três desfechos, três status HTTP. Nunca 200 com lista vazia

- **Decisão:**

  | Desfecho | Status | Corpo |
  |---|---|---|
  | Credencial obtida | `200` | `{ iceServers, ttl, expiresAt }` |
  | Não configurado (`fetchCloudflareIceServers()` → `null`) | `503` | `{ error: 'turn-unconfigured', message }` |
  | Erro na Cloudflare (throw, `!res.ok`, timeout) | `502` | `{ error: 'turn-upstream', message }` |

  Os dois erros também emitem log de nível `error` no servidor.
- **Motivação:** hoje (`index.js:19-27`) **os três casos respondem `200 {"iceServers": []}`**. Um deploy
  sem as variáveis de ambiente é bit-a-bit indistinguível de uma sala saudável, tanto para o client
  quanto para qualquer probe externo. 503 (*"eu não estou pronto para servir isto"*) e 502 (*"o upstream
  me falhou"*) são exatamente os significados dos dois casos, e distinguem-se um do outro na aba de rede
  sem precisar de ninguém lendo log.
- **Alternativas descartadas:**
  - *Manter 200 com um campo `error` no corpo* — rejeitado: um 200 é "sucesso" para todo intermediário
    (proxy, CDN, health checker, `res.ok` do próprio client). O silêncio continua.
  - *500 para os dois* — rejeitado: apaga a distinção que interessa operacionalmente ("falta config"
    versus "a Cloudflare está fora"). São ações de resposta diferentes.
  - *404 para não-configurado* — rejeitado: o recurso existe, a capacidade é que não está provisionada.

### D3 — O fallback de STUN público **sai**. Sem TURN, a lista volta vazia e o motivo fica registrado

- **Decisão:** `config.js:26-27` deixa de devolver `[{ urls: 'stun:stun.cloudflare.com:3478' }]`. Em
  qualquer falha, o provedor devolve `[]` e expõe um `status` legível
  (`'ok' | 'unconfigured' | 'upstream' | 'unreachable' | 'stale'`).
- **Motivação:** sob `iceTransportPolicy: 'relay'`, um STUN puro gera **zero** candidatos utilizáveis.
  Não é resiliência degradada, é falha com aparência de sucesso — e pior que a falha crua, porque
  consome o orçamento de tempo do ICE antes de morrer, e porque um STUN de terceiro contradiz
  `ARCHITECTURE.md` §7 e `docs/architecture.md` §1 ("sem Google STUN público", "zero dependência de
  infraestrutura de terceiros"). Uma lista vazia falha mais rápido, falha sinceramente e não fala com
  ninguém de fora.
- **Alternativas descartadas:**
  - *Manter o STUN e marcar internamente como degradado* — rejeitado: mantém a chamada de rede a um
    terceiro sem nenhum ganho funcional possível sob `relay`.
  - *Lançar exceção em vez de devolver `[]`* — rejeitado, e este é o ponto de D4.

### D4 — `fetchIceServers()` **nunca lança**, porque `Room.jsx` está fora do alcance

- **Decisão:** o provedor de ICE servers resolve sempre — com a lista boa, ou com `[]` mais um status.
  Nunca rejeita a promise. Quem transforma isso em sinal visível é o **mesh**, via
  `onPeerStateChange(peerId, 'failed')` (D6).
- **Motivação:** `Room.jsx:336-338` chama `fetchIceServers()` dentro de um `Promise.all`, e o
  `setup().catch` do `Room.jsx` leva a fase para `PHASE.DENIED` **sem `denyReason`**. Uma rejeição aqui
  transformaria "o TURN está fora" em uma tela de acesso negado sem explicação — e a correção teria que
  ser feita em `Room.jsx`, que é da outra worktree. Devolver `[]` mantém o contrato de tipo intacto
  (`Room.jsx` só repassa o array ao construtor) e move o reporte para o canal que **é** meu e que **já**
  atravessa a fronteira: `onPeerStateChange`.
- **Alternativas descartadas:**
  - *Lançar e deixar a fase `DENIED` acontecer* — rejeitado pelo acima; além disso derruba a sala
    inteira por uma condição que pode ser transitória.
  - *Um callback novo tipo `onTurnStatus`* — rejeitado: exigiria `Room.jsx` passar o handler para
    virar visível, e `Room.jsx` não é meu.

### D5 — O mesh renova a credencial antes de **cada** `RTCPeerConnection`, por um provedor **injetável com default de módulo**

- **Decisão:** a lógica de cache/TTL sai de `config.js` para um módulo novo `client/src/lib/iceServers.js`,
  puro e sem `import.meta.env`. `config.js` continua exportando `fetchIceServers()` com a **assinatura e o
  tipo de retorno de hoje** (compat com `Room.jsx`), agora delegando para o módulo novo. O
  `webrtcMesh.js` importa a função do módulo irmão e a usa como **default** de uma opção de construtor
  nova e **opcional** (`getIceServers`), que só os testes passam.
  - `this.iceServers` (o array vindo do `Room.jsx`) deixa de ser a fonte e vira **semente / último valor
    conhecido**: é o que se usa se a renovação falhar mas ainda houver credencial dentro da validade.
- **Motivação:** três requisitos que só fecham juntos.
  1. *Renovar antes de cada PC nova* exige que o mesh alcance o fetcher — o array que o `Room.jsx`
     passou é, por definição, velho.
  2. *Não mudar a assinatura de construção* (fronteira de arquivos) exige que a novidade tenha default.
  3. *Ser testável* exige poder injetar um dublê de relógio e de `fetch` sem subir Vite: por isso o
     módulo novo não pode tocar `import.meta.env`, e por isso `config.js` (que toca) fica como camada
     fina por cima.
- **Alternativas descartadas:**
  - *`webrtcMesh.js` importar `config.js` diretamente* — rejeitado: inverte a camada (o `lib/` passaria a
    depender da configuração da app) e arrasta `import.meta.env` para dentro dos testes unitários do
    mesh, que hoje rodam em `node --test` puro.
  - *Aceitar `iceServers` como função no construtor* — rejeitado: `Room.jsx` continuaria passando um
    array, então na prática nunca renovaria. Resolve o tipo, não o problema.
  - *Um singleton global configurado por efeito colateral no load de `config.js`* — rejeitado: torna o
    mesh instubável e faz a ordem de import virar comportamento.

### D6 — "Sem TURN" é reportado imediatamente como `'failed'`, sem esperar o timeout do ICE

- **Decisão:** ao montar uma `RTCPeerConnection`, se a lista de ICE servers não contiver **nenhuma** URL
  `turn:`/`turns:`, o mesh emite um `console.error` com o status do provedor e chama
  `this.onPeerStateChange?.(peerId, 'failed')` — sem deixar de criar a conexão nem de seguir o fluxo
  normal.
- **Motivação:** sob `relay` sem TURN o desfecho é **determinístico**: nenhum candidato, nenhuma conexão.
  Esperar o ICE estourar sozinho custa dezenas de segundos de tile mudo antes de o produto admitir o
  óbvio. `'failed'` é um valor legítimo de `RTCPeerConnectionState`, então a **assinatura
  `(peerId, connectionState)` permanece exatamente a de hoje** — a task irmã não precisa saber que esta
  entrega existe. A conexão continua sendo criada porque, se a credencial voltar, a recuperação (D10)
  a resgata sem precisar reconstruir nada.
- **Alternativas descartadas:**
  - *Não criar a PC e abortar `addPeer`* — rejeitado: o par sumiria do `this.peers`, `handleSignal`
    recriaria do zero a cada sinal, e não haveria objeto para recuperar depois.
  - *Um estado novo tipo `'no-turn'`* — rejeitado: quebra o contrato com a outra worktree, que é
    justamente o que não se pode fazer.

### D7 — Reafirmar estado em transição, com `state-request`. **Sem heartbeat periódico**

- **Decisão:** duas adições ao protocolo do data channel, ambas idempotentes:
  1. No `channel.onopen`, além de enviar o próprio estado (como hoje), enviar também
     `{ type: 'state-request' }`. Quem recebe `state-request` responde com o `state` corrente e o
     snapshot musical — exatamente o mesmo par de mensagens do `onopen`.
  2. Quando uma recuperação (D10) termina com o par de volta em `connected`, reenviar `state` +
     snapshot para aquele par (só para ele).
  Coalescência: `state-request` recebido mais de uma vez dentro de uma janela curta responde uma vez só.
- **Motivação:** o `onopen` já manda o estado inteiro (§1.5), então o buraco não é "faltou reenviar
  periodicamente" — é "faltou reafirmar quando algo se reconstrói". `state-request` fecha a assimetria
  entre os dois lados com **uma** mensagem por par, no momento em que o canal abre; a reafirmação
  pós-recuperação fecha o caso do canal que sobreviveu a um restart. Nos dois casos o tráfego em regime
  permanente é **zero**.
- **Alternativas descartadas:**
  - *Reenvio periódico do `state` (ex. a cada 10s)* — rejeitado: numa sala de 6 são 5 mensagens por
    aba a cada intervalo, para sempre, para corrigir um evento que acontece em transições discretas e
    observáveis. Custo permanente para um problema pontual, e ainda por cima com latência de até um
    intervalo inteiro.
  - *Deduzir o estado da chegada da track de tela* — rejeitado: o transceiver de tela existe desde a
    negociação inicial e chega **vazio**; é justamente por isso que o `state` existe
    (`webrtcMesh.js:286-290`). Deduzir traria de volta o bug que esse desenho já resolveu.

### D8 — Sem cache de credencial no servidor

- **Decisão:** cada `GET /turn-credentials` gera uma credencial nova na Cloudflare.
- **Motivação:** o volume é desprezível — uma aba pede uma vez por TTL (1h, após D9), e a sala tem no
  máximo 6 pessoas. Cachear no servidor faria todos os clientes compartilharem **um** instante de
  expiração, transformando a renovação escalonada de hoje num efeito manada em que a sala inteira
  renova (ou falha) junto. O custo de simplicidade não se paga.
- **Alternativas descartadas:** *cache com jitter por cliente* — complexidade real para economizar
  chamadas que não são um problema. Fica registrado como o caminho a seguir **se** o volume mudar.

### D9 — `CF_TURN_TTL` passa a ter default de **3600s (1h)**, validado e com clamp

- **Decisão:** default 3600; valor vindo do ambiente é rejeitado se não for finito ou ≤ 0, e é fixado na
  faixa **[600, 86400]** com aviso em log quando sofre clamp.
- **Motivação:** `docs/architecture.md` §7 já especifica *"TTL curto, ex. 1h"* — o default de 24h nunca
  esteve alinhado. TTL menor encurta a janela de credencial morta e o raio de dano de um vazamento;
  agora que o client renova sozinho, TTL curto não custa nada em usabilidade. O piso de 600s existe
  porque abaixo disso a renovação começa a competir com a duração de uma negociação; o teto preserva o
  máximo da Cloudflare.
- **Alternativas descartadas:** *manter 86400* — mantém a janela de 24h que é o núcleo de H1(a).
- **⚠ Mudança de comportamento para deploys existentes:** quem depende do default passa de 24h para 1h.
  Não quebra nada (o client renova), mas **precisa constar no `README.md` e na nota do PR**. Se a
  operação preferir manter 86400, é uma linha de `.env` — e a decisão é do Nicolas, não do agente de
  implementação.

### D10 — Uma recuperação, um gatilho, uma fila. Recuperar = renovar → reconfigurar → reiniciar

- **Decisão:** substituir o handler de `iceConnectionState` de hoje por **um único ponto de entrada**
  `_scheduleRecovery(rec, motivo)`, alimentado por:
  - `connectionState ∈ {'failed'}` → imediato;
  - `connectionState ∈ {'disconnected'}` → após carência (**5s**), cancelada se voltar antes;
  - `iceConnectionState ∈ {'failed'}` → imediato;
  - `iceConnectionState ∈ {'disconnected'}` → mesma carência, **mesmo timer**.

  Um único `rec.recoveryTimer` e um único `rec.recovering` desduplicam os quatro gatilhos. O corpo da
  recuperação, sempre dentro do `_enqueue` do par:
  1. renovar ICE servers (`force`, respeitando o intervalo mínimo entre tentativas);
  2. se não houver TURN → logar, reportar `'failed'` (D6) e **reagendar com backoff**, sem reiniciar
     nada (reiniciar sem credencial é o no-op do §1.3);
  3. `pc.setConfiguration({ iceServers: <novos>, iceTransportPolicy: 'relay' })` — **em ambos os lados**;
  4. **só no impolite:** `pc.restartIce()`;
  5. reagendar uma reavaliação com backoff; ao ver `connectionState === 'connected'`, zerar o contador
     de tentativas e reafirmar o estado (D7).

  **Backoff:** tentativas 1..5 em 2s, 4s, 8s, 16s, 30s. Esgotado o teto, um `console.error` final e
  parar — a conexão permanece reportada como `'failed'`, que é a verdade.

  **Válvula do lado polite:** se o polite continuar em `failed` depois de **15s** (isto é, o impolite
  não voltou — aba fechada, processo suspenso), o polite também executa o passo 4. O perfect negotiation
  existente resolve a colisão se os dois agirem.
- **Motivação:** o passo 3 é a razão de ser desta decisão (§1.3): sem ele, todo o resto é decorativo.
  `disconnected` entra com carência porque é frequentemente transitório (troca de rede, Wi-Fi oscilando)
  e reiniciar o ICE em cima de uma recuperação natural é pura perda. Um único timer e um único flag são o
  que impede que quatro gatilhos virem quatro recuperações concorrentes para o mesmo par.
- **Alternativas descartadas:**
  - *Manter só `iceConnectionState`* — rejeitado: `connectionState` agrega o DTLS e é o estado que a UI
    da task irmã vai mostrar; divergir dele é reportar uma coisa e agir sobre outra.
  - *Recriar a `RTCPeerConnection` do zero* — rejeitado como primeira linha: descarta o data channel
    (com o histórico de chat na tela), força negociação completa e reintroduz o glare de entrada. Fica
    registrado como escalonamento futuro, **depois** de o ICE restart esgotar o teto.
  - *Restart nos dois lados desde o início* — rejeitado: dobra as offers em toda queda de rede, que é
    exatamente o cenário em que menos se quer tráfego de sinalização. Daí a válvula com atraso.

### D11 — Todas as offers passam por `_negotiate`, e **só o navegador decide quando** — a verificação apenas confere

- **Decisão:** extrair o corpo do `onnegotiationneeded` de hoje (`webrtcMesh.js:161-173`) para
  `_negotiate(rec)`, com duas guardas de entrada: sai imediatamente se `pc.signalingState !== 'stable'`
  ou se a PC estiver fechada. Ela é chamada de **exatamente dois** lugares, sempre via `_enqueue`:
  1. `onnegotiationneeded` (o caminho normal e o único caminho da recuperação — `restartIce()` faz o
     navegador disparar o evento; a recuperação **nunca** cria offer diretamente);
  2. `_verifyNegotiation(rec)`, e **somente** se sobrar transceiver **nosso** com `mid === null`.

  `_verifyNegotiation` é agendada quando o par volta a `stable`, com atraso de acomodação (**750ms**),
  no máximo **3 vezes** por par, com espaçamento crescente (750ms, 2s, 5s). Se ao rodar não houver
  transceiver sem `mid`, ela não faz nada e não reagenda. Uma flag `rec.negotiationQueued` coalesce
  pedidos redundantes enfileirados.
- **Motivação:** é a resposta direta à nota *"uma só fonte de renegociação"* da task. Os dois novos
  comportamentos (recuperação e verificação) são **vizinhos textuais** do handler de hoje, e um merge
  descuidado produz tempestade de renegociação. Fazendo a recuperação disparar offer **só
  indiretamente** (via `restartIce` → `negotiationneeded`) e a verificação disparar **só quando há
  evidência de que falta associar m-line**, o caso das duas condições simultâneas colapsa
  naturalmente numa única offer serializada pela fila que já existe. Além disso, como o vencedor do
  glare **nunca** tem transceiver sem `mid`, a verificação é auto-limitante por construção: só o
  perdedor renegocia, o que é exatamente o comportamento correto.
- **Alternativas descartadas:**
  - *A verificação chamar `setLocalDescription()` incondicionalmente após a primeira rodada* —
    rejeitado: dobraria a negociação em toda entrada, inclusive quando a segunda rodada automática da
    spec já resolveu.
  - *A recuperação chamar `_negotiate` direto depois do `restartIce()`* — rejeitado: são duas offers
    para o mesmo restart.
  - *Usar `currentDirection === null` como sinal* — aceitável, mas `mid === null` é o critério exato de
    "não associado" e é o mesmo que o algoritmo de negotiation-needed da spec usa. Um só critério,
    escrito uma vez.

### D12 — `addPeer` reserva o par **antes** de esperar por rede

- **Decisão:** `addPeer` ganha um mapa de em-voo (`peerId → Promise`). Chamadas concorrentes para o
  mesmo `peerId` recebem **a mesma promise**, não uma segunda conexão. Após o `await` da renovação, e
  antes de qualquer efeito, reconferir `this.closed` e se o par foi removido enquanto se esperava —
  nesses casos, fechar a PC recém-criada e sair sem registrar nada.
- **Motivação:** hoje `addPeer` é síncrona entre a guarda `if (this.peers.has(peerId)) return` e o
  `this.peers.set(peerId, rec)` — não há janela de reentrância. **Introduzir um `await` de rede antes
  do `set` abre essa janela**, e ela é atingida no cenário mais comum que existe: `Room.jsx` chama
  `addPeer` no `peer-joined` enquanto o primeiro sinal daquele mesmo par já está chegando e
  `handleSignal` (`webrtcMesh.js:307-309`) chama `addPeer` também. Duas PCs para o mesmo par, uma
  órfã sem nenhuma referência — vazamento de conexão, de transceivers e de tracks, sem sintoma
  imediato. É a armadilha mais séria desta entrega. Ver R1.
- **Alternativas descartadas:**
  - *Renovar a credencial fora do `addPeer`, antes* — não resolve: o `await` teria que estar em algum
    lugar, e no `Room.jsx` não pode.
  - *Só um `Set` de "em construção" e sair cedo* — rejeitado: `handleSignal` faz
    `await this.addPeer(peerId)` contando que, ao retornar, o par existe. Sair cedo sem promise
    devolveria o controle antes da hora e o sinal cairia no chão.

---

## 4. Componentes Afetados

### Servidor

| Arquivo | O que muda | Por quê |
|---|---|---|
| `server/src/turnCredentials.js` | Passa a devolver `{ iceServers, ttl, expiresAt }` em vez de um array cru. Valida/clampa `CF_TURN_TTL` com default 3600. Timeout na chamada à Cloudflare. Exporta um `isTurnConfigured()` (só lê presença das duas variáveis, nunca o valor). Continua devolvendo `null` para "não configurado" e continua lançando para erro de upstream — o contrato de sinalização de erro **não muda**, só o formato do sucesso. | D1, D9, §1.6 |
| `server/src/index.js` | `/turn-credentials` mapeia os três desfechos para 200/503/502 com log de erro nos dois últimos (D2). `/health` passa a devolver `{ ok: true, turn: { configured } }`. Aviso `console.warn` no boot quando as variáveis de TURN estão ausentes. | D2, §1.6 |

### Client

| Arquivo | O que muda | Por quê |
|---|---|---|
| `client/src/lib/iceServers.js` **(novo)** | Provedor com cache por TTL, margem de renovação, coalescência de requisições em voo, intervalo mínimo entre tentativas após falha, e um `status` legível. Sem `import.meta.env`, sem DOM — `fetch` e relógio injetáveis, no mesmo espírito de `lib/devices.js` e `lib/gridLayout.js`. Também exporta o utilitário que responde "esta lista tem algum TURN?". | D1, D3, D5 |
| `client/src/config.js` | `fetchIceServers()` mantém **exatamente** a assinatura e o tipo de retorno de hoje (`Promise<Array>`, nunca lança) e passa a delegar ao provedor, injetando o endpoint derivado de `SIGNALING_URL`. Some o `cachedIceServers` local e some o fallback de STUN público. | D3, D4, D5 |
| `client/src/lib/webrtcMesh.js` | **Único arquivo grande.** (a) opção de construtor opcional `getIceServers` com default de módulo; (b) `addPeer` com reserva de par e renovação por conexão (D12, D5); (c) detecção de "sem TURN" com reporte `'failed'` (D6); (d) `_scheduleRecovery` unificado substituindo o handler atual de `iceConnectionState` (D10); (e) `_negotiate` extraída e `_verifyNegotiation` (D11); (f) `state-request` e reafirmação pós-recuperação (D7); (g) limpeza de **todos** os timers em `removePeer`/`closeAll`. | Todo o documento |

`client/src/pages/Room.jsx` **não muda.** É o teste ácido do desenho: se algum passo exigir mexer nele,
**pare e registre em `docs/progress/WTK-MEET-18.md`** — não edite.

### Testes

| Arquivo | O que muda |
|---|---|
| `client/test/iceServers.test.mjs` **(novo)** | O provedor isolado, com relógio e `fetch` dublês. |
| `client/test/meshRecovery.test.mjs` **(novo)** | Recuperação, verificação de negociação e reserva de par, sobre o dublê de `RTCPeerConnection` do padrão de `musicMeshRouting.test.mjs`. |
| `client/test/meshPeerState.test.mjs` **(novo, ou fundido no anterior)** | `state-request` e reafirmação pós-recuperação. |
| `server/test/turnCredentials.test.mjs` **(novo — o diretório não existe)** | Clamp de TTL, formato da resposta, `null` versus throw, timeout. |
| `server/package.json` | Ganha `"test": "node --test \"test/*.test.mjs\""`, espelhando `client/package.json`. Nenhuma dependência nova. |
| `e2e/harness.mjs` | Uma mudança **aditiva e mínima**: o mock de `/turn-credentials` passa a incluir `ttl`, e `openParticipant` aceita uma opção para variar a resposta daquele participante (200 normal / 503 / 200 com TTL curtíssimo). Ver R7 sobre conflito de merge. |
| `e2e/run.mjs` | **Bloco V**, e só ele. Ver §8.3. |

### Documentação

| Arquivo | O que muda |
|---|---|
| `docs/progress/WTK-MEET-18.md` **(novo)** | O progresso desta task. **Nada em `claude-progress.md`.** |
| `ARCHITECTURE.md` | §6.1 (existente, "Layout de transceivers e renegociação"): substituir o parágrafo sobre `restartIce()` (linhas ~190-197) pela política de recuperação e pela verificação da segunda rodada. Mais uma subseção **dentro** de §6 (§6.12, "Ciclo de vida da credencial de TURN") — subseção nova dentro de seção existente, não seção nova no fim do arquivo. |
| `README.md` | §3 (existente, "STUN/TURN") — documentar `CF_TURN_TOKEN_ID`/`CF_TURN_API_TOKEN`/`CF_TURN_TTL` (com o novo default), os três status de `/turn-credentials`, o campo `turn` do `/health`, e uma nota de que a seção descrevia coturn enquanto o código usa Cloudflare (§1.6). §"Testes" — mencionar `npm test` no `server/`. |

---

## 5. Contratos de Interface

### 5.1 Endpoints REST

| Método | Path | Request | Response | Observações |
|---|---|---|---|---|
| GET | `/turn-credentials` | — | **200** `{ iceServers: RTCIceServer[], ttl: number, expiresAt: string }` | `ttl` em segundos, autoritativo. `expiresAt` ISO-8601, informativo (D1). `iceServers` no formato pronto para `RTCPeerConnection`, como hoje. |
| | | | **503** `{ error: 'turn-unconfigured', message: string }` | `CF_TURN_TOKEN_ID` e/ou `CF_TURN_API_TOKEN` ausentes. `message` **nunca** contém valor de segredo. Log `error` no servidor. |
| | | | **502** `{ error: 'turn-upstream', message: string }` | Cloudflare respondeu não-OK, lançou, ou estourou o timeout. Log `error` no servidor. |
| GET | `/health` | — | **200** `{ ok: true, turn: { configured: boolean } }` | Campo **aditivo**: `ok` continua onde estava, quem só lê `ok` não quebra. Booleano puro — não diz qual token, não valida credencial, não chama a Cloudflare. |

**Compatibilidade:** o client novo lê `ttl`; o client velho (bundle em cache numa aba antiga) ignora
campos extras e continua funcionando no caminho 200. No caminho de erro, o client velho cai no seu
próprio fallback de STUN — que já não conectava mesmo. Nenhuma regressão.

### 5.2 Mensagens do data channel

| Tipo | Payload | Quem emite | Quem consome | Quando |
|---|---|---|---|---|
| `state` *(existente, inalterado)* | `{ type, displayName, cameraOff, micOff, screenOn }` | qualquer par | o par oposto (`_handleChannelMessage`) | **hoje:** `channel.onopen` e todo `setLocalState`. **novo, aditivo:** em resposta a `state-request`, e após uma recuperação bem-sucedida (D7). |
| `state-request` **(novo)** | `{ type: 'state-request' }` | qualquer par, no seu `channel.onopen` | o par oposto | responde com `state` + snapshot musical, coalescido por janela curta. Ignorado silenciosamente por par que não conheça o tipo. |

**Regra de compatibilidade obrigatória:** `parseChannelPayload` + o `if/else` de
`_handleChannelMessage` (`webrtcMesh.js:491-519`) já ignoram tipos desconhecidos. Um par com o bundle
antigo recebe `state-request`, não reconhece e **não responde** — o comportamento degrada exatamente
para o de hoje (só o `onopen`). Nada de versionamento de protocolo, nada de negociação de capacidade.

### 5.3 Callbacks do mesh

| Callback | Assinatura | Muda? |
|---|---|---|
| `onPeerStateChange` | `(peerId: string, connectionState: RTCPeerConnectionState)` | **NÃO.** Congelada por contrato com a task irmã. Passa a ser chamada em mais situações (D6), sempre com um valor legítimo do enum. |
| `onRemotePeerState`, `onRemoteStream`, `onRemoteScreen`, `onRemoteMusic`, `onChatMessage`, `onMusicMessage`, `onRemoteStreamClosed`, `getMusicSnapshot` | — | **NÃO.** Nenhuma. |
| `getIceServers` **(novo)** | `(opts?) => Promise<Array>` | **Opcional**, com default de módulo. `Room.jsx` não passa e não precisa saber que existe (D5). |

### 5.4 Configuração (variáveis de ambiente)

| Variável | Tipo | Default | Observações |
|---|---|---|---|
| `CF_TURN_TOKEN_ID` | string | — | Sem ela, `/turn-credentials` → 503 e `/health` → `turn.configured: false`. |
| `CF_TURN_API_TOKEN` | string | — | Idem. Nunca aparece em log nem em resposta. |
| `CF_TURN_TTL` | inteiro (s) | **3600** *(era 86400)* | Clamp em [600, 86400], com aviso em log quando aplicado (D9). |
| `CF_TURN_TIMEOUT_MS` | inteiro (ms) | **5000** | Novo. Timeout da chamada à Cloudflare (§1.6). |

### 5.5 Schema de banco

Não se aplica — o produto não tem persistência (`ARCHITECTURE.md` §5).

---

## 6. Dependências e Ordem de Implementação

A ordem é **de fora para dentro**: o servidor primeiro, porque é ele que define o `ttl` de que o client
depende; o `webrtcMesh.js` por último e em passos pequenos, porque é o arquivo com risco de regressão.

1. **Servidor — `turnCredentials.js`** (sem dependências)
   Formato de retorno, validação/clamp de TTL, timeout, `isTurnConfigured()`.
2. **Servidor — `index.js`** *(depende de 1)*
   Mapeamento 200/503/502, campo `turn` no `/health`, aviso de boot.
3. **`server/test/turnCredentials.test.mjs` + script `test` no `server/package.json`** *(depende de 1)*
   — **pode rodar em paralelo com 2.**
4. **Client — `lib/iceServers.js`** *(depende do contrato de 1, não do código)* — **pode rodar em
   paralelo com 2 e 3**, contra o contrato de §5.1.
5. **`client/test/iceServers.test.mjs`** *(depende de 4)*
6. **Client — `config.js`** *(depende de 4)*
   Delegar, remover o STUN, preservar a assinatura de hoje. **Checkpoint:** `npm run build` no client e
   `npm run lint` limpos; nada em `Room.jsx`.
7. **`webrtcMesh.js` — passo A: `addPeer`** *(depende de 4 e 6)*
   Opção `getIceServers` com default, **reserva de par (D12 — faça isto no mesmo passo, nunca depois)**,
   renovação por conexão, detecção de "sem TURN" (D6).
8. **`webrtcMesh.js` — passo B: extrair `_negotiate`** *(depende de 7)*
   **Refactor puro, sem mudança de comportamento.** Commit isolado — é o que permite revisar os passos
   C e D como diff pequeno.
9. **`webrtcMesh.js` — passo C: `_scheduleRecovery`** *(depende de 8)*
   Gatilho único, carência, `setConfiguration` + `restartIce`, backoff, teto, válvula do polite,
   limpeza de timers em `removePeer`/`closeAll`.
10. **`webrtcMesh.js` — passo D: `_verifyNegotiation`** *(depende de 8; **e de 9**, para exercitar o
    caso das duas condições simultâneas)*
11. **`webrtcMesh.js` — passo E: `state-request` + reafirmação pós-recuperação** *(depende de 9)*
12. **`client/test/meshRecovery.test.mjs` (+ estado)** *(depende de 7-11)*
    Inclui **obrigatoriamente** o teste de recuperação e verificação disparando juntas (§8.2, U-nada:
    é o critério A16).
13. **E2E — harness + bloco V** *(depende de tudo)*
14. **Documentação** *(depende de tudo)* — `docs/progress/WTK-MEET-18.md`, `ARCHITECTURE.md` §6.1 e
    §6.12, `README.md` §3 e §Testes.

**Commite cedo e por passo.** O worktree desta sessão é efêmero, e os passos 7-11 são o tipo de edição
que um snapshot automático no meio publica quebrada.

---

## 7. Riscos e Armadilhas

### R1 — `addPeer` reentrante cria duas `RTCPeerConnection` para o mesmo par ⚠ **o mais grave**

- **Risco:** o `await` da renovação de credencial fica **antes** de `this.peers.set(peerId, rec)`. Duas
  chamadas concorrentes (`Room.jsx` no `peer-joined` + `handleSignal` no primeiro sinal) passam as duas
  pela guarda `this.peers.has(peerId)` e criam duas conexões. A segunda sobrescreve o mapa; a primeira
  fica órfã — PC viva, transceivers vivos, tracks vivas, sem nenhuma referência que permita fechá-la.
  `removePeer` fecha uma só. O sintoma é **exatamente o que esta task investiga**: mídia que não chega,
  intermitentemente, num par específico. Introduzir isto enquanto se corrige aquilo seria irônico e
  difícil de perceber.
- **Mitigação:** D12 — mapa de em-voo devolvendo a mesma promise; após o `await`, reconferir `closed`
  e remoção pendente e desmontar a PC nascida tarde. Teste unitário obrigatório: duas chamadas
  concorrentes de `addPeer` com o mesmo id → **exatamente uma** construção de `RTCPeerConnection`.
- **Anti-pattern:** confiar na guarda de entrada porque "ela já estava lá". Ela funcionava porque o
  caminho até o `set` era síncrono. O `await` é o que a invalida.

### R2 — Tempestade de renegociação quando recuperação e verificação coincidem

- **Risco:** os handlers são vizinhos (`webrtcMesh.js:176-187`) e os dois novos comportamentos disparam
  no mesmo instante — uma conexão que falhou e recuperou volta a `stable` com transceivers possivelmente
  não associados. Duas offers concorrentes para o mesmo par, glare artificial, e — no pior caso — um
  laço em que cada recuperação gera uma verificação que gera uma offer que falha e gera outra
  recuperação.
- **Mitigação:** D11 é o desenho inteiro para isto. A recuperação **nunca** cria offer diretamente
  (só `restartIce()`, e o navegador dispara o evento); a verificação **só** age com evidência
  (`mid === null`); tudo passa pelo `_enqueue` que já existe; `_negotiate` sai cedo fora de `stable`;
  a verificação tem teto de 3.
- **Anti-pattern:** "vou chamar `setLocalDescription()` depois do `restartIce()` para garantir". São
  duas offers para o mesmo restart, e a segunda chega quando a primeira ainda está no ar.

### R3 — Timer sobrevivendo ao `removePeer` e ressuscitando trabalho numa PC fechada

- **Risco:** esta entrega introduz até três timers por par (carência de `disconnected`, backoff de
  recuperação, acomodação da verificação). `removePeer` (`webrtcMesh.js:524-550`) hoje limpa handlers e
  fecha a PC, mas não conhece timer nenhum. Um timer que dispara depois vai mexer numa PC fechada, e a
  recuperação pode até chamar `addPeer` de volta para alguém que **saiu da sala** — um par fantasma,
  ressuscitado por um `setTimeout`.
- **Mitigação:** guardar todos os timers no `rec`; limpar **todos** em `removePeer` e em `closeAll`;
  toda continuação assíncrona reconfere `this.closed` e `this.peers.has(rec.peerId)` **depois** do
  await, não só antes. Teste unitário: `removePeer` durante uma recuperação pendente não produz efeito
  posterior nenhum.
- **Anti-pattern:** limpar só o timer "principal" e deixar o de backoff, que é o de vida mais longa
  (até 30s) e o mais provável de sobreviver a uma saída de sala.

### R4 — Renovar a credencial dentro do `addPeer` atrasa toda entrada

- **Risco:** `addPeer` passa a esperar rede. Numa sala de 6, o entrante chama `addPeer` cinco vezes
  quase juntas; sem coalescência são cinco requisições HTTP, e com o servidor lento a entrada trava.
  Pior: `handleSignal` faz `await this.addPeer(peerId)` antes de tratar o sinal — um fetch lento
  **enfileira sinalização**.
- **Mitigação:** coalescência de requisições em voo no provedor (uma promise compartilhada), cache
  quente no caminho normal (o `Room.jsx` já aqueceu no setup, então a renovação em `addPeer` é
  sincronicamente resolvida em ~100% das entradas), e o timeout de §5.4 limitando o pior caso.
- **Anti-pattern:** "não tem problema, é rápido" — o caminho lento é justamente o do servidor com
  problema, que é o cenário que esta task existe para tratar.

### R5 — 503/502 quebrando algum consumidor que hoje conta com 200

- **Risco:** `res.ok` no client velho vira falso e ele cai no fallback de STUN.
- **Mitigação:** aceito e desejado. O client velho já não conectava nesse caso (STUN sob `relay` não
  gera candidato — §1.2); a diferença é que agora falha rápido em vez de devagar. Não há outro
  consumidor: `grep` por `/turn-credentials` acha apenas `config.js`, `index.js`, o `harness.mjs` e a
  lista de CSP do `README.md`.
- **Anti-pattern:** manter 200 "por compatibilidade". É a compatibilidade com o bug.

### R6 — Reafirmação de estado virando amplificação em sala cheia

- **Risco:** um `state-request` que responde a cada `state` recebido, ou uma reafirmação que dispara em
  cada transição de `connectionState`, produz N² mensagens numa sala que oscila.
- **Mitigação:** D7 — `state-request` **só** no `onopen` (uma vez por par, por canal), resposta
  coalescida por janela curta, e reafirmação só na borda de subida de uma recuperação **daquele par**
  (`broadcast` não; `_send(rec, ...)` sim). Nada de timer periódico.
- **Anti-pattern:** responder `state-request` com `broadcast`. É a diferença entre 1 e N mensagens, e
  o erro é fácil de cometer porque `setLocalState` (`webrtcMesh.js:104-107`) usa `broadcast` e serve de
  modelo visual.

### R7 — Conflito de merge no E2E com a task irmã

- **Risco:** `e2e/run.mjs` e `e2e/harness.mjs` são os únicos arquivos que as duas worktrees tocam. A
  task irmã usa a letra **U**.
- **Mitigação:** bloco **V** e nada além dele em `run.mjs`; em `harness.mjs`, mudanças estritamente
  aditivas (um campo no corpo do mock, um parâmetro opcional em `openParticipant` com default que
  preserva o comportamento atual) e **nenhuma** alteração em helper compartilhado. Em `README.md` e
  `ARCHITECTURE.md`, editar a seção existente do assunto, nunca acrescentar seção no fim.
- **Anti-pattern:** refatorar `openParticipant` "de passagem". Um helper reformatado conflita com
  qualquer diff da outra worktree.

### R8 — Confundir "a hipótese estava certa" com "o teste passou"

- **Risco:** os quatro fixes vão passar em teste independentemente de qual hipótese era a verdadeira.
  Declarar as quatro confirmadas porque a suíte ficou verde é o modo mais fácil de encerrar esta task
  errado.
- **Mitigação:** §8 separa os critérios; §9.4 define o que registrar. O DoD é explícito: **hipótese
  refutada se documenta e se pula.** H3 e H4 já entram com refutação parcial argumentada (§1.4, §1.5) —
  o agente de implementação deve **verificar essa refutação**, não herdá-la de mim.
- **Anti-pattern:** apagar do progresso a hipótese que não se sustentou. O valor de uma task
  investigativa está tanto no que se eliminou quanto no que se corrigiu.

### R9 — Mexer no `iceTransportPolicy` "só para testar"

- **Risco:** durante a investigação é tentador trocar para `'all'` e ver se conecta. Se isso vazar para
  um commit, o produto passa a expor IP local entre participantes — regressão de privacidade,
  invisível em qualquer teste funcional, contra decisão documentada (`webrtcMesh.js:6`, `:18`,
  `ARCHITECTURE.md` §2 e §5).
- **Mitigação:** não fazer. Se for indispensável para diagnóstico local, fazer fora de commit e
  registrar no progresso que foi feito e revertido. O bloco V deve incluir uma checagem que **afirma**
  `iceTransportPolicy === 'relay'` em toda PC (via `getConfiguration()` sobre `window.__wtkPeers`),
  para que uma reversão esquecida quebre o E2E.
- **Anti-pattern:** um flag de ambiente para relaxar a política. Vira default em algum deploy.

### R10 — `setConfiguration` rejeitando por mudança não permitida

- **Risco:** a spec permite alterar `iceServers` em `setConfiguration`, mas **proíbe** alterar alguns
  campos depois de a PC ter conexão (notadamente `bundlePolicy` e `rtcpMuxPolicy`); omitir campos ao
  chamar pode ser interpretado como tentativa de reset conforme a implementação. Se lançar, a
  recuperação morre no meio e não reagenda.
- **Mitigação:** passar o objeto de configuração **completo** — `{ iceServers, iceTransportPolicy:
  'relay' }`, os mesmos campos do construtor — e envolver a chamada em try/catch que, em caso de falha,
  loga e **segue para o `restartIce()`** (melhor um restart com credencial velha do que nenhuma
  tentativa) e mantém o agendamento do backoff.
- **Anti-pattern:** deixar a exceção subir para o `_enqueue`. Ela vira um `console.error` e a
  recuperação para de vez — exatamente o modo de falha silenciosa que esta task veio eliminar.

### R11 — TTL curtíssimo levando a renovação em laço

- **Risco:** com margem de renovação mal calculada (por exemplo, margem fixa de 60s contra um `ttl` de
  60s), o provedor considera a credencial "quase vencida" no instante em que a recebe e renova
  infinitamente, num laço de requisições.
- **Mitigação:** margem = `min(60s, 10% do ttl)` — sempre estritamente menor que o TTL. Somado ao clamp
  de piso 600s no servidor (D9) e a um intervalo mínimo entre tentativas no client. Teste unitário
  explícito com `ttl` patológico (1s, 0, negativo, `NaN`, string).
- **Anti-pattern:** margem fixa em constante sem relação com o TTL recebido.

---

## 8. Critérios de Aceite Técnicos

### 8.1 Servidor

- **A1.** Com `CF_TURN_TOKEN_ID` e `CF_TURN_API_TOKEN` presentes e a Cloudflare respondendo, `GET
  /turn-credentials` devolve **200** com `iceServers` não vazio, `ttl` numérico positivo e `expiresAt`
  ISO-8601 coerente com `ttl`.
- **A2.** Sem as variáveis de ambiente, `GET /turn-credentials` devolve **503** com
  `error: 'turn-unconfigured'`. **Não** devolve 200. **Não** devolve `iceServers`.
- **A3.** Com a Cloudflare respondendo não-OK, lançando, ou não respondendo dentro de
  `CF_TURN_TIMEOUT_MS`, o endpoint devolve **502** com `error: 'turn-upstream'`, e a requisição termina
  em tempo limitado (não fica pendurada).
- **A4.** Nenhuma resposta e nenhuma linha de log contém o valor de `CF_TURN_API_TOKEN` ou de
  `CF_TURN_TOKEN_ID`.
- **A5.** `GET /health` devolve `turn.configured: false` sem as variáveis e `true` com elas, **sem
  chamar a Cloudflare** em nenhum dos casos. O campo `ok` continua presente e verdadeiro nos dois.
- **A6.** `CF_TURN_TTL` ausente → 3600 é enviado à Cloudflare. Valor `0`, negativo, não numérico ou
  vazio → 3600, com aviso em log. Valor `100` → 600 (clamp) com aviso. Valor `999999` → 86400 (clamp).
- **A7.** Subir o servidor sem as variáveis de TURN imprime **um** aviso explícito no boot dizendo que
  nenhuma chamada vai conectar.

### 8.2 Client — provedor e mesh (unitário)

- **A8.** Duas chamadas concorrentes ao provedor com o cache frio resultam em **uma única** requisição
  HTTP; as duas recebem a mesma lista.
- **A9.** Com o relógio avançado além de `ttl − margem`, a chamada seguinte **refaz** a requisição. Antes
  disso, não refaz.
- **A10.** Falha de rede/503/502 → o provedor **resolve** (não rejeita) com `[]` e um `status` que
  distingue `unconfigured`, `upstream` e `unreachable`. **Nenhuma** entrada de `stun:` aparece no
  retorno em nenhum caminho.
- **A11.** Se a renovação falhar mas a credencial anterior ainda estiver **dentro** da validade, o
  provedor devolve a anterior com status `stale`. Se já estiver **vencida**, devolve `[]`.
- **A12.** Após uma falha, uma nova tentativa dentro do intervalo mínimo **não** dispara requisição.
- **A13.** Duas chamadas concorrentes de `mesh.addPeer(mesmoId)` constroem **exatamente uma**
  `RTCPeerConnection` e ambas resolvem com o par registrado. (R1)
- **A14.** `mesh.addPeer` com o provedor devolvendo lista sem nenhum `turn:`/`turns:` chama
  `onPeerStateChange(peerId, 'failed')` e emite `console.error`, **sem** lançar e **sem** deixar de
  registrar o par.
- **A15.** Transição para `connectionState: 'disconnected'` **não** dispara recuperação se voltar a
  `'connected'` dentro da carência. Permanecendo `'disconnected'` além dela, dispara **uma** recuperação.
- **A16.** ⭐ Com `connectionState: 'failed'` **e** um transceiver local sem `mid` ao mesmo tempo,
  observa-se **exatamente uma** sequência de negociação para aquele par — nunca duas offers concorrentes.
  *(É o caso que a nota de implementação da task manda testar explicitamente.)*
- **A17.** A recuperação chama `setConfiguration` com a lista **renovada** **antes** de `restartIce()`,
  e nunca `restartIce()` sozinho. Com o provedor devolvendo `[]`, `restartIce()` **não** é chamado e o
  backoff é reagendado.
- **A18.** As tentativas de recuperação respeitam o backoff, param no teto, e o contador zera ao ver
  `'connected'`.
- **A19.** `removePeer` durante uma recuperação pendente cancela todos os timers; nenhum efeito ocorre
  depois, e o par **não** é recriado. (R3)
- **A20.** Um par que recebe `state-request` responde com **um** `state` **apenas àquele par**, e
  `state-request` repetido em janela curta não gera segunda resposta. (R6)
- **A21.** Ao voltar a `'connected'` depois de uma recuperação, o par reenvia `state` + snapshot musical
  para aquele par.
- **A22.** Um payload `state-request` recebido por um par que não conhece o tipo é ignorado sem erro no
  console (compat de protocolo, §5.2).
- **A23.** `_verifyNegotiation` roda no máximo 3 vezes por par e **não** dispara offer quando todos os
  transceivers locais têm `mid`.

### 8.3 E2E — bloco V

Os checks abaixo definem o bloco; a numeração exata é do implementador, dentro da letra **V**.

- **V1.** Toda `RTCPeerConnection` criada nas três abas tem `getConfiguration().iceTransportPolicy ===
  'relay'`. *(Trava contra R9.)*
- **V2.** Uma aba cujo `/turn-credentials` responde **503** entra na sala, e o par correspondente é
  reportado como `'failed'` em poucos segundos — não fica indefinidamente em `connecting`. O
  `console.error` de "sem TURN" está presente.
- **V3.** Com `ttl` curto no mock, um participante que entra **depois** da expiração dispara nova
  requisição a `/turn-credentials` **antes** de a `RTCPeerConnection` daquele par ser criada, e a
  conexão fecha normalmente. *(É a reprodução dirigida de H1(a) — o teste que hoje não existe.)*
- **V4.** No estado estável de 3 participantes, **nenhum** transceiver local tem `mid === null` em
  nenhuma das abas. *(Verificação de H3; confirma o que o A2 já sugeria.)*
- **V5.** A entrada de um terceiro participante não gera mais `setLocalDescription` do que a linha de
  base de hoje — a verificação não introduziu rodada extra no caminho feliz. *(Trava contra R2.)*
- **V6.** Com um participante compartilhando tela, um entrante vê a tela; e após uma recuperação forçada
  daquele par, continua vendo. *(H4 + D7.)*
- **V7.** Os blocos A–T existentes continuam passando, com a **única** exceção conhecida de F4a
  (regressão pré-existente, não desta entrega).

### 8.4 Critérios de confirmação/refutação das hipóteses (separados de propósito)

Estes **não** são critérios de "o fix funciona". São o que autoriza escrever "confirmada" ou "refutada"
em `docs/progress/WTK-MEET-18.md`.

- **H1(a) confirmada** se V3 falha **antes** do fix (com o `ttl` curto, o par não conecta) e passa
  depois. Se V3 passar antes do fix, H1(a) não é o mecanismo e isso precisa estar escrito.
- **H1(b) confirmada como buraco de observabilidade** se, antes do fix, um servidor sem variáveis de
  ambiente responde 200 e a aplicação não emite nenhum sinal — o que a leitura de `index.js:19-27` já
  indica. **Não** confirma o sintoma relatado (§0).
- **H2 confirmada** se, antes do fix, um par levado a `failed` não volta sozinho em nenhum cenário; e se
  a instrumentação mostrar `restartIce()` reusando a configuração antiga (§1.3).
- **H3:** registrar **refutada como causa** se V4 passa antes do fix (o que se espera, dado A2). O que
  a entrega adiciona é rede de segurança, e o progresso deve dizer isso com essas palavras.
- **H4:** registrar **parcialmente refutada** se o caminho "entrei durante um compartilhamento" já
  funcionar antes do fix (§1.5). O que a entrega adiciona é a reafirmação pós-recuperação.

---

## 9. Notas para os Agentes de Implementação

### 9.1 Divisão sugerida

Um agente único dá conta e é preferível: os passos 7-11 (§6) são todos no mesmo arquivo, e dividi-los
entre agentes recria, dentro da task, o mesmo problema de merge que a fronteira de arquivos existe para
evitar. Se houver paralelismo, a única linha de corte limpa é **servidor (1-3) ‖ client (4-6)**, com o
`webrtcMesh.js` (7-11) sempre depois e sempre com um dono só.

### 9.2 Pitfalls desta demanda que não estão na documentação geral

1. **`restartIce()` não recarrega ICE servers.** É o achado que organiza a entrega (§1.3). Se em algum
   momento a implementação chamar `restartIce()` sem ter chamado `setConfiguration` antes, o fix
   inteiro é decorativo.
2. **O `await` no `addPeer` invalida a guarda de reentrância.** R1. Não é hipotético e não é raro.
3. **`_enqueue` engole erro.** `webrtcMesh.js:229-234` faz `.catch(console.error)` e a cadeia
   continua — o que é bom para não travar a fila, e péssimo para descobrir que algo falhou. Não conte
   com uma promise rejeitada chegando a lugar nenhum; se algo precisa reagir a um erro, trate **dentro**
   da função enfileirada.
4. **A ordem de `addTransceiver` é contrato de rede.** `webrtcMesh.js:210-218` + `_classifyTransceiver`
   (`:258-272`) são o mesmo contrato escrito duas vezes. Nada nesta entrega deveria tocar nisso — se
   tocar, pare e reveja.
5. **`this.iceServers` deixa de ser fonte da verdade** mas **não some**: é a semente para o caso de a
   primeira renovação falhar.
6. **Não use `broadcast` para responder `state-request`.** R6.
7. **Limpe os timers.** R3. `removePeer` hoje não conhece nenhum; três estão sendo introduzidos.

### 9.3 Ordem de validação após a implementação

1. `cd server && npm test` — os testes novos.
2. `cd client && npm test` — a suíte inteira, não só os arquivos novos.
3. `cd client && npm run lint && npm run build`.
4. `node e2e/run.mjs` — bloco V mais a suíte inteira. **Baseline conhecida: 111/112, com F4a falhando
   por regressão pré-existente alheia a esta entrega.** Qualquer falha nova é sua.
5. Conferência manual da fronteira: `git diff --name-only origin/main...HEAD` **não** pode listar
   `client/src/pages/Room.jsx`, `client/src/components/PeerAudio.jsx`, `RemoteMusicAudio.jsx`,
   `VideoTile.jsx`, `VideoGrid.jsx` nem `claude-progress.md`.
6. Conferência do contrato com a task irmã: `grep -n "onPeerStateChange" client/src/lib/webrtcMesh.js`
   — toda chamada tem que ser `(peerId, <RTCPeerConnectionState>)`.

### 9.4 O que registrar em `docs/progress/WTK-MEET-18.md`

Arquivo **novo**. Nada em `claude-progress.md`.

- Um bloco por hipótese (H1a, H1b, H2, H3, H4) com veredito explícito: **confirmada / refutada /
  parcialmente refutada / não determinada**, o critério de §8.4 que sustenta o veredito, e o que foi
  entregue mesmo assim.
- A mudança de default de `CF_TURN_TTL` (D9) sinalizada como **decisão que precisa de aval do Nicolas** —
  a alternativa é uma linha de `.env`.
- A deriva de documentação coturn × Cloudflare (§1.6) como pendência **não resolvida** nesta entrega.
- Se em algum momento algo parecer exigir mudança em `Room.jsx`: **o quê, por quê e o que foi feito no
  lugar** — sem editar o arquivo.
- Verificação critério a critério de §8, no formato das entradas já existentes em `claude-progress.md` (que esta task **não** edita — o formato se copia, o arquivo não se toca).
