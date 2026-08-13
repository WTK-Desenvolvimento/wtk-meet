# Slug curto de sala e rotas wildcard na raiz — Documento de Arquitetura Técnica

> Gerado em: 2026-08-13
> Status: Rascunho
> Task: WTK-MEET-10 — Substituir UUID da sala por slug curto e mover rotas para wildcard na raiz
> Autor: Arquiteto

---

## 1. Contexto e Objetivo

### Problema atual

- `client/src/pages/Home.jsx:36` gera o identificador da sala com `crypto.randomUUID()` — 36 caracteres,
  com hífens, impossível de ditar por telefone.
- `client/src/App.jsx:9` publica a sala em `/room/:roomId`, somando mais 6 caracteres de prefixo.
- O resultado é um link de convite como
  `https://meet.exemplo.com/room/3f2b7c1e-9a41-4d0b-8e77-2c5b9d1a4f60#kJ8s...` — 90+ caracteres antes do
  fragmento. É longo demais para caber numa linha da UI (`Room.jsx:1117` já trunca), ruim para colar em
  mensagem e impossível de ler em voz alta.
- Não existe forma de a pessoa escolher o endereço da sala. Toda sala é um UUID opaco, mesmo quando o time
  usa a mesma sala recorrente ("daily", "sala-do-suporte").

### Comportamento esperado após a entrega

- "Criar sala" gera um **slug de 9 caracteres** em base32 sem caracteres ambíguos
  (ex.: `/k7m2xq9tp#<chave>`), ditável e colável.
- A pessoa pode **definir o próprio endereço** ao criar a sala (ex.: `/uma-sala-so-minha`), sem limite
  rígido de tamanho — só as guardas técnicas descritas em §3.3.
- O prefixo `/room/` **deixa de existir**. As telas da aplicação vivem sob `/app/*`; qualquer path que não
  seja rota reservada é interpretado como sala.
- O modelo E2EE **não muda**: a passphrase de 128 bits continua sendo gerada no client e vivendo só no
  fragmento da URL. Quem abrir um path de sala **sem** `#chave` recebe uma passphrase nova e é redirecionado
  (replace) para o link completo.
- Links antigos no formato `/room/:id#chave` continuam funcionando por redirecionamento.

### Vínculo com o produto

O link **é** o produto: não há conta, não há diretório de salas, não há convite por e-mail. Um link que não
cabe numa linha e não pode ser ditado é atrito direto no único fluxo de entrada que existe. Endereço próprio
transforma "me manda o link de novo" em "é a sala de sempre, /daily".

---

## 2. Escopo

**Dentro do escopo:**

- Novo módulo utilitário de path de sala no client: geração de slug, normalização/slugify de path escolhido,
  lista de rotas reservadas, montagem e parsing de link de convite.
- Reestruturação de rotas: `/` → redireciona para `/app`; `/app` = Home; `/app/*` reservado para telas da
  aplicação; `/room/:roomId` mantido apenas como redirecionamento legado; `*` = sala.
- Campo opcional "endereço da sala" na Home, com validação inline e preview do link resultante.
- Room passa a ler o path da sala do splat da rota (não mais de `:roomId`), canonicaliza e redireciona
  quando necessário.
- Auto-geração de passphrase + redirect quando o path é aberto sem fragmento.
- Validação defensiva de `roomId` no servidor de sinalização (formato e tamanho).
- Atualização do E2E (`e2e/run.mjs`, `e2e/harness.mjs`) e novos testes unitários do módulo de path.
- Atualização de `ARCHITECTURE.md`, `README.md` e `claude-progress.md`.

**Fora do escopo:**

- Reservar/registrar salas no servidor. O servidor continua sem persistência e sem saber de sala nenhuma
  antes do primeiro `join-request`.
- Qualquer endpoint que diga se uma sala existe (ver §7, anti-pattern).
- Reativar E2EE — segue desabilitada como está hoje (`Room.jsx:29,238,1022`). O contrato de
  `deriveRoomKey(passphrase, roomId)` não muda; muda só o formato do valor que será passado quando for
  reativada.
- Vanity URL persistente, "minhas salas", histórico ou favoritos — exigiria persistência, que o produto não
  tem.
- Multi-segmento no path da sala (`/time/daily`). Ver decisão 3.4.
- Mudar o limite de 6 participantes, o fluxo de aprovação ou o protocolo de sinalização.

---

## 3. Decisões Arquiteturais

### 3.1 Alfabeto e tamanho do slug gerado

