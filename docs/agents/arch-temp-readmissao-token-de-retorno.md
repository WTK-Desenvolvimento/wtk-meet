# Readmissão sem aprovação via token de retorno (WTK-MEET-25) — Documento de Arquitetura Técnica

> Gerado em: 2026-09-15
> Status: Rascunho
> Task: WTK-MEET-25 — "Readmitir sem aprovação quem recarrega a página ou reconecta,
> via token de retorno com janela de graça de 60s"
> Autor: Arquiteto de Soluções

---

## 1. Contexto e Objetivo

Hoje a identidade de um participante **é** o `socket.id`. `packages/server/src/rooms.ts`
guarda `socketId → { displayName }` e nada mais; `packages/client/src/pages/Room.tsx`
reemite `join-request` a cada evento `connect` do Socket.IO. Resultado: todo F5, toda
troca de rede e toda reconexão automática do Socket.IO produzem um `socket.id` novo, e
para o servidor isso é indistinguível de um desconhecido batendo na porta. Como a sala
não está vazia, o pedido entra em `pendingJoins` e o `JoinRequestModal` — que é modal
bloqueante, não fecha por Esc nem por backdrop (§6.7 do `ARCHITECTURE.md`) — abre na
tela de **todos** os presentes.

Duas consequências reais, nesta ordem de gravidade:

1. Quem caiu pode ficar de fora da própria reunião porque ninguém reparou no modal.
2. Numa rede instável, a sala inteira é interrompida a cada oscilação de quem está mal
   conectado — o custo do problema recai sobre quem **não** teve o problema.

