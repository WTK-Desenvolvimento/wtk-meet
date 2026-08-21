# Progresso — WTK-MEET-18: renovar a credencial de TURN, recuperar conexões caídas e garantir a segunda rodada de negociação

**Status: implementação concluída e validada.** Branch
`agent/wtk-meet-18-renovar-a-credencial-de-turn-recuperar-c`.

Documento de arquitetura seguido:
`docs/agents/arch-temp-turn-renovavel-e-recuperacao-de-conexao.md`.

Task **investigativa**: quatro hipóteses derivadas de leitura de código, nenhuma
reproduzida na abertura. A regra do DoD — *hipótese refutada se documenta e se
pula, não se força um fix* — foi seguida, e o §1 abaixo é o resultado dela.
Duas das quatro hipóteses **não** explicam o sintoma relatado, e isso está
escrito com todas as letras em vez de sumir do registro.

---

## 1. Veredito das hipóteses

### H1(a) — credencial de TURN vencida no cache da aba: **CONFIRMADA**

**Critério (§8.4):** confirmada se V3 falha antes do fix e passa depois.

O mecanismo é íntegro e é o único dos quatro cujo padrão de falha reproduz o
sintoma relatado — *intermitente, contra um participante específico, com o resto
da sala normal*. `config.js` guardava `cachedIceServers` num módulo-singleton sem
TTL nenhum, válido pela sessão inteira da aba, enquanto a credencial da
Cloudflare vencia sozinha (default de **86400s / 24h**). Sob
`iceTransportPolicy: 'relay'` credencial vencida não degrada a conexão: **impede
que ela exista**, porque o navegador não gera candidato nenhum. As conexões já de
pé continuam funcionando — a alocação de relay já existe — e só as **novas**
falham. Daí a assimetria: quem tem a aba velha é o incumbente, quem sofre é o
entrante, e só contra aquele incumbente.

**Como foi reproduzida.** A suíte E2E nunca conseguiu exercitar isto porque o
harness sempre respondeu `/turn-credentials` com 200 e validade infinita. O TURN
local (`node-turn`) tem credencial estática e não expira nada, então "vencer" foi
encenado **ao contrário**: a primeira resposta a Vera traz uma senha que o TURN
recusa, com `ttl: 1`; a renovação traz a boa. Uma aba que não renova fica presa
na senha recusada.

- Antes do fix, V3 falharia nas duas pontas: `turnRequests` de Vera ficaria em
  **1** (a busca única do setup) e a conexão com quem entra **nunca fecharia**.
- Depois do fix: `pedidos: 1 → 2`, `renovação em …750`, `conexão criada em …758`
  — a renovação precede a criação da `RTCPeerConnection` em 8ms —, e as duas
  pontas conectam.

**Limite honesto desta reprodução:** ela demonstra o mecanismo com uma credencial
que o TURN recusa, não com o relógio real da Cloudflare passando por cima de uma
credencial legítima. É a encenação mais próxima possível sem um TURN que revogue
credencial por tempo.

### H1(b) — fallback de STUN e HTTP 200 com lista vazia: **CONFIRMADA como buraco de observabilidade, NÃO como o sintoma**

**Critério (§8.4):** confirmada se um servidor sem variáveis de ambiente responde
200 e a aplicação não emite sinal nenhum.

Confirmada por leitura direta e por teste: `server/src/index.js:19-27` (antes
desta entrega) respondia **200 com `{ iceServers: [] }`** nos três desfechos —
credencial obtida, credencial não configurada (`fetchCloudflareIceServers()`
devolvendo `null`) e erro da Cloudflare. O client então caía num STUN público,
que sob `relay` gera zero candidatos utilizáveis. Um deploy sem
`CF_TURN_TOKEN_ID`/`CF_TURN_API_TOKEN` era bit-a-bit indistinguível de uma sala
saudável, para o client, para um probe externo e para qualquer proxy no caminho.