- **Decisão:** base32 estilo Crockford em minúsculas, **sem** `i`, `l`, `o`, `u` —
  `0123456789abcdefghjkmnpqrstvwxyz` (exatamente 32 símbolos) — com **9 caracteres**, sorteados de
  `crypto.getRandomValues`.
- **Motivação:** 32 símbolos ⇒ 5 bits por caractere ⇒ **45 bits** de espaço para o slug de 9 caracteres
  (~35 trilhões). Como o alfabeto tem exatamente 32 símbolos, `byte % 32` é **uniforme** (256 é múltiplo de
  32) — nenhum viés de módulo e nenhuma necessidade de rejection sampling. Remover `i/l/o/u` elimina os
  pares confundíveis ao ditar (`0`/`o`, `1`/`l`/`i`) e a palavra ofensiva mais comum sai junto com o `u`.
- **Alternativas descartadas:**
  - *Manter UUID e só encurtar visualmente* — o link continua o mesmo; não resolve nada.
  - *base62 (`a-zA-Z0-9`)* — mais entropia por caractere, mas exige distinguir maiúscula de minúscula ao
    ditar, e o path precisa ser case-insensitive (3.5). Incompatível.
  - *Palavras de dicionário ("azul-cavalo-bateria")* — ótimo para ditar, mas exige embarcar dicionário no
    bundle e o link fica longo de novo.
  - *6 caracteres (30 bits)* — colisão entre salas simultâneas ainda improvável, mas 9 custa 3 caracteres e
    remove a discussão. O gargalo do tamanho do link é a passphrase de 22 caracteres, não o slug.

### 3.2 Sem verificação de disponibilidade no servidor

- **Decisão:** o client **nunca** pergunta ao servidor se um path já está em uso. Slug gerado e path
  escolhido são usados direto.
- **Motivação:** o servidor não persiste nada (`server/src/rooms.js` — a sala some quando o último socket
  sai) e `ARCHITECTURE.md §5` posiciona explicitamente "que um roomId existe" como conhecimento efêmero e
  interno. Expor isso numa API transformaria o servidor em oráculo de enumeração de salas ativas. Colidir com
  uma sala viva significa cair na fila de aprovação dela — e ser negado. O controle de acesso já cobre o
  caso.
- **Alternativas descartadas:**
  - *`GET /rooms/:id/exists`* — leak de metadados, ver §7.
  - *Reservar o path no servidor por N minutos* — introduz estado persistente-ish, TTL, e um vetor de
    squatting de nomes.

### 3.3 Path escolhido pelo usuário: normalização, não rejeição

- **Decisão:** um único `normalizeRoomPath(input)` slugifica: NFD + remoção de diacríticos, minúsculas,
  qualquer caractere fora de `[a-z0-9]` vira `-`, hífens colapsam, hífens das pontas caem. Guardas: 1 a
  **128** caracteres, path resultante não vazio, não reservado (3.6).
- **Motivação:** "Sala do Nícolas" precisa virar `sala-do-nicolas` sem a pessoa ter que descobrir a regra
  sozinha. O cap de 128 não é uma regra de produto — é guarda contra path patológico (limite prático de URL,
  chave de `Map` no servidor, layout do link na UI). Proibir ponto é **obrigatório**: `client/nginx.conf:13`
  captura `\.(js|css|woff2?|png|svg|ico)$` num `location` **sem** `try_files`, então `/minha.sala.js` retorna
  404 em produção em vez de abrir o SPA. Proibir `/` mantém o path num único segmento (3.4).
- **Alternativas descartadas:**
  - *Rejeitar entrada inválida com erro* — hostil; a pessoa digita com acento e espaço porque é assim que se
    escreve.
  - *Aceitar Unicode/percent-encoding* — path bonito na barra, ilegível ao colar (`%C3%A7`), e ambíguo como
    chave de sala. Fere o objetivo de "fácil de ditar".
  - *Sem limite algum de tamanho* — a task pede "sem limite rígido"; 128 caracteres não é um limite que
    alguém encoste sem querer, e sem cap o servidor aceita chave de `Map` arbitrariamente grande.

### 3.4 Sala é um único segmento de path

- **Decisão:** o path da sala não contém `/`. `/a/b` não é sala — é rota desconhecida e cai na Home com aviso.
- **Motivação:** o splat `*` do react-router casaria `/a/b` alegremente, mas aí o namespace de rotas fica
  impossível de reservar no futuro (qualquer `/app/x` novo passa a poder ser sala de alguém) e a checagem de
  reservado vira prefix-matching. Um segmento só mantém a regra legível: **primeiro segmento reservado ⇒
  app; senão ⇒ sala**.
