# WTK-MEET-25 — Readmitir sem aprovação quem recarrega a página ou reconecta

> Status: **COMPLETED** (implementação, testes, docs)
> Branch: `agent/wtk-meet-25-readmitir-sem-aprova-o-quem-recarrega-a-`
> Documento de arquitetura: `docs/agents/arch-temp-readmissao-token-de-retorno.md`

## Linha de base, medida **antes** da primeira linha de código

`npm install` na raiz (workspaces), depois `npm test` por pacote:

| Pacote | Antes | Depois | Delta |
|---|---|---|---|
| `wtk-meet-server` | **98/98** verdes | **124/124** verdes | +26 casos novos |
| `wtk-meet-client` | **571/574** — 3 vermelhos | **582/585** — os **mesmos** 3 vermelhos | +11 casos novos |

`npm run typecheck` e `npm run lint`: limpos nos três pacotes, antes e depois (o único
aviso do lint, `react-hooks/exhaustive-deps` em `src/lib/useMusicRoom.ts:844`, é
pré-existente e fica de fora desta entrega).

### A base do client chegou vermelha, e não foi consertada aqui

Três casos de `packages/client/test/roomPhases.test.ts` (a partir da linha 708) já
falhavam nesta branch antes de qualquer edição:

- `path que não é sala volta para a Home, sempre com replace`
- `path não canônico é redirecionado para o slug, preservando o hash`
- `path sem hash ganha uma passphrase gerada, e o redirect é replace`

O sintoma é o mesmo nos três: o redirect é registrado **duas vezes** em
`cena.navegacoes` (`['/', { replace: true }]` duplicado), e a asserção é de igualdade
profunda com uma entrada só. É o efeito de canonicalização de rota disparando duas
vezes; nenhum dos três toca em sinalização, em `signaling.ts` ou em token de retorno, e
nenhum arquivo de rota foi modificado por esta task (`git diff` em
`src/lib/roomRouting.ts` e `test/roomPhases.test.ts` está vazio).