**Mas não é o sintoma relatado**, e isso importa para o diagnóstico: configuração
ausente derruba a sala **inteira**, para todos, o tempo todo — não um par
específico de forma intermitente. É o instrumento que tornava H1(a)
indiagnosticável, não a causa dela.

### H2 — nada se recupera quando a conexão cai: **CONFIRMADA, e é o mesmo defeito que H1(a)**

**Critério (§8.4):** confirmada se um par levado a `failed` não volta sozinho em
nenhum cenário, e se `restartIce()` reusa a configuração antiga.

Confirmada, e o achado que a liga a H1(a) é o mais importante do diagnóstico:
**`restartIce()` reusa a configuração congelada no construtor da
`RTCPeerConnection`.** Contra credencial vencida ele gera uma geração nova de ICE
com *exatamente a mesma credencial morta* e falha idêntico. Somado ao que já se
sabia — só rodava no primeiro `iceConnectionState === 'failed'`, só do lado
impolite, sem segunda tentativa, sem log e sem UI — o resultado é que **a única
recuperação que existia era precisamente incapaz de recuperar o modo de falha
mais provável.**

Corrigir H1 sem H2 deixaria de pé todas as conexões já quebradas; corrigir H2 sem
H1 produziria um retry que repete o mesmo erro em laço. A correção é uma só e tem
forma obrigatória: **renovar → `setConfiguration` → `restartIce`**, nessa ordem.
O teste `recuperar é renovar, reconfigurar e SÓ ENTÃO reiniciar o ICE (A17)`
existe para travar exatamente essa sequência: se um refactor futuro remover o
passo do meio, o fix inteiro vira decoração e nada mais na suíte quebra.

### H3 — a segunda rodada de negociação pode não acontecer: **REFUTADA como causa**

**Critério (§8.4):** registrar refutada como causa se V4 passa antes do fix.

A mecânica descrita na task está correta: os dois lados chamam `addPeer` quase
juntos, os dois criam quatro transceivers `sendonly`, os dois disparam
`onnegotiationneeded` → **glare em toda entrada**. E é verdade que a *answer* só
espelha as m-lines da *offer* e que transceivers de `addTransceiver()` nunca são
pareados implicitamente, então quem perde o glare fica mesmo com quatro
`sendonly` sem `mid` depois da primeira rodada.

O que a hipótese não considerava: **a spec faz a segunda rodada disparar
sozinha.** O algoritmo de negotiation-needed do JSEP retorna verdadeiro justamente
quando existe transceiver não associado (`mid === null`), então o navegador
dispara o evento de novo assim que o lado perdedor volta a `stable`. Não é sorte,
é comportamento especificado.

**Evidências:**

- **V4 passa**, com os três participantes: `[["Vera",[0,0]],["Vitor",[0,0]],
  ["Valter",[0,0]]]` — nenhum transceiver local sem `mid` em nenhuma das abas.
  V4 é uma checagem **de observação**, não de comportamento novo: ela mede o
  mesmo que mediria antes do fix.
- A checagem **A2**, que já existia e exige quatro canais por sentido com três
  participantes, sempre passou de forma consistente. Se a segunda rodada não
  acontecesse, A2 falharia em cerca de metade das entradas.
- **V5** mostra a negociação **parando**: `setLocalDescription: [6,4,5] →
  [6,4,5]` depois de 8s de sala assentada — bem além das janelas de verificação
  (750ms, 2s, 5s).

**O que foi entregue mesmo assim, e com que rótulo.** `_verifyNegotiation` é
**rede de segurança, não correção de causa raiz**. Ela só age **com evidência**
(`mid === null`, o mesmo critério da spec), no máximo 3 vezes por par. Como o
vencedor do glare nunca tem transceiver sem `mid`, ela é auto-limitante por
construção: só o perdedor pode renegociar. Nenhum fix especulativo foi escrito
para fechar checkbox — o que se entregou foi a *verificação* que a fragilidade
legítima justificava (a segunda rodada não tinha verificação nem retry, e se
estourasse era engolida por `_enqueue` com um `console.error`).

