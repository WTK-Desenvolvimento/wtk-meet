# Entrar com a câmera desligada por padrão, com tela de pré-entrada — Documento de Arquitetura Técnica

> Gerado em: 2026-08-21
> Status: Rascunho
> Task: WTK-MEET-19 — Entrar na sala com a câmera desligada por padrão, com tela de pré-entrada
> Autor: Arquiteto

---

## 1. Contexto e Objetivo

### Problema atual

O efeito de setup de `client/src/pages/Room.jsx` (`getLocalStream`, por volta da linha 316) tenta, como
primeira opção, `getUserMedia({ video: true, audio: true })`. O estado local nasce `useState(false)` para
`cameraOff` (linha 97). A soma das duas coisas é: **abrir o link de uma sala acende o LED da webcam antes de
qualquer decisão de quem abriu**, e o vídeo começa a sair para todo mundo assim que a entrada é aprovada.

Hoje o único ponto de decisão antes da conexão é o formulário de nome (`if (!displayName)`, linha ~1180) — um
campo de texto e um botão, sem preview e sem nenhuma escolha sobre mídia.

Há um segundo defeito, hoje raro e que esta entrega torna o caso comum: quem já está na sala vê o tile do
recém-chegado **preto**, não em placeholder, na janela entre o `ontrack` do áudio e a chegada da mensagem
`state` pelo data channel. A causa está em `VideoTile.jsx`: `showVideo = !!stream && !cameraOff`, com
`cameraOff` vindo de um registro de participante que nasce sem o campo (`peer-joined` só grava
`displayName`, e `!!undefined` é `false`). Um stream só de áudio satisfaz `!!stream`, e o `<video>` é
montado com um stream sem track de vídeo.

### Comportamento esperado após a entrega

- Quem abre um link de sala **sem nome na sessão** cai numa tela de pré-entrada com: campo de nome, preview
  local espelhado, toggle de câmera e botão de Configurações. Nada disso conecta nada.
- O padrão de fábrica é **entrar com a câmera desligada**: sem preferência gravada, nenhum `getUserMedia`
  com `video: true` acontece — nem no lobby, nem na entrada.
- A escolha do toggle é gravada na hora em `localStorage`, no campo novo `startCameraOff` da chave que já
  existe (`wtk-meet:devices`), e vale para as próximas salas.
- Quem já está na sala vê o tile do recém-chegado **em placeholder desde o primeiro frame**: sem retângulo
  preto, sem piscar vídeo, e sem nenhum toast ou bipe de "desligou a câmera" (entrar desligado não é
  transição de estado).
- Ligar a câmera depois de entrar continua sendo `replaceTrack` no canal de vídeo que já foi negociado —
  sem SDP novo, sem derrubar áudio, música ou tela.

### Vínculo com o produto

O LED aceso sem pedido é o defeito de privacidade mais visível que este produto pode ter: é uma promessa
quebrada em hardware, não em texto. O `ARCHITECTURE.md` §1 coloca "nada de conteúdo no servidor" como
objetivo — mas o que a pessoa transmite sem ter escolhido transmitir é a mesma classe de problema, um passo
antes. Além disso, tela de pré-entrada é o comportamento que qualquer pessoa que já usou Meet ou Zoom
espera: a ausência dela hoje é lida como imaturidade do produto, não como simplicidade.

---

## 2. Escopo

**Dentro do escopo:**

- `client/src/lib/devices.js`: preferência `startCameraOff` (default `true`) e helper puro do plano de mídia
  inicial.
- `client/src/components/PreJoin.jsx` (novo): a tela de pré-entrada, com preview opt-in.
- `client/src/pages/Room.jsx`: renderizar o `PreJoin` no lugar do formulário de nome, iniciar `cameraOff` da
  preferência, usar o plano de mídia na cadeia de entrada, e semear `cameraOff: true` em todo registro de
  participante recém-criado.
- `client/src/components/VideoTile.jsx`: só montar imagem quando o stream de fato tem track de vídeo.
- `client/src/styles.css`: estilos do lobby, reaproveitando `.home` e `.local-preview`.
- Testes: `client/test/devices.test.mjs` (estendido) e `client/test/joinCameraDefault.test.mjs` (novo).
- `e2e/harness.mjs` (entrada pelo lobby) e `e2e/run.mjs` (checks novos + reordenação das seções E. e S.).
- `README.md` e `ARCHITECTURE.md`.

**Fora do escopo:**

- **Toggle de câmera na Home.** Quem cria a sala pela Home já tem nome em `sessionStorage` e não passa pelo
  lobby (ver Decisão 1). O caminho fica com o padrão de fábrica (câmera desligada) e com o botão "Ativar
  câmera" dentro da sala. A lacuna está registrada no risco R7, com o encaminhamento sugerido.
- **Microfone.** `muted` continua nascendo `false`, nenhuma constraint de áudio muda, e o lobby **não** abre
  o microfone (ver Decisão 4). Entrar mutado é outra demanda.