**Comportamento esperado após a entrega:** quem já foi admitido e volta em até 60
segundos entra direto, sem que nenhum modal apareça para ninguém. Quem não tem prova de
que já esteve lá continua passando pela aprovação exatamente como hoje. Nada disso cria
conta, cookie, banco ou qualquer coisa durável: o §1 e o §5 do `ARCHITECTURE.md` ("o
processo mantém estado apenas em memória, por sala, e o descarta quando a sala esvazia")
continuam verdadeiros palavra por palavra.

---

## 2. Escopo

**Dentro do escopo:**

- Registro em memória de tokens de retorno no `RoomStore`, com vida atada à sala.
- Emissão de `resumeToken` em **toda** admissão, dentro do `join-approved`.
- Aceitação de `resumeToken` opcional no `join-request`, com admissão direta quando
  válido e queda para o fluxo de aprovação quando não.
- Janela de graça de 60s a partir da desconexão, com constante exportada e relógio
  injetável.
- Reserva da vaga do ausente durante a graça, contando para `MAX_PARTICIPANTS`.
- Persistência do token em `sessionStorage` no client, sob `wtk-meet:resume:<roomId>`,
  e limpeza na saída intencional.
- Novo desfecho `resumed` em `wtk_joins_total` e atualização do catálogo de métricas
  (`README.md`, `README.en.md`, `ARCHITECTURE.md` §5/§10).
- Testes de servidor (unitários do store + integração de sinalização) e de client
  (módulo puro de storage + integração sem jsdom).

**Fora do escopo:**

- Qualquer mudança na malha WebRTC. `peer-left`/`peer-joined` continuam como estão; para
  o mesh, quem volta é um peer novo. Nada de reaproveitar `RTCPeerConnection`, nada de
  "reconexão de peer".
- Qualquer mudança na camada de E2EE. O token não é chave, não deriva chave e não
  substitui a passphrase do fragmento — quem tem token e não tem passphrase entra na
  sala e não entende nada do que trafega.
- Suprimir os toasts de "saiu"/"entrou" no ciclo queda-e-volta (§6.5). Eles vão aparecer
  em sequência; é cosmético e vira task própria se incomodar.
- Sobreviver ao fechamento da aba, à troca de aba/navegador ou a um restart do servidor.
- Persistir o token no `localStorage`, em cookie, na URL ou em qualquer lugar durável.
- Reaproveitar o token como identidade estável para telemetria, para "lembrar quem
  sou" ou para qualquer recurso futuro de identidade.
- Endpoint REST novo. Nada nesta entrega é alcançável por HTTP.

---

## 3. Decisões Arquiteturais

As decisões marcadas **[DoD]** vêm fechadas pela task e estão aqui para registro, não
para reabertura. As demais são resoluções de arquitetura desta entrega.

### 3.1 O token vive no `RoomStore`, ao lado das salas — e morre com a sala

- **Decisão:** o registro `token → { roomId, socketId, displayName, expiresAt }` é um
  `Map` privado do `RoomStore`, e as entradas de uma sala são descartadas no mesmo
  instante em que a sala é deletada (`removeMember`, quando `room.size === 0`).
- **Motivação:** é estado de produto, não de observação — logo pertence ao mesmo objeto
  que já é o dono do estado do produto, e não a um módulo paralelo. Atar o ciclo de vida
  à sala é o que mantém o §5 do `ARCHITECTURE.md` literalmente verdadeiro: sala vazia ⇒
  nada resta. É também o que faz "servidor reiniciou" significar "todo mundo pede
  aprovação de novo", sem nenhum código a mais.
- **Alternativas descartadas:**
  - *`Map` de módulo no `index.ts`, ao lado de `pendingJoins`.* `pendingJoins` é estado
    de um pedido em voo, some sozinho; o registro de tokens precisa ser varrido quando a
    sala morre, e do `index.ts` isso vira um segundo lugar que tem que lembrar de limpar
    — exatamente o tipo de acoplamento que produz vazamento silencioso.
  - *Campo dentro de `Member`.* O membro **não existe** durante a graça; é justamente a
    ausência dele que o token descreve.
  - *Token assinado sem estado (HMAC/JWT curto).* Dispensa o registro, mas impede
    revogação: não dá para invalidar na rotação, não dá para saber se o socket anterior
    ainda está conectado (regra anti-clone) e não dá para reservar vaga. E introduz um
    segredo de servidor onde hoje não há nenhum.

### 3.2 A graça é **armada na desconexão**, não na admissão **[DoD: 60s]**

- **Decisão:** `RESUME_GRACE_MS = 60_000`, exportada de `rooms.ts`. No momento da
  admissão a entrada nasce com `expiresAt: null` — existe, mas **não** é retomável.
  Quando aquele socket cai (`disconnect`), o `expiresAt` passa a `now() + RESUME_GRACE_MS`.
- **Motivação:** a janela é "há quanto tempo você sumiu", não "há quanto tempo você
  entrou". Uma reunião de duas horas não pode expirar o token de quem está dentro dela.
  E o estado `expiresAt: null` faz a regra anti-clone (§3.5) cair de graça: um token de
  socket vivo nunca é retomável, porque nunca foi armado.
- **Alternativas descartadas:** TTL desde a emissão (quebra reunião longa); TTL infinito
  enquanto a sala existir (transforma o token num passe permanente para a sala, que é o
  que a aprovação existe para evitar).

### 3.3 Graça só para queda, nunca para saída explícita

- **Decisão:** `leaveCurrentRoom` hoje serve a **dois** eventos, `leave-room` e
  `disconnect`. Ela passa a receber o motivo, e só arma a graça no caso `disconnect`.
- **Motivação:** quem clicou em "Sair da sala" decidiu sair. Reservar a vaga dele por 60s
  segura um lugar num teto de 6 sem que ninguém tenha pedido, e manter o token vivo
  contradiz a limpeza que o próprio client faz do lado dele. Sem essa distinção, sair e
  voltar viraria "entrar sem aprovação", que não é o caso de uso desta task.
- **Alternativas descartadas:** armar sempre e confiar na limpeza do `sessionStorage` do
  client — confiar no client para não usar um token que o servidor considera válido é
  uma regra de segurança implementada no lugar errado.

### 3.4 Rotação a cada admissão, uso único **[DoD]**

- **Decisão:** toda admissão — primeira entrada, aprovação e retomada — emite um token
  novo. O token apresentado é **deletado no instante do consumo**, antes de a admissão
  acontecer, e o token anterior daquele socket é descartado na emissão do novo.
- **Motivação:** sem replay. Um token que funcionasse duas vezes seria um convite
  transferível que não expira ao ser usado, e o dono nem saberia.
- **Anti-pattern explícito:** consumir o token **depois** de admitir, ou deletá-lo só no
  caminho feliz. Se qualquer passo intermediário falhar ou retornar cedo, sobra uma
  entrada viva reutilizável.

### 3.5 Token de socket ainda conectado não vale **[DoD: sem clone de presença]**

- **Decisão:** a retomada exige (a) entrada armada (`expiresAt !== null`) e (b) o
  `socketId` gravado **não** estar presente na sala agora.
- **Motivação:** duplicar a aba no Chrome copia o `sessionStorage`. Sem essa regra, a
  cópia entraria sem aprovação enquanto a original segue na sala — duas presenças a
  partir de uma aprovação só. A condição (a) já resolve o caso comum; a (b) é o cinto de
  segurança contra qualquer caminho que arme a graça sem remover o membro.
- **Alternativas descartadas:** expulsar o socket antigo quando o token é reapresentado
  ("takeover"). É um comportamento novo, visível e destrutivo — alguém perde a chamada
  por causa de uma aba duplicada.

### 3.6 Token ruim nunca nega entrada **[DoD]**

- **Decisão:** token ausente, malformado, expirado, de outra sala, já usado ou de socket
  vivo ⇒ **nenhum** `join-denied`, **nenhum** log, **nenhuma** métrica de fracasso. O
  pedido simplesmente segue para o fluxo de aprovação de hoje.
- **Motivação:** o token é um atalho, não uma credencial. Um token ruim que negasse
  entrada criaria uma forma de bloquear alguém plantando lixo no `sessionStorage` dele, e
  transformaria uma otimização de conforto em ponto único de falha do acesso à sala.
- **Anti-pattern explícito:** emitir `join-denied { reason: 'invalid-token' }`, ou logar
  "token inválido" com qualquer fragmento do valor.

### 3.7 Vaga reservada conta para `MAX_PARTICIPANTS`, mas não para o gauge **[DoD]**

- **Decisão:** `isFull(roomId)` passa a ser `membros + reservas ativas ≥ MAX_PARTICIPANTS`.
  `snapshot()` continua somando **só** `room.size`.
- **Motivação:** sem a reserva, quem caiu de uma sala de 6 volta e leva `room-full` —
  a pior versão possível do problema que esta task resolve. E o gauge se chama
  `wtk_participants_active`: ele mede gente conectada agora, não cadeiras ocupadas.
  Misturar as duas faria um painel mentir sobre ocupação real.
- **Consequência aceita, e ela é visível:** um desconhecido que chega enquanto alguém
  está na graça pode receber `room-full` numa sala onde aparecem 5 pessoas. Em salas de
  6 num teto de 6, `wtk_joins_total{outcome="room_full"}` deve subir um pouco. É o preço
  da garantia de retorno, e precisa estar escrito no README.

### 3.8 Retomada é decidida **antes** da checagem de sala cheia

- **Decisão:** no handler de `join-request`, a ordem passa a ser: (1) `roomId` válido →
  (2) tentativa de retomada → (3) `isFull` → (4) `isEmpty` → (5) fila de aprovação.
- **Motivação:** a reserva do próprio retornante é parte do que torna a sala "cheia".
  Checar `isFull` antes da retomada faria a pessoa ser barrada pela vaga que foi
  reservada para ela — um bug que só aparece com a sala em 6, que é exatamente o cenário
  que a reserva existe para cobrir.
- **Invariante que o teste precisa fixar:** no instante do consumo, `room.size` é no
  máximo `MAX_PARTICIPANTS - 1`, porque a reserva bloqueou o sexto lugar.

### 3.9 Na retomada, vale o `displayName` guardado — não o do payload

- **Decisão:** a admissão por token usa o `displayName` que estava no registro. O nome
  que vier no payload do `join-request` é ignorado **nesse caminho** (e continua sendo a
  fonte em todos os outros).
- **Motivação:** a autoridade do token cobre exatamente a identidade que foi aprovada, e
  nada além. Deixar o payload sobrescrever o nome cria um canal de renomeação que
  ninguém revisa: quem volta aparece com nome novo na tela de quem nem viu a queda.
  É também o único uso que justifica guardar `displayName` no registro.
- **Alternativa descartada:** payload vence, registro é só bookkeeping. Mais simples, mas
  abre o canal de renomeação silenciosa acima.
- **Consequência aceita:** quem edita o nome no lobby e volta na mesma aba dentro dos 60s
  reaparece com o nome antigo. Documentar em `ARCHITECTURE.md`; não tratar.

### 3.10 `sessionStorage`, e o módulo que fala com ele é puro **[DoD]**

- **Decisão:** um módulo novo, `packages/client/src/lib/resumeToken.ts`, com a chave e
  quatro funções que recebem a `Storage` **por parâmetro** (precedente direto:
  `lib/devices.ts`, `readPreferences(window.localStorage)`). Nenhum acesso a
  `window` dentro do módulo, todo acesso envolto em `try/catch`.
- **Motivação:** é o que torna o módulo testável no `node --test` sem jsdom (memória
  [[wtk-meet-hook-testavel-sem-jsdom]] e precedente em `test/devices.test.ts`), e é o que
  faz `sessionStorage` desabilitado (modo privado, política de terceiros) degradar para
  "pede aprovação, como sempre" em vez de quebrar a entrada na sala.
- **[DoD] Por que `sessionStorage` e não `localStorage`:** sobrevive ao F5 e à
  reconexão, morre com a aba. Fechar a aba volta a exigir aprovação — proposital, para
  que um link vazado numa máquina compartilhada não entre sozinho.

### 3.11 O token é opaco, e opaco inclui os logs

- **Decisão:** `crypto.randomBytes(32).toString('hex')` (256 bits, 64 chars hex). O valor
  **nunca** aparece em `console.log`/`warn`/`error`, em atributo de métrica, em mensagem
  de erro, em payload de broadcast ou em qualquer evento que não seja o `join-approved`
  do próprio dono.
- **Motivação:** 256 bits tornam adivinhação irrelevante como vetor; o que sobra é
  vazamento por descuido, e descuido mora no caminho de erro. O `ARCHITECTURE.md` §5 é a
  tabela que uma pessoa desconfiada lê primeiro — um token em log a contradiz.
- **Nota de ameaça, honesta:** quem executa script na origem do client (XSS) lê o
  `sessionStorage` e entra sem aprovação. Quem consegue isso já controla a aba e a chave
  de E2EE que vive no fragmento; o token não move essa fronteira. O que ele muda é que
  agora existe **um** valor com poder de entrada — daí a rotação, o uso único e a janela
  de 60s.
- **Gerador injetável:** o `RoomStore` já injeta `now`; passa a injetar também
  `createToken`. Isso dá determinismo ao teste sem stub de `node:crypto`, e o default do
  construtor continua sendo `randomBytes`.

### 3.12 Validação de forma antes de usar o token como chave de `Map`

- **Decisão:** o servidor só olha o registro se o campo for `string` e casar
  `/^[0-9a-f]{64}$/`. Qualquer outra coisa é tratada como token ausente.
- **Motivação:** o campo chega de fora, como `roomId` e `displayName` (que já chegam como
  `unknown` no `JoinRequestPayload` justamente por isso). Sem a checagem de forma, uma
  string de megabytes vira chave de lookup e argumento de comparação vindo direto da
  rede. Não é exploit conhecido; é a diferença entre um campo validado e um não validado.

### 3.13 Expiração preguiçosa, sem `setTimeout`

- **Decisão:** nada de timer. Entradas expiradas são ignoradas na leitura e varridas nos
  caminhos de escrita daquela sala (admissão e desconexão).
- **Motivação:** um `setTimeout` por participante é um handle por participante para
  manter vivo, cancelar no `disconnect`, cancelar no fechamento da sala e cancelar no
  `gracefulShutdown` — e um deles sempre escapa. Preguiçoso é correto por construção com
  o relógio injetado, e o teste não depende de timer real (exigência explícita do DoD).
- **Cuidado que o sweep resolve:** sem varredura, uma sala de vida longa com rotatividade
  acumula entradas expiradas até a sala morrer. O sweep é O(tokens da sala), com a sala
  limitada a 6 membros.

---

## 4. Componentes Afetados

### Servidor (`packages/server`)

| Componente | O que muda | Por quê |
|---|---|---|
| `src/rooms.ts` — `RESUME_GRACE_MS` | Constante nova, exportada, `60_000` | DoD: teste sem timer real e sem número mágico repetido |
| `src/rooms.ts` — `ResumeEntry` | Interface nova: `roomId`, `socketId`, `displayName`, `expiresAt: number \| null` | O registro de retorno; `null` = socket ainda conectado (§3.2) |
| `src/rooms.ts` — `RoomStore.resumeTokens` | `Map<string, ResumeEntry>` privado | Estado de produto, dono único (§3.1) |
| `src/rooms.ts` — `constructor` | Segundo parâmetro injetável `createToken` | Determinismo no teste sem stub de crypto (§3.11) |
| `src/rooms.ts` — `issueResumeToken` | Cria token, descarta o token anterior do mesmo `socketId` naquela sala, varre expirados | Rotação e uso único (§3.4) |
| `src/rooms.ts` — `armResumeGrace` | Marca `expiresAt = now() + RESUME_GRACE_MS` para o socket que caiu | Janela contada da desconexão (§3.2) |
| `src/rooms.ts` — `consumeResumeToken` | Valida (sala, prazo, socket antigo ausente) e **deleta** antes de devolver `{ displayName }` ou `null` | Coração da retomada (§3.4, §3.5) |
| `src/rooms.ts` — `reservedSeats` (privado) | Conta entradas armadas e não expiradas de uma sala | Insumo de `isFull` (§3.7) |
| `src/rooms.ts` — `isFull` | Passa a somar reservas | Vaga garantida no retorno (§3.7) |
| `src/rooms.ts` — `removeMember` | Ao deletar a sala, deleta também os tokens dela | Nada sobrevive à sala (§3.1) |
| `src/rooms.ts` — `snapshot` | **Não muda** | O gauge conta conectados, não cadeiras (§3.7) |
| `src/index.ts` — `JoinRequestPayload` | Campo `resumeToken?: unknown` | Chega de fora ⇒ chega como `unknown` (§3.12) |
| `src/index.ts` — handler `join-request` | Tentativa de retomada entre a validação de `roomId` e o `isFull` | Ordem do §3.8 |
| `src/index.ts` — `admitToRoom` | Emite token novo e o inclui no `join-approved` | Rotação em toda admissão (§3.4) |
| `src/index.ts` — `leaveCurrentRoom` | Ganha o motivo (`'leave' \| 'disconnect'`) e arma a graça só na queda | §3.3 |
| `src/telemetry.ts` | `JoinOutcome` ganha `'resumed'`; comentário do `CARDINALITY_LIMIT` passa de "no máximo 5" para 6 | Novo desfecho contado em `wtk_joins_total` |

### Client (`packages/client`)

| Componente | O que muda | Por quê |
|---|---|---|
| `src/lib/resumeToken.ts` **(novo)** | `RESUME_KEY_PREFIX`, `resumeKey(roomId)`, `readResumeToken(storage, roomId)`, `writeResumeToken(storage, roomId, token)`, `clearResumeToken(storage, roomId)` — `Storage` injetada, tudo em `try/catch` | Módulo puro e testável sem jsdom (§3.10) |
| `src/lib/signaling.ts` — `requestJoin` | Assinatura `(roomId, displayName, resumeToken?)`; o campo só entra no payload quando existe | Reenvio do token no `connect` |
| `src/lib/signaling.ts` — `leaveRoom` | Assinatura `(roomId: string)`; emite `leave-room` e limpa a chave — **apenas se o socket estiver conectado** | DoD (saída intencional apaga o token) + guarda do StrictMode (§7.3) |
| `src/pages/Room.tsx` — handler `join-approved` | Grava `resumeToken` no `sessionStorage`, quando vier | Próxima reconexão tem o que apresentar |
| `src/pages/Room.tsx` — handler `connect` | Lê o token da sala e passa para `requestJoin` | É o ponto onde o F5 e a reconexão se parecem |
| `src/pages/Room.tsx` — cleanup do efeito | `leaveRoom(roomId)` | Nova assinatura |

### Documentação

| Arquivo | O que muda |
|---|---|
| `ARCHITECTURE.md` §4 | Passo novo no fluxo de aprovação: retomada por token, com as cinco condições e a regra "token ruim nunca nega" |
| `ARCHITECTURE.md` §5 | Linha nova na coluna "Sabe" (um token opaco e efêmero por participante admitido, morto com a sala) e na "Nunca sabe" (que duas sessões são a mesma pessoa fora da janela de 60s) |
| `ARCHITECTURE.md` §10 | `resumed` no catálogo de desfechos |
| `README.md` / `README.en.md` (~linha 412) | `outcome` de `wtk_joins_total` ganha `resumed`; o parágrafo "conta desfechos, não tentativas" fala em cinco valores e passa a seis; nota sobre `room_full` poder subir por vaga reservada |
| `docs/progress/WTK-MEET-25.md` | Log da task, conforme convenção de `docs/progress/` |

**Sem mudança:** `turnCredentials.ts`, `telemetryEvents.ts`, `webrtcMesh`, componentes de
UI (`JoinRequestModal` incluso), rotas, nginx, docker-compose.

---

## 5. Contratos de Interface

### Endpoints REST

Nenhum endpoint novo ou alterado. **Requisito explícito:** nada nesta entrega pode ser
alcançável por HTTP — em particular, não existe rota que valide, consulte ou emita token.

### Eventos em tempo real (Socket.IO)

| Tipo de Evento | Payload | Quem emite | Quem consome |
|---|---|---|---|
| `join-request` (client→servidor) | `{ roomId: string, displayName: string, resumeToken?: string }` — campo novo, opcional, 64 chars hex | Client, a cada `connect` | Servidor |
| `join-approved` (servidor→client) | `{ selfId, members, maxParticipants, resumeToken: string }` — campo novo, **sempre** presente | Servidor, a quem foi admitido | Só o socket admitido |
| `join-request` (servidor→membros) | **Inalterado** — e, no caminho de retomada, **não é emitido** | Servidor | Membros da sala |
| `peer-joined`, `peer-left`, `join-denied`, `join-request-cancelled`, `signal` | **Inalterados**. Nenhum deles carrega token, em nenhuma hipótese | — | — |

Ambos os campos são **aditivos**: um client antigo contra um servidor novo continua
entrando pela aprovação, e um client novo contra um servidor antigo manda um campo que
o servidor ignora. Os testes existentes leem `payload.maxParticipants` por campo, não por
igualdade profunda — o campo novo não os quebra.

### Contrato interno do `RoomStore` (pseudológica, não código)

```
issueResumeToken(roomId, socketId, displayName) -> token
    varre entradas expiradas da sala
    remove qualquer entrada com o mesmo (roomId, socketId)
    token := createToken()
    registra { roomId, socketId, displayName, expiresAt: null }
    devolve token

armResumeGrace(roomId, socketId) -> void
    para a entrada de (roomId, socketId), se existir:
        expiresAt := now() + RESUME_GRACE_MS
    varre entradas expiradas da sala

consumeResumeToken(token, roomId) -> { displayName } | null
    entrada := registro[token];              se ausente            -> null
    se entrada.roomId != roomId                                    -> null
    se entrada.expiresAt é null (socket nunca caiu)                -> null
    se now() >= entrada.expiresAt                                  -> deleta, null
    se a sala não existe ou está vazia                             -> null
    se a sala contém entrada.socketId (socket vivo)                -> null
    deleta registro[token]        // uso único, ANTES de devolver
    devolve { displayName: entrada.displayName }

reservedSeats(roomId) -> número de entradas da sala com expiresAt != null e now() < expiresAt
isFull(roomId)        -> room.size + reservedSeats(roomId) >= MAX_PARTICIPANTS
```

### Pseudológica do handler `join-request` (ordem observável)

```
se roomId inválido                  -> join-denied{invalid-room}; recordJoin('invalid_room'); fim
nome := sanitizeDisplayName(payload.displayName)
se resumeToken tem forma válida:
    retomada := rooms.consumeResumeToken(resumeToken, roomId)
    se retomada != null:
        admitToRoom(socket, roomId, retomada.displayName)   // nome do registro, §3.9
        recordJoin('resumed')                               // depois dos emits
        fim                                                  // NENHUM broadcast de join-request
se rooms.isFull(roomId)             -> join-denied{room-full}; recordJoin('room_full'); fim
se rooms.isEmpty(roomId)            -> admitToRoom(...); recordJoin('admitted'); fim
pendingJoins.set(...); broadcast join-request aos membros     // como hoje
```

### Schema de Banco

Não se aplica. O produto não tem banco, e esta entrega não cria o primeiro.

### Chave de `sessionStorage` (client)

| Chave | Valor | Escopo | Some quando |
|---|---|---|---|
| `wtk-meet:resume:<roomId>` | token hex de 64 chars | Aba (`sessionStorage`), por origem | A aba fecha, a pessoa sai pela UI, ou é sobrescrita na próxima admissão |

---

## 6. Dependências e Ordem de Implementação

1. **`rooms.ts`: constante, registro e métodos** (`RESUME_GRACE_MS`, `ResumeEntry`,
   `issueResumeToken`, `armResumeGrace`, `consumeResumeToken`, reservas em `isFull`,
   limpeza em `removeMember`, `createToken` injetável). Fundação de tudo. — *sem
   dependências*
2. **`test/rooms.test.ts`: casos do registro** com `now` e `createToken` injetados —
   emissão, rotação, consumo único, expiração no limite exato, token de outra sala,
   token de socket vivo, reserva contando em `isFull`, reserva fora do `snapshot`,
   morte junto com a sala. — *depende de 1*
3. **`telemetry.ts`: `resumed` em `JoinOutcome`** e comentário do `CARDINALITY_LIMIT`
   (5 → 6). — *independente de 1 e 2; pode ir em paralelo*
4. **`index.ts`: handler, `admitToRoom` e `leaveCurrentRoom`** — ordem do §3.8, token no
   `join-approved`, motivo na saída. — *depende de 1 e 3*
5. **`test/signaling.test.ts`: integração do servidor** — retomada sem broadcast,
   token ruim caindo na aprovação, vaga reservada, rotação ponta a ponta. Expiração aqui
   **não** se testa com relógio de parede: prove-a na camada 2. — *depende de 4*
6. **`lib/resumeToken.ts` + teste puro** do client. — *independente de 1–5; pode ir em
   paralelo desde o início*
7. **`lib/signaling.ts`**: assinaturas de `requestJoin` e `leaveRoom`. — *depende de 6*
8. **`pages/Room.tsx`**: gravar no `join-approved`, ler no `connect`, nova assinatura no
   cleanup. — *depende de 7*
9. **Teste de integração do client** (`test/resumeSignaling.test.ts`), no padrão de
   `test/joinRequestSignaling.test.ts`: servidor real, dois sockets, F5 simulado por
   desconexão e reconexão com o token. — *depende de 4 e 7*
10. **Documentação**: `ARCHITECTURE.md` §4/§5/§10, os dois READMEs,
    `docs/progress/WTK-MEET-25.md`. — *depende de tudo estar decidido; escreva por
    último, mas não deixe de fora*

Passos 1→2→4→5 são o caminho crítico. 3 e 6 podem começar junto com 1.

---

## 7. Riscos e Armadilhas

### 7.1 A vaga reservada barra um desconhecido numa sala que parece ter 5 pessoas

- **Risco:** a sala mostra 5 tiles e responde `room-full`. Quem está de fora acha que o
  produto está quebrado.
- **Mitigação:** é comportamento decidido (§3.7). Deixe escrito no README e no
  `ARCHITECTURE.md`, e não tente "consertar" na UI. A reserva dura no máximo 60s.
- **Anti-pattern a evitar:** liberar a reserva "se a sala estiver cheia", que é
  exatamente quando ela precisa existir.

### 7.2 Testar expiração com timer real

- **Risco:** um teste que espera 60s (ou, pior, que reduz a constante por variável de
  ambiente) — suíte lenta e intermitente.
- **Mitigação:** o `RoomStore` já injeta `now`. Teste a expiração com relógio fabricado,
  incluindo o limite exato (`now === expiresAt` ⇒ expirado).
- **Anti-pattern a evitar:** tornar `RESUME_GRACE_MS` configurável por `process.env` só
  para o teste. Isso vira superfície de configuração de produção que ninguém pediu.

### 7.3 StrictMode do React apaga o token no F5 (ambiente de dev)

- **Risco:** o cleanup do efeito de `Room.tsx` chama `leaveRoom()`. Em dev, o
  `React.StrictMode` (`src/main.tsx`) monta → limpa → monta. A limpeza fantasma rodaria
  `clearResumeToken` **antes** de a segunda montagem ler a chave, e a retomada nunca
  funcionaria com `npm run dev` — funcionando no build do E2E e falhando na mão de quem
  desenvolve, que é o pior dos dois mundos para diagnosticar.
- **Mitigação:** `leaveRoom` só limpa a chave **se o socket estiver conectado**. Na
  limpeza fantasma o `connect` ainda não completou, então nada é apagado; na saída real
  pelo botão "Sair da sala" (`Room.tsx:1829` → `navigate('/')` → unmount) o socket está
  conectado e a chave some. A semântica até melhora: "só apaga o token de uma sessão que
  chegou a existir".
- **Anti-pattern a evitar:** trocar a limpeza por um `beforeunload`/`pagehide`. O F5
  passa por lá — apagaria o token exatamente no caso que a task existe para resolver.

### 7.4 Deletar o token depois de admitir

- **Risco:** um `return` antecipado ou uma exceção entre a validação e a deleção deixa a
  entrada viva e reutilizável — replay silencioso.
- **Mitigação:** `consumeResumeToken` deleta **antes** de devolver, e é a única porta de
  leitura do registro. Nenhum outro caminho no `index.ts` toca no `Map`.
- **Anti-pattern a evitar:** um `peekResumeToken` "só para checar" ao lado do consume.

### 7.5 O token vazando por onde ninguém olha

- **Risco:** um `console.log` de depuração no handler, uma mensagem de erro que ecoa o
  payload, um atributo de métrica, ou o token entrando no `peer-joined`.
- **Mitigação:** o token só existe em dois lugares do fio: o campo de entrada do
  `join-request` e o `join-approved` do próprio dono. Vale acrescentar um caso ao
  `telemetryNoLeak.test.ts` ou irmão: nenhuma métrica exportada contém atributo cujo
  valor case com o formato do token. O projeto já tem precedente forte disso.
- **Anti-pattern a evitar:** logar um prefixo do token ("só os 8 primeiros") para
  depurar. Continua sendo o token em log, e ninguém remove depois.

### 7.6 Sala que esvazia durante a graça

- **Risco:** tratar a reserva como motivo para manter a sala viva, criando uma sala
  fantasma de 60s que aparece em `wtk_rooms_active`, responde `occupancy: true` e adia o
  `wtk_room_lifetime_seconds`.
- **Mitigação:** a sala continua morrendo quando o último membro sai, e os tokens dela
  morrem junto. Quem volta para uma sala que não existe mais é o **primeiro** a entrar e
  é admitido sozinho (`admitted`), que é o comportamento certo e já existente.
- **Anti-pattern a evitar:** segurar `rooms.delete` até a graça acabar.

### 7.7 Graça armada na saída explícita

- **Risco:** `leaveCurrentRoom` serve a `leave-room` e a `disconnect`; armar em ambos faz
  quem saiu de propósito segurar uma cadeira.
- **Mitigação:** motivo explícito no parâmetro (§3.3), e um teste que prove que sair pela
  UI e voltar em 5s **pede aprovação**.

### 7.8 Confundir retomada com reconexão de mídia

- **Risco:** alguém "aproveitar" o token para tentar preservar `RTCPeerConnection`,
  reaproveitar `selfId` ou suprimir `peer-left`/`peer-joined`.
- **Mitigação:** o DoD é explícito — a malha não muda. O `selfId` **é** o `socket.id`
  novo, e `Room.tsx` já o reescreve no `join-approved`.
- **Anti-pattern a evitar:** tentar manter o mesmo `selfId` entre as duas sessões. Isso
  reintroduz identidade estável no protocolo, que é exatamente o que o §5 nega.

### 7.9 `sessionStorage` indisponível

- **Risco:** modo privado, política de cookies de terceiros ou storage cheio fazem
  `getItem`/`setItem` lançarem, e uma exceção no handler de `join-approved` deixaria a
  pessoa fora da sala por causa de uma otimização.
- **Mitigação:** todo acesso dentro de `try/catch` no módulo puro, degradando para
  "sem token" (§3.10). Cubra o caso com uma `Storage` fajuta que lança.

### 7.10 A suíte do servidor e a porta sorteada

- **Risco:** testes novos que subam servidor em porta fixa colidem com os arquivos que
  rodam em paralelo (memória [[wtk-meet-porta-sorteada-trava-a-suite]]).
- **Mitigação:** peça a porta ao SO, como `joinRequestSignaling.test.ts` já faz
  (`freePort()`), e feche os sockets no `after`.

### 7.11 Acúmulo de entradas expiradas

- **Risco:** sem varredura, uma sala de vida longa com rotatividade acumula entradas
  mortas até a sala esvaziar.
- **Mitigação:** sweep nos caminhos de escrita daquela sala (§3.13). É O(≤ poucas
  entradas), sem timer.

---

## 8. Critérios de Aceite Técnicos

**Retomada**

1. Admitido numa sala, o participante recebe `join-approved` contendo `resumeToken` —
   string hex de 64 caracteres. Vale para as três admissões: primeira da sala, aprovada e
   retomada.
2. Com a sala tendo outro membro, um socket que se conecta e emite `join-request` com um
   `resumeToken` válido recebe `join-approved` **e nenhum membro da sala recebe o evento
   `join-request`**. O `JoinRequestModal` não aparece na tela de ninguém.
3. O `join-approved` da retomada traz um `resumeToken` **diferente** do apresentado.
4. Reapresentar o token já consumido não retoma: o pedido cai na fila de aprovação.
5. A retomada preserva o `displayName` que estava registrado, mesmo que o payload mande
   outro nome.

**Token que não vale — e nunca nega**

6. Token ausente, com forma inválida, de outra sala, expirado ou já usado ⇒ o pedido
   segue para a fila de aprovação normal. Em nenhum desses casos o requisitante recebe
   `join-denied` por causa do token.
7. Com o socket original ainda conectado na sala, o mesmo token apresentado por um
   segundo socket **não** retoma (cai na aprovação) e não remove ninguém da sala.
8. Um pedido com `resumeToken` de tipo inesperado (número, objeto, string gigante) é
   tratado como ausente, sem lançar e sem derrubar o processo.

**Janela de graça**

9. Com relógio injetado, um token armado é retomável em `expiresAt - 1` e não é retomável
   em `expiresAt` nem depois.
10. Um token cujo socket **nunca** desconectou não é retomável em nenhum instante.
11. Sair pela UI (`leave-room`) e reconectar em seguida com o token: cai na aprovação.
    Cair (`disconnect`) e reconectar com o token: retoma.

**Vaga reservada**

12. Sala com `MAX_PARTICIPANTS` membros; um deles cai. Dentro da janela, um socket novo
    **sem** token recebe `join-denied { reason: 'room-full' }`, e quem caiu retoma com
    sucesso — nunca recebe `room-full`.
13. No instante da retomada, a sala tem no máximo `MAX_PARTICIPANTS - 1` membros.
14. `snapshot().participants` conta apenas membros conectados: a vaga reservada **não**
    aparece no gauge.
15. Quando o último membro de uma sala cai, a sala é deletada e o token dela deixa de
    existir; ao voltar, a pessoa é admitida como primeira da sala (desfecho `admitted`).

**Telemetria e sigilo**

16. `wtk_joins_total` recebe `outcome="resumed"` em cada retomada bem-sucedida, e
    continua recebendo `admitted`/`approved`/`denied`/`room_full`/`invalid_room` nos
    casos de hoje.
17. Nenhum ponto de dado exportado, nenhuma linha de log e nenhuma mensagem de erro
    contém o valor do token ou parte dele.
18. O token não viaja em `peer-joined`, `join-denied`, `join-request` (broadcast),
    `join-request-cancelled` nem `signal`.

**Client**

19. Ao receber `join-approved` com token, a chave `wtk-meet:resume:<roomId>` passa a
    conter exatamente esse valor; uma admissão seguinte a sobrescreve.
20. Ao sair pela UI, a chave daquela sala é removida do `sessionStorage`.
21. Com `sessionStorage` lançando em `getItem`/`setItem`, a entrada na sala funciona
    normalmente, apenas sem retomada.
22. O token gravado para a sala A nunca é enviado num `join-request` da sala B.

**Regressão**

23. `npm test` fecha em 56/56 no servidor (mais os casos novos) e 520/520 no client (mais
    os casos novos); `npm run typecheck` e `npm run lint` limpos.
24. O `packages/e2e/run.ts` não regride além da linha de base medida **nesta branch**
    antes da primeira linha de código (memória [[wtk-meet-e2e-f4a-falha-preexistente]]).

---

## 9. Notas para os Agentes de Implementação

**Divisão sugerida**

- *Agente de backend*: passos 1–5 do §6. É o miolo da entrega e concentra todo o risco de
  correção.
- *Agente de frontend*: passos 6–9. Pode começar pelo passo 6 (módulo puro + teste) sem
  esperar o backend; só o passo 9 precisa do servidor pronto.
- *Documentação*: passo 10, por quem fechar por último.

**Pitfalls específicos desta demanda**

- **Meça a linha de base antes de escrever qualquer coisa.** A main deste projeto já
  chegou quebrada em entregas anteriores. Rode `npm install` na raiz e depois
  `npm test`, `npm run typecheck` e `npm run lint`. Se vier vermelho antes da sua
  primeira linha, registre em `docs/progress/WTK-MEET-25.md` e siga — não conserte a main
  dentro desta task.
- **Este documento não tem autoridade sobre o DoD.** Onde eu tiver contrariado a task, a
  task vence; anote a divergência no log em vez de silenciá-la. Onde a task é omissa
  (§3.9 nome na retomada, §3.12 validação de forma, §3.13 expiração preguiçosa, §7.3
  guarda do StrictMode), estas decisões valem — e se alguma delas se mostrar errada na
  implementação, registre o motivo.
- **`consumeResumeToken` é a única porta de leitura do registro.** Não exponha getters de
  conveniência; a deleção acontece lá dentro, antes do retorno.
- **`leaveCurrentRoom` tem dois chamadores com semânticas diferentes.** Se você só
  encontrar um, procure de novo: `leave-room` e `disconnect`.
- **A ordem dos `emit` é contrato.** `test/signaling.test.ts` e `test/telemetry.test.ts`
  caracterizam a ordem observável dos eventos; todo `recordJoin` continua **depois** dos
  `emit` do handler, inclusive o novo `resumed`.
- **Nada de `setTimeout` para expirar token.** Relógio injetado e leitura preguiçosa.
- **Não toque no `snapshot()`.** Se um teste de gauge mudar de valor, a reserva vazou
  para onde não devia.

**Ordem de validação depois de implementar**

1. `npm test` no servidor — os casos de `rooms.test.ts` primeiro, que são os que provam
   a lógica sem rede.
2. `npm test` no client.
3. `npm run typecheck` e `npm run lint` na raiz.
4. `npm run test:e2e`, comparando com a linha de base **desta** branch.
5. Verificação manual que nenhum teste automatizado cobre bem: duas abas, sala com duas
   pessoas, F5 na segunda — a primeira não pode ver modal nenhum, e o tile da segunda
   deve voltar com o mesmo nome em poucos segundos.