### H4 — o `state` da tela é enviado uma vez e nunca reenviado: **PARCIALMENTE REFUTADA**

**Critério (§8.4):** registrar parcialmente refutada se "entrei durante um
compartilhamento" já funcionar antes do fix.

O que a hipótese elogia é real e foi preservado: as duas ordens de chegada
(`ontrack` antes do `state` e `state` antes do `ontrack`) já estavam tratadas. E o
ponto que a refuta: o `channel.onopen` **não envia um delta — envia o estado
inteiro corrente** (`{...this.localState}`) mais o snapshot musical. Quem entra no
meio de um compartilhamento recebe `screenOn: true` no primeiro frame do canal.

**V6 confirma:** Valter entra depois de Vera já estar compartilhando e vê a tela
(`destaque: Vera — tela`). Esse caminho já funcionava.

**O que sobrava, e foi corrigido:** não era "faltou reenviar periodicamente", era
"faltou reafirmar quando algo se reconstrói" —

- a **assimetria entre os dois lados**, se por qualquer motivo um `onopen` correu
  e o outro não: aquele lado ficaria sem a tela **para sempre**, com a track
  chegando normalmente, porque a imagem só aparece quando `ontrack` e `screenOn`
  coincidem. Resolvido com `state-request` no `onopen`: **uma** mensagem por par;
- a **conexão que se reconstrói** depois de uma recuperação, que voltaria com
  áudio e sem tela pelo mesmo motivo. Resolvido com reafirmação na borda de
  subida, só para aquele par.

**Sem heartbeat**, deliberadamente: numa sala de 6 um reenvio periódico custaria
5 mensagens por aba por intervalo, para sempre, para corrigir um evento que
acontece em transições discretas e observáveis. Tráfego em regime permanente:
zero.

---

## 2. O que foi entregue

### Servidor

| Arquivo | Mudança |
|---|---|
| `server/src/turnCredentials.js` | Devolve `{ iceServers, ttl, expiresAt }`. `CF_TURN_TTL` validado com clamp em `[600, 86400]` e default **3600** (era 86400). `CF_TURN_TIMEOUT_MS` novo (5000). `isTurnConfigured()`. Segredos redigidos em toda mensagem de erro. Lista vazia da Cloudflare passa a ser erro de upstream, não sucesso magro. |
| `server/src/index.js` | `/turn-credentials` → **200** / **503 `turn-unconfigured`** / **502 `turn-upstream`**, com log de erro nos dois últimos. `/health` → `{ ok, turn: { configured } }` (aditivo). Aviso no boot quando falta TURN. |

### Client

| Arquivo | Mudança |
|---|---|
| `client/src/lib/iceServers.js` **(novo)** | Cache com prazo derivado do `ttl`, margem `min(60s, 10% do ttl)`, coalescência de requisições em voo, intervalo mínimo entre tentativas após falha, `status` legível (`ok`/`unconfigured`/`upstream`/`unreachable`/`stale`). Puro: `fetch` e relógio injetáveis, sem `import.meta.env`, sem DOM. |
| `client/src/config.js` | Delega ao provedor. **Assinatura preservada** (`Promise<Array>`, nunca rejeita) — é contrato com `Room.jsx`. Fallback de STUN público **removido**. |
| `client/src/lib/webrtcMesh.js` | `getIceServers` opcional com default de módulo; `addPeer` com **reserva de par** e renovação por conexão; `_reportMissingTurn`; `_scheduleRecovery` unificado; `_negotiate`/`_queueNegotiation`; `_verifyNegotiation`; `state-request` e reafirmação; limpeza de todos os timers em `removePeer`/`closeAll`. |

### Testes