- **Preferência por sala.** `startCameraOff` é global do navegador, não por endereço de sala.
- **Mudar a política de entrada** (aprovação, sala cheia, passphrase): nada aqui encosta nisso.
- **Sincronizar a escolha entre abas** (`storage` event). Duas abas abertas mantêm cada uma a sua leitura;
  é o comportamento que as outras preferências já têm.

---

## 3. Decisões Arquiteturais

### D1. O lobby continua sendo o ramo `!displayName` — não se cria um estado `joined`

- **Decisão:** a tela de pré-entrada substitui o formulário de nome no mesmo ponto em que ele está hoje
  (`if (!displayName) return <PreJoin/>`). Quem já tem nome em `sessionStorage` — quem veio da Home e quem
  recarregou a página — continua entrando direto, com a preferência gravada decidindo a câmera.
- **Motivação:** (a) o `sessionStorage` guarda uma decisão que a pessoa já tomou, e a preferência de câmera
  também; exigir um clique para reconfirmar as duas a cada F5 é ruído. (b) O roteiro do E2E depende disso:
  a seção D. recarrega a aba do Bob e espera que ele volte à chamada sozinho (`e2e/run.mjs:728-740`) —
  um gate obrigatório transformaria isso num timeout de 40s difícil de ler. (c) O plano da própria task
  pede explicitamente que recarregar não perca a decisão.
- **Alternativas descartadas:** um estado `joined` que força o lobby em toda montagem. Resolveria a lacuna
  do caminho da Home (R7), mas ao custo de um clique obrigatório em todo reload, de uma alteração na
  seção D. do E2E e de um segundo formulário de nome para quem acabou de digitar o nome na Home. O ganho
  de privacidade é nulo: sem preferência gravada, o padrão já é câmera desligada nos dois caminhos.

### D2. `startCameraOff` mora em `wtk-meet:devices`, e o default é `true`

- **Decisão:** campo booleano novo em `DEFAULT_PREFERENCES`, com `true` (entrar desligado) como default.
  A validação segue o molde de `soundsEnabled`: só um booleano de verdade é aceito; string, número, `null`
  e ausência caem no default.
- **Motivação:** é preferência de hardware da pessoa, da mesma natureza das outras três, e cabe na exceção
  de persistência já declarada no cabeçalho de `lib/devices.js`. Reusar a chave significa que
  `readPreferences`/`writePreferences`/`sanitize` já entregam merge parcial, tolerância a JSON inválido e a
  modo privado — nada disso precisa ser escrito de novo. Preferência gravada por versão anterior (sem o
  campo) resolve para `true`, que é o comportamento seguro.
- **Alternativas descartadas:** chave própria (`wtk-meet:join`). Só se justificaria se o módulo precisasse
  ficar puro de algo — foi o caso da supressão de ruído, que depende de capacidade do navegador. Aqui não
  há nada disso: seria uma terceira chave para um booleano.
