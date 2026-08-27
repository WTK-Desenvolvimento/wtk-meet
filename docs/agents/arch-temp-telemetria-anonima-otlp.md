# Instrumentar wtk-meet com telemetria anônima via OTLP — Documento de Arquitetura Técnica

> Gerado em: 2026-08-27
> Status: Rascunho
> Task: WTK-MEET-21 (`01a04391-6c53-76c4-9b67-cf2c96701c66`), estimativa do board: 16h
> Branch: `agent/wtk-meet-21-eu-tenho-uma-stack-completa-de-monitoram`
> Coluna de origem: **Architect Design** → próximo destino: **Development**

---

## 1. Contexto e Objetivo

Hoje o processo do servidor **não emite um único número**. Ele já sabe tudo o que seria
preciso saber — `RoomStore` (`packages/server/src/rooms.ts`) tem a sala inteira em um
`Map`, e `index.ts` vê cada `join-request`, cada `approve-join`, cada `deny-join` e cada
`disconnect` — mas esse conhecimento morre no processo. O único sinal operacional que
existe é `console.warn`/`console.error` em três lugares (TURN ausente, TURN 502, erro de
setup do `Room`), o que significa que perguntas triviais de operação não têm resposta:
quantas salas estão abertas agora, quantas pessoas em média por sala, quanto tempo dura
uma chamada, quantas entradas foram recusadas por sala cheia, se alguém sequer abriu a
Home hoje.

O usuário já tem a stack de monitoramento de pé — OpenTelemetry Collector / Grafana Alloy
fazendo fan-out para Prometheus, Tempo e Loki. Esta entrega adiciona a camada que
**alimenta** essa stack, e nada mais: nenhum backend novo, nenhum banco, nenhum agente de
APM, nenhuma dependência de SaaS.

**Comportamento esperado após a entrega:**

- O servidor exporta métricas **agregadas** por OTLP/HTTP para o endpoint configurado em
  `OTEL_EXPORTER_OTLP_ENDPOINT`. Sem essa variável, ele se comporta **exatamente** como
  hoje, com um aviso de boot no mesmo tom do aviso de TURN ausente.
- O client envia beacons anônimos e stateless para um `POST /telemetry` **no próprio
  servidor de sinalização** — que é o único ponto de saída do sistema para a stack de
  monitoramento. O navegador nunca fala com o collector.
- Nenhum identificador é criado: nem cookie, nem `localStorage`, nem UUID de aba, nem
  hash de sala. É por isso que não há banner de consentimento — e essa é a parte mais
  fácil de alguém reverter por engano no futuro, então ela é sustentada por **teste**,
  não por convenção.
- Nada no protocolo observável muda: os mesmos eventos Socket.IO, na mesma ordem, com os
  mesmos payloads.

### 1.1 Por que isto é delicado neste projeto especificamente

O wtk-meet vende privacidade como recurso, não como conformidade. `ARCHITECTURE.md` §5
mantém uma tabela literal do que o servidor sabe e do que ele **nunca** sabe, e o README
tem uma seção inteira ("O que fica fora do servidor") escrita para ser lida por quem
desconfia. Uma camada de telemetria é, por definição, um cano novo saindo do processo — e
a diferença entre "métrica agregada" e "vigilância discreta" está em detalhes que não
aparecem em code review distraído: um label `room` aqui, um `sessionId` ali, um
`X-Forwarded-For` gravado em log acolá.

O documento inteiro existe para tornar essa fronteira **estrutural**, e não disciplinar:
se o tipo do evento não tem campo para `roomId`, não há caminho por onde ele vaze.

---

## 2. Escopo

**Dentro do escopo:**

- Módulo de telemetria no servidor (`telemetry.ts`) com instrumentos OTel e exporter
  OTLP/HTTP injetável, e um núcleo puro de validação de beacon (`telemetryEvents.ts`).
- Instrumentação dos pontos de ciclo de vida que já existem em `index.ts` e no
  `RoomStore`: entrada admitida/aprovada/recusada, duração de sessão de socket,
  nascimento e morte de sala, pico de ocupação.
- `POST /telemetry`: endpoint público, sem autenticação, com envelope fechado, limite de
  corpo de 1 kB e rate limit em memória.
- `GET /health` estendido de forma aditiva com `telemetry: { enabled: boolean }`.
- Módulo puro de telemetria no client (`lib/telemetry.ts`) + ligação em `config.ts` +
  três call sites (`Home`, `Room`, `LegacyRoomRedirect`).
- Testes: contrato de eventos, instrumentos/buckets, no-op sem configuração,
  degradação com collector fora do ar, **cardinalidade constante** e **não-vazamento**
  (server e client).
- Infra versionada: `infra/otel/collector.example.yaml` e
  `infra/otel/dashboards/wtk-meet.json`.
- Documentação: seção nova em `ARCHITECTURE.md`, seções em `README.md` e `README.en.md`,
  `.env.example` dos dois pacotes, `docker-compose.yml`, `docs/progress/WTK-MEET-21.md`.

**Fora do escopo:**

- **Traces e logs.** A stack faz fan-out para Tempo e Loki, mas esta entrega exporta
  **apenas métricas**. O `collector.example.yaml` deixa os dois pipelines escritos e
  comentados como extensão futura — um trace de sinalização carregaria `roomId` em
  atributo de span por default e exigiria uma rodada de decisão de privacidade que não
  cabe aqui.
- **Qualquer métrica de mídia** (bitrate, packet loss, jitter, `getStats()` do
  `RTCPeerConnection`). São dados por-peer, medidos no navegador, e o caminho até o
  servidor recriaria exatamente o identificador que esta entrega se recusa a criar.
- **Métricas por sala, por participante ou por origem.** Não é uma limitação temporária:
  é o item 2 do DoD, e está em §3.2 como decisão.
- **Banner/modal de consentimento e página de política.** Ausência justificada em §3.3.
- **Autenticação do `/telemetry`.** Autenticar exigiria credencial no bundle (pública por
  construção) ou um identificador de sessão (proibido). Ver §7.6 para o que substitui.
- **Alertas e SLOs.** O painel é entregue; regras de alerta são decisão de operação.
- **`packages/e2e/`.** O E2E não ganha checagem nova; ele é usado só como portão de
  não-regressão (item 13 do DoD).
- **O `TODO(WTK-MEET-21)` de `packages/client/vite.config.ts`.** Ver §7.13 — a decisão
  está registrada lá, mas não é trabalho de telemetria.

---

## 3. Decisões Arquiteturais

### 3.1 O servidor de sinalização é o único ponto de saída

**Decisão:** o navegador nunca fala com o collector. Ele envia um beacon para
`POST /telemetry` no mesmo servidor com que já fala (`SIGNALING_URL`), e o servidor
converte o beacon nas mesmas métricas agregadas que já exporta.

**Motivação:** três razões, todas concretas.

1. O endpoint do collector nunca fica exposto publicamente, nem no bundle. Um
   `VITE_OTEL_ENDPOINT` seria legível por qualquer pessoa que abrisse o DevTools, e um
   collector OTLP aberto na internet é um vetor de flood contra o Prometheus.
2. Se o navegador falasse OTLP, o collector veria o **IP de cada participante**. Falando
   com o servidor de sinalização — que já vê esse IP, por necessidade técnica de manter
   um WebSocket — não há nenhum observador novo.