| Arquivo | Conteúdo |
|---|---|
| `server/test/turnCredentials.test.mjs` **(novo)** + `npm test` no server | 18 testes (A1–A7). Metade unitária, metade subindo o `index.js` real num processo filho com a Cloudflare dublada por `--import` — o mapeamento status↔desfecho e o aviso de boot só existem lá. |
| `client/test/iceServers.test.mjs` **(novo)** | 16 testes (A8–A12 e o TTL patológico de R11). |
| `client/test/meshRecovery.test.mjs` **(novo)** | 25 testes (A13–A23), incluindo o **A16**. |
| `e2e/harness.mjs` | Aditivo: `turn: { status, ttl, expiredFirstCredential }` opcional, `ttl`/`expiresAt` no mock, `turnRequests` no retorno, `__wtkPeerCreatedAt` na instrumentação. |
| `e2e/run.mjs` | **Bloco V**, 8 checagens, em sala própria. |

---

## 3. Verificação executada

- `cd server && npm test` → **18/18**
- `cd client && npm test` → **369/369** (57 novos)
- `cd client && npm run lint` → limpo
- `cd client && npm run build` → ok
- `node e2e/run.mjs` → **119/120**, com o bloco V inteiro verde. A única falha é
  a **F4a**, regressão pré-existente conhecida (botão restaurado por engano em
  `1baa707`), alheia a esta entrega e presente antes dela.

### §8.1 — servidor

| # | Critério | Resultado |
|---|---|---|
| A1 | 200 com `iceServers` não vazio, `ttl` positivo, `expiresAt` coerente | ✅ unitário + endpoint real (`ttl: 1200`, `expiresAt` = agora + ttl) |
| A2 | Sem variáveis → **503**, não 200, sem `iceServers` | ✅ `body.iceServers === undefined` |
| A3 | Cloudflare não-OK / lançando / timeout → **502**, em tempo limitado | ✅ quatro modos (`error`, `throw`, `empty`, `hang`); com `hang` a requisição termina em <5s |
| A4 | Nenhuma resposta e nenhum log carrega segredo | ✅ redação na origem; verificado na resposta **e** na saída do processo |
| A5 | `/health` reporta `turn.configured` sem chamar a Cloudflare; `ok` preservado | ✅ testado com o dublê em modo `throw`: se tocasse o upstream, quebraria |
| A6 | TTL: ausente→3600; inválido→3600 com aviso; 100→600; 999999→86400 | ✅ e o valor resolvido é o que de fato vai no corpo para a Cloudflare |
| A7 | Um aviso no boot sem as variáveis | ✅ exatamente **um**, e silêncio quando configurado |

### §8.2 — client, unitário

| # | Critério | Resultado |
|---|---|---|
| A8 | Duas chamadas concorrentes → uma requisição | ✅ três concorrentes → 1 |
| A9 | Renova passada a margem, não antes | ✅ 3539s não renova, 3541s renova |
| A10 | Falha resolve com `[]` + status distinguível; **nenhum `stun:`** | ✅ seis modos de falha; asserção explícita de que `stun:` não aparece |
| A11 | Falha com credencial ainda válida → `stale`; vencida → `[]` | ✅ |
| A12 | Nova tentativa dentro do intervalo mínimo não vai à rede | ✅ nem com `force` |
| A13 | Dois `addPeer` concorrentes → **uma** `RTCPeerConnection` | ✅ mais o caso "saiu durante a construção" |
| A14 | Lista sem TURN → `onPeerStateChange(id,'failed')` + `console.error`, sem lançar, par registrado | ✅ mais a asserção de que o valor pertence ao enum |
| A15 | `disconnected` que volta na carência não recupera; além dela, **uma** recuperação | ✅ 4999ms nada, 5001ms recupera |
| A16 | ⭐ `failed` **e** transceiver sem `mid` juntos → **uma** negociação | ✅ `setLocalDescription` = 1 |
| A17 | `setConfiguration` com lista **renovada** antes de `restartIce`; com `[]`, **não** reinicia | ✅ ordem verificada no trace; `force: true` verificado |
| A18 | Backoff respeitado, teto, contador zera em `connected` | ✅ 5 tentativas, erro final logado, contador zerado |
| A19 | `removePeer` durante recuperação cancela tudo | ✅ 120s depois, nenhum efeito, par não recriado |
| A20 | `state-request` responde **só** ao remetente, coalescido | ✅ o outro par recebe zero |
| A21 | Volta de recuperação reenvia `state` + snapshot | ✅ e conectar **sem** ter recuperado não reanuncia nada |
| A22 | Tipo desconhecido ignorado sem erro no console | ✅ |
| A23 | Verificação no máximo 3×, e nenhuma offer com todos os `mid` presentes | ✅ |