Conforme a instrução da task ("se a base estiver vermelha antes da sua primeira linha de
código, registre isso no log da task em vez de tentar consertar a main"), fica registrado
e **não** foi consertado aqui. Vale abrir task própria — o candidato mais provável é a
PR #33 (`3dfc6bb`, redesign da UI), que é o commit mais recente a mexer em `Room.tsx`.

## O que foi implementado

### Servidor

- `rooms.ts`: `RESUME_GRACE_MS = 60_000` **exportada**; `ResumeEntry`; `Map` privado
  `token → { roomId, socketId, displayName, expiresAt }`; `createToken` injetável ao lado
  do `now` já existente; `issueResumeToken`, `armResumeGrace`, `discardResumeTokens`,
  `consumeResumeToken`, `reservedSeats` (privado), `sweepExpired` (privado).
- `isFull` passou a somar reservas; `snapshot()` **não** mudou — o gauge conta gente
  conectada, não cadeiras.
- `removeMember` apaga os tokens da sala junto com a sala.
- `index.ts`: `resumeToken?: unknown` no payload, validação de forma (`isResumeTokenShaped`,
  64 chars hex, `length` antes do regex), tentativa de retomada **antes** do `isFull`,
  token novo em todo `join-approved`, e `leaveCurrentRoom(socket, reason)` armando a graça
  só no `disconnect`.
- `telemetry.ts`: `resumed` em `JoinOutcome`; comentário do `CARDINALITY_LIMIT` de 5 → 6.

### Client

- `lib/resumeToken.ts` (novo): módulo puro, `Storage` por parâmetro, tudo em `try/catch`.
- `lib/signaling.ts`: grava o token no `join-approved`, reenvia no `join-request`,
  `leaveRoom(roomId)` apaga a chave — com a guarda do `socket.connected`.
- `pages/Room.tsx`: só a assinatura nova do `leaveRoom` no cleanup.

## Divergências em relação ao documento de arquitetura

O documento avisa (§9) que não tem autoridade sobre o DoD e pede que divergências sejam
registradas em vez de silenciadas. São duas.

### 1. Quem grava o token é `signaling.ts`, não `Room.tsx`

O §4 do documento punha a gravação no handler de `join-approved` do `Room.tsx` e deixava
`requestJoin` receber o token por parâmetro. Isso deixaria o passo "gravou?" exercitável
só com jsdom — e o item 9 do DoD pede justamente um teste de client **sem** jsdom
cobrindo os três momentos (grava, reenvia, apaga).

Os três passaram para `createSignalingClient`, com a `Storage` injetável. Efeitos:
`requestJoin(roomId, displayName)` manteve a assinatura de duas posições (lê o token
sozinho), `Room.tsx` mudou uma linha só, e o ciclo inteiro é testado em `node --test`.
Nenhum item do DoD foi enfraquecido — a chave, o momento da gravação e a limpeza na saída
são exatamente os pedidos.

### 2. `token expirado` no `signaling.test.ts` é provado com relógio injetado

O item 8 do DoD pede o caso "token expirado cai na aprovação" em
`packages/server/test/signaling.test.ts`, que sobe o servidor num processo filho. Um
token só expira 60 segundos depois da queda, e o processo filho usa `Date.now()` real: o
caso, ali, só existiria esperando 60s de relógio de parede ou tornando `RESUME_GRACE_MS`
configurável por ambiente — que o §7.2 do documento chama de anti-pattern (superfície de
configuração de produção criada só para o teste), e que o item 3 do DoD contradiz ao pedir
relógio injetável justamente "para os testes não usarem timer real".

O caso está no arquivo pedido e se chama `token expirado cai na aprovação — provado no
relógio, não no cronômetro`. Ele faz as duas metades: prova a expiração na borda exata com
um `RoomStore` de relógio fabricado (a mesma unidade que o servidor instancia) e, no fio,
prova o que de fato importa para quem usa o produto — um token que o servidor não
reconhece mais **não nega entrada a ninguém**, cai na fila de aprovação. A cobertura
completa da janela (borda de dentro, borda exata, varredura) está em `test/rooms.test.ts`.

### 3. Acréscimo: `discardResumeTokens` na saída intencional

O documento só previa "não armar a graça" quando a saída é pelo botão. Isso deixa a
entrada não-armada daquele socket viva até a sala morrer — inofensiva para admissão (só a
queda arma), mas é lixo que se acumula numa sala de vida longa com rotatividade. O método
existe e é chamado no ramo `'leave'`. É higiene de memória, não regra de acesso, e não
contradiz nada do §3.3.

## QA de navegador — os 9 cenários do DoD, no Chromium

Todos passaram. O roteiro está versionado em `docs/progress/wtk-meet-25/`, então é
reexecutável e não vira relato de memória:

| # | Cenário | Resultado |
|---|---|---|
| QA 1 | B dá F5 e volta sozinho; nenhum modal na tela de A | ✔ (mais: token de 64 hex gravado, e **rotacionado** no retorno) |
| QA 2 | B sai pela UI e reabre na mesma aba | ✔ pede aprovação (e a chave já tinha sumido do `sessionStorage`) |
| QA 3 | B fecha a aba e reabre numa aba nova | ✔ pede aprovação |
| QA 4 | B demora mais de 60s para voltar | ✔ pede aprovação, e entra normalmente depois de aprovado |
| QA 5 | Aba duplicada (com o `sessionStorage` copiado) | ✔ a cópia pede aprovação, a original continua na sala, 2 tiles — sem fantasma |
| QA 6 | Sala de 6, um dá F5 | ✔ volta sem `room-full`; e o sétimo estranho continua barrado enquanto ele está fora |
| QA 7 | Sala X e depois sala Y na mesma aba | ✔ Y pede aprovação normal |
| QA 8 | Mídia depois do retorno | ✔ mesh reconectado nos dois sentidos, áudio+vídeo de volta, 2 tiles |
| QA 9 | Vazamento do token | ✔ console do browser limpo; varredura de `[0-9a-f]{64}` no log do servidor: zero ocorrências |

Comandos (com a receita de libs do `claude-progress.md` exportada):

```bash
node docs/progress/wtk-meet-25/qa.ts        > /tmp/qa25.log 2>&1         # QA 1,2,3,5,6,7,8,9
node docs/progress/wtk-meet-25/qa-janela.ts > /tmp/qa25-janela.log 2>&1  # QA 4
```

**Por que o QA 4 tem processo próprio.** Rodando no fim do `qa.ts`, logo depois do
bloco de sala cheia (sete contextos Chromium), o `browser.newContext()` seguinte não
voltava: o cenário travou quinze minutos sem produzir verde nem vermelho, e foi preciso
matar a execução. Com navegador limpo, o mesmo cenário fecha em pouco mais de um minuto.
Não é falha do produto — é saturação do Chromium neste sandbox, o mesmo tipo de
armadilha que a memória do projeto já registra para o E2E.

## Como testar à mão

```bash
npm install
npm test                 # server 124/124; client 582/585 (3 vermelhos pré-existentes)
npm run typecheck
npm run lint

npm run dev:server       # :4000
npm run dev:client       # :5173
```

Duas abas, duas pessoas na mesma sala, F5 na segunda: a primeira não pode ver modal
nenhum, e o tile da segunda volta com o **mesmo nome** em poucos segundos.

## Débito identificado (não implementado)

- Os 3 casos vermelhos de `roomPhases.test.ts` acima — task própria.
- Toasts de "saiu"/"entrou" aparecem em sequência no ciclo queda-e-volta. É cosmético,
  está fora do escopo declarado (§2 do documento) e vira task se incomodar.
- Quem edita o nome no lobby e volta dentro dos 60s reaparece com o nome antigo:
  consequência aceita e documentada no `ARCHITECTURE.md` §5, não tratada.