3. O que sai do processo continua sendo um único formato, por um único cano, com um
   único conjunto de instrumentos: a prova de não-vazamento tem **um** lugar para olhar.

**Alternativas descartadas:**

- *SDK OTel no browser exportando direto* — descartada pelos três motivos acima, e porque
  o bundle cresceria com uma dependência de runtime nova no client (hoje: React, router,
  socket.io-client, e nada mais).
- *Nenhuma métrica de client* — descartada porque page view e tempo de aba são
  exatamente as duas perguntas que o servidor **não** consegue responder sozinho: ele não
  vê quem abriu a Home e desistiu, nem a aba que ficou aberta na sala depois do socket
  cair.

### 3.2 Agregado sem label de sala, de participante ou de origem

**Decisão:** o conjunto de séries temporais exportadas é **fixo e conhecido em tempo de
compilação**. As únicas chaves de atributo que existem no sistema inteiro são `outcome`
(valores `admitted|approved|denied|room_full|invalid_room` em `wtk_joins_total`;
`accepted|rejected` em `wtk_telemetry_beacons_total`) e `route`
(`home|room|legacy` em `wtk_page_views_total`). Nenhum `roomId`, nenhum `socketId`,
nenhum `displayName`, nenhum IP, nenhum `Origin`, nenhum User-Agent — **nem hasheados**.

**Motivação:** o endereço da sala é secreto por desenho. Desde a WTK-MEET-10 ele é um
slug curto e adivinhável (`/daily`), e a chave de E2EE vive no fragmento da URL, que
nunca chega ao servidor. Um label `room="daily"` transformaria "quem está reunido agora"
em série temporal **persistida** no Prometheus — que é exatamente o banco de dados que o
produto se orgulha de não ter. Um label hasheado é pior, porque parece resolvido: com um
espaço de nomes prováveis (`daily`, `suporte`, `1x1-nicolas`), o hash é reversível por
força bruta em segundos, e continua sendo um identificador estável de sala ao longo do
tempo.

O segundo motivo é operacional e vale por si: cardinalidade constante significa que o
custo de armazenamento do Prometheus **não depende do uso do produto**. Uma instalação
com 10 salas e uma com 10 000 geram o mesmo número de séries.

**Reforço estrutural (não é só disciplina):** além do desenho dos call sites, a
configuração do `MeterProvider` leva uma *view* catch-all (`instrumentName: '*'`) com
`attributesProcessors: [createAllowListAttributesProcessor(['outcome', 'route'])]`. Um
atributo acrescentado por engano em qualquer call site futuro é **descartado antes da
agregação**, e não vira série. Some-se `aggregationCardinalityLimit` como teto duro.

**Alternativas descartadas:**

- *Label de sala com `aggregationCardinalityLimit` alto* — resolveria o custo, não o
  sigilo.
- *Exemplars apontando para traces por sala* — mesma objeção, com um cano a mais.

### 3.3 Nenhum identificador ⇒ nenhum consentimento a pedir

**Decisão:** o produto não cria, não lê e não persiste identificador de usuário, de aba
ou de sala para fins de telemetria. Consequentemente não há banner de cookies nem tela de
consentimento — e a ausência é uma **consequência declarada**, não um esquecimento.

**Motivação:** a base legal para banner é o armazenamento/leitura de informação no
terminal do usuário e o tratamento de dado pessoal. Um contador de page views por rota,
sem identificador, sem IP e sem User-Agent, não é nenhum dos dois. O que sustenta isso ao
longo do tempo não é este parágrafo: é o teste do item 7 do DoD, que **falha** se o
módulo de telemetria do client tocar `localStorage`, `sessionStorage`,
`document.cookie`, `crypto.randomUUID` ou `Math.random`.

**Consequência que precisa estar escrita no `ARCHITECTURE.md`:** reintroduzir qualquer
identificador — inclusive "só um id de sessão para deduplicar" — **reabre** a exigência de
consentimento e invalida esta decisão. Quem reintroduzir tem que trazer o banner junto.

**Alternativas descartadas:**

- *Cookie de sessão de 30 min "só para não contar a mesma aba duas vezes"* — é o começo
  clássico da erosão. A duplicação que ele evitaria (`page_view` dobrado num reload) não
  vale a promessa que ele quebra.
- *Hash de IP+UA como identificador anônimo* — é dado pessoal pseudonimizado, não
  anônimo, e o produto não precisa dele para responder nenhuma das perguntas de §1.

### 3.4 SDK oficial do OpenTelemetry, atrás de uma interface de uma função

**Decisão:** usar `@opentelemetry/api`, `@opentelemetry/sdk-metrics`,
`@opentelemetry/resources` e `@opentelemetry/exporter-metrics-otlp-http`, com o exporter
**injetado** em `initTelemetry({ exporter })` por trás da interface `PushMetricExporter`
do próprio SDK.

**Motivação e custo medido** (sondado no registry em 2026-08-27, versões
`sdk-metrics@2.10.0` / `exporter-metrics-otlp-http@0.221.0`):

| Item | Número |
|---|---|
| Pacotes instalados (transitivos incluídos) | 11, **todos** sob `@opentelemetry/` |
| Dependências de terceiros arrastadas | **zero** (a codificação é JSON, não protobuf) |
| Tamanho em disco | ~30 MB de `node_modules` no estágio de runtime |
| `engines` | `>=20.6.0` — compatível com o `>=26` do repositório |

Onze pacotes para uma imagem que hoje tem quatro dependências não é gratuito, e a
`ARCHITECTURE.md` §7 se orgulha explicitamente de "nenhuma dependência de runtime nova".
A troca é consciente: o que se compra é a codificação OTLP correta — temporalidade
cumulativa vs delta, `start_time_unix_nano`, `fixed64` serializado como string em JSON —
que é precisamente onde um exporter escrito à mão falha **em silêncio** contra um
collector real, produzindo contadores que o Prometheus interpreta como reset a cada
scrape.

**Alternativa descartada:** *POST OTLP/JSON à mão (~150 linhas, zero dependências)*. Fica
registrada como plano B viável, e o desenho a mantém barata: como o exporter é injetado e
tipado pela interface `PushMetricExporter`, trocá-lo é mudança de **um** arquivo. Se em
algum momento o custo das 11 dependências pesar mais que a correção de encoding, a
substituição não toca em nenhum call site.

**Corolário de teste:** o `InMemoryMetricExporter` do próprio `sdk-metrics` é o exporter
falso dos testes. Nenhum teste abre socket, e a asserção é feita sobre a estrutura
`ResourceMetrics` de verdade — a mesma que iria pro fio.

### 3.5 Gauges são derivados do `RoomStore`, nunca contados

**Decisão:** `wtk_rooms_active` e `wtk_participants_active` são **ObservableGauge** cujo
callback lê um snapshot do `RoomStore` no instante da coleta. Não são `UpDownCounter`
incrementados nos handlers.

**Motivação:** contador incremental exige que **todo** caminho de saída decremente — e
este servidor tem quatro (`leave-room`, `disconnect`, `cancelPendingJoin` no meio de uma
aprovação, e a remoção implícita quando a sala é deletada). Um caminho esquecido produz
"7 salas ativas" num servidor com zero, o gráfico mente para sempre e ninguém descobre
sem reiniciar o processo. Derivar do estado real torna o defeito impossível por
construção: a fonte da verdade do produto é o `Map`, e a métrica é uma leitura dele.