### §8.3 — E2E, bloco V

| # | Critério | Resultado observado |
|---|---|---|
| V1 | `iceTransportPolicy === 'relay'` em toda PC | ✅ 6 conexões, `["relay"]` |
| V2 | Sem TURN a aba diz o que houve, e não fica indefinidamente em `connecting` | ✅ `[mesh] sem servidor TURN utilizável (provedor: unconfigured)`; zero conexões |
| V3 | Renova **antes** de criar a PC de quem entra, e a conexão fecha | ✅ pedidos 1→2; renovação em `…750`, PC criada em `…758` |
| V4 | Nenhum transceiver local sem `mid` com 3 participantes | ✅ `[["Vera",[0,0]],["Vitor",[0,0]],["Valter",[0,0]]]` |
| V5 | Nenhuma rodada extra depois da sala assentar | ✅ `[6,4,5] → [6,4,5]` após 8s |
| V6 | Quem entra no meio de um compartilhamento vê a tela | ✅ `destaque: Vera — tela` |
| V7 | Blocos A–T continuam passando, exceto F4a | ✅ 119/120 |

**Cobertura de V2 e V6, declarada.** O reporte `onPeerStateChange(peerId,
'failed')` que acompanha o aviso de V2 **não é observável no E2E desta worktree**:
o callback ainda não tem consumidor de UI aqui — quem o constrói é a task irmã.
O que V2 observa é o `console.error` e a ausência de conexão; o reporte em si é
coberto no unitário (A14). Do mesmo modo, V6 cobre "entrei no meio de um
compartilhamento e vi a tela"; a **reafirmação pós-recuperação** não é
exercitável no navegador sem forçar uma falha real de ICE (o TURN local não
revoga credencial), e está coberta no unitário (A21).

---

## 4. Decisões que precisam de aval do Nicolas

### D9 — `CF_TURN_TTL` passa de 86400 (24h) para **3600 (1h)** por default

**Mudança de comportamento para deploys existentes.** Quem depende do default vai
de 24h para 1h. Não quebra nada — o client agora renova sozinho, e
`docs/architecture.md` §7 já especificava *"credenciais efêmeras … TTL curto, ex.
1h"*, ou seja, o default de 24h nunca esteve alinhado com a arquitetura escrita. É
também a janela que dá a H1(a) o tamanho que ela tem.

**Se a operação preferir manter 86400, é uma linha de `.env`** —
`CF_TURN_TTL=86400`. A decisão é do Nicolas, não do agente de implementação.

---

## 5. Pendências e divergências registradas

### 5.1 Divergência entre o DoD do board e a fronteira de arquivos da task

O DoD desta task manda, nos itens 10, 15 e 19, escrever o progresso em
**`docs/progress/WTK-MEET-17.md`**. A descrição da task e o §9.4 do documento de
arquitetura mandam **`WTK-MEET-18.md`**.

`WTK-MEET-17` é uma task **separada, com título idêntico, em outra worktree** —
esta task foi duplicada. Escrever em `WTK-MEET-17.md` daqui colidiria com o
arquivo de progresso dela, o que é exatamente o que a seção "Fronteira de
arquivos" da task existe para impedir. **Este arquivo é o `WTK-MEET-18.md`**, e a
divergência fica registrada aqui em vez de resolvida no silêncio.

