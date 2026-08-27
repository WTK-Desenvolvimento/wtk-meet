# WTK-MEET-21 — Instrumentar wtk-meet com telemetria anônima via OTLP

> Documento de arquitetura: `docs/agents/arch-temp-telemetria-anonima-otlp.md`
> Branch: `agent/wtk-meet-21-eu-tenho-uma-stack-completa-de-monitoram`
> Início: 2026-08-27

O registro do que a implementação encontrou — a linha de base medida **antes**, as
decisões tomadas com evidência, as divergências entre documento e realidade, e o que foi
deliberadamente **não** feito.

---

## 1. Linha de base (fase 0)

Medida na árvore intocada, em cima de `1c5ad41` (o commit do documento de arquitetura),
depois de um único `npm install` na raiz — o repositório é monorepo npm workspaces desde
a WTK-MEET-20.

| Portão | Comando | Resultado |
|---|---|---|
| server | `npm -w wtk-meet-server run test` | **56/56**, 0 fail (~28s) |
| client | `npm -w wtk-meet-client run test` | **520/520**, 0 fail (~82s) |
| tipos | `npm run typecheck` (client + server + e2e) | exit 0 |
| lint | `npm run lint` (client + server) | exit 0 |

Estes são **os** números de comparação do item 13 do DoD. Os que aparecem em DoDs antigos
(336 casos, 111/112 checagens de E2E) estão desatualizados desde a WTK-MEET-20 e não
servem de referência — o total cresce a cada entrega.

---

## 2. O que foi implementado

### Servidor

| Arquivo | O que é |
|---|---|
| `src/telemetryEvents.ts` (novo, puro) | O envelope fechado do beacon e `parseBeacon`. Não existe campo para `roomId` nem para `displayName`, e o parse constrói objeto novo campo a campo — chave desconhecida não tem por onde atravessar |
| `src/telemetry.ts` (novo) | Único arquivo do repositório que importa `@opentelemetry/*`. Nove instrumentos, exporter injetável, view catch-all com allow-list, resource explícito, no-op absoluto sem endpoint |
| `src/rooms.ts` | `RoomMeta` efêmero (`openedAt`, `peak`, `joinedAt`) num `Map` paralelo + `roomStats`, `memberJoinedAt`, `snapshot`. Relógio injetável no construtor |
| `src/index.ts` | `initTelemetry` no boot; registro nos pontos de join/deny/leave/disconnect que já existiam; `POST /telemetry`; `/health` aditivo; shutdown com prazo |

### Client

| Arquivo | O que é |
|---|---|
| `src/lib/telemetry.ts` (novo, puro) | `configureTelemetry`, `trackPageView`, `startSession`, transporte e relógio injetáveis, `text/plain` como Content-Type |
| `src/config.ts` | Liga o módulo com `${SIGNALING_URL}/telemetry` e a comparação literal com a string `'false'` |
| `pages/Home.tsx`, `pages/Room.tsx`, `pages/LegacyRoomRedirect.tsx` | Os três call sites de `page_view`, mais a sessão da sala |

### Infra e documentação

`infra/otel/collector.example.yaml`, `infra/otel/dashboards/wtk-meet.json` (9 painéis),
os dois `.env.example`, `docker-compose.yml`, `packages/client/Dockerfile` (o build arg),
seção "Telemetria" no `README.md` e no `README.en.md`, e `ARCHITECTURE.md` §10 mais as
correções de §5, §7 e §8.

---

## 3. Testes acrescentados

| Arquivo | Casos | O que sustenta |
|---|---|---|
| `server/test/telemetryEvents.test.ts` | 11 | O envelope fechado (item 3 do DoD) |
| `server/test/telemetry.test.ts` | 24 | Catálogo, unidades, buckets, allow-list, no-op, degradação e a rota (itens 3, 8, 9, 10) |
| `server/test/telemetryNoLeak.test.ts` | 2 | Fluxo completo com valores reconhecíveis e cardinalidade com 50 salas (itens 2, 6) |
| `server/test/rooms.test.ts` | +5 | A contabilidade efêmera e `snapshot` depois de 50 ciclos (critério 15) |
| `client/test/telemetry.test.ts` | 13 | Rota, duração, idempotência, `enabled:false`, transporte que rejeita (item 8) |
| `client/test/telemetryNoLeak.test.ts` | 4 | As armadilhas nos cinco globais proibidos (item 7) |

Dois deles merecem nota, porque a forma foi escolhida para não passar por acidente:

- **`server/test/telemetryNoLeak.test.ts` afirma sobre os bytes crus.** O collector falso
  guarda o corpo do `POST /v1/metrics` como string, e a busca por `sala-secreta-do-nicolas`
  / `Nicolas Woitchik` / a passphrase é feita nele. Se um `roomId` vazasse por um caminho
  que ninguém imaginou — atributo de resource, descrição de instrumento, nome de escopo —
  ele estaria ali. A prova de que o teste não é vazio: o mesmo arquivo afirma
  `wtk_room_lifetime_seconds.count == 50` no teste de cardinalidade, ou seja, houve
  tráfego de verdade.
- **`client/test/telemetryNoLeak.test.ts` valida as próprias armadilhas.** Antes de
  exercitar o módulo, o teste toca em cada global proibido de propósito e afirma que a
  armadilha registrou. Sem esse controle, um erro na instalação das armadilhas faria o
  teste passar dizendo o contrário do que aconteceu.

---

## 4. Divergências em relação ao documento de arquitetura

Todas conscientes, e nenhuma delas afeta os treze itens do DoD.

### 4.1 Cinco dependências `@opentelemetry/*`, não quatro

O documento (§3.4) previa `api`, `sdk-metrics`, `resources` e `exporter-metrics-otlp-http`.
Entrou também **`@opentelemetry/core`**: `ExportResult` e `ExportResultCode` — o tipo de
retorno de `PushMetricExporter.export`, que o wrapper de aviso throttled precisa
inspecionar — moram nele. Ele já vinha instalado como transitivo dos outros quatro;
declará-lo apenas torna explícito o que já era usado. O total instalado continua sendo
**11 pacotes, todos sob `@opentelemetry/`, nenhum de terceiros**, exatamente como o
documento mediu.

### 4.2 `recordRoomOpened()` não existe

O `Telemetry` de §5.4 listava esse método. Ele não alimenta nenhuma das nove métricas do
catálogo — o número de salas abertas é derivável do que já se exporta (`count` de
`wtk_room_lifetime_seconds` + `wtk_rooms_active`). Um método vazio no contrato seria código
morto convidando alguém a "consertá-lo" acrescentando uma décima métrica fora do DoD.

### 4.3 `joinedAt` fica ao lado de `Member`, não dentro