**Contrato que isso impõe:** `initTelemetry` recebe uma função
`snapshot: () => { rooms: number; participants: number }` — injeção, para que
`telemetry.ts` não importe `rooms.ts` e o teste possa fornecer números fixos.

**Armadilha coberta em §7.4:** o callback do gauge roda no ciclo de exportação; se ele
lançar, o SDK registra erro a cada intervalo. Ele precisa ser total (sem `throw`) por
construção.

### 3.6 O `RoomStore` continua passivo; quem orquestra é o `index.ts`

**Decisão:** `rooms.ts` ganha apenas **memória efêmera adicional** — `openedAt` da sala,
`peak` de ocupação e `joinedAt` de cada membro — e dois leitores
(`roomStats(roomId)`, `memberJoinedAt(roomId, socketId)`). Ele **não** importa
`telemetry.ts`, não recebe callbacks e não emite eventos. Todas as chamadas de registro
ficam em `index.ts`, ao lado dos `emit` que elas descrevem.

**Motivação:** o `RoomStore` é a única estrutura do produto e tem um teste que o trata
como valor puro (`test/rooms.test.ts`). Injetar um recorder nele transformaria cada teste
existente numa montagem com dublê e acoplaria o estado do produto ao seu observador. O
comentário de topo do arquivo ("All state lives in memory only… a server restart wipes
every room") continua literalmente verdadeiro: os três campos novos vivem e morrem com o
`Map`.

**Sobre a transição "sala fechou":** `removeMember` já deleta a sala quando ela esvazia.
O `index.ts` lê `roomStats` **antes** da remoção e consulta `isEmpty` **depois** — se a
sala deixou de existir, registra `wtk_room_lifetime_seconds` e o pico em
`wtk_room_occupancy`. Nenhuma assinatura pública muda.

### 3.7 O beacon viaja como `text/plain`, e o servidor não confia no `Content-Type`

**Decisão:** o client envia o JSON serializado com tipo `text/plain;charset=UTF-8`
(via `navigator.sendBeacon` com `Blob`, ou `fetch` com `keepalive: true` como fallback).
O servidor monta `express.json({ limit: '1kb', type: () => true })` **apenas** na rota
`/telemetry`.

**Motivação:** é o detalhe que decide se a telemetria do client funciona ou some.
`text/plain` é um Content-Type *CORS-safelisted*: a requisição é simples e **não gera
preflight**. Um `Blob` de `application/json` faria o navegador tentar um `OPTIONS` antes —
e no `pagehide`, com a aba morrendo, o preflight frequentemente não completa e o beacon é
descartado **silenciosamente**. O sintoma seria "o page view da Home aparece, o fim de
sessão nunca", com zero erro no console de quem investiga.

Do outro lado, `type: () => true` existe por um motivo verificável: o item 10 do DoD
exige que `curl -si -X POST localhost:4000/telemetry -d '{"event":"page_view","route":"home"}'`
responda **204**. O `curl -d` sem `-H` manda `application/x-www-form-urlencoded`; com o
parser default (`application/json` apenas), o corpo chegaria vazio e a receita do README
responderia 400. Aceitar qualquer tipo e validar o **conteúdo** com `parseBeacon` é o que
faz a receita, o `sendBeacon` e o `fetch` de fallback caírem no mesmo caminho.

**Consequência de segurança, e por que ela é aceitável:** um endpoint que aceita corpo de
qualquer tipo, sem preflight, é chamável por qualquer página da internet (CSRF-able). O
que se pode fazer com isso é **incrementar um contador agregado** — não há estado, não há
sessão, não há efeito colateral. O limite de 1 kB e o rate limit de §3.9 cuidam do resto.

**Alternativa descartada:** *`mode: 'no-cors'` com `application/json`* — `no-cors` só
permite os mesmos tipos safelisted; o Content-Type seria reescrito para `text/plain` de
qualquer forma. Assumir isso explicitamente é melhor do que descobrir por acidente.

### 3.8 Sem endpoint configurado, a telemetria é um no-op absoluto

**Decisão:** `initTelemetry` sem `OTEL_EXPORTER_OTLP_ENDPOINT` devolve uma implementação
**no-op com a mesma superfície** — mesmos métodos, mesmas assinaturas, todos vazios — e
imprime **um** aviso no boot, no padrão do aviso de TURN ausente. Nenhum
`MeterProvider` é criado, nenhum timer é armado, nenhum socket é aberto.

**Motivação:** o repositório já tem o precedente e o argumento pronto em `index.ts`: um
deploy sem configuração não pode ser indistinguível de um deploy saudável, mas também não
pode **falhar**. A diferença em relação ao TURN é que TURN ausente desliga o produto
inteiro, enquanto telemetria ausente não degrada nada — por isso aviso, e não erro.

**Corolário:** o mesmo objeto no-op é o que roda em todo teste que não seja de telemetria,
e em `npm run dev`. Ninguém precisa de collector para desenvolver.

### 3.9 Rate limit por janela, sobre IP truncado, que nunca é armazenado nem exportado

**Decisão:** janela fixa em memória (sugestão: 60 s), chaveada por IP **truncado**
(IPv4 → /24, IPv6 → /48). O `Map` é descartado inteiro ao virar a janela. A chave nunca
vai para log, nunca vira atributo de métrica e nunca sai do processo. Estouro responde
**429 sem corpo** e conta como `wtk_telemetry_beacons_total{outcome="rejected"}`.

**Motivação:** o endpoint é público e não autenticado; sem limite, ele é um amplificador
de cardinalidade zero mas de CPU não-zero, e um flood empurraria o event loop que serve a
sinalização. Truncar o IP dá agrupamento suficiente para limitar sem individualizar.

**Duas notas honestas, que precisam estar no código:**

- O servidor **não** habilita `trust proxy`. Atrás de um reverse proxy, `req.ip` é o IP do
  proxy e o rate limit degrada para um balde **global** — mais restritivo, nunca menos.
  Isso é preferível a ler `X-Forwarded-For`, que é um cabeçalho falsificável e que
  reintroduziria o IP real do usuário num caminho de código novo.
- O `Map` precisa de teto (sugestão: 10 000 chaves por janela); ao estourar, o limite
  passa a valer globalmente até a virada. Sem teto, o balde é o vazamento de memória.

### 3.10 Temporalidade cumulativa e nomes exatamente como o DoD os escreve

**Decisão:** temporalidade **cumulativa** (default do exporter OTLP), e os nomes de
instrumento são literalmente os nove do item 1 do DoD. O
`infra/otel/collector.example.yaml` configura o exporter Prometheus com
**`add_metric_suffixes: false`**.

**Motivação:** o tradutor Prometheus do Collector, por default, anexa sufixo de unidade e
`_total` ao nome do instrumento. Com `add_metric_suffixes` ligado,
`wtk_session_duration_seconds` (unidade `s`) tem chance real de chegar ao Prometheus como
`wtk_session_duration_seconds_seconds` — e o painel versionado, escrito contra os nomes do
DoD, mostraria "No data" sem nenhum erro em lugar nenhum. Desligar o sufixo faz o nome do
DoD ser o nome no PromQL, no painel e na documentação: um nome só, do começo ao fim.

Cumulativa porque é o que o Prometheus espera; delta exigiria `deltatocumulative` no
pipeline do collector, que é estado a mais em troca de nada.

---

## 4. Componentes Afetados

### 4.1 Servidor (`packages/server/`)

| Arquivo | O que muda | Por quê |
|---|---|---|
| `src/telemetryEvents.ts` **(novo, puro)** | Union type fechado do beacon + `parseBeacon(body: unknown)` | O vocabulário do client precisa ser validável sem I/O e sem Express, em `node --test`. É aqui que "não existe campo para `roomId`" vira propriedade do tipo. |
| `src/telemetry.ts` **(novo)** | `initTelemetry(...)`, os nove instrumentos, views/buckets, exporter injetado, no-op | Único lugar do repositório que importa `@opentelemetry/*`. Os call sites falam domínio (`recordJoin`), nunca API de OTel. |
| `src/rooms.ts` | `Member.joinedAt`; metadados efêmeros por sala (`openedAt`, `peak`); leitores `roomStats`/`memberJoinedAt` | Duração de sessão, tempo de vida da sala e pico de ocupação não são deriváveis do estado atual — precisam do instante de entrada. Nada durável (§3.6). |
| `src/index.ts` | `initTelemetry` no boot; registro nos pontos de join/deny/leave/disconnect; `POST /telemetry`; `/health` aditivo; shutdown do reader | São os pontos que já existem; nenhum handler novo, nenhum evento novo de Socket.IO. |
| `package.json` | +4 dependências `@opentelemetry/*` | §3.4. |
| `.env.example` | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_METRIC_EXPORT_INTERVAL_MS`, `TELEMETRY_RATE_LIMIT_PER_MINUTE` | Descoberta: hoje o arquivo é a única documentação de configuração que o operador lê antes de subir. |
| `test/telemetryEvents.test.ts` **(novo)** | Validação total do beacon | Item 3 do DoD. |
| `test/telemetry.test.ts` **(novo)** | Instrumentos, unidades, buckets, no-op, endpoint fechado, rota `/telemetry` (204/400/429/413) | Itens 3, 8, 9, 10 do DoD. |
| `test/telemetryNoLeak.test.ts` **(novo)** | Fluxo completo com valores reconhecíveis + cardinalidade com 50 salas | Itens 2 e 6 do DoD. |
| `test/signaling.test.ts` | Ajuste **se** ele afirmar a forma exata do corpo de `/health` | `/health` ganha campo; a mudança é aditiva, o teste pode não ser. |

### 4.2 Client (`packages/client/`)

| Arquivo | O que muda | Por quê |
|---|---|---|
| `src/lib/telemetry.ts` **(novo, puro)** | `configureTelemetry`, `trackPageView`, `startSession`, transporte e relógio injetáveis | Mesmo padrão de `lib/iceServers.ts`: `lib/` não conhece `import.meta.env` nem DOM, e por isso roda em `node --test` sem jsdom. |
| `src/config.ts` | Chama `configureTelemetry` com `${SIGNALING_URL}/telemetry` e `VITE_TELEMETRY_ENABLED` | `config.ts` já é quem conhece a URL do servidor e o ambiente; o comentário do arquivo diz exatamente por quê. |
| `src/pages/Home.tsx` | `page_view` com `route: 'home'` | Item 1 do DoD. |
| `src/pages/Room.tsx` | `page_view` com `route: 'room'`; início da sessão em `PHASE.IN_CALL`; `end()` no cleanup do efeito de setup | O ciclo de limpeza que para tracks e fecha peer connections já é o lugar canônico de "a sala acabou". |
| `src/pages/LegacyRoomRedirect.tsx` | `page_view` com `route: 'legacy'` | Mede se os links antigos ainda circulam — a única pergunta que justifica a existência daquele componente. |
| `src/main.tsx` | Nada, se `config.ts` já é importado na árvore; caso contrário, garantir o import de efeito | A configuração precisa acontecer antes do primeiro `trackPageView`. |
| `.env.example` | `VITE_TELEMETRY_ENABLED=true` com o parágrafo de "como desligar tudo" | Mesmo formato do bloco `VITE_ENABLE_YOUTUBE`, que já faz esse papel. |
| `Dockerfile` | `ARG`/`ENV VITE_TELEMETRY_ENABLED` | `import.meta.env` é resolvido em **build time**; sem o build arg, a variável do compose não tem efeito nenhum. |
| `test/telemetry.test.ts` **(novo)** | Rota, duração, idempotência, `enabled: false`, transporte que rejeita | Item 8 do DoD. |
| `test/telemetryNoLeak.test.ts` **(novo)** | Stubs de `localStorage`/`cookie`/`randomUUID` que reprovam se tocados; payload sem slug/hash/nome | Item 7 do DoD — o teste que sustenta §3.3. |

### 4.3 Infra e documentação

| Arquivo | O que muda |
|---|---|
| `infra/otel/collector.example.yaml` **(novo)** | Receiver OTLP (gRPC + HTTP), `add_metric_suffixes: false` no exporter Prometheus, pipelines de traces/logs para Tempo/Loki **comentados** como extensão futura. |
| `infra/otel/dashboards/wtk-meet.json` **(novo)** | Painel Grafana versionado (§5.5). |
| `docker-compose.yml` | Repasse das quatro `OTEL_*` ao serviço `server`; `VITE_TELEMETRY_ENABLED` como **build arg** do `client`. |
| `README.md` / `README.en.md` | Seção "Telemetria": tabela de variáveis, tabela de métricas, receita de `curl`, como desligar tudo. Atualização de "O que fica fora do servidor" (§7.11). |
| `ARCHITECTURE.md` | Seção nova (sugestão: §10, ou §6.13 se ficar melhor no fluxo) + linhas novas na tabela de §5 + nota em §7 sobre as dependências. |
| `docs/progress/WTK-MEET-21.md` **(novo)** | Linha de base medida **antes**, decisões com evidência, divergências. |

---

## 5. Contratos de Interface

### 5.1 Endpoints REST

| Método | Path | Request Body | Response | Observações |
|---|---|---|---|---|
| `POST` | `/telemetry` | JSON ≤ 1 kB, **qualquer** `Content-Type` (§3.7). Campos: `event` (enum fechado) e os campos daquele evento | `204` sem corpo | Caminho feliz. Valida com `parseBeacon`; campos extras não são copiados. |
| `POST` | `/telemetry` | Corpo inválido: JSON malformado, `event` fora do enum, `durationMs` não-numérico/negativo/absurdo, corpo não-objeto | `400` + `{ error: 'invalid-beacon' }` | Incrementa `wtk_telemetry_beacons_total{outcome="rejected"}`. A mensagem **não** ecoa o corpo recebido. |
| `POST` | `/telemetry` | Corpo > 1 kB | `413` + `{ error: 'payload-too-large' }` | Vem do `express.json`; tratado por handler de erro **da rota**, não global. Conta como `rejected`. |
| `POST` | `/telemetry` | Acima do limite da janela | `429` sem corpo | Conta como `rejected` (o enum de `outcome` é fechado pelo DoD; ver §7.9). |
| `GET` | `/health` | — | `{ ok: true, turn: { configured }, telemetry: { enabled } }` | **Aditivo**: `ok` e `turn` inalterados. `telemetry.enabled` é booleano puro — nunca o endpoint, nunca os headers. |

Endpoints existentes (`/turn-credentials`, `/rooms/:roomId/occupancy`) e todos os eventos
Socket.IO permanecem **byte a byte** iguais.

### 5.2 Envelope do beacon (contrato client → server)

Vocabulário fechado. Qualquer chave fora desta tabela é descartada por **não ser copiada**
— `parseBeacon` constrói um objeto novo, campo a campo, e nunca faz spread do corpo
recebido.

| `event` | Campos | Domínio | Métrica que alimenta |
|---|---|---|---|
| `page_view` | `route` | `'home' \| 'room' \| 'legacy'` | `wtk_page_views_total{route}` |
| `client_session_end` | `durationMs` | número finito em `[0, 86_400_000]` | `wtk_client_session_duration_seconds` |

Pseudológica de `parseBeacon(body: unknown)`:

1. `body` não é objeto não-nulo → `null`.
2. `body.event` não é string ou não está no conjunto fechado → `null`.
3. `page_view`: `body.route` deve ser string e pertencer ao conjunto fechado; caso
   contrário → `null`. Devolve `{ event: 'page_view', route }` — objeto **novo**.
4. `client_session_end`: `body.durationMs` deve ser `number`, finito, `>= 0` e
   `<= 86_400_000`; caso contrário → `null`. Devolve `{ event: 'client_session_end',
   durationMs }`.
5. Não há passo 5. Não existe caminho que copie chave desconhecida.

> **Restrição de linguagem:** o `tsconfig.base.json` liga `erasableSyntaxOnly`, que
> **proíbe `enum`**. "Enum fechado" aqui significa union type de literais + array `as
> const` para validação em runtime — nunca a palavra-chave `enum` (§7.2).

### 5.3 Catálogo de métricas

Nomes literais, exportados sem sufixo adicional (§3.10). "Emissor" indica quem chama.

| Nome | Tipo | Unidade | Atributos | Emissor | Quando |
|---|---|---|---|---|---|
| `wtk_rooms_active` | ObservableGauge | `{room}` | — | server (callback) | A cada coleta: nº de salas no `RoomStore` |
| `wtk_participants_active` | ObservableGauge | `{participant}` | — | server (callback) | A cada coleta: soma dos membros de todas as salas |
| `wtk_room_occupancy` | Histogram | `{participant}` | — | server | Uma amostra **por sala**, no fechamento: o **pico** de membros simultâneos |
| `wtk_session_duration_seconds` | Histogram | `s` | — | server | Saída de um socket da sala (`leave-room`/`disconnect`): `agora - joinedAt` |
| `wtk_room_lifetime_seconds` | Histogram | `s` | — | server | Sala esvaziou e foi deletada: `agora - openedAt` |
| `wtk_joins_total` | Counter | `{join}` | `outcome` ∈ `admitted, approved, denied, room_full, invalid_room` | server | Desfecho de cada tentativa de entrada |
| `wtk_page_views_total` | Counter | `{page_view}` | `route` ∈ `home, room, legacy` | client → `/telemetry` | Montagem de cada página |
| `wtk_client_session_duration_seconds` | Histogram | `s` | — | client → `/telemetry` | Aba deixa a sala (unmount ou `pagehide`) |
| `wtk_telemetry_beacons_total` | Counter | `{beacon}` | `outcome` ∈ `accepted, rejected` | server | Cada `POST /telemetry` |

**Fronteiras de bucket:**

- Ocupação (`wtk_room_occupancy`): `[1, 2, 3, 4, 5, 6]`. `MAX_PARTICIPANTS` é 6, então o
  bucket `+Inf` deve permanecer vazio para sempre — se ele encher, há defeito na
  contagem, e isso é um sinal útil por si só. Ler `le="1"` como "salas cujo pico foi 1
  pessoa".
- Durações (`wtk_session_duration_seconds`, `wtk_room_lifetime_seconds`,
  `wtk_client_session_duration_seconds`): `[5, 30, 60, 300, 900, 1800, 3600, 7200]`
  segundos. Cobre desde "abriu e desistiu" (≤5 s) até "reunião de duas horas".

**Mapa dos desfechos de entrada** — cada tentativa produz **no máximo um** `wtk_joins_total`:

| Situação em `index.ts` | `outcome` |
|---|---|
| `rooms.isEmpty(roomId)` → `admitToRoom` direto (primeira pessoa) | `admitted` |
| `approve-join` → `admitToRoom` | `approved` |
| `deny-join` → `join-denied { reason: 'denied' }` | `denied` |
| `rooms.isFull` no `join-request` **ou** na aprovação | `room_full` |
| `roomId` ausente/não-string | `invalid_room` |
| Requester desistiu enquanto esperava (`disconnect` com pendência) | **nenhum** — ver nota |

> Nota que precisa estar no README: `wtk_joins_total` conta **desfechos**, não tentativas.
> Pedidos abandonados na fila de aprovação não aparecem em nenhum desfecho, porque o enum
> do DoD é fechado e não tem valor para eles. A diferença entre "pedidos recebidos" e a
> soma dos desfechos é, portanto, invisível — é uma limitação declarada, não um bug.

### 5.4 Contratos de módulo

**`packages/server/src/telemetry.ts`**

- `initTelemetry(options)` → `Telemetry`. Opções: `exporter?` (um `PushMetricExporter`;
  ausente ⇒ constrói o OTLP a partir do ambiente), `snapshot` (§3.5), `endpoint?`,
  `serviceName?`, `intervalMs?`, `logger?`.
- `Telemetry` expõe **apenas** verbos de domínio: `recordJoin(outcome)`,
  `recordSessionEnd(durationMs)`, `recordRoomOpened()`, `recordRoomClosed(lifetimeMs,
  peak)`, `recordPageView(route)`, `recordClientSession(durationMs)`,
  `recordBeacon(outcome)`, `enabled: boolean`, `shutdown(): Promise<void>`.
- **Todos os `record*` são totais**: engolem qualquer exceção interna e retornam `void`.
  Nenhum é `async`, nenhum devolve promise, nenhum pode ser esperado por um handler.
- O no-op tem a mesma superfície, com `enabled: false`.

**`packages/client/src/lib/telemetry.ts`** (puro: sem `import.meta.env`, sem DOM implícito)

- `configureTelemetry({ endpoint, enabled, send?, now? })` — `send` e `now` injetáveis;
  os defaults só são resolvidos quando existe `navigator`/`Date`.
- `trackPageView(route)` — dispara e esquece; nunca lança, nunca devolve promise que
  alguém precise tratar.
- `startSession()` → `{ end(): void }`, com `end` **idempotente**: a segunda chamada não
  faz nada.

### 5.5 Painel Grafana (`infra/otel/dashboards/wtk-meet.json`)

| Painel | Consulta (essência) |
|---|---|
| Salas ativas | `wtk_rooms_active` |
| Participantes ativos | `wtk_participants_active` |
| Distribuição de ocupação | heatmap sobre os buckets de `wtk_room_occupancy` |
| Duração de sessão (p50/p90/p99) | `histogram_quantile` sobre `wtk_session_duration_seconds_bucket` |
| Duração de sessão do client | `histogram_quantile` sobre `wtk_client_session_duration_seconds_bucket` |
| Tempo de vida das salas | `histogram_quantile` sobre `wtk_room_lifetime_seconds_bucket` |
| Page views por rota | `rate(wtk_page_views_total[5m])` por `route` |
| Desfechos de entrada | `rate(wtk_joins_total[5m])` por `outcome` |
| Beacons rejeitados | razão `rejected / (accepted + rejected)` |

### 5.6 Variáveis de ambiente

| Variável | Pacote | Default | Efeito |
|---|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | server | *(vazio)* | **Ausente ⇒ telemetria desligada por inteiro** (no-op + um aviso no boot) |
| `OTEL_EXPORTER_OTLP_HEADERS` | server | *(vazio)* | Autenticação do collector. **Nunca** aparece em `/health` nem em log |
| `OTEL_SERVICE_NAME` | server | `wtk-meet-server` | Atributo de resource |
| `OTEL_METRIC_EXPORT_INTERVAL_MS` | server | `60000` | Intervalo do `PeriodicExportingMetricReader` |
| `TELEMETRY_RATE_LIMIT_PER_MINUTE` | server | `120` | Teto por balde da janela (§3.9) |
| `VITE_TELEMETRY_ENABLED` | client | `true` | `'false'` (string!) desliga **antes** de qualquer efeito — nenhuma requisição sai do browser |

### 5.7 Schema de banco

**Não aplicável.** O produto não tem banco, e esta entrega não cria nenhum. Todo o estado
novo (`openedAt`, `peak`, `joinedAt`, balde do rate limit) vive no mesmo `Map` em memória
que já existe e morre com a sala ou com a janela. Se alguém em revisão vir uma migration
nesta entrega, o desenho foi violado.

---

## 6. Dependências e Ordem de Implementação

A ordem é a mesma do plano do board, com os pontos de paralelismo explícitos.

**Fase 0 — linha de base (antes de tocar em qualquer arquivo).**
Rodar `npm install` na raiz e medir: `npm test` (client e server), `npm run typecheck`,
`npm run lint` e `npm run test:e2e`. Anotar os números em `docs/progress/WTK-MEET-21.md`.
Sem isto não há como afirmar o item 13 do DoD. Referência histórica: a suíte do client
estava em 478 casos e o E2E em **140/141** (única falha: F4a, pré-existente) na
WTK-MEET-20 — mas **meça a sua própria linha de base**, porque o total cresce a cada
entrega.

**Fase 1 — núcleo puro** (`telemetryEvents.ts` + testes). Sem dependência nenhuma; é o
único ponto que define o vocabulário. Tudo depois depende disto.

**Fase 2 — exporter e no-op** (`telemetry.ts` + `package.json` + testes). Depende da fase
1 apenas para os tipos de `route`/`outcome`.
→ **Pode rodar em paralelo com a fase 4** (client), que só depende do contrato de §5.2.

**Fase 3 — instrumentação do servidor** (`rooms.ts` + `index.ts` + `telemetryNoLeak`).
Depende da fase 2 (precisa dos verbos de domínio).

**Fase 4 — beacons do client** (`lib/telemetry.ts`, `config.ts`, três páginas, testes).
Depende só do contrato de §5.2.

**Fase 5 — `POST /telemetry`** (rota, rate limit, handler de erro, testes de rota).
Depende das fases 1, 2 e 3.

**Fase 6 — infra, painel e documentação.** Depende de tudo, porque a documentação afirma
nomes de métrica que só existem depois da fase 3.

**Fase 7 — portões.** `npm run typecheck`, `npm run lint`, `npm test` nos dois pacotes e
`npm run test:e2e`, comparados **contra a linha de base da fase 0**.

---

## 7. Riscos e Armadilhas

### 7.1 O beacon que desaparece no `pagehide`

- **Risco:** o `client_session_end` nunca chega, e só ele — page views funcionam, então o
  problema parece "métrica esquisita", não "transporte quebrado".
- **Mitigação:** `text/plain` (§3.7); `pagehide` **e** `visibilitychange → hidden` como
  gatilhos, com `end()` idempotente; nunca `unload` (ignorado por navegadores com
  bfcache); nunca `fetch` sem `keepalive`.
- **Anti-pattern:** `Blob([json], { type: 'application/json' })` no `sendBeacon`. Parece
  mais correto, gera preflight, e falha exatamente quando a aba está morrendo.

### 7.2 `enum` não compila neste repositório

- **Risco:** o DoD e o plano dizem "enum fechado" cinco vezes; o reflexo é escrever
  `enum TelemetryEvent`. O `tsconfig.base.json` tem `erasableSyntaxOnly: true` e o Node
  roda o `.ts` por type stripping — `enum` é erro de compilação, não aviso.
- **Mitigação:** union type de literais + `const ROUTES = [...] as const` para a
  validação em runtime. `verbatimModuleSyntax` também exige `import type` explícito para
  qualquer import só-de-tipo (inclusive os do `@opentelemetry/*`).
- **Anti-pattern:** `as const enum`, ou "resolver" com `// @ts-expect-error`.

### 7.3 A API do `sdk-metrics` 2.x não é a dos exemplos que estão na internet

- **Risco:** a maior parte dos tutoriais é da 1.x. Na 2.10.0 a classe `View` **não é mais
  exportada** (só o tipo `ViewOptions`), `addMetricReader` saiu, e a agregação virou
  objeto (`{ type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries } }`).
- **Mitigação:** `new MeterProvider({ resource, readers: [...], views: [...] })`, com
  `views` como **objetos literais** `ViewOptions`. Se o `tsc` reclamar de `new View(...)`,
  o problema é a versão do exemplo, não o tipo.
- **Anti-pattern:** fixar uma versão 1.x antiga do SDK para o exemplo copiado compilar.

### 7.4 O callback do ObservableGauge lançando a cada intervalo

- **Risco:** `snapshot()` lança (sala mutada durante a iteração, `undefined` inesperado) e
  o SDK loga o erro a cada janela de exportação — barulho constante, métrica ausente.
- **Mitigação:** `snapshot` é total por construção (lê `size` de `Map`s, sem I/O, sem
  `await`); o registro do gauge envolve a chamada num guard que devolve o último valor
  conhecido em caso de erro.
- **Anti-pattern:** callback `async` que faz qualquer coisa além de ler memória — ele tem
  `exportTimeoutMillis` e derruba a coleta inteira quando estoura.

### 7.5 Atributos de resource que ninguém pediu para exportar

- **Risco:** `detectResources()` com `hostDetector`/`processDetector` acrescenta
  `host.name`, `process.pid` e `process.command_args` — que carregam hostname e caminho do
  filesystem. Não é dado de usuário, mas é dado do operador saindo para a stack, e o teste
  de não-vazamento vai ter que abrir exceção para eles.
- **Mitigação:** montar o resource **explicitamente** com `resourceFromAttributes({
  'service.name': ..., 'service.version': ... })`. Não chamar `detectResources`.
- **Anti-pattern:** usar `NodeSDK` do pacote `@opentelemetry/sdk-node` "porque é mais
  fácil" — ele liga detectores e instrumentações automáticas (inclusive HTTP), o que
  criaria métricas por rota **com path**, e o path de sala **é** o `roomId`.

### 7.6 O endpoint público que qualquer um pode encher

- **Risco:** `/telemetry` não tem autenticação (não pode ter — §2). Um script simples
  inflaciona `wtk_page_views_total` e, no limite, ocupa o event loop que serve a
  sinalização.
- **Mitigação:** rate limit (§3.9) + `limit: '1kb'` + resposta sem corpo + nenhum trabalho
  além de um incremento. Os números **são** falsificáveis por design: o README deve dizer
  isso com todas as letras, porque um painel de produto que finge precisão que não tem é
  pior do que nenhum painel.
- **Anti-pattern:** "proteger" com um token no bundle do client, ou com checagem de
  `Origin` — os dois são copiáveis do DevTools em dez segundos e dariam falsa segurança.

### 7.7 O `curl` do DoD que responderia 400

- **Risco:** item 10 do DoD, verbatim: `curl -si -X POST localhost:4000/telemetry -d
  '{"event":"page_view","route":"home"}'` → **204**. Com `express.json()` default, o
  `Content-Type` que o `curl -d` manda (`application/x-www-form-urlencoded`) não casa, o
  corpo chega vazio e a resposta é 400. A receita do README nasceria errada.
- **Mitigação:** `type: () => true` na rota (§3.7), e um teste que roda **essa string de
  curl** — mesmo verbo, mesmo header ausente.
- **Anti-pattern:** corrigir a receita do README acrescentando `-H 'Content-Type:
  application/json'`. Funciona, mas contraria o texto literal do item 10, e o DoD do
  board é imutável depois da criação — não dá para corrigir o critério, só para
  atendê-lo.

### 7.8 O handler de erro do body-parser vazando corpo em log

- **Risco:** o `express.json` rejeita com `SyntaxError`/`entity.too.large`. Sem handler
  próprio, o handler default do Express **loga o erro no stderr em desenvolvimento** — e a
  mensagem do `SyntaxError` do body-parser inclui um trecho do corpo recebido. É o
  vazamento mais provável desta entrega, e ele acontece no caminho de erro, que ninguém
  olha.
- **Mitigação:** handler de erro montado **na rota** `/telemetry`, que converte
  `entity.too.large` → 413 e o resto → 400, incrementa `rejected` e **não loga nada**.
- **Anti-pattern:** `app.use(express.json())` global. Muda o comportamento de
  `/turn-credentials` e `/rooms/:id/occupancy` (que hoje não parseiam corpo nenhum) e
  espalha o handler de erro para rotas que não pediram.

### 7.9 429 sem casa no enum de `outcome`

- **Risco:** o DoD fecha `wtk_telemetry_beacons_total{outcome}` em `accepted|rejected`.
  Beacon barrado pelo rate limit não é nenhum dos dois com naturalidade; contar como
  `accepted` é mentira, não contar é ponto cego.
- **Mitigação:** 429 conta como `rejected`, e isso fica escrito no README e no comentário
  do código. Cardinalidade continua 2.
- **Anti-pattern:** acrescentar `outcome="rate_limited"` — quebraria o item 1 do DoD, que
  lista o conjunto fechado, e o painel versionado.

### 7.10 `VITE_TELEMETRY_ENABLED=false` que não desliga nada

- **Risco:** `import.meta.env.VITE_TELEMETRY_ENABLED` é **string**. `if (enabled)` com
  `'false'` é `true`, e o item 8 do DoD passa a ser falso com a variável configurada
  corretamente.
- **Mitigação:** comparação explícita com `'false'`; o teste do item 8 passa a string, não
  o booleano. E o `Dockerfile` do client precisa do `ARG`/`ENV`: `import.meta.env` é
  substituído em **build time**, então a variável no `docker-compose` do serviço `client`
  (runtime do nginx) não teria efeito **nenhum** — falha silenciosa clássica.
- **Anti-pattern:** ler a variável dentro de `lib/telemetry.ts`. Quebra a pureza do módulo
  (o comentário de `config.ts` explica por que isso importa) e torna o teste impossível
  sem Vite.

### 7.11 A documentação que passa a mentir

- **Risco:** três textos ficam **falsos** no instante em que esta entrega mergear, e
  nenhum teste os cobre:
  - `README.md` / `README.en.md` → "O que fica fora do servidor": o client passa a fazer
    uma chamada HTTP ao servidor que **não** é sinalização nem TURN. A lista precisa ganhar
    a linha do beacon (e dizer o que ele não carrega).
  - `ARCHITECTURE.md` §5 (tabela "Sabe / Nunca sabe"): o servidor passa a saber "que uma
    página foi vista, e qual das três" e "quanto tempo uma aba ficou na sala". Continua sem
    saber **qual** sala, **qual** aba e **quem**.
  - `ARCHITECTURE.md` §7: "nenhuma dependência de runtime nova" deixa de valer para o
    server (§3.4).
- **Mitigação:** os três são itens de entrega da fase 6, não "documentação depois".
- **Anti-pattern:** escrever a seção nova e deixar §5 como está. A tabela é o documento que
  alguém desconfiado lê primeiro; contradizê-la em silêncio custa mais que a métrica vale.

### 7.12 A ordem dos `emit` do Socket.IO

- **Risco:** uma chamada de telemetria colocada no meio de `admitToRoom` que lance (ou
  demore) altera a ordem observável de `join-approved` e `peer-joined` — e
  `test/signaling.test.ts` existe exatamente para caracterizar essa ordem.
- **Mitigação:** todo `record*` é síncrono, total e chamado **depois** dos `emit`
  daquele handler; teste que injeta um recorder que lança em todo método e afirma que o
  fluxo de join/approve continua idêntico.
- **Anti-pattern:** `await telemetry.recordX(...)` dentro de um handler de socket.

### 7.13 O `TODO(WTK-MEET-21)` que não é desta entrega

- **Risco:** `packages/client/vite.config.ts` tem um `TODO(WTK-MEET-21)` sobre
  `allowedHosts: 'all'` (que, como o comentário explica, não libera host nenhum). O
  identificador aponta para **esta** task, mas o assunto não tem relação com telemetria, e
  o arquivo não está no `scope` do card.
- **Mitigação:** decisão recomendada — **corrigir em commit isolado** (`allowedHosts:
  true`, uma linha, só afeta o servidor de desenvolvimento), porque um TODO apontando para
  uma task entregue apodrece e o próximo leitor vai procurar o que não existe. Se o agente
  de desenvolvimento preferir não misturar, a alternativa aceitável é **reetiquetar** o
  TODO para uma task nova e registrar isso no `docs/progress/`. O que não é aceitável é
  deixar como está.
- **Anti-pattern:** embutir a correção num commit de telemetria. O comentário existente
  registra que `true` libera **qualquer** host — é afrouxamento de proteção contra DNS
  rebinding no dev server, e merece ser revertível sozinho.

### 7.14 Portões e ambiente

- **Risco:** a suíte do client aparece vermelha por `node_modules` ausente e alguém trata
  isso como linha de base. E o E2E tem uma falha **pré-existente** (F4a) que não é
  regressão desta entrega.
- **Mitigação:** `npm install` na raiz antes de medir qualquer coisa (o repositório usa
  npm workspaces, apesar de `ARCHITECTURE.md` §8 ainda dizer que não há workspace na
  raiz — deriva pré-existente, vale corrigir de passagem já que §7/§8 serão editados).
  A comparação é sempre contra **a sua** linha de base da fase 0.
- **Anti-pattern:** usar os números que aparecem em DoDs antigos (336 casos, 111/112
  checagens) como referência — estão desatualizados desde a WTK-MEET-20.

### 7.15 Shutdown que engole o último intervalo

- **Risco:** com intervalo default de 60 s, um restart perde até um minuto de contadores.
  Pior: se o handler de `SIGTERM` chamar `shutdown()` e **esperar** um collector fora do
  ar, o processo demora para morrer.
- **Mitigação:** `shutdown()` do reader com timeout curto, disparado junto do fechamento
  do http server, e **nunca** bloqueando a saída indefinidamente. Nota de ambiente: neste
  sandbox o `SIGTERM` costuma ser ignorado, então o caminho de shutdown **não** é
  verificável à mão aqui — cubra-o por teste (chamar `shutdown()` direto e afirmar que
  resolve mesmo com exporter falhando).

---

## 8. Critérios de Aceite Técnicos

Comportamentos observáveis. Numerados em paralelo ao DoD do board (itens 1–13).

1. **Catálogo fechado.** Os nove nomes de §5.3 existem, com o tipo, a unidade e os
   atributos declarados, e estão documentados nos três documentos (`README.md`,
   `README.en.md`, `ARCHITECTURE.md`) com a mesma grafia que aparece no exporter.
2. **Cardinalidade constante.** Um teste que abre 50 salas distintas, com nomes
   diferentes, e coleta duas vezes: o conjunto de pares `(nome da métrica, atributos)` da
   segunda coleta é **idêntico** ao da primeira, com no máximo as séries de §5.3.
3. **Envelope fechado.** `POST /telemetry` com `{"event":"page_view","route":"home"}` →
   204. Com `event` fora do enum, `durationMs` string/NaN/negativo/`1e12`, corpo
   `"[]"`/`"null"`/texto solto → 400, e `wtk_telemetry_beacons_total{outcome="rejected"}`
   sobe 1 em cada caso. Um beacon com `roomId`, `displayName` e `ip` extras → 204 e
   **nenhum atributo novo** em métrica nenhuma.
4. **Silêncio no log.** Um fluxo que exercita 204, 400, 413 e 429 não produz, no stdout
   nem no stderr do processo, nenhuma ocorrência do IP, do User-Agent ou de qualquer
   trecho do corpo enviado.
5. **Suíte verde.** `npm -w wtk-meet-server run test` e `npm -w wtk-meet-client run test`
   passam, com todos os testes novos em `node --test`, sem jsdom, no padrão de dispatcher
   próprio de `musicRoomPlayerError.test.ts`.
6. **Não-vazamento no servidor.** Um fluxo completo — entrada da primeira pessoa, pedido,
   aprovação, recusa, sala cheia, desconexão — usando `roomId = 'sala-secreta-do-nicolas'`,
   `displayName = 'Nicolas Woitchik'` e uma passphrase reconhecível, seguido de coleta no
   exporter falso: nenhuma dessas strings aparece em nome de métrica, chave de atributo,
   valor de atributo ou em qualquer campo do `ResourceMetrics` serializado.
7. **Não-vazamento no client.** Com `localStorage`, `sessionStorage`, `document.cookie`,
   `crypto.randomUUID` e `Math.random` substituídos por stubs que **falham o teste** ao
   serem tocados, o módulo configura, emite page view e encerra sessão sem disparar
   nenhum deles. O corpo do beacon emitido a partir da `Room` não contém o slug da sala,
   o fragmento da URL nem o `displayName`.
8. **Desligável de ponta a ponta.** Sem `OTEL_EXPORTER_OTLP_ENDPOINT`, o servidor sobe,
   responde tudo, imprime **um** aviso e `/health` reporta `telemetry.enabled: false`.
   Com `VITE_TELEMETRY_ENABLED='false'`, o transporte injetado do client **nunca é
   chamado**, em nenhum dos três call sites.
9. **Collector fora do ar não contamina o produto.** Com o endpoint apontando para uma
   porta fechada: `/health`, `/turn-credentials`, `/rooms/:id/occupancy` e o ciclo
   completo de Socket.IO continuam respondendo dentro do mesmo tempo, o processo não
   morre, e o aviso de falha de exportação aparece **no máximo uma vez por janela de
   backoff** — não uma por tentativa.
10. **Receita de verificação.** `curl -s localhost:4000/health` devolve
    `{ ok, turn: { configured }, telemetry: { enabled } }`; a linha de `curl` do item 10
    do DoD, **sem header de Content-Type**, devolve `204`. As duas estão no README.
11. **Painel.** `infra/otel/dashboards/wtk-meet.json` importa no Grafana sem edição manual
    e renderiza os nove painéis de §5.5 a partir dos nomes de §5.3.
12. **Configuração versionada.** `docker-compose.yml` repassa as quatro `OTEL_*` ao
    `server` e `VITE_TELEMETRY_ENABLED` como **build arg** ao `client`; os dois
    `.env.example` listam as variáveis com seus defaults; `collector.example.yaml`
    documenta o caminho até Prometheus (com `add_metric_suffixes: false`) e deixa
    Tempo/Loki comentados.
13. **Sem regressão.** `npm run typecheck` e `npm run lint` verdes nos três pacotes;
    `npm run test:e2e` com **a mesma** contagem de falhas da fase 0.

**Além do DoD, dois critérios que este documento acrescenta:**

14. **Ordem do protocolo intacta.** Com um recorder que lança em todos os métodos, o
    `test/signaling.test.ts` existente continua verde, sem alteração.
15. **Gauges não derivam.** Depois de 50 ciclos de entrada/saída, incluindo desconexões
    abruptas e recusas, `wtk_rooms_active` e `wtk_participants_active` lidos pelo callback
    valem exatamente o que o `RoomStore` tem — porque são leitura dele, não contagem.

---

## 9. Notas para os Agentes de Implementação

**Divisão sugerida.** A entrega tem duas metades quase independentes, e o contrato entre
elas é §5.2 (o envelope) — congele-o primeiro:

- **Agente A (servidor):** fases 1, 2, 3 e 5.
- **Agente B (client):** fase 4.
- **Quem fechar por último:** fase 6 (infra, painel, documentação) e fase 7 (portões).

Se for um agente só, a ordem de §6 já é a ordem de menor retrabalho.

**Pitfalls desta demanda que não estão na documentação geral do projeto** — leia §7
inteiro antes de escrever a primeira linha; os quatro que mais custam se descobertos
tarde são: `enum` proibido pelo `erasableSyntaxOnly` (§7.2), a API 2.x do `sdk-metrics`
que difere de todo tutorial (§7.3), o `Content-Type` do beacon e do `curl` (§7.1 e §7.7),
e o build arg do `Dockerfile` do client (§7.10).

**Sobre o board.** O DoD do card é **imutável depois da criação** e o gate de movimentação
não confere o `checked` dos itens: registre a evidência item a item com `add_task_log` e
repita o resumo no `reason` do move. Antes de qualquer `move_task_forward`, **confira a
coluna atual** — de *Code Review* o move vai para *Done*, e aquela coluna é o portão
humano do Nicolas.

**Ordem de validação depois de implementar:**

1. `npm -w wtk-meet-server run test` — o mais rápido e o que cobre o núcleo.
2. `npm -w wtk-meet-client run test`.
3. `npm run typecheck` e `npm run lint` (os três pacotes).
4. Subir o servidor sem `OTEL_EXPORTER_OTLP_ENDPOINT` e rodar as duas linhas de `curl` do
   item 10 — é a checagem que prova que o caminho desligado continua servindo.
5. Subir com o endpoint apontando para uma porta fechada e repetir o passo 4: mesma
   resposta, mesmo tempo, um aviso só.
6. `npm run test:e2e`, comparado com a fase 0.

**Uma coisa para não fazer.** Se em algum momento a implementação parecer pedir "só um
identificador, para deduplicar" — de aba, de sessão, de sala, hasheado ou não — pare e
releia §3.3. Esse identificador é a única mudança nesta entrega que exigiria voltar ao
produto para discutir consentimento, e ele nunca chega anunciado como tal: chega como
detalhe de implementação de outra coisa.