- **Alternativas descartadas:** *permitir hierarquia* — sem dono e sem persistência, `/time/daily` não
  significa nada além de um path mais longo.

### 3.5 Canonicalização no client, com redirect

- **Decisão:** ao montar, Room canonicaliza `location.pathname` (minúsculas, sem barra final, slugificado).
  Se o resultado difere do path atual, faz `navigate(canonico + hash, { replace: true })` **antes** de
  conectar ao signaling.
- **Motivação:** o path é a chave da sala no servidor *e* o salt do PBKDF2 (`lib/e2ee.js:23-35`). Se um
  participante entra por `/Daily` e outro por `/daily`, eles caem em salas diferentes no servidor — falha
  silenciosa em que ninguém vê ninguém. Um único ponto de canonicalização, aplicado antes de qualquer uso do
  valor, elimina a classe inteira do bug. Teclado de celular com autocapitalize torna isso rotina, não caso
  raro.
- **Alternativas descartadas:** *normalizar só na hora de emitir `join-request`* — a barra de endereço e o
  link de convite exibido continuariam divergentes do que o servidor usa; e o salt do E2EE (quando reativado)
  poderia divergir do path exibido.

### 3.6 Rotas reservadas: lista explícita, uma fonte de verdade

- **Decisão:** `RESERVED_SEGMENTS` vive em `client/src/lib/roomPath.js` e é o único lugar que enumera o que
  não pode ser sala: `app`, `room`, `assets`, `api`, `health`, `turn-credentials`, `socket.io`,
  `.well-known`, `favicon.ico`, `robots.txt`, `index.html`, `static`, `public`.
- **Motivação:** três consumidores precisam da mesma lista (roteador, validação do campo da Home,
  canonicalização do Room). Duplicá-la garante divergência. `assets` **precisa** estar na lista: em produção
  é um diretório real e `try_files $uri $uri/` casa `$uri/` antes do fallback do SPA, então `/assets` nunca
  chegaria ao React. `room` fica reservado para o redirect legado.
- **Alternativas descartadas:** *derivar da lista de rotas do react-router* — não cobre os paths servidos
  pelo nginx antes do SPA, que são exatamente os perigosos.

### 3.7 Passphrase ausente: gera nova e redireciona

- **Decisão:** Room detecta `location.hash` vazio, gera passphrase de 128 bits e faz `navigate(path + '#' +
  nova, { replace: true })`. Nenhuma tela de "digite a chave".
- **Motivação:** é o comportamento pedido pela task e é o que faz "digitar `/daily` na barra e apertar enter"
  funcionar como criação de sala. `replace` (nunca `push`) porque um push criaria uma entrada de histórico
  sem chave — o botão Voltar devolveria a pessoa a um path sem fragmento, que geraria outra chave, num laço.