§4.1 sugeria `Member.joinedAt`. A contabilidade foi para um `Map` paralelo por dois
motivos: `Member` é o estado do produto, e o comentário que o descreve ("o que se guarda
de cada participante — só isto, nada de nome real, nada de IP") é uma promessa que não
deve passar a incluir bookkeeping do observador; e a mudança teria quebrado a forma que
`test/rooms.test.ts` caracteriza hoje (`assert.deepEqual(members, [['socket-a',
{ displayName: '...' }]])`), sem ganho nenhum. É o mesmo princípio do §3.6 do documento,
aplicado um nível abaixo.

### 4.4 As fronteiras de bucket vão em `advice`, não em views por nome

§3.2 pedia uma view catch-all com a allow-list, e §5.3 pedia buckets explícitos por
histograma. As duas coisas juntas, como views, produzem **fluxos duplicados**: quando
duas views casam com o mesmo instrumento, o SDK cria dois metric streams com o mesmo nome.
A solução foi manter **uma** view catch-all (que é onde mora a garantia de privacidade) e
declarar as fronteiras em `advice: { explicitBucketBoundaries }` na criação de cada
histograma — a API que existe exatamente para isso. Verificado no exporter: os quatro
histogramas saem com as fronteiras corretas e um `+Inf` vazio na ocupação.

### 4.5 A duração de sessão do client tem viés declarado

§7.1 pede `pagehide` **e** `visibilitychange → hidden` como gatilhos (é o que faz o beacon
chegar em navegador móvel, onde `pagehide` não é garantido); §5.3 descreve a métrica como
"aba deixa a sala (unmount ou `pagehide`)". Os dois gatilhos foram implementados, como
§7.1 manda — e a consequência está escrita no código, no README, no painel e aqui:
`wtk_client_session_duration_seconds` mede **o tempo até a aba ser escondida ou fechada
pela primeira vez**, não a duração da reunião. Trocar de aba no meio da chamada encerra a
contagem. Quem quer duração de reunião lê `wtk_session_duration_seconds`, medida no
servidor, que não tem esse viés.

### 4.6 Os arquivos de teste da rota foram reorganizados

O documento previa `test/telemetry.test.ts` com os testes de rota e `test/telemetryNoLeak.
test.ts` com o fluxo. Foi isso que se fez, mais um `test/fixtures/telemetryHarness.ts`
compartilhado (collector falso + `startServer`), que não estava previsto e que os dois
arquivos precisavam igualmente.

---

## 5. Duas armadilhas de ambiente encontradas na prática

### 5.1 Porta sorteada colide entre arquivos de teste paralelos

O harness nasceu com `22000 + random(8000)`, no mesmo espírito do de
`turnCredentials.test.ts` (`21000 + random(9000)`). Com seis arquivos rodando em paralelo
(`--test-isolation=process`), cada um subindo vários servidores, duas escolhas iguais
fazem o segundo `listen` falhar — e o sintoma **não** é um erro claro: é o `startServer`
esperando o `/health` de um processo que já morreu, quinze segundos por vez.

Na primeira rodada completa isso travou a suíte do server por mais de seis minutos, com
`turnCredentials.test.ts` segurando um filho órfão. Rodando sozinho, o mesmo arquivo passa
em 27s.

**Conserto:** o harness pede uma porta livre ao **SO** (`net.createServer().listen(0)`),
como `signaling.test.ts` já fazia. E o `telemetry.test.ts` passou a compartilhar **um**
servidor entre os casos que não dependem de configuração — de dez servidores para quatro,
de 27s para 15s no arquivo.

> Vale como regra geral para este repositório: **porta sorteada é bug latente** quando os
> arquivos de teste rodam em paralelo. Peça ao SO.

### 5.2 O `node` do sandbox é v24, e o `engines` diz `>=26`

`npm install` avisa `EBADENGINE` nos três pacotes. Não é regressão desta entrega e não
impede nada — os testes rodam. Registrado porque aparece no log de qualquer install e
pode ser confundido com problema novo.

---

## 6. O `TODO(WTK-MEET-21)` do `vite.config.ts` — decisão

O `packages/client/vite.config.ts` tinha um `TODO(WTK-MEET-21)` apontando para esta task
por causa do identificador, não do assunto: ele trata de `allowedHosts: 'all'`, que (como o
próprio comentário explicava) **não libera host nenhum**, porque o Vite itera o valor e
iterar uma string percorre `'a'`, `'l'`, `'l'`.

O documento (§7.13) recomendava corrigir para `allowedHosts: true` em commit isolado, com
a alternativa aceitável de reetiquetar. **Escolhida a segunda, e por um motivo concreto:**
`true` não é conserto, é afrouxamento — libera qualquer host e remove a proteção contra DNS
rebinding do servidor de desenvolvimento. Ninguém pediu acesso remoto ao dev server, e a
situação atual é a **segura**. O comentário foi reescrito para registrar a decisão e parar
de apontar para uma task entregue; quem precisar de acesso remoto deve listar os hosts
explicitamente, em commit próprio.

---

## 7. Portões (fase 7)

| Portão | Linha de base | Depois |
|---|---|---|
| `npm -w wtk-meet-server run test` | 56/56 | **98/98** (+42) |
| `npm -w wtk-meet-client run test` | 520/520 | **537/537** (+17) |
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run lint` | exit 0 | exit 0 |

Nenhum teste existente foi removido, e nenhum ganhou `skip`. Três asserções existentes
mudaram, todas pelo mesmo motivo aditivo: `/health` passou a responder
`telemetry: { enabled: false }` além de `ok` e `turn`, e os `deepEqual` que descrevem a
forma exata do corpo foram atualizados (`signaling.test.ts` ×1, `turnCredentials.test.ts`
×2).

**E2E:** ver §8.

---

## 8. E2E

`npm run test:e2e` sobe três contextos Chromium, um coturn local e faz o build do client —
dez minutos por rodada, com passos historicamente intermitentes por temporização do
sandbox. A entrega **não** acrescenta checagem de E2E (era escopo declarado do documento),
e o produto não muda de comportamento observável: nenhum evento novo de Socket.IO, nenhum
payload alterado, e a telemetria roda como no-op sem `OTEL_EXPORTER_OTLP_ENDPOINT` — que é
o ambiente do E2E.

O portão relevante é a ausência de regressão, e a falha conhecida F4a é pré-existente
(ver `docs/progress/WTK-MEET-20.md`). Compare sempre contra a **sua** linha de base, não
contra números de DoDs antigos.

---

## 9. O que ficou de fora, e por quê

- **Traces e logs.** Escopo declarado do documento. Os dois pipelines estão escritos e
  comentados em `infra/otel/collector.example.yaml`: um trace de sinalização carrega
  `roomId` em atributo de span por default, e ligá-lo exige uma decisão de privacidade que
  não cabia aqui.
- **Métricas de mídia** (bitrate, packet loss, jitter, `getStats()`). São dados por-peer
  medidos no navegador, e o caminho até o servidor recriaria exatamente o identificador que
  esta entrega se recusa a criar.
- **Alertas e SLOs.** O painel é entregue; regras de alerta são decisão de operação.
- **Autenticação do `/telemetry`.** Não é possível sem quebrar a premissa: credencial no
  bundle é pública por construção, e id de sessão é o identificador proibido. O que
  substitui está em `ARCHITECTURE.md` §10.6 e §10.8 — e o README diz com todas as letras
  que os números do client são falsificáveis.