### 5.2 Deriva de documentação: coturn × Cloudflare — **não resolvida**

`docs/architecture.md` §7 e o `infra/coturn/` descrevem **coturn self-hosted com
TURN REST API**; o código em produção usa a **Cloudflare TURN API**. Quem for
debugar TURN em produção seguindo aquele documento vai procurar um
`turnserver.conf` que não está no caminho.

Esta entrega **registra** a deriva e corrige o `README.md` no ponto onde ele
engana quem for debugar, mas **não reconcilia** os dois documentos nem migra a
infraestrutura — está explicitamente fora do escopo (§2 do doc de arquitetura).

### 5.3 Nada exigiu mudança em `Room.jsx`

O teste ácido do desenho passou: **`client/src/pages/Room.jsx` e
`client/src/components/**` não foram tocados**, e nenhum passo chegou a exigir
isso. Os dois pontos onde a pressão apareceu e como foram resolvidos sem editar:

1. **Renovar a credencial antes de cada conexão** exigiria o mesh alcançar o
   fetcher, e o array que o `Room.jsx` passa é, por definição, velho. Resolvido
   com `getIceServers` como opção de construtor **opcional com default de
   módulo**: `Room.jsx` não passa e não precisa saber que existe.
2. **Tornar "sem TURN" visível** exigiria um callback novo (`onTurnStatus`), que
   só viraria UI se o `Room.jsx` passasse o handler. Resolvido usando o canal que
   já atravessa a fronteira: `onPeerStateChange(peerId, 'failed')` — `'failed'` é
   valor legítimo de `RTCPeerConnectionState`, então a assinatura
   `(peerId, connectionState)` permanece **exatamente** a de hoje.

### 5.4 Riscos aceitos

- **`/turn-credentials` fica mais chamado** — uma vez por TTL por aba (1h), em vez
  de uma por sessão. Para salas de 6 o volume continua desprezível. Sem cache no
  servidor de propósito: cachear faria todos os clientes compartilharem um
  instante de expiração, trocando a renovação escalonada de hoje por um efeito
  manada em que a sala inteira renova (ou falha) junto.
- **503/502 quebram um client com bundle antigo em cache**, que cairá no seu
  próprio fallback de STUN. Aceito e desejado: aquele client já não conectava
  nesse caso; a diferença é que agora falha rápido em vez de devagar.

---

## 6. Nota de execução: três sessões na mesma worktree

Esta task foi aberta em **três** sessões simultâneas apontando para o **mesmo**
worktree e a **mesma** branch — onde não existe "conflito de merge", existe
sobrescrita direta. A divisão acordada por mensagem, antes de qualquer escrita
concorrente:

- **Esta sessão:** `server/**`, `client/**`, `e2e/**`, `docs/progress/`.
- **Segunda sessão:** apenas `README.md` e `ARCHITECTURE.md` (commit `4d9eea9`),
  com `git add` explícito dos dois arquivos.
- **Terceira sessão (QA):** **nenhuma escrita**; revisão por leitura de
  `server/src/**` e `client/src/lib/iceServers.js` contra A1–A12, reportada por
  mensagem.

Dois achados da revisão de QA entraram no código: o provedor passou a tratar
"200 com lista não vazia porém **sem nenhum `turn:`**" como falha em vez de
sucesso cacheável — o formato mais enganoso de todos, e exatamente o que o
fallback antigo produzia —, e o ramo de cache-hit ganhou o comentário que explica
por que ele sobrescreve um `stale` com `ok`.

O E2E foi rodado **em série e por uma sessão só**: duas rodadas simultâneas neste
sandbox derrubam o `node-turn` por contenção e, com `relay`-only, isso produz o
sintoma exato de uma regressão de negociação (`conn: failed`, `ice: new`) sem que
haja regressão nenhuma.