- **Nota de nomenclatura:** o nome é negativo (`startCameraOff`) por vir assim do DoD, e porque o default
  `true` fica coerente com "o que não foi decidido é desligado". A UI mostra o inverso ("Entrar com a
  câmera ligada"), então a conversão acontece num ponto só — ver Decisão 5.

### D3. O plano de mídia inicial é uma função pura em `lib/devices.js`

- **Decisão:** `initialMediaPlan(prefs, { audioProcessing })` devolve `{ wantsVideo, cameraOff, attempts }`.
  Fica em `devices.js`, ao lado de `buildConstraints`, e não em módulo novo.
- **Motivação:** é a única forma de cobrir a cadeia de entrada em `node:test` sem DOM — o `Room.jsx` inteiro
  é intestável hoje. `audioProcessing` é injetado por quem chama, exatamente como em `buildConstraints`, e é
  isso que mantém o módulo puro (a preferência de supressão mora em outra chave).
- **Detalhe que não pode passar batido:** com `startCameraOff: true`, a cadeia atual colapsa — a primeira e
  a segunda tentativa viram a **mesma** requisição. O plano deve devolver **duas** tentativas nesse caso
  (a com preferência de microfone e a sem), não três com uma repetida: um `getUserMedia` a mais numa falha
  é meio segundo de espera que ninguém entende.
- **Alternativas descartadas:** ramificar dentro de `getLocalStream` no `Room.jsx`. É o que existe hoje, e é
  justamente o que não tem teste.

### D4. O preview do lobby é opt-in, só de vídeo, e o stream **não** é entregue à sala

- **Decisão:** o `PreJoin` abre o próprio `getUserMedia({ video: <preferência>, audio: false })` **apenas**
  quando o toggle está ligado, e o para no cleanup do efeito. Ao entrar, o stream do lobby morre e o efeito
  de setup da sala faz o seu próprio `getUserMedia`.
- **Motivação:** três razões, em ordem de peso.
  1. **`StrictMode` está ligado** (`client/src/main.jsx`): todo efeito monta, desmonta e remonta em
     desenvolvimento. Um stream criado no lobby e "emprestado" ao efeito da sala seria parado pela primeira
     limpeza e chegaria morto na segunda execução — um bug que só aparece em dev, ou só em prod, dependendo
     de quem escreveu a guarda.
  2. **Dono único.** O efeito de setup é hoje o dono absoluto de `localStreamRef`, do pipeline de microfone
     e do teardown. Introduzir um stream com dono anterior espalha a responsabilidade de apagar o LED por
     dois lugares — que é a classe de bug que o `ARCHITECTURE.md` §6.6 existe para evitar.
  3. **Precedente.** O `SettingsModal` já faz exatamente isto: preview próprio, montado condicionalmente,
     parado no desmonte, sem nunca entregar o stream ao pai.
- **Custo aceito:** um `getUserMedia` a mais para quem entra com a câmera ligada, e um pisca-pisca local do
  preview no momento da entrada. Ninguém do outro lado vê nada — não há peer conectado ainda.
- **Ordem que precisa ser garantida:** o `PreJoin` precisa ser um **componente**, não um bloco de JSX
  inline. É o desmonte dele que dispara a limpeza, e o React roda todas as limpezas de um commit antes de
  qualquer efeito novo — é isso que garante que a câmera do lobby está fechada antes do `getUserMedia` da
  sala. Duas capturas simultâneas do mesmo device dão `NotReadableError` em parte das máquinas Windows e
  Linux, e o sintoma seria "às vezes entro sem vídeo".
- **Sem microfone no lobby:** o DoD não pede medidor de nível na pré-entrada, e abrir o microfone ali
  acenderia o indicador de captura do sistema operacional antes da entrada — a mesma crítica que a task faz
  à câmera, num device diferente. Quem quiser conferir o microfone abre Configurações, que tem medidor.

### D5. Uma fonte da verdade para a escolha: o estado `cameraOff` do `Room`

- **Decisão:** o toggle do lobby não tem estado próprio. Ele recebe `cameraOn={!cameraOff}` e chama um
  callback do `Room` que faz duas coisas, nesta ordem: `savePreferences({ startCameraOff: !on })` e
  `setCameraOff(!on)`. O `cameraOff` do `Room` passa a nascer de
  `readPreferences(window.localStorage).startCameraOff`.
- **Motivação:** com dois estados (um no lobby, outro no `Room`) existe um caminho em que a pessoa vê o
  toggle ligado e entra desligada. Um estado só, inicializado da preferência e escrito na hora, elimina a
  categoria inteira. Gravar no clique — e não no submit — também é o que faz a escolha valer quando a pessoa
  fecha a aba antes de entrar.
- **Consequência desejada:** o `videoPreview={!cameraOff}` que o `SettingsModal` já recebe do `Room` passa a
  funcionar de graça no lobby: abrir Configurações com o toggle desligado não acende a câmera lá dentro.

### D6. Participante remoto nasce `cameraOff: true` — desconhecido é desligado

- **Decisão:** todo registro de participante criado antes de ter recebido uma mensagem `state` do peer nasce
  com `cameraOff: true`. Isso vale nos **três** pontos que criam registro hoje: o loop de `members` do
  `join-approved`, o `peer-joined` e o `onRemoteStream` (que também cria, com
  `{ ...(next.get(peerId) || {}), stream }`).
- **Motivação:** é o que entrega "placeholder desde o primeiro frame". A mensagem `state` chega quando o
  data channel abre (`_announceState`, `webrtcMesh.js:938`), e não há garantia nenhuma de que isso aconteça
  antes do primeiro `ontrack`. Assumir "ligado" enquanto não se sabe é escolher o erro mais caro: um
  retângulo preto ou um frame de vídeo de alguém que pediu para não aparecer.
- **Custo aceito:** um peer que está com a câmera **ligada** aparece em placeholder por algumas centenas de
  milissegundos até o `state` chegar. É a troca certa — o erro do outro lado é irreversível.
- **Implementação sugerida:** uma constante `DEFAULT_PARTICIPANT` no `Room.jsx` e todo `next.set(...)` de
  criação passando por ela. Três `set` espalhados com o campo escrito à mão é como este bug volta.

### D7. `VideoTile` só monta imagem quando o stream tem track de vídeo

- **Decisão:** `showVideo` passa a exigir, além de `!!stream && !cameraOff`, que o stream tenha ao menos uma
  track de vídeo. O estado é mantido com os listeners de `addtrack`/`removetrack` que o componente **já**
  registra para o refresh de `srcObject`.
- **Motivação:** é o piso estrutural. A Decisão 6 depende de mensagens chegarem na ordem certa; esta não
  depende de nada — sem track de vídeo, não há o que mostrar, e o placeholder é o correto por construção.
  Vale também para o tile local na tela de espera, que hoje é montado sem `cameraOff` nenhum
  (`Room.jsx:~1240`) e ficaria preto ao entrar sem vídeo.
- **Anti-pattern explícito:** **não** derivar "câmera desligada" de `track.muted` no lado receptor. Um
  `replaceTrack(null)` do outro lado não remove a track do stream recebido nem dispara `ended` — a track só
  fica muda, e ela também fica muda em soluço de rede. Confundir os dois faria a sala inteira piscar
  placeholder a cada engasgo de banda. Quem responde por "desligou" é a mensagem `state`, e só ela.
- **Complemento necessário:** passar `cameraOff={cameraOff}` no `VideoTile` da tela de espera, para que os
  dois caminhos concordem.

### D8. Nenhum toast de câmera é criado — a ausência é o requisito

- **Decisão:** nada a implementar. Auditoria feita: `pushToast` é chamado em exatamente dois pontos de
  presença (`peer-joined` e `peer-left`) e nos avisos do player de música; `onRemotePeerState` só atualiza
  estado. Não existe hoje toast nem bipe de câmera, e **nenhum deve ser introduzido** ao mexer no
  `onRemotePeerState`.
- **Motivação:** o item do DoD é uma proteção contra o remédio errado. A tentação, ao implementar a
  Decisão 6, é notificar a primeira transição recebida por peer — o que produziria "Fulano desligou a
  câmera" no instante em que Fulano entra. O E2E passa a assertar a ausência (ver §8).

### D9. Pedir vídeo e não conseguir vira aviso, não silêncio

- **Decisão:** se `startCameraOff === false` (a pessoa pediu para entrar com vídeo) e a cadeia de entrada
  terminar sem track de vídeo, o `Room` seta `mediaError` com uma frase específica. Se a pessoa entrou
  desligada, nada é dito — não houve falha.
- **Motivação:** hoje a cadeia de fallback é silenciosa, o que está certo para "o headset salvo não existe
  mais". Mas "pedi câmera e entrei sem" é uma discrepância entre o que a pessoa escolheu e o que aconteceu:
  sem aviso, ela conclui que os outros a estão vendo. `mediaError` já é uma linha de aviso não bloqueante
  (`.warning`), não um erro de tela.

### D10. O preview do lobby para enquanto o modal de configurações está aberto

- **Decisão:** o `PreJoin` recebe `previewPaused` (ligado a `settingsOpen`) e trata a pausa como o toggle
  desligado: o efeito limpa e o stream morre.
- **Motivação:** o `SettingsModal` abre o próprio preview de câmera. Dois `getUserMedia` de vídeo sobre o
  mesmo device, na mesma aba, é justamente o cenário de `NotReadableError` em hardware de acesso exclusivo —
  e o sintoma ("o preview do modal não abre, às vezes") é caro de diagnosticar.
- **Nota:** no lobby não existe `AudioLevelMonitor` ainda, então `openSettings` passa `audioContext = null`
  para o modal. Isso já é suportado — é exatamente o que a Home faz.

---

## 4. Componentes Afetados

### `client/src/lib/devices.js`

- **O que muda:** `startCameraOff: true` em `DEFAULT_PREFERENCES`; `sanitize` aceitando o campo só quando
  booleano; `initialMediaPlan` novo e exportado. Atualizar o cabeçalho do módulo dizendo por que a
  preferência cabe na exceção de persistência.
- **Por quê:** é o único lugar puro onde a política de entrada pode ser escrita e testada.
- **Verificar sem alterar:** `reconcilePreferences` chama `sanitize` e itera apenas `ID_KEYS` — o campo novo
  sobrevive. Um teste cobre isso (§8), porque a próxima pessoa que mexer ali não vai saber.
- **Correção de passagem:** o cabeçalho cita `ARCHITECTURE.md §6.8` para a exceção de persistência, mas hoje
  §6.8 é "Destaque de compartilhamento de tela" — a seção certa é **§6.10**. Mesma correção no comentário
  equivalente de `Room.jsx` (~linha 118).

### `client/src/components/PreJoin.jsx` (novo)

- **O que muda:** componente novo. Mantém o markup atual da tela de nome (classe `home`, `<h1>wtk-meet</h1>`,
  tagline, `maxLength={40}`, `autoFocus`, botão desabilitado com nome vazio) e acrescenta preview, toggle e
  botão de Configurações.
- **Por quê:** ser um componente com efeito próprio é o que garante a ordem de desmonte da Decisão 4.

### `client/src/pages/Room.jsx`

- **O que muda:** (a) `cameraOff` inicializado da preferência; (b) o ramo `!displayName` passa a renderizar
  `<PreJoin/>`; (c) o callback do toggle (Decisão 5); (d) `getLocalStream` consumindo `initialMediaPlan`;
  (e) `DEFAULT_PARTICIPANT` aplicado nos três pontos de criação de registro; (f) `cameraOff` passado ao
  `VideoTile` da tela de espera; (g) o aviso da Decisão 9.
- **Por quê:** é onde o efeito de setup, o mesh e o estado de participantes vivem.
- **Não muda:** `mesh.localState = { ..., cameraOff: !cameraTrackRef.current }` já produz `true` sozinho
  quando não há track — confirmar, não reescrever. O mesmo vale para `if (!cameraTrackRef.current)
  setCameraOff(true)`, que deixa de ser correção de erro e passa a ser confirmação do caminho normal.

### `client/src/components/VideoTile.jsx`

- **O que muda:** `showVideo` passa a considerar a presença de track de vídeo, com o estado atualizado nos
  listeners que já existem.
- **Por quê:** Decisão 7.

### `client/src/lib/webrtcMesh.js`

- **O que muda:** **nada.** Os quatro transceivers `sendonly` são criados por `addTransceiver` na negociação
  (`webrtcMesh.js:382-383`), sem depender de track existir; `_safeReplace(sender, null)` é o caminho normal.
  Ligar a câmera depois continua sendo `replaceTrack`. Confirmar no E2E, não alterar o arquivo.

### `client/src/styles.css`

- **O que muda:** estilos do lobby, reusando `.home` e `.local-preview`; estilo do toggle.

### Testes e E2E

- `client/test/devices.test.mjs` — casos do campo novo.
- `client/test/joinCameraDefault.test.mjs` (novo) — `initialMediaPlan` e o snapshot de estado do mesh.
- `e2e/harness.mjs` — `openParticipant` passa a saber entrar pelo lobby.
- `e2e/run.mjs` — checks novos e reordenação das seções E. e S.

### Documentação

- `README.md` — "Fluxo de uma chamada" (itens 3 e 5), subseção da pré-entrada, lista de campos de
  `wtk-meet:devices`.
- `ARCHITECTURE.md` — §6 e §6.10. Ao editar §6.1, corrigir de passagem "três transceivers" para **quatro**
  (mic, câmera, tela, música): o texto ficou para trás do código quando a música entrou.

---

## 5. Contratos de Interface

### Preferências persistidas — chave `wtk-meet:devices`

| Campo | Tipo | Default | Observações |
|-------|------|---------|-------------|
| `startCameraOff` | `boolean` | `true` | Só booleano é aceito; qualquer outro valor (ausente, `'sim'`, `1`, `null`) resolve para `true`. Escrito no clique do toggle, não no submit. |

Os demais campos (`videoInputId`, `audioInputId`, `audioOutputId`, `soundsEnabled`) não mudam.

### `initialMediaPlan(prefs, { audioProcessing })` — pura, em `lib/devices.js`

| Retorno | Tipo | Significado |
|---------|------|-------------|
| `wantsVideo` | `boolean` | `!prefs.startCameraOff`. |
| `cameraOff` | `boolean` | Estado inicial da UI. Igual a `prefs.startCameraOff`; a confirmação real vem do track obtido. |
| `attempts` | `Array<MediaStreamConstraints>` | Cadeia de fallback, do mais desejado ao mínimo viável. |

Pseudológica de `attempts`:

- `wantsVideo === true` → três tentativas: `[vídeo+áudio com preferências, áudio com preferência,
  áudio sem nenhuma preferência]`. É a cadeia de hoje, inalterada.
- `wantsVideo === false` → duas tentativas: `[áudio com preferência, áudio sem nenhuma preferência]`.
  Nenhuma delas contém `video` verdadeiro — este é o item verificável do DoD.
- A última tentativa **sempre** ignora a preferência de microfone, de propósito: uma preferência obsoleta
  não pode fazer a pessoa entrar sem áudio nenhum. O comentário que explica isso hoje deve migrar junto.

### `PreJoin` — props

| Prop | Tipo | Papel |
|------|------|-------|
| `preferences` | objeto | Fonte das constraints do preview (`buildConstraints`). |
| `nameInput` / `onNameChange` | string / fn | Campo de nome controlado pelo pai, como hoje. |
| `cameraOn` | boolean | `!cameraOff` do `Room` — o toggle não tem estado próprio. |
| `onToggleCamera` | fn(boolean) | Grava a preferência e atualiza `cameraOff` (Decisão 5). |
| `previewPaused` | boolean | Ligado a `settingsOpen`; suspende o preview (Decisão 10). |
| `onSubmit` | fn(nome) | Grava `displayName` em `sessionStorage` e no estado — é o que dispara o setup. |
| `onOpenSettings` | fn | Reusa o `openSettings` do `Room`. |
| `onPreviewError` | fn(mensagem) | Falha de preview vira linha de aviso; **nunca** bloqueia a entrada. |

### `VideoTile` — comportamento (sem prop nova)

| Condição | Renderiza |
|----------|-----------|
| Stream ausente | Placeholder |
| Stream sem track de vídeo | Placeholder |
| Stream com track de vídeo e `cameraOff` | Placeholder |
| Stream com track de vídeo e `!cameraOff` | `<video>` |

O `<video>` continua montado sempre — o placeholder é camada por cima. Isso não muda.

### Registro de participante (estado do `Room`)

| Campo | Valor ao criar o registro | Quem sobrescreve |
|-------|---------------------------|------------------|
| `displayName` | do evento de sinalização | `state` complementa se estiver vazio |
| `stream` / `screenStream` | `null` | `onRemoteStream` / `onRemoteScreen` |
| `cameraOff` | **`true`** (mudança) | `onRemotePeerState` |
| `micOff` | `false` | `onRemotePeerState` |

### Eventos em tempo real

Nenhuma mensagem nova e nenhum campo novo. A mensagem `state` do data channel
(`{ type: 'state', displayName, cameraOff, micOff, screenOn }`) já carrega tudo, e o snapshot enviado a cada
canal que abre (`_announceState`) já sai com `cameraOff: true` quando não há track de câmera.

### Endpoints REST / Schema de banco

Nada. Esta entrega não toca o servidor.

---

## 6. Dependências e Ordem de Implementação

1. **Preferência e plano de mídia** (`lib/devices.js`) — fundação pura, sem dependência de nada. Pode ser
   commitada sozinha.
2. **Testes unitários da fase 1** (`devices.test.mjs`, `joinCameraDefault.test.mjs`) — rodam já aqui, antes
   de qualquer UI existir. Fazer nesta ordem é o que permite descobrir o colapso da cadeia (D3) sem navegador.
3. **Entrada na sala sem track de vídeo** (`Room.jsx`: `cameraOff` inicial, `getLocalStream`, confirmação do
   `localState`) — depende de 1. **Neste ponto o defeito principal já está corrigido** (o padrão de fábrica
   é câmera desligada), mesmo sem lobby: bom ponto de commit e de verificação manual.
4. **Placeholder desde o primeiro frame** (`DEFAULT_PARTICIPANT` no `Room.jsx` + `VideoTile.jsx`) —
   independente de 3 na prática, mas só observável depois dele. Pode rodar em paralelo com 5.
5. **Lobby** (`PreJoin.jsx`, ramo `!displayName`, callback do toggle, `styles.css`) — depende de 1 e 3.
6. **E2E** (`harness.mjs` primeiro, `run.mjs` depois) — depende de 5, porque o helper de entrada precisa do
   markup final do lobby.
7. **Documentação** (`README.md`, `ARCHITECTURE.md`, `claude-progress.md`) — depende de tudo estar decidido;
   pode ser escrita em paralelo a 6.

Paralelizável: 4 e 5. Tudo o mais é sequencial.

---

## 7. Riscos e Armadilhas

### R1. Duas capturas do mesmo device ao mesmo tempo

- **Risco:** o preview do lobby continua vivo quando o `getUserMedia` da sala roda (ou quando o
  `SettingsModal` abre o dele) → `NotReadableError` intermitente em parte das máquinas, e a pessoa entra
  sem vídeo sem entender por quê.
- **Mitigação:** `PreJoin` como componente com limpeza no efeito (D4) e `previewPaused` no modal (D10).
- **Anti-pattern:** parar o preview no `onClick` do botão "Entrar". Sair por navegação, por `Esc` ou por
  desmonte não passa pelo clique — é exatamente o erro que o `SettingsModal` documenta ter evitado.

### R2. Notificar a primeira transição de estado do peer

- **Risco:** ao implementar D6, tratar o primeiro `state` recebido como mudança e disparar toast/bipe. Todo
  mundo passa a ver "Fulano desligou a câmera" logo depois de "Fulano entrou na sala".
- **Mitigação:** não existe notificação de câmera hoje e nenhuma deve nascer (D8). Estado inicial não é
  transição.
- **Anti-pattern:** comparar `prev.cameraOff !== next.cameraOff` para notificar. Como o registro nasce
  `true`, essa comparação dispara justamente no caso mais comum.

### R3. Só um dos três pontos de criação de registro é corrigido

- **Risco:** `onRemoteStream` cria registro quando o peer é desconhecido (`{ ...(next.get(peerId) || {}) }`).
  Corrigir apenas `peer-joined` deixa uma corrida viva: em ordens de evento incomuns, o registro nasce sem
  `cameraOff` e o tile pisca preto.
- **Mitigação:** `DEFAULT_PARTICIPANT` aplicado nos três pontos.
- **Anti-pattern:** "esse caminho nunca acontece na prática" — é a definição de bug intermitente.

### R4. Preferência de versão anterior sem o campo

- **Risco:** `sanitize` copiando o campo sem checar tipo faria um `undefined` gravado virar `undefined` lido,
  e `!undefined` daria câmera **ligada** — o oposto do requisito.
- **Mitigação:** aceitar só `typeof === 'boolean'`, como `soundsEnabled`; teste explícito com valores
  inválidos.

### R5. O `SettingsModal` devolve preferências que ele não renderiza

- **Risco:** `handleSave` envia `{ ...pending }`, e `pending` nasce de
  `{ ...DEFAULT_PREFERENCES, ...preferences }`. Se algum pai passar um `preferences` incompleto ao modal, o
  `startCameraOff` volta como default e a escolha da pessoa é sobrescrita em silêncio.
- **Mitigação:** os dois pais (Home e Room) passam o estado vivo lido de `readPreferences`, então o campo
  trafega intacto — **é uma invariante, não um acaso**. Um teste de `applyDeviceSelection`/merge não é
  exigido, mas quem introduzir um terceiro consumidor do modal precisa saber disso. `soundsEnabled` já vive
  sob a mesma invariante hoje.
- **Anti-pattern:** dar ao modal um estado de câmera próprio "para ficar completo". Ele não renderiza o
  toggle; renderizá-lo é outra demanda (R7).

### R6. O roteiro do E2E assume que todo mundo entra com a câmera ligada

- **Risco:** as seções E. (desligar/religar) e S. (troca de dispositivos) começam de um estado que deixa de
  existir. Pior: a checagem **E3** ("peers remotos mostram placeholder") passa a ser trivialmente verdadeira
  desde antes do clique — verde sem verificar nada.
- **Mitigação:** E. passa a começar ligando a câmera **e esperando o placeholder sumir** no tile remoto;
  só então desliga e espera o placeholder voltar. Sem a primeira espera, E3 vira decoração.
- **Anti-pattern:** fazer o harness entrar sempre com a câmera ligada para "não mexer no roteiro". Isso
  deixaria o caminho novo — o que 100% dos usuários vão percorrer — sem cobertura E2E nenhuma.

### R7. Quem vem da Home nunca vê o toggle

- **Risco:** pela decisão D1, o caminho Home → sala não passa pelo lobby. Uma pessoa que sempre cria salas
  pela Home não tem como **persistir** "entrar com a câmera ligada": ela vai clicar em "Ativar câmera"
  dentro da sala toda vez.
- **Mitigação nesta entrega:** nenhuma — é comportamento aceito, e o padrão de fábrica (desligada) é o
  seguro. Documentar no README.
- **Encaminhamento:** card de follow-up para expor o toggle no `SettingsModal` (que é alcançável da Home, da
  tela de espera e da sala), seguindo o precedente do `noiseSuppression` — um campo que o modal carrega
  mesmo morando em outra chave de storage. Não fazer agora: alarga o contrato do modal no meio de uma
  entrega de privacidade.

### R8. `A2` do E2E e a ordem dos transceivers

- **Risco:** ler "entrar sem track de câmera" como "entrar sem canal de câmera" e passar a criar o
  transceiver condicionalmente. Isso quebraria a ordem fixa das m-lines (mic, câmera, tela, música), que é o
  contrato de classificação do outro lado, e faria `toggleCamera` precisar de renegociação.
- **Mitigação:** os quatro `addTransceiver` são incondicionais e continuam assim; `currentDirection`
  negocia como `sendonly` mesmo sem track. `webrtcMesh.js` não é tocado.
- **Anti-pattern:** "otimizar" a negociação removendo o canal que nasce vazio.

### R9. Suíte vermelha por ambiente, lida como regressão

- **Risco:** `npm test` do client falha inteiro sem `node_modules`, e o `lint` também. E o E2E tem uma falha
  conhecida (**F4a**) que é anterior a esta branch.
- **Mitigação:** `npm install` em `client/` **e** `server/` antes de qualquer conclusão; a linha de base é
  336/336. Para o E2E, a receita de bibliotecas em `/tmp/pwlibs` está no fim de `claude-progress.md`.
  Registrar a F4a explicitamente como pré-existente no relato.

---

## 8. Critérios de Aceite Técnicos

Comportamentos observáveis. A numeração acompanha o DoD da task.

1. Abrir um link de sala em navegador sem preferência gravada e sem nome na sessão não produz nenhuma
   chamada de `getUserMedia` com `video` verdadeiro — nem no lobby, nem depois de entrar. O LED não acende.
2. `readPreferences({})` devolve `startCameraOff === true`.
3. Ligar o toggle e fechar a aba antes de entrar: ao reabrir, `wtk-meet:devices` contém
   `startCameraOff: false` e os demais campos preservados. Uma preferência gravada por versão anterior
   (sem o campo) continua válida e resolve para `true`.
4. A tela de pré-entrada exibe campo de nome, preview espelhado, toggle e botão Configurações. Sair dela por
   qualquer caminho (entrar, navegar, desmontar, desligar o toggle, abrir o modal) deixa o track de vídeo do
   preview em `readyState: 'ended'`.
5. `muted` continua nascendo `false`; as constraints de áudio das tentativas são idênticas às de hoje.
6. Quando alguém entra com a câmera desligada, o tile dele nas outras abas **nunca** aparece sem
   `.video-placeholder` — verificável com um observador de mutação instalado antes da entrada, não por
   amostragem depois.
7. Nenhum toast cujo texto mencione câmera aparece em nenhuma aba durante a entrada. O toast e o bipe de
   "entrou na sala" continuam existindo.
8. Clicar em "Ativar câmera" depois de entrar sem vídeo: `setLocalDescription` não é chamado, nenhum peer
   muda de `connectionState`, o áudio continua `live`, e o vídeo aparece nos outros participantes.
9. `client/test/joinCameraDefault.test.mjs` cobre `initialMediaPlan` nos dois estados da preferência
   (incluindo a ausência de tentativa com vídeo e a última tentativa sem preferência de microfone) e o valor
   de `cameraOff` publicado no `localState` do mesh quando não há track de câmera. Roda em `node:test`, sem
   DOM.
10. `client/test/devices.test.mjs` cobre leitura, default, valor inválido, merge parcial por
    `writePreferences` e preservação do campo por `reconcilePreferences`.
11. `cd client && npm test` e `npm run lint` verdes (≥ 336/336, com `npm install` feito em `client` e
    `server`).
12. E2E: logo após a aprovação, `localStream.getVideoTracks().length === 0` na aba que entrou e nenhum
    sender de câmera com track; as seções E. e S. ligam a câmera antes de exercitar desligar/religar e
    trocar de câmera, com E3 precedido da espera pelo placeholder **sumir**.
13. `node e2e/run.mjs` passa com o placar de antes mais os checks novos, sem regressão além da F4a
    pré-existente.
14. `README.md` atualizado: "Fluxo de uma chamada" (itens 3 e 5), subseção da pré-entrada e a lista de
    campos de `wtk-meet:devices` incluindo `startCameraOff`.
15. `ARCHITECTURE.md` atualizado: §6 (os quatro canais nascendo sem track de câmera) e §6.10 (a preferência
    nova e por que ela cabe na exceção de persistência).

---

## 9. Notas para os Agentes de Implementação

### Divisão sugerida

- **Dev 1 — núcleo:** fases 1 a 4 da §6 (preferência, plano de mídia, testes unitários, entrada sem vídeo,
  placeholder). É o que corrige o defeito relatado.
- **Dev 2 — UI:** fase 5 (lobby e estilos). Depende do núcleo, mas o contrato de props está fechado na §5 e
  pode ser escrito contra ele.
- **QA:** fase 6 (E2E) e a validação manual descrita abaixo.

### Seletores que **não** podem mudar

O harness do E2E entra pelo placeholder `Como te chamam` e pelo botão de texto exato `Entrar na sala`
(`e2e/harness.mjs:366-368`). Renomear qualquer um dos dois quebra **todos** os cenários da suíte de uma vez,
inclusive os que nada têm a ver com esta task. Mantenha os dois no `PreJoin`. Para o toggle, use um
`<input type="checkbox">` com rótulo associado (sugestão: "Entrar com a câmera ligada"), acessível por
`getByRole('checkbox', { name: ... })`.

### Pitfalls específicos desta demanda

- O default do harness deve ser **entrar com a câmera desligada** — é o caminho que todo usuário vai
  percorrer. Ligar a câmera onde o roteiro precisa dela, pela UI. Semear
  `preferences: { startCameraOff: false }` via `addInitScript` também funciona (o mecanismo já existe no
  harness) e é o caminho certo quando o objetivo do cenário não é exercitar o lobby.
- "Placeholder desde o primeiro frame" não se verifica com `waitFor`: um `waitFor` que encontra o
  placeholder não prova que ele esteve lá o tempo todo. Instale um `MutationObserver` **antes** de a
  terceira aba entrar e assere que o tile dela nunca existiu sem `.video-placeholder`.
- A contagem de `getUserMedia` do E2E (`window.__wtkCounters`) passa a incluir as chamadas do preview do
  lobby. As checagens existentes são relativas (`gumAfter === gumBefore + 1`) e continuam válidas — mas
  qualquer check novo deve ser relativo pelo mesmo motivo.
- `reconcilePreferences` nunca fixa um id vazio no device do momento; nada nesta entrega deve mudar isso.
- Ao reordenar a seção E., lembre que ela deixa a câmera **ligada** no fim (E6 religa) — a seção S., que vem
  depois, conta com isso.

### Ordem de validação após a implementação

1. `cd client && npm install && npm test && npm run lint` — antes de abrir o navegador.
2. Manual, com o `localStorage` limpo: abrir um link de sala, confirmar que o LED **não** acende no lobby,
   entrar, e confirmar na segunda aba que o tile nasce em placeholder.
3. Manual, com o toggle ligado: confirmar preview, entrar, confirmar vídeo nas outras abas, e confirmar que
   a escolha sobrevive a recarregar a página.
4. `node e2e/run.mjs` (com `/tmp/pwlibs` exportado), comparando o placar com o da `main` se algo além da
   F4a falhar. Não rodar em paralelo com outra suíte — a contenção derruba o TURN local e o sintoma imita
   uma regressão de negociação.
5. Registrar em `claude-progress.md` o que foi feito e a divergência entre o roteiro antigo do E2E e o
   comportamento novo de entrada.