- **Trade-off explícito, obrigatório documentar na UI:** duas pessoas que abrem o **mesmo path sem
  fragmento** recebem passphrases **diferentes**. Elas ficam na mesma sala de sinalização e (hoje, com E2EE
  desabilitada) se veem normalmente; quando a E2EE for reativada, derivariam chaves distintas e não
  decodificariam o vídeo uma da outra. Ver §7 — a mitigação é o texto da UI ("compartilhe o link completo,
  com a parte depois do `#`") e uma nota no código de reativação da E2EE.
- **Alternativas descartadas:**
  - *Derivar a chave do próprio path* — destruiria a E2EE: o servidor conhece o path.
  - *Pedir a passphrase num formulário* — ninguém tem a passphrase fora do link; seria um beco sem saída.

### 3.8 Servidor valida formato de `roomId`

- **Decisão:** `server/src/index.js` passa a exigir `roomId` string de 1..128 caracteres casando
  `^[a-z0-9-]+$`; fora disso, `join-denied { reason: 'invalid-room' }` (motivo já existente em
  `index.js:48`).
- **Motivação:** defesa em profundidade barata. Hoje qualquer cliente pode fazer o servidor guardar chaves de
  `Map` arbitrárias — e a regra de formato agora existe e é conhecida pelos dois lados. Não é o mecanismo de
  segurança da sala (não é, e não deve virar); é sanidade de entrada.
- **Alternativas descartadas:** *manter o servidor totalmente agnóstico* — foi o certo enquanto o id era UUID
  gerado pelo client; com path livre digitado por humano, uma guarda de tamanho passa a valer os 4 linhas.

---

## 4. Componentes Afetados

### Client — novo módulo

**`client/src/lib/roomPath.js`** (novo) — fonte única da gramática de path.

- **O que muda:** criado. Exporta: `ROOM_SLUG_ALPHABET`, `ROOM_SLUG_LENGTH` (9), `MAX_ROOM_PATH_LENGTH`
  (128), `RESERVED_SEGMENTS`, `generateRoomSlug()`, `normalizeRoomPath(input)`, `isReservedPath(path)`,
  `isValidRoomPath(path)`, `generatePassphrase()`, `buildRoomUrl(origin, path, passphrase)`,
  `parseInviteLink(text)`.
- **Por quê:** três telas e os testes precisam da mesma regra; §3.6 e §3.5 dependem de um único ponto de
  verdade. `generatePassphrase` migra de `Home.jsx:6-12` para cá porque agora Room também precisa dela (§3.7)
  — duplicar geração de chave em dois arquivos é exatamente o tipo de divergência que não se descobre em
  review.

### Client — roteamento

**`client/src/App.jsx`**

- **O que muda:** o mapa de rotas passa a ser, nesta ordem: `/` → `<Navigate to="/app" replace>`; `/app` →
  `Home`; `/room/:roomId` → componente de redirect legado; `*` → `Room`.
- **Por quê:** entrega o objetivo central — path na raiz é sala, telas do app vivem sob `/app`.

**`client/src/pages/LegacyRoomRedirect.jsx`** (novo, ou função no próprio `App.jsx`)

- **O que muda:** lê `:roomId` e `location.hash`, redireciona com `replace` para `/{normalize(roomId)}{hash}`.
- **Por quê:** links `/room/<uuid>#chave` compartilhados minutos antes do deploy precisam continuar
  abrindo. Note que o UUID normalizado (`3f2b7c1e-9a41-...`, já minúsculo e alfanumérico com hífen) sobrevive
  ao slugify sem alteração — o redirect preserva a sala, não só a página.

### Client — telas

**`client/src/pages/Home.jsx`**

- **O que muda:**
  1. Remove `generatePassphrase` local (passa a importar de `roomPath.js`).
  2. `handleCreate` usa `generateRoomSlug()` quando o campo de endereço está vazio, ou
     `normalizeRoomPath(campo)` quando preenchido; navega para `/{path}#{passphrase}`.
  3. Novo campo opcional "Endereço da sala", com preview do link final e mensagem de erro inline para path
     vazio após normalização, reservado, ou acima de 128 caracteres.
  4. `handleJoin` passa a usar `parseInviteLink`, que aceita **os dois** formatos (`/room/:id#chave` e
     `/:path#chave`) e também um path colado sem origem (`/daily#chave`).
- **Por quê:** é o ponto de criação; a escolha do endereço não existe em nenhum outro lugar do fluxo.

**`client/src/pages/Room.jsx`**

- **O que muda:**
  1. `const { roomId } = useParams()` (`:43`) → deriva o path do splat/`location.pathname`, aplicando
     `normalizeRoomPath`.
  2. Novo efeito, **antes** de conectar: se o path não é canônico → redirect replace; se `location.hash` está
     vazio → gera passphrase e redirect replace. Enquanto qualquer redirect estiver pendente, nada de
     `getUserMedia`, nada de socket.
  3. Path inválido/reservado → redirect replace para `/app`.
  4. `inviteLink` (`:1015`) passa a `buildRoomUrl(window.location.origin, roomPath, passphrase)`.
  5. Botão "Sair" (`:1110`) e "Voltar" (`:985`) navegam para `/app` em vez de `/`.
  6. Tratamento de `join-denied` ganha o texto para `invalid-room` (`:979-983` hoje cai no genérico "pedido
     negado", que seria mentira).
- **Por quê:** Room é quem consome o path como chave de sinalização e como salt do E2EE; a canonicalização
  precisa acontecer aqui, antes do primeiro uso.

### Server

**`server/src/index.js`**

- **O que muda:** o guard de `join-request` (`:47-50`) ganha validação de formato/tamanho de `roomId`,
  idealmente extraída para um `isValidRoomId(roomId)` exportado por `server/src/rooms.js`.
- **Por quê:** §3.8. Nenhuma outra mudança no servidor — o protocolo e os eventos ficam idênticos.

**`server/src/rooms.js`**

- **O que muda:** nada além (opcionalmente) de hospedar `isValidRoomId`. O `RoomStore` é agnóstico ao formato
  da chave e continua assim.

### Testes

**`client/test/roomPath.test.mjs`** (novo)

- **O que muda:** criado. Cobre: alfabeto e tamanho do slug; ausência de `i/l/o/u`; distribuição sem viés
  (todos os 32 símbolos aparecem numa amostra grande); slugify de acento/espaço/maiúscula/pontuação; hífens
  colapsados e aparados; rejeição de reservados, de vazio-após-normalização, de `>128`, de path com `/` e
  com `.`; idempotência (`normalize(normalize(x)) === normalize(x)`); `parseInviteLink` nos dois formatos +
  link sem hash + link inválido.
- **Por quê:** é lógica pura, sem DOM — casa com o padrão dos testes existentes (`node --test`,
  `client/package.json:11`), e é a única camada onde a regra de path é verificável sem browser.

**`client/test/joinRequestSignaling.test.mjs`**

- **O que muda:** acrescentar caso de `join-request` com `roomId` inválido (vazio, com `/`, com 200 chars)
  esperando `join-denied { reason: 'invalid-room' }`.
- **Por quê:** a validação nova de §3.8 fica sem cobertura de outra forma.

### E2E

**`e2e/run.mjs`** e **`e2e/harness.mjs`**

- **O que muda:** `run.mjs:60-62` troca `crypto.randomUUID()` + `/room/${roomId}` por um slug curto e
  `${CLIENT_ORIGIN}/${roomId}#${passphrase}`. O `roomId` do E2E deve ser gerado com o **mesmo** alfabeto (ou
  ser um path fixo válido, ex. `e2e-sala`) para não depender de caractere que a app rejeitaria. Acrescentar
  um passo curto: abrir `${CLIENT_ORIGIN}/e2e-sem-chave` sem fragmento e verificar que a URL final tem
  fragmento não vazio e mesmo path.
- **Por quê:** o E2E abre a sala por URL direta; sem isso ele testa uma rota que não existe mais. O servidor
  estático do harness (`harness.mjs:134-146`) já faz fallback para `index.html`, então paths de um segmento
  funcionam sem mudança — desde que não casem com arquivo existente em `dist/` (mais um motivo para proibir
  ponto, §3.3).

### Infra

**`client/nginx.conf`**

- **O que muda:** possivelmente nada — `try_files $uri $uri/ /index.html` já cobre paths de um segmento sem
  extensão. **Verificar** e, se o time preferir cinto e suspensório, restringir o `location ~*` de cache ao
  prefixo `/assets/` em vez de casar extensão em qualquer path.
- **Por quê:** o bloco de cache por extensão não tem `try_files`; qualquer path de sala terminando em `.js`,
  `.css`, `.png`, `.svg`, `.ico` ou `.woff2` retornaria 404. A proibição de ponto em §3.3 já fecha o buraco
  pelo lado do client, mas alguém que digita a URL na mão contorna o client.

### Documentação

- **`ARCHITECTURE.md`** — §3 (mecanismo E2EE, `passphrase + roomId` como salt: o salt agora é o path
  canônico), §4 passo 1 (`roomId` (UUID)` → slug base32 de 9 caracteres ou path escolhido; formato do link
  sem `/room/`), §5 (a tabela permanece válida — vale registrar que o path pode agora carregar sentido
  escolhido pelo humano, ou seja, o servidor passa a ver um nome possivelmente descritivo onde antes via um
  UUID opaco).
- **`README.md`** — linhas 52-53, formato do link.
- **`claude-progress.md`** — registro da entrega, como nas anteriores.

---

## 5. Contratos de Interface

### Rotas do client (novas / modificadas / removidas)

| Path | Componente | Situação | Observações |
|------|-----------|----------|-------------|
| `/` | — | modificada | `Navigate` replace para `/app`. Raiz não é sala. |
| `/app` | `Home` | nova | Antiga `/`. Ponto de criação e de entrada por link. |
| `/app/*` | reservado | nova | Namespace das telas da aplicação. Sem rota filha nesta entrega. |
| `/room/:roomId` | redirect legado | modificada | Replace para `/{normalize(roomId)}{hash}`, preservando o fragmento. |
| `*` | `Room` | nova | Primeiro segmento não reservado ⇒ sala. Multi-segmento ⇒ inválido ⇒ `/app`. |

### Contrato do módulo `lib/roomPath.js` (pseudo-assinaturas, sem implementação)

| Função | Entrada | Saída | Observações |
|--------|---------|-------|-------------|
| `generateRoomSlug()` | — | `string` de 9 chars do alfabeto | `crypto.getRandomValues`; `byte % 32` é uniforme. |
| `normalizeRoomPath(input)` | `string` (pode ter acento, espaço, maiúscula, barra inicial) | `string` slugificada ou `''` | `''` sinaliza "não utilizável"; nunca lança. |
| `isReservedPath(path)` | path já normalizado | `boolean` | Compara com `RESERVED_SEGMENTS`. |
| `isValidRoomPath(path)` | path já normalizado | `boolean` | Não vazio, ≤128, `^[a-z0-9-]+$`, não reservado. |
| `generatePassphrase()` | — | `string` base64url de 22 chars | 16 bytes = 128 bits. Movida de `Home.jsx`. |
| `buildRoomUrl(origin, path, passphrase)` | strings | `string` | `${origin}/${path}#${passphrase}`. |
| `parseInviteLink(text)` | link colado ou path | `{ path, passphrase } \| null` | Aceita `/room/:id#k`, `/:path#k` e path relativo. `null` se faltar path ou passphrase. |

### Eventos de sinalização

| Tipo de Evento | Payload | Quem emite | Quem consome | Mudança |
|----------------|---------|------------|--------------|---------|
| `join-request` | `{ roomId, displayName }` | client | servidor | **Payload idêntico.** Muda só o formato do valor de `roomId` (path canônico) e a validação no servidor. |
| `join-denied` | `{ reason: 'invalid-room' }` | servidor | client | Motivo já existe; passa a ser emitido também para `roomId` fora do formato, e ganha texto próprio na UI. |

> Nenhum evento novo. Nenhum endpoint REST novo, modificado ou removido.

### Schema de Banco

Não aplicável — o produto não tem banco. `RoomStore` continua sendo `Map` em memória.

---

## 6. Dependências e Ordem de Implementação

1. **`client/src/lib/roomPath.js`** — fundação; tudo depende dele.
2. **`client/test/roomPath.test.mjs`** — imediatamente depois de (1), antes de qualquer consumidor. A
   gramática de path precisa estar travada antes de três telas passarem a depender dela.
3. **`client/src/App.jsx` + redirect legado** — depende de (1) para `RESERVED_SEGMENTS`.
4. **`client/src/pages/Home.jsx`** — depende de (1) e (3). *Pode rodar em paralelo com (5).*
5. **`client/src/pages/Room.jsx`** — depende de (1) e (3). *Pode rodar em paralelo com (4).*
6. **`server/src/index.js` (+ `rooms.js`)** — independente de 1-5; *pode rodar em paralelo desde o início*,
   desde que a regra de formato acordada em §3.3/§3.8 seja respeitada.
7. **`client/test/joinRequestSignaling.test.mjs`** — depende de (6).
8. **`e2e/run.mjs` / `e2e/harness.mjs`** — depende de (3), (4) e (5) estarem no lugar.
9. **Docs (`ARCHITECTURE.md`, `README.md`, `claude-progress.md`)** — por último, refletindo o que ficou.

---

## 7. Riscos e Armadilhas

**Risco: divergência de canonicalização parte a sala em duas.**
Se um lugar normaliza e outro não (ex.: Home navega para `/Daily`, Room emite `join-request` com `daily`),
duas pessoas ficam em salas de sinalização diferentes e cada uma vê uma sala vazia — sem nenhum erro.
- **Mitigação:** `normalizeRoomPath` é o único caminho; Room canonicaliza e redireciona **antes** de
  conectar. Todo valor que vira chave de sala ou salt de PBKDF2 sai de lá.
- **Anti-pattern a evitar:** normalizar "onde precisa" (na hora de emitir o evento) e deixar a barra de
  endereço/link de convite com o valor cru.

**Risco: o redirect de passphrase entra em laço ou dispara `getUserMedia` duas vezes.**
Room monta, gera chave, redireciona, remonta — se o efeito de setup rodar antes do redirect, a câmera acende
duas vezes e dois sockets entram na mesma sala com o mesmo nome.
- **Mitigação:** o efeito de canonicalização/passphrase roda primeiro e, enquanto houver redirect pendente,
  o efeito de setup faz early-return. `navigate(..., { replace: true })` sempre — nunca `push`.
- **Anti-pattern a evitar:** `push` no redirect. O Voltar levaria de volta ao path sem fragmento, que geraria
  outra chave — laço infinito com chave nova a cada volta.

**Risco: link sem fragmento circula como se fosse convite.**
Duas pessoas abrindo `/daily` sem `#` recebem passphrases diferentes (§3.7). Hoje, com E2EE desabilitada, a
chamada funciona e ninguém percebe; no dia em que a E2EE for religada, vira "vejo a pessoa na lista mas o
vídeo não aparece".
- **Mitigação:** o texto da Home e o `.invite-hint` da sala precisam dizer que o link **inclui** a parte
  depois do `#`. Adicionar comentário no ponto de derivação de chave (`Room.jsx:238`) registrando essa
  precondição para quem reativar a E2EE.
- **Anti-pattern a evitar:** derivar a chave do path para "resolver" o problema — o servidor conhece o path;
  isso zera a E2EE.

**Risco: path de sala colide com asset servido pelo nginx.**
`/assets` casa `try_files $uri/` e nunca chega ao React; `/algo.js` cai no `location ~*` de cache
(`nginx.conf:13`), que **não** tem `try_files`, e retorna 404.
- **Mitigação:** ponto proibido na gramática de path; `assets`/`static`/`public` na lista de reservados;
  avaliar restringir o bloco de cache a `location /assets/`.
- **Anti-pattern a evitar:** confiar só na validação do client. Quem digita a URL na mão não passa por ela —
  a defesa que vale é a do nginx.

**Risco: viés no sorteio do slug.**
Implementar com `Math.random()`, ou com `getRandomValues` e um alfabeto que não seja potência de 2, gera
distribuição enviesada.
- **Mitigação:** alfabeto de exatamente 32 símbolos e `crypto.getRandomValues`; teste cobre a presença dos
  32 símbolos numa amostra grande.
- **Anti-pattern a evitar:** `Math.random().toString(36)` — enviesado, alfabeto errado, entropia
  imprevisível. O padrão de fallback em `useMusicRoom.js:89` é aceitável para id local de mensagem; **não**
  serve para endereço de sala.

**Risco: path curto e adivinhável baixa a barreira de "bater na porta".**
`/daily` é trivial de chutar; um estranho pode disparar um pedido de entrada.
- **Mitigação:** nenhuma mudança necessária — a aprovação manual (`ARCHITECTURE.md §4`) já é a fronteira, e
  o conteúdo permanece protegido pela passphrase, que o adivinhador não tem. Vale um aviso na UI de que
  endereço personalizado é mais fácil de adivinhar do que um slug gerado.
- **Anti-pattern a evitar:** compensar com "senha da sala" enviada ao servidor. Seria a primeira coisa
  secreta a trafegar pelo signaling — quebra a promessa central do produto.

**Risco: enumeração de salas via API.**
- **Mitigação:** não criar endpoint de existência/disponibilidade (§3.2).
- **Anti-pattern a evitar:** "só para melhorar a UX do campo de endereço" — é exatamente o pretexto pelo qual
  esse endpoint costuma nascer.

**Risco: E2E quebrado silenciosamente.**
`e2e/run.mjs:62` monta a URL da sala à mão; se ficar em `/room/...`, o novo roteador manda para `Room` como
sala de path `room` — que é **reservado** — e o teste vira redirect para `/app`, com falhas confusas.
- **Mitigação:** item 8 da ordem de implementação; rodar o E2E completo antes de fechar.
- **Anti-pattern a evitar:** deixar `/room/` no E2E "porque o redirect legado cobre" — o redirect legado
  espera `/room/:roomId`, e depender dele no teste principal apagaria a cobertura da rota nova.

---

## 8. Critérios de Aceite Técnicos

**Slug e criação**

1. "Criar sala" com o campo de endereço vazio navega para um path de exatamente 9 caracteres, todos em
   `0123456789abcdefghjkmnpqrstvwxyz`, seguido de `#` e uma passphrase não vazia.
2. Duas criações consecutivas produzem paths diferentes.
3. Nenhum path gerado contém `i`, `l`, `o` ou `u`.

**Endereço personalizado**

4. Endereço `Sala do Nícolas!` resulta no path `/sala-do-nicolas`.
5. Endereço com 128 caracteres válidos é aceito; com 129, o botão de criar fica bloqueado e aparece erro
   inline.
6. Endereço `app`, `room` ou `assets` é recusado com erro inline citando que o endereço é reservado.
7. Endereço que normaliza para vazio (ex.: `!!!`) é recusado com erro inline.

**Rotas**

8. Abrir `/` resulta em `/app` na barra de endereço, sem entrada extra no histórico (um Voltar sai do app,
   não volta para `/`).
9. Abrir `/qualquer-coisa#chave` monta a tela de sala e emite `join-request` com `roomId === 'qualquer-coisa'`.
10. Abrir `/room/<uuid>#chave` resulta em `/<uuid>#chave` e entra na mesma sala de sinalização, com a
    passphrase preservada.
11. Abrir `/a/b` resulta em `/app`, sem tentar conectar ao signaling.

**Canonicalização**

12. Abrir `/Daily#chave` resulta em `/daily#chave`; o `join-request` carrega `daily`.
13. Abrir `/daily/#chave` (barra final) resulta em `/daily#chave`.
14. Em nenhum dos casos acima o socket conecta com o valor não canônico — a única emissão de `join-request`
    da sessão usa o path canônico.

**Passphrase ausente**

15. Abrir `/daily` sem fragmento resulta, sem interação do usuário, em `/daily#<passphrase>` com passphrase
    não vazia, mesmo path, e `replace` no histórico.
16. Após esse redirect, apertar Voltar sai do app — não retorna a `/daily` sem fragmento.
17. Duas aberturas de `/daily` sem fragmento produzem passphrases diferentes (comportamento documentado,
    não bug).

**Link de convite**

18. Dentro da sala, o link exibido é `{origin}/{path}#{passphrase}`, sem `/room/`, e abrir esse link em outra
    aba leva à mesma sala com a mesma passphrase.
19. Colar no campo "Entrar" um link no formato novo, um no formato legado `/room/:id#k`, ou um path relativo
    `/daily#k`, leva à sala correta nos três casos.
20. Colar um link sem `#` mostra "Link de convite inválido" e não navega.

**Servidor**

21. `join-request` com `roomId` de 129 caracteres, com `/`, com maiúsculas ou vazio responde
    `join-denied { reason: 'invalid-room' }` e não cria entrada no `RoomStore`.
22. `join-request` com `roomId` válido mantém exatamente o comportamento atual (auto-admissão do primeiro,
    fila de aprovação para os demais, `room-full` em 6).
23. A tela de acesso negado exibe texto específico para `invalid-room`, distinto do genérico "pedido negado".

**Não regressão**

24. `npm test` no client passa inteiro, incluindo os arquivos existentes.
25. O E2E de 3 participantes passa fim a fim com a URL de sala no formato novo.

---

## 9. Notas para os Agentes de Implementação

**Divisão sugerida**

- *Agente A (fundação):* itens 1, 2 e 6 da ordem de implementação — `lib/roomPath.js`, seu teste, e a
  validação no servidor. Entregar isso primeiro e completo; é contrato para os outros.
- *Agente B (rotas e telas):* itens 3, 4, 5 — `App.jsx`, redirect legado, `Home.jsx`, `Room.jsx`.
- *Agente C (testes e docs):* itens 7, 8, 9 — teste de sinalização, E2E, documentação.

**Pitfalls específicos desta demanda**

- `Room.jsx` tem um efeito de setup grande com dependências `[roomId, passphrase, displayName]` (`:456`) que
  adquire mídia e abre socket. **O redirect precisa acontecer antes dele rodar** — não depois, não em
  paralelo. Um early-return guardado por "path canônico E hash presente" é o caminho; verifique também o
  cleanup (`:428-454`), que hoje pressupõe que o setup rodou.
- O splat de `<Route path="*">` chega por `useParams()['*']` **sem** a barra inicial; `location.pathname` vem
  **com**. Escolha um e seja consistente — `normalizeRoomPath` deve tolerar os dois, mas o código não deve
  depender dessa tolerância.
- `deriveRoomKey(passphrase, roomId)` (`lib/e2ee.js:23`) está comentado em `Room.jsx:238`. **Não reative a
  E2EE nesta task.** Só garanta que, quando for reativada, o valor passado como salt seja o path já
  canonicalizado — deixe o comentário registrando isso.
- Ao mexer em `Room.jsx`, atenção ao histórico deste repositório: já houve duas fusões que apagaram blocos
  do render (`SpotlightStage`, `MusicVoteCard`, `RemoteMusicAudio`, `tiles={people}`) — ver commits `1b09b12`
  e `1baa707`. Faça edições cirúrgicas nos pontos listados em §4; não reescreva o arquivo.
- Os textos dos botões da barra de controles são comparados por `textContent` exato no E2E
  (comentário em `Room.jsx:1087-1088`). Não mexa neles.
- `parseInviteLink` recebe texto colado por humano: pode vir com espaços nas pontas, sem esquema
  (`meet.exemplo.com/daily#k`) ou como path puro. `new URL(text)` sozinho lança nos dois últimos casos —
  trate antes, e nunca deixe a exceção escapar para o render.

**Ordem de validação após implementação**

1. `cd client && npm test` — inclui o novo `roomPath.test.mjs` e o de sinalização.
2. `cd server && npm test` (se existir script) ou o teste de sinalização do client, que sobe o servidor real.
3. Smoke manual: `/`, `/app`, `/daily`, `/daily` sem hash, `/Daily`, `/room/<uuid>#k`, `/a/b`, `/assets`.
4. `node e2e/run.mjs` — fim a fim, 3 participantes.
5. Build de produção + nginx (`docker compose up --build client`) e conferir na imagem real:
   `/uma-sala-so-minha` abre o SPA, `/assets/<arquivo real>` continua servindo o asset.
