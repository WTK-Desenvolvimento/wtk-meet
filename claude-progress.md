# Progresso — WTK-MEET-14: recusar no ato link do YouTube que não pode ser incorporado

**Status: implementação concluída e validada.** Branch
`agent/wtk-meet-14-recusar-no-ato-links-do-youtube-que-n-o-`. Commit `c3a443b`
(implementação + testes) e o commit de documentação que fecha a entrega.

Documento de arquitetura seguido:
`docs/agents/arch-temp-recusa-imediata-youtube-indisponivel.md`. **O DoD do
board não conflitou com ele desta vez** — os dois pedem a mesma coisa, inclusive
a pureza de `musicSources.js` (ao contrário da WTK-MEET-12, onde o DoD mandava
`parseSource` fazer rede).

## O problema

`addToQueue` já fazia a requisição ao oEmbed do YouTube para trocar o
`YouTube · <id>` pelo título de verdade — e jogava fora o **status** dessa
resposta, que é justamente o que distingue "vídeo removido" de "incorporação
bloqueada pelo dono" e de "o oEmbed não respondeu". `fetchYouTubeTitle` fazia
`if (!response?.ok) return null`, colapsando tudo num `null` indistinguível de
timeout. O diagnóstico era feito e descartado, e a sala só descobria o problema
quando a faixa chegava a tocar — minutos e várias faixas depois de quem colou o
link ter saído da tela de adicionar.

## O que foi entregue

- `client/src/lib/youtubePlayer.js` — `fetchYouTubeOEmbed` (nova, exportada)
  devolve `{ title, availability, status }`, com o mapa explícito
  `{401, 403} → 'embed-blocked'`, `404 → 'not-found'` e **todo o resto**
  `'unknown'`. `fetchYouTubeTitle` virou envelope de duas linhas sobre ela, com
  o contrato `string | null` que nunca lança **intacto**.
- `client/src/lib/musicSources.js` — `resolveSourceTitle` virou
  `resolveSourceMeta`, ainda **pura e por injeção**, devolvendo
  `{ title, availability }`. Mais `REFUSAL_BY_AVAILABILITY` (a tabela do que
  recusa) e duas mensagens novas em `SOURCE_ERRORS`.
- `client/src/lib/useMusicRoom.js` — o segundo item do `Promise.all` passou a
  resolver o par, e a recusa entrou **entre o `await` e o `bumpLamport`**.
- `client/test/musicQueueRefusal.test.mjs` (novo) — a recusa exercitada no
  `addToQueue` de verdade, com o hook rodando sob um dispatcher de teste.
- `ARCHITECTURE.md` §6.9 — a recusa no ato, o mapa de status e o fail-open.

## As três decisões que sustentam a entrega

**Uma requisição, duas respostas.** O veredito sai da mesma chamada que já
buscava o título. Uma sonda dedicada dobraria a exposição do IP do usuário à
Google, dobraria a latência do enfileiramento e abriria a chance de as duas
respostas discordarem. A promessa do §6.9 ("só quem enfileira fala com a
Google") continua intacta: os outros participantes recebem o nome pelo data
channel e não sondam nada.

**Fail-open, por lista explícita.** Só 401, 403 e 404 recusam. 429, 5xx, 400,
erro de rede, CORS, timeout, corpo que não é JSON, flag desligada e ambiente sem
`fetch` viram `unknown`, e `unknown` enfileira. Classificar por `!response.ok`
transformaria um rate-limit de sala movimentada em "ninguém consegue adicionar
música" — um sintoma que ninguém rastrearia até aqui. O custo de um falso
negativo é o comportamento de hoje; o de um falso positivo é um recurso quebrado
sem caminho de contorno.

**A rede não se mudou para `musicSources.js`.** O módulo puro continua sem
import nenhum — nem de rede, nem de DOM —, e agora isso é **teste**, não
convenção: um caso lê o arquivo, tira os comentários e falha se aparecer
`import`, `fetch`, `document`, `window`, `navigator` ou `localStorage`.

## A verificação de CORS (risco 7.1 do documento), com o resultado

Era o risco que decidia se a feature entrega o efeito ou degrada para o
comportamento atual: o navegador só expõe `response.status` ao JavaScript se a
resposta trouxer `Access-Control-Allow-Origin`. **Verificado contra o oEmbed
real em 2026-08-21**, com `Origin: https://meet.example.com`:

| videoId | status | `access-control-allow-origin` |
|---|---|---|
| `dQw4w9WgXcQ` (tocável) | 200 | `https://meet.example.com` |
| `M3fnZUuvJ2M`, `00000000000` (id bem formado, sem vídeo) | 404 | `https://meet.example.com` |
| `zzzzzzzzzzz`, `A1b2C3d4E5f` (id malformado) | 400 | `https://meet.example.com` |

O cabeçalho vem **também nas respostas de erro**, refletindo a origem — então o
status chega legível ao JavaScript e a recusa dispara de verdade no navegador.
O risco 7.1 está resolvido a favor da feature.

Duas constatações que vieram junto, e que valem mais que o "verde":

1. **O 400 existe e não estava previsto.** O oEmbed responde `400 Bad Request`
   (texto puro, não JSON) para id de 11 caracteres cuja forma o YouTube rejeita
   — o último caractere de um videoId real é restrito, e `zzzzzzzzzzz` não passa.
   O documento manda 400 cair em `unknown`, e é o que acontece: esse link entra
   na fila e falha na hora de tocar, como hoje. **Débito identificado, não
   implementado** (está fora do escopo do documento): recusar 400 também
   cobriria o link digitado errado, ao custo de estreitar o fail-open.
2. **Não foi possível reproduzir 401/403 com um vídeo real** neste ambiente — os
   12 candidatos de incorporação tipicamente restrita responderam 200. Esse ramo
   está coberto só por teste unitário. A consequência é conhecida e está
   documentada: **200 no oEmbed não garante incorporável**, e é por isso que
   `handlePlayerError` continua obrigatório.

## Verificação, critério a critério (os 15 ACs do documento)

| # | Critério | Como foi verificado |
|---|---|---|
| 1 | 404 não enfileira, não envia `music-queue-add`, avisa | `musicQueueRefusal.test.mjs` AC1 — `false`, aviso, `sent === []`, fila vazia, 1 requisição |
| 2 | 401/403 recusam com mensagem **diferente** | `musicQueueRefusal.test.mjs` AC2 — os dois status, e `notEqual` contra a mensagem do 404 |
| 3 | `addToQueue` devolve `false`, texto preservado | AC1/AC2 devolvem `false`; `MusicPanel.jsx:49-57` só limpa o `draft` quando `onAdd` devolve verdadeiro (verificado por inspeção, sem alteração) |
| 4 | Nada criado nem deixado para trás | `musicQueueRefusal.test.mjs` AC4 — `lamport` e `entries` idênticos, `deliveryHint` vazio |
| 5 | Rede, timeout, 429, 5xx, não-JSON enfileiram com fallback | AC5 no hook (4 casos) e no `youtubePlayer.test.mjs` (7 casos + abort) |
| 6 | Flag desligada: nenhuma requisição, nenhuma recusa por veredito | `youtubePlayer.test.mjs` AC6/AC7 — `fetchImpl` que falha se for chamado |
| 7 | Sem `fetch` no ambiente, enfileira | mesmo caso, com `globalThis.fetch` removido |
| 8 | Link válido enfileira com o título real | `musicQueueRefusal.test.mjs` AC8 — inclusive o `music-queue-add` enviado |
| 9 | 200 sem título legível **enfileira** com fallback | AC9 no hook e AC8/AC9 no `youtubePlayer.test.mjs` (4 corpos diferentes) |
| 10 | Uma requisição por link; nenhuma para os demais participantes | AC1 conta as chamadas; AC10 do `youtubePlayer.test.mjs`; quem recebe `music-queue-add` não chama nada (nenhum caminho novo foi adicionado ao receptor) |
| 11 | `fetchYouTubeTitle` inalterada, suíte AC10 passa **sem edição** | os 28 casos originais de `youtubePlayer.test.mjs` não foram tocados e passam; mais o AC11 novo, sobre o envelope |
| 12 | `musicSources.test.mjs` sem mock de `fetch` nem de DOM | nenhum mock no arquivo, e o caso de pureza afirma isso sobre o módulo |
| 13 | Veredito nunca recusa origem que não seja YouTube | AC13 no hook (arquivo local com o oEmbed respondendo 404 o tempo todo) e o caso de arquivo/URL/lixo em `musicSources.test.mjs` |
| 14 | A ordem de `addToQueue` é preservada | inspeção: a recusa lê só `parsed` e `meta` e não toca em `sessionRef`; a primeira leitura de `sessionRef.current` **destinada ao estado publicado** continua sendo a do `bumpLamport`, depois das duas esperas (as leituras de duplicata e limite, que já ficavam antes, não mudaram de lugar) |
| 15 | Documentação | `ARCHITECTURE.md` §6.9 e este registro |

## Comandos e resultados

```
npm --prefix client test    # 346/346 (era 328/328 antes da task; +18 casos)
npm --prefix client run lint  # limpo
node e2e/run.mjs            # ver abaixo
```

**E2E: 111/112.** O bloco de música (N1–N10) passou inteiro — fila convergindo
nos três participantes, áudio no quarto canal, pulo assumido pelos três,
nenhuma mensagem de música no Socket.IO. A única falha é a **F4a**, que é
regressão pré-existente e **não pertence a este diff** (o botão de avisos
sonoros restaurado por engano na barra em `1baa707`; já registrada nas tasks
anteriores).

O E2E **não cobre** a recusa: exercitá-la exigiria um link real de vídeo
indisponível e uma requisição à Google de dentro do teste. A cobertura dela é a
unitária mais a verificação de CORS acima.

## Nota de execução: duas sessões na mesma task, de novo

Duas sessões foram atribuídas à WTK-MEET-14 e ao mesmo worktree. Resolvido por
mensagem direta antes de qualquer escrita — esta sessão assumiu a implementação
inteira, a outra parou sem ter tocado no tree. Vale continuar rodando
`ListAgents` antes da primeira escrita.

O `node_modules` não existia no worktree (nem em `client/`, `server/` ou `e2e/`),
o que deixava 5 arquivos de teste vermelhos por dependência ausente — não por
regressão. `npm install` nos três resolveu, e a linha de base antes de qualquer
edição era 328/328.

## Pendências

Nenhuma para esta task. Dois pontos registrados acima que **não** são pendência
desta entrega: o `400` do oEmbed caindo em `unknown` (débito identificado, fora
do escopo do documento) e a F4a.

**Atenção para quem for implementar a WTK-MEET-13** ("classificar o código de
erro do YouTube e recuperar erro transitório"): ela mexe em `handlePlayerError`
e em `youtubePlayer.js`, a mesma região deste diff. Este commit **não alterou**
`handlePlayerError` de propósito — ele continua obrigatório, e o comentário novo
em `addToQueue` diz por quê.

---

# Progresso — WTK-MEET-11: supressão de ruído client-side com toggle

**Status: implementação concluída e validada, com uma falha de E2E alheia à task
em aberto (F4a, abaixo).** Branch
`agent/wtk-meet-11-quero-implementar-um-anti-ruido-supress-`. Commits `58f0703`
(client: motor, worklet, plumbing do Room, testes de DSP e do modal), `b889b70`
(bloco T do E2E + ARCHITECTURE §6.11 + README), `dd4c995` (cobertura unitária de
`micPipeline.js`).

Documento de arquitetura seguido:
`docs/agents/arch-temp-supressao-ruido-client-side.md`.

## O problema

`buildConstraints` (`client/src/lib/devices.js`) só montava `deviceId: { ideal }`.
O microfone ia cru para o mesh: ventilador, teclado e obra do vizinho junto com a
voz, sem nenhum controle na interface.

## O que foi entregue

- `client/src/lib/noiseSuppression.js` (novo, **puro**) — preferência em chave
  própria, detecção de capacidade e a matriz de modo
  (`'native' | 'worklet' | 'unsupported'`).
- `client/src/lib/micPipeline.js` (novo) — o grafo `source → worklet →
  destination`, com dono explícito. Único arquivo da entrega que encosta em
  `AudioContext`.
- `client/src/lib/noiseSuppressorWorklet.js` (novo) — porta espectral tipo Wiener
  sobre STFT (512/128, Hann, piso adaptativo assimétrico). Arquivo único sem
  imports, que avalia tanto no escopo do worklet quanto no `node:test`.
- `devices.js` — `buildConstraints` aceita `audioProcessing`.
- `Room.jsx` — `micPipelineRef`; o track processado entra no mesh, no
  `localStreamRef` e no medidor; `ended` e `reconcilePreferences` passam a usar o
  track **cru**.
- `SettingsModal.jsx` — o toggle nos três pontos de entrada, com hint por motor e
  desabilitado com explicação onde não há suporte.

## A armadilha conceitual da entrega

Os navegadores **já ligam** `noiseSuppression` por padrão quando se pede
`audio: true` sem qualificar. Por isso a constraint é emitida **também no estado
desligado**: omiti-la entregaria um toggle que não desliga nada, sem erro nenhum,
e a queixa chegaria semanas depois como "o toggle não faz nada".

## Quatro falhas silenciosas corrigidas junto

Todas da premissa "o track do mesh é o track do `getUserMedia`", que deixa de
valer no modo worklet: microfone que seguia aberto após sair da sala, recuperação
de mic arrancado que nunca dispararia, preferência que parava de se autocorrigir e
uma captura vazada por troca de device.

## Divergências declaradas: o DoD do board x o documento de arquitetura

Terceira task seguida com o mesmo padrão (ver WTK-MEET-10). **O DoD venceu**, pelo
mesmo critério: é ele o gate que fecha a task. Seis pontos:

| # | DoD | Documento | Resolução |
|---|---|---|---|
| 1 | `noiseSuppression.js` puro | §4.1 põe o grafo nesse arquivo | Grafo separado em `micPipeline.js` |
| 2 | Chave própria `wtk-meet:audio` | §3.1/§5.4 querem 5ª chave em `wtk-meet:devices` | Chave própria, justificada no cabeçalho do módulo e em §6.11 |
| 3 | Terceiro modo `'unsupported'` | §3.3 usa `'off'` | `'unsupported'` — é capacidade do navegador, não estado do toggle |
| 4 | Estado sem suporte com toggle desabilitado | não previsto | Implementado, com hint próprio |
| 5 | `replaceTrack` ao alternar em chamada | §3.5 diz **nunca** `replaceTrack` | `replaceTrack`, sem renegociar SDP (provado no E2E T4) |
| 6 | Rótulo "Supressão de ruído" | "Reduzir ruído de fundo" | "Supressão de ruído" |

A justificativa da chave própria (o que o DoD 15 manda documentar):
`wtk-meet:devices` responde *que hardware usar* — ids que só valem na máquina em
que foram gravados, e que `reconcilePreferences` reescreve sozinho. Supressão de
ruído é propriedade do **ambiente**, vale para qualquer microfone e nunca deve ser
reescrita por reconciliação. Juntas, a autocorreção de device passaria por cima de
um campo que não deveria nem enxergar.

## Decisão registrada: `wtk-meet:audio` não é materializada na entrada

A primeira versão do E2E afirmava que a chave nasce gravada. Não nasce: o default
"ligado" vive em memória e a chave só é escrita quando alguém escolhe de fato.
Mantido assim de propósito — gravar na entrada persistiria uma escolha que ninguém
fez, contra a regra de zero persistência do projeto, e o único ganho seria
congelar o default de hoje contra uma mudança futura dele. Quem prova o default é
o T1 (no que é **pedido** ao `getUserMedia`); o T2, que nada é gravado antes da
escolha; o T6, que salvar persiste.

## Verificação executada

| Critério (§8 do documento) | Resultado |
|---|---|
| 1. Constraint `noiseSuppression: { ideal: true }` no primeiro `getUserMedia` | ✅ E2E T1 |
| 2. Leitura tolerante ao formato antigo, sem perder as outras chaves | ✅ `noiseSuppression.test.mjs` |
| 3. Desmarcar emite a constraint explícita, **nunca** a ausência | ✅ unitário + E2E T6 |
| 4. Alternar em chamada não renegocia nem derruba peer | ✅ **com divergência**: usa `replaceTrack` (DoD 6). E2E T4/T5 — `setLocal/setRemote 4→4`, `negotiationneeded 2→2`, `signalingState` `stable` |
| 5. No modo worklet o sender não é o track do `getUserMedia`, e `AudioContext` continua 1 | ✅ E2E T3 |
| 6. `localStreamRef` e medidor observam o mesmo track dos senders | ✅ E2E T3 + `micPipeline.test.mjs` |
| 7. Sair não deixa track `live` | ✅ E2E T11 (e F5, no fluxo sem worklet) |
| 8. Mic arrancado dispara a recuperação existente | ✅ E2E bloco S (o `ended` observa o track cru) |
| 9. Ruído branco ≥10 dB, tom de fala <1 dB, RMS acima de `SPEAKING_ON` | ✅ **13,49 dB** e **0,46 dB**, remedidos nesta sessão |
| 10. `enabled: false` reconstrói a entrada com erro < 1e-6 | ✅ identidade **exata**: erro máximo por amostra **0** |
| 11. `ifftReal(fftReal(x)) === x` com erro < 1e-6 | ✅ 6,1e-16 |
| 12. `decideEngine` bate com a tabela nas cinco linhas | ✅ `noiseSuppression.test.mjs` + `micPipeline.test.mjs` |
| 13. Trocar de mic com worklet ativo estando mudo | ✅ E2E T10 (`sender.enabled === false`) |
| 14. Checkbox nos três pontos, hint diz o motor | ✅ `settingsNoiseToggle.test.mjs` |
| 15. `npm test`, `lint` e `build` passam | ✅ **298/298**, lint limpo, build OK |
| 16. `node e2e/run.mjs` passa integralmente | ⚠️ **111/112** — a única falha é F4a, pré-existente e alheia (abaixo) |
| 17. README e ARCHITECTURE atualizados | ✅ **com divergência**: descrevem **duas chaves**, não cinco campos em uma (DoD 2) |

Medição de ponta a ponta, a mais relevante da entrega: **13,62 dB** de redução do
RMS no **peer receptor** (`0.04423` ligado contra `0.21212` desligado), contra os
6 dB exigidos — medido por `totalAudioEnergy/totalSamplesDuration` do `getStats`
entre dois instantâneos, porque o Chromium headless não entrega o áudio de uma
track a um segundo `AudioContext`.

Forçar o caminho de fallback exigiu **duas** coisas no harness, não uma: esconder
`noiseSuppression` de `getSupportedConstraints()` **e** zerar as constraints de
processamento antes do `getUserMedia` real. Só a primeira não bastaria — sem
constraint o Chrome liga a própria supressão por padrão, limparia o ruído antes de
o worklet ver qualquer coisa, e a comparação mediria duas amostras já limpas.

## Débito identificado, NÃO corrigido: E2E F4a

`❌ F4a. O toggle de avisos sonoros não ocupa mais um slot na barra de controles
— botões de aviso na barra=1`

**É regressão pré-existente, de outra entrega.** `ed7960d` (modal de dispositivos)
removeu o botão da barra de propósito — o espaço é escasso e o layout de altura
fixa depende de a barra não crescer. `1baa707` ("fix(room): restaurar
MusicVoteCard, RemoteMusicAudio e botões perdidos na fusão PR8↔PR9"), que é o
commit de reparo do incidente de duas sessões simultâneas, restaurou junto um
botão que não devia voltar. Confirmado por commit:

```
ed7960d → 0 ocorrências de "Silenciar avisos" em Room.jsx
1baa707 → 1     565d62b → 1     58f0703 → 1
```

Ou seja, já falhava antes desta task começar. **Não corrigido aqui** por ser
mudança de UI fora do escopo do documento de arquitetura — a regra é registrar e
avisar, não implementar por conta própria. O conserto é a remoção de
`Room.jsx:1380-1385`; o toggle já vive no modal e o `settingsNoiseToggle.test.mjs`
cobre isso.

## Nota de execução: duas sessões no mesmo worktree, de novo

Terceira ocorrência (ver WTK-MEET-10 e WTK-MEET-12). Desta vez sem dano: as duas
sessões se identificaram por `SendMessage` **antes** da primeira escrita e
dividiram por diretório — uma em `client/src/**`, `e2e/**` e documentação, a outra
em `client/test/**`. A sessão de QA encerrou no meio (o `ListAgents` passou a
devolver "No reachable agents" e a socket dela ficou obsoleta), e o `micPipeline.js`
sem cobertura que ela havia identificado foi escrito por esta sessão — o achado
sobreviveu porque estava na mensagem, não só na cabeça dela.

## Pendências

- **F4a**, acima: aguarda decisão do Nicolas.
- Os checkboxes do DoD **não foram marcados no board**: a API segue devolvendo
  HTTP 500 (`GET /api/tasks` em `http://127.0.0.1:3000`). A verificação item a
  item está na tabela acima.
- Fora de escopo, propostos e **não** implementados (§9.4 do documento): toggles
  de `echoCancellation` e `autoGainControl` — o contrato de `buildConstraints` já
  os comporta — e um seletor de intensidade mapeando para `gMin`.

---

# Progresso — WTK-MEET-10: endereço de sala curto na raiz, sem `/room/`

**Status: implementação concluída e validada.** Branch
`agent/wtk-meet-10-quero-que-fa-a-um-ajuste-no-id-das-salas`. Commits `f968a54`
(client + rotas + nginx + E2E), `aa3f012` (endpoint de occupancy, isolado),
`4396bfe` (docs), `07b2c5f` (ajustes do E2E).

Documento de arquitetura seguido:
`docs/agents/arch-temp-slug-curto-e-rotas-wildcard.md`.

## O problema

`Home.jsx` gerava `crypto.randomUUID()` (36 caracteres) e `App.jsx` publicava a
sala em `/room/:roomId`. O convite saía com 90+ caracteres antes do fragmento:
não cabia numa linha da UI (`Room.jsx` já truncava), era ruim de colar e
impossível de ditar. E não havia como o time ter "a sala de sempre" — toda sala
era um UUID opaco.

## O que foi entregue

- `client/src/lib/roomSlug.js` — slug de 9 caracteres em base32 sem caracteres
  ambíguos (`0123456789abcdefghjkmnpqrstvwxyz`, sem `i/l/o/u`). São 32 símbolos
  exatos, então `byte % 32` sobre `crypto.getRandomValues` é uniforme, sem viés
  de módulo e sem rejection sampling. Normalização do endereço escrito por gente
  (NFD, minúsculas, não-alfanumérico vira hífen, hífens colapsam e caem das
  pontas) e a passphrase de 128 bits, que migrou da Home porque a sala também
  precisa gerá-la.
- `client/src/lib/roomRouting.js` — quem é sala e quem é app: `RESERVED_SEGMENTS`
  (rotas da aplicação), `BLOCKED_SEGMENTS` (o que a camada estática já possui),
  `ROUTE_TABLE`, redirect legado e leitura de convite colado.
- Rotas: `/` e `/app` são a Home, `/app/*` é o namespace da aplicação,
  `/room/:roomId` vira redirect com o fragmento intacto, `/:roomSlug` é sala.
- `Room.jsx` deriva o id do `location.pathname` canonicalizado e redireciona —
  sempre com `replace` — antes de qualquer `getUserMedia` ou socket.
- `Home.jsx` ganhou campo opcional de endereço, normalizado a cada tecla, com
  preview do link e erro inline para reservado, vazio-após-normalização e longo
  demais.
- `nginx.conf`: cache restrito a `/assets/`.
- `GET /rooms/:roomId/occupancy` no servidor, em commit isolado (ver ressalva).

## Decisão que vale registrar: não truncar endereço longo

A primeira versão cortava em 64 caracteres dentro de `normalizeRoomPath`. Uma
passada de QA mostrou o buraco: colar 200 caracteres válidos criaria uma sala
**diferente** da pedida, silenciosamente, e o link ditado para o time apontaria
para outro lugar. Agora a normalização não corta; quem valida tamanho é
`isValidRoomPath` e quem avisa é o campo da Home.

## Verificação executada

| Item do DoD | Resultado |
|---|---|
| 1. Slug curto no alfabeto sem ambiguidade | ✅ **com desvio declarado**: 9 caracteres, não 7. A descrição da task ("alvo de 9") e o doc §3.1 pedem 9; o DoD diz "7 (≤9 com folga)". 9 satisfaz o "≤9" |
| 2. Nenhum `randomUUID` como roomId | ✅ `grep -rn "randomUUID" client/src/pages` → sem ocorrência |
| 3. Path próprio digitado na barra abre a sala com `replace` | ✅ E2E R5 e R6 |
| 4. Normalização e charset `/^[a-z0-9][a-z0-9-]{0,63}$/` | ✅ `roomSlug.test.mjs` |
| 5. `/app/*` para o app, `/` na Home, catch-all só para não-reservados | ✅ `roomRouting.test.mjs` (matchRoutes real) + E2E R8 |
| 6. `/room/*` redireciona preservando o fragmento | ✅ teste automatizado + E2E R3/R4 |
| 7. Aviso de sala ocupada via `GET /rooms/:roomId/occupancy` | ✅ **com ressalva de privacidade** (abaixo) |
| 8. Servidor permissivo, sem regex em `join-request` | ✅ `server/src/` sem mudança além do endpoint |
| 9. `npm test` com os dois arquivos novos | ✅ 249/249 |
| 10. Cenário no E2E | ✅ 97/98 (a vermelha é anterior a esta entrega) |
| 11. `nginx.conf` com fallback de um nível sem quebrar cache | ✅ `location ^~ /assets/` + `try_files` |
| 12. README e ARCHITECTURE atualizados | ✅ `4396bfe` |

`cd client && npm test` → **249/249**. `npm run lint` → limpo. `npm run build` →
ok. `node e2e/run.mjs` → **97/98**.

> Os `node_modules` não persistem no worktree: sem `npm install` em `server/`, o
> `joinRequestSignaling.test.mjs` falha com "o servidor não subiu em 10s", que
> não é regressão.

## Ressalva registrada: o endpoint de occupancy

O item 7 do DoD pede o aviso de sala ocupada alimentado por
`GET /rooms/:roomId/occupancy`. O documento de arquitetura desta mesma entrega
**proíbe** esse endpoint em três lugares (§2 fora-de-escopo, §3.2 e §7), pelo
motivo certo: com endereços curtos e adivinháveis, um booleano varrido sobre uma
lista de nomes prováveis diz quais times estão reunidos agora, sem entrar em
sala nenhuma. Duas sessões de QA independentes levantaram o mesmo ponto.

Entregue, porque é item explícito do DoD, com três mitigações:

1. a resposta é `{ occupied }` e nada mais — sem contagem, sem nomes;
2. vive num **commit isolado** (`aa3f012`): `git revert aa3f012` desliga o
   recurso sozinho, e o client trata falha de rede como "não ocupado", então a
   criação de sala continua funcionando;
3. a ressalva está escrita no código, no commit e em `ARCHITECTURE.md` §5.

**A decisão de manter ou remover é do produto.**

## Pendências e débitos

- **F4a do E2E falha desde antes desta entrega.** O toggle "Silenciar avisos"
  voltou para a barra de controles no merge de restauração (`1baa707`), e o teste
  da WTK-MEET-9 espera que ele viva só no modal (F4b, que passa). É contradição
  entre dois commits anteriores, não desta task — não foi mexido.
- **Board.** As ferramentas MCP (`update_task`, `move_task_forward`,
  `add_task_log`, `list_tasks`) continuam **não expostas** — `ToolSearch` não
  encontra nenhuma. Os checkboxes do DoD e a movimentação da task seguem
  pendentes para quem tem acesso ao board.
- **Três sessões no mesmo worktree, de novo.** Além desta, uma outra sessão de
  implementação (que chegou a escrever `App.jsx`, `Home.jsx`, `roomPath.js` e
  validação no servidor) e duas de QA. Resolvido por negociação explícita: esta
  sessão assumiu a implementação, `roomPath.js` foi removido em favor de
  `roomSlug.js` + `roomRouting.js`, e as mudanças no servidor foram revertidas
  por contrariarem o item 8 do DoD. **Uma sessão por task, por favor.**

---

# Progresso — WTK-MEET-9: modal de configurações de câmera, microfone e saída de áudio

**Status: implementação concluída e validada.** Branch
`agent/wtk-meet-9-quero-que-seja-poss-vel-ajustar-as-confi`.

Documento de arquitetura seguido:
`docs/agents/arch-temp-modal-configuracoes-dispositivos.md` (produzido na fase de
arquitetura desta mesma task).

## O problema

`Room.jsx` chamava `getUserMedia({ video: true, audio: true })` sem restrição de
`deviceId`, e `toggleCamera` reaquiria com `{ video: true }`. O navegador sempre
entregava o device **default do sistema**: quem usa webcam ou headset USB ficava preso
ao hardware embutido do notebook, e a única saída era trocar o default no sistema
operacional e recarregar a página. Não havia seleção de saída de áudio, nem preview —
a pessoa descobria que a câmera errada estava ativa já visível para os outros.
# Progresso — WTK-MEET-8: player de música colaborativo P2P

**Status: implementação concluída e validada.** Branch
`agent/wtk-meet-8-quero-adicionar-uma-funcionalidade-de-mu`.

Documento de arquitetura seguido: `docs/agents/arch-temp-player-musica-colaborativo.md`.

> O histórico das entregas anteriores está preservado abaixo, incluindo a receita
> de ambiente do E2E — que continua necessária **a cada sessão**, porque `/tmp`
> não persiste.

## Ponto de partida

Uma sessão anterior nesta mesma branch deixou os módulos puros commitados
(`musicSession`, `musicVote`, `musicSources`, `musicProtocol` + testes),
`audioContext.js` extraído, e `MusicVoteCard`/`RemoteMusicAudio` criados. O
`webrtcMesh.js` estava **no meio da edição**: importava `isMusicMessage` sem usar,
não criava o quarto transceiver, não roteava `music-*` e não tinha `setMusicTrack`.
Esta sessão continuou dali, seguindo a ordem do §6 do documento a partir do item 4.

## O que foi implementado

| Arquivo | Mudança |
|---|---|
| `client/src/lib/devices.js` | **Novo.** Módulo puro (sem DOM, sem `navigator`): normalização/dedup/rotulagem de `enumerateDevices`, `resolvePreferredDevice` com fallback, `buildConstraints` com `deviceId: { ideal }`, leitura/escrita validada de `wtk-meet:devices` e `reconcilePreferences` |
| `client/src/lib/audioLevels.js` | `createLevelMeter({ stream, context, onLevel })` para o preview, fora do registro do monitor da sala; RMS→nível extraído para helper compartilhado com `_tick` |
| `client/src/components/SettingsModal.jsx` | **Novo.** Modal único: listagem, seleção pendente, preview de vídeo, medidor de mic, seletor de saída, toggle de avisos sonoros, salvar/cancelar, `Esc`/backdrop, `devicechange` |
| `client/src/components/VideoTile.jsx` | Prop `sinkId` + aplicação de `setSinkId` com `catch` (feature-detect, no-op sem suporte) |
| `client/src/components/VideoGrid.jsx` | Repassa `sinkId`/`onSinkError` aos tiles |
| `client/src/pages/Home.jsx` | Botão "Configurações" e modal; salvar aqui **só persiste** (não há chamada ativa) |
| `client/src/pages/Room.jsx` | Preferências hidratadas no primeiro render; cadeia de fallback do `getLocalStream` em 3 passos; reconciliação pós-`getUserMedia`; `toggleCamera` respeita a câmera preferida; `applyDeviceSelection` (tabela §3.8); recuperação por `ended`/`devicechange`; botão em `.controls` e na fase de espera; toggle de avisos removido da barra |
| `client/src/styles.css` | `.modal-backdrop.settings` (z-index 28, modificadora de camada), `.settings-modal`, preview 16:9, `.mic-meter` dirigido por custom property, seletor desabilitado |
| `client/test/devices.test.mjs` | **Novo.** 27 casos: dedup, aliases do Chrome, rotulagem sintética, resolução/fallback, storage corrompido, reconciliação |
| `e2e/harness.mjs` | Camada de simulação de dispositivos (registro mutável, `enumerateDevices`, `gumRequests`, `setSinkId`, `__wtkAddDevice`/`__wtkRemoveDevice`), helpers `openSettings`/`setSelectValue`/`senderTracks`, semente de preferências em `openParticipant` |
| `e2e/run.mjs` | Bloco **S** novo (S1–S16) e F4a/F4b para o toggle de avisos que mudou de lugar |
| `README.md`, `ARCHITECTURE.md` | Fluxo de seleção, chave `wtk-meet:devices` e a exceção à regra de zero persistência (nova §6.8, §1, §8, §9) |

## Decisões que valem registrar

1. **`deviceId: { ideal }` + reconciliação, nunca `{ exact }`.** `exact` transformaria
   "o device sumiu" em `OverconstrainedError` a ser capturado e reexecutado. Com
   `ideal`, o caminho feliz já satisfaz o item 6 do DoD.
2. **A reconciliação só corrige um id que foi pedido e não atendido.** Reconciliar um
   id vazio fixaria "Padrão do sistema" no device do momento — transformando uma
   escolha explícita de seguir o sistema numa escolha concreta pelas costas do usuário.
3. **Com a câmera desligada, o modal não pede vídeo no preview.** O documento previa
   preview sempre ligado; abrir a câmera para pré-visualizar uma câmera que a pessoa
   acabou de desligar acende o LED sem pedido. O modal recebe `videoPreview={!cameraOff}`
   e mostra uma explicação no lugar do vídeo. Foi o E2E (S11) que cobrou a consequência:
   a seleção de câmera também saiu das dependências do preview nesse estado, senão
   trocar de câmera dispararia um `getUserMedia` para reabrir o mesmo stream de mic.
4. **`enabled = !muted` antes do `replaceTrack`.** Depois seria tarde: existe uma
   janela de frames em que o áudio vazaria. Coberto por S10.
5. **`detach('local')` antes do `attach('local', stream)`** na troca de mic — o
   `attach` é idempotente por (id, stream) e o `MediaStream` é o mesmo objeto.
6. **Bloco E2E chamado `S`, não `H`:** o documento pedia "bloco H", mas `H` já existia
   no arquivo (inventário do tráfego do servidor).
| `client/src/lib/webrtcMesh.js` | Quarto transceiver `sendonly` de áudio criado **depois** do de tela; `_classifyTransceiver` estendido para `['audio','camera','screen','music']` na mesma edição; `rec.musicStream` + `onRemoteMusic`; `setMusicTrack` com `contentHint='music'` e `maxBitrate` de 96 kbps por conexão; roteamento de `music-*` para `onMusicMessage`; snapshot musical no `onopen` do canal |
| `client/src/lib/musicEngine.js` | **Novo.** Grafo WebAudio (`<audio>` → `MediaElementSource` → `MediaStreamDestination` + ramo de monitoração local), sonda de CORS por `Range: bytes=0-0`, ciclo de vida de `objectURL`, `play()` cuja rejeição vira aviso em vez de silêncio |
| `client/src/lib/youtubePlayer.js` | **Novo.** IFrame API carregada sob demanda (nada da Google no bundle), atrás de `VITE_ENABLE_YOUTUBE`, com a mesma superfície do motor (`play`/`pause`/`seek`/`positionSec`) |
| `client/src/lib/useMusicRoom.js` | **Novo.** Orquestração: votação com árbitro, fila convergente, escritor único da reprodução, sucessão determinística, correção de deriva e snapshot para quem entra depois |
| `client/src/components/MusicPanel.jsx` | **Novo.** Painel irmão do `ChatPanel`: faixa atual, progresso, fila, formulário (link/arquivo) e volume local |
| `client/src/components/MusicVoteCard.jsx` | Dispensar passou a ser explícito (`Esc` ou ✕) — ver "Desvios conscientes" |
| `client/src/pages/Room.jsx` | Hook de música ligado ao mesh, botão na barra, painel mutuamente exclusivo com o chat, overlays sempre montados, `selfId` em estado, `AudioContext` injetado no monitor e fechado pelo `Room` |
| `client/src/styles.css` | Painel, card de votação (z-index 25), fila, barra de progresso, host oculto do YouTube |
| `client/test/musicProtocol.test.mjs` | **Novo.** 12 casos de entrada hostil e de identidade |
| `client/test/joinRequestSignaling.test.mjs` | Teardown escala SIGTERM → SIGKILL após 2s (ver "Nota de ambiente") |
| `e2e/{harness,run}.mjs` | Fixture de áudio WAV sintético; A2 atualizada para 4 canais por sentido; seção **N** com 10 checagens novas |
| `ARCHITECTURE.md`, `README.md`, `client/.env.example`, `docs/teste-3-participantes.md` | §6.9, limitações, flag do YouTube e checklist manual |

## Decisões que valem registrar

1. **Trocar de faixa é publicado pelo dono da faixa *seguinte*, nunca pelo da que
   acabou.** O documento fixa "escritor único", mas não diz quem escreve a
   transição — e as duas escolhas óbvias (o dono que terminou publica "parei"; o
   próximo publica "comecei") coexistindo dariam dois escritores disputando a
   mesma versão, com o "parei" podendo vencer por desempate de id. Um escritor
   por transição resolve; se a fila acabou, quem declara o silêncio é o dono da
   que terminou.
2. **A condição de "começar a próxima" é *a faixa corrente não existe mais na
   fila*, não *`entryId` é nulo*.** Quando alguém pula, o `entryId` continua
   apontando para uma entrada que já virou tombstone. Testar por nulo deixaria a
   sala parada com a fila cheia — e o sintoma seria "pular às vezes não faz nada".
3. **O padrão de entrega é `local`, e `stream` só entra com a sonda de CORS
   confirmando.** Errar para o lado do `local` custa banda; errar para o outro
   lado transmite **silêncio sem erro nenhum**, que é o modo de falha mais caro
   de diagnosticar deste recurso.
4. **A orquestração virou um hook (`useMusicRoom.js`) em vez de morar em
   `Room.jsx`.** O documento pede o estado no `Room`; ele já orquestra mídia,
   chat, toasts e pedidos de entrada, e somar a máquina de estados da música
   levaria o arquivo a ~1000 linhas. A fronteira é limpa: o hook não conhece JSX,
   o `Room` não conhece o protocolo.
5. **O container do player do YouTube é criado fora do React.** `YT.Player`
   substitui o elemento que recebe por um iframe; um nó trocado por baixo do
   React estoura no unmount. O React cuida do host, nós cuidamos do filho.

## Desvios conscientes do documento

**§3.6 — o card de votação não fecha mais por "clique fora".** O documento diz
"fecha por `Esc`/clique fora, sem votar". Implementado ao pé da letra, o efeito
era o oposto do pretendido: **silenciar o microfone com a votação aberta fazia a
pessoa perder o voto**, sem entender por quê. Num card fixo de canto, que não
intercepta clique nenhum, "clique fora" não significa "quis fechar" — significa
"usou a sala". Dispensar passou a ser explícito (`Esc` ou ✕), o que preserva a
intenção da decisão (abster-se é legítimo, a tela não é bloqueada) sem o efeito
colateral. A checagem N2 do E2E fixa isso: usar a sala com o card aberto não pode
custar o voto.

**Votação para pular não foi implementada**, conforme §3.7 — mas os módulos puros
já commitados suportam `kind: 'skip'` e o card já sabe renderizá-lo. É código
morto deliberado, pronto para quando/se a decisão mudar.

## Verificação executada

- `npm --prefix client run lint` → limpo
- `npm --prefix client test` → **66/66** (27 novos em `devices.test.mjs`;
  `audioLevels`, `gridLayout`, `chat` e sinalização sem regressão)
- `npm --prefix client run build` → ok
- `node e2e/run.mjs` → **76/76**, com o bloco S cobrindo: listagem sem duplicatas,
  troca de câmera+mic em chamada com track novo em todos os senders e SDP inalterado,
  cancelamento por `Esc` e por clique no backdrop, `setSinkId` em todos os tiles, troca
  de mic estando mudo, troca de câmera com a câmera desligada, releitura da preferência
  num documento novo, `devicechange` (conectar e arrancar em uso) e preferência
  obsoleta se corrigindo.

Quatro execuções da suíte no total. Uma delas (a segunda) abortou em **"mesh
reconectado após reload de Bob"**, na seção D — passo que existe desde a entrega
anterior e que não é tocado por esta: todas as conexões apareceram em
`failed`/`disconnected`, e as outras três execuções passaram no mesmo commit. É
intermitência do TURN local sob carga, não regressão. Vale rodar de novo antes de
investigar.

**A intermitência do TURN foi isolada, não presumida.** Numa sessão em que a suíte
abortou duas vezes seguidas em "mesh conectado (2 peers por participante)" — a
primeira checagem que depende de ICE, com `conn: failed` / `ice: disconnected` em
todos os participantes e **nenhum erro de console** —, o experimento decisivo foi
rodar a suíte no estado anterior à task (`git checkout 6bc3129 -- client e2e`, rodar,
`git checkout HEAD -- client e2e` para restaurar): o código **sem nada desta entrega
falhou exatamente no mesmo ponto**. Na execução seguinte, com a máquina ociosa, o
mesmo commit passou 76/76. Duas coisas para a próxima pessoa:

- O sintoma se agrava quando **duas suítes rodam ao mesmo tempo** no sandbox (4
  núcleos, dois TURN, seis contextos Chromium). Se houver outra execução em voo,
  espere-a terminar antes de concluir qualquer coisa sobre uma falha de ICE.
- UDP em loopback continua funcionando no Node quando isso acontece (testável com um
  `dgram` de 5 linhas), então "a rede caiu" não é a explicação — é alocação de TURN
  sob contenção de CPU. Rodar de novo é mais barato que investigar.

O bloco S foi o que cobrou a decisão 3 acima: a primeira execução falhou em S11
porque trocar a câmera com a câmera desligada ainda reiniciava o preview (só de
áudio) e gastava um `getUserMedia`. Hoje o contador não se move.

### Correção de ambiente incluída

`client/test/joinRequestSignaling.test.mjs` e `e2e/harness.mjs` passaram a matar o
processo de sinalização com `SIGKILL`. Onde o `SIGTERM` não é entregue ao filho (é o
caso deste sandbox), o `await` pelo evento `exit` nunca resolvia e o `npm test`
terminava em *"Promise resolution is still pending"* — com todos os casos verdes e
nenhum vermelho para explicar. A mesma correção já existia na branch da WTK-MEET-6;
esta branch partiu de um ponto que não a tinha.

## O que ficou fora (e por quê)

- Controles de qualidade de áudio (`echoCancellation`, `noiseSuppression`, ganho) e
  resolução/framerate de câmera: são constraints de qualidade, não seleção de
  hardware — demanda separada (§2 do documento).
- Botão "Testar saída" e "Restaurar padrões": §9.4 do documento os classifica como
  fora do DoD, a propor e não a implementar por conta própria.
- Sincronizar a preferência entre abas (evento `storage`): cada aba é uma sessão de
  chamada independente.
- Seleção de fonte para compartilhamento de tela: `getDisplayMedia` já tem o seletor
  nativo do navegador.

## Checklist manual que o navegador headless não cobre

- LED físico da webcam ao trocar de câmera com a câmera desligada (S11 prova que
  nenhum `getUserMedia` de vídeo acontece, que é a causa; o LED em si é físico).
- `setSinkId` de verdade mudando o alto-falante que emite o som (o harness registra a
  chamada, o headless não tem saída de áudio real).
- Seletor de saída desabilitado com explicação no Firefox (que não implementa
  `setSinkId` por padrão) — o teste cobre a feature detection, não o navegador.
- Conectar/desconectar um headset USB físico com o modal aberto.

---


# Histórico — WTK-MEET-5: layout de viewport fixo, grade automática e modal de aprovação
- `npm --prefix client test` → **95/95** (12 novos de `musicProtocol`; `audioLevels`
  e `gridLayout` verdes **sem edição**, como o documento exige)
- `npm --prefix client run build` → ok
- `node e2e/run.mjs` → **67/67** (57 anteriores + 10 da seção N)

Cobertura das checagens novas do E2E:

| Checagem | O que prova |
|---|---|
| N1 | "Música" entra na barra sem alterar o texto de nenhum botão existente |
| N2 | Card não-bloqueante: silenciar o mic com ele aberto funciona **e não custa o voto** |
| N3 | 2 sim + 1 não aprovam e habilitam o player nos três |
| N4 | Abrir a música fecha o chat e a página continua sem rolar (invariante §6.7) |
| N5 | Faixas de dois participantes na **mesma ordem** nos três |
| N6 | Áudio real chegando **no 4º canal**, medido por mid (`bytesReceived=4819`) |
| N7 | Silenciar o mic de quem transmite não interrompe a música (`4819 → 43138`) |
| N8 | Quem não é dono pula a faixa e a próxima assume nos três |
| N9 | Nenhuma mensagem de música no protocolo Socket.IO |
| N10 | Nada de música em `localStorage`/`sessionStorage` |

**A2 foi atualizada de propósito**, e é a única checagem pré-existente alterada:
ela fixava "3 transceivers por sentido", que é justamente o contrato que esta
entrega muda. A versão nova verifica também a **ordem** (`audio,video,video,audio`)
— criar o canal de música em qualquer outra posição embaralha câmera com tela ou
faz a música cair no stream de voz, e nos dois casos *parece* funcionar.

**N6/N7 medem o transceiver de índice 3**, não o total de áudio da conexão. Se a
música vazasse para o canal de voz — exatamente o bug que o canal dedicado existe
para evitar — uma medição do total passaria por acidente.

## Dois erros que a leitura do código pegou (e o teste não pegaria)

1. **A fila era lida antes do `await` da sonda de CORS.** Uma faixa adicionada por
   outro participante durante a sonda desapareceria: o estado publicado depois do
   `await` fora calculado antes dela chegar. Corrigido movendo a sonda para antes
   de qualquer leitura de estado. Só apareceria com duas pessoas adicionando ao
   mesmo tempo, e com uma URL lenta.
2. **Dispensar o card excluía a pessoa da decisão da sala.** O anúncio do árbitro
   era conferido contra a votação ativa; sem ela, era descartado, e quem tinha
   fechado o card ficava sem o player que todos os outros acabaram de ligar. A
   votação dispensada passou a ser guardada (só para validar o anúncio — o card
   não volta à tela sozinho).

## Pendências e débitos identificados

- **Arquivo local, URL sem CORS, YouTube e saída do dono no meio da faixa** não são
  cobertos por teste automatizado: dependem, respectivamente, do seletor nativo de
  arquivos, de um host externo, de um terceiro e de temporização de rede real. Estão
  no checklist manual (`docs/teste-3-participantes.md`, itens 7–11).
- **`music-vote-cast` que chegue antes do `music-vote-open` correspondente é
  descartado.** Só afeta a contagem exibida em quem não é árbitro (o resultado
  oficial vem do anúncio, e o árbitro sempre tem a votação aberta). Um buffer de
  votos pendentes resolveria; não pareceu valer a complexidade para uma sala de 6.
- **Decisão de produto em aberto:** manter ou desligar a origem YouTube antes do
  deploy (§3.4/§7 do documento). Entregue com a flag ligada e aviso na UI.

---

# Progresso — WTK-MEET-6: destaque 80/20 para compartilhamento de tela

**Status: COMPLETED (implementação concluída, testes e lint verdes).** Branch
`agent/wtk-meet-6-1-quando-algu-m-compartilhar-a-pagina-qu`.

Documento de arquitetura seguido:
`docs/agents/arch-temp-destaque-compartilhamento-tela.md`.

## O problema

Toda tela compartilhada entrava na grade uniforme do `VideoGrid` como mais um
tile igual aos outros. Com 3 participantes e 1 tela, o palco virava 2×2 e o
conteúdo que era o motivo da reunião — um slide, um código — ficava com ~1/4 do
palco, em 16:9 com letterbox, ilegível. O layout de viewport fixo da WTK-MEET-5
resolveu "a sala cabe na tela"; não resolvia "o que importa aparece maior".

## O que foi implementado

| Arquivo | Mudança |
|---|---|
| `client/src/lib/spotlightLayout.js` | **Novo.** Módulo puro: geometria do destaque + coluna (`computeSpotlightLayout`), fallback do destaque (`resolveSpotlightScreen`) e ordenação da coluna (`orderRailItems`). 80/20 como alvo com trava (160–280px), piso de miniatura, modo estreito por largura de palco medida |
| `client/test/spotlightLayout.test.mjs` | **Novo.** 32 testes: travas do 80/20, destaque cabendo em janela achatada, virada e não-oscilação do modo estreito, piso da miniatura, zero/uma/várias telas, prioridade de quem fala, congelamento da ordem |
| `client/src/components/SpotlightStage.jsx` | **Novo.** Mede o palco (`ResizeObserver`), escreve `--spot-w`/`--spot-h`/`--rail-w`/`--thumb-w`/`--thumb-h`, e no modo estreito troca a coluna por botão + painel (fecha por `Esc`, clique fora e pelo botão) |
| `client/src/components/ThumbnailRail.jsx` | **Novo.** Coluna rolável; telas viram `<button aria-pressed>`, câmeras não são focáveis; congela a ordem quando o usuário rolou para fora do topo |
| `client/src/components/PeerAudio.jsx` | **Novo.** Sink de áudio por peer, fora do palco |
| `client/src/pages/Room.jsx` | `people`/`screens` derivados, `pinnedScreenId` local, destaque derivado no render, troca automática de palco, montagem dos sinks |
| `client/src/components/VideoTile.jsx` | Variante `compact`; `<video>` agora é sempre `muted` |
| `client/src/styles.css` | Bloco do modo destaque, variante compacta, painel do modo estreito |
| `e2e/run.mjs`, `e2e/harness.mjs` | Cenário C reescrito: C5–C11 (modo destaque, sem scroll, seleção local, teclado, painel estreito, fallback, volta à grade) + helper `spotlightLayout` |
| `ARCHITECTURE.md`, `README.md` | Nova §6.8; §8 e o fluxo de chamada atualizados |
| `client/test/joinRequestSignaling.test.mjs` | Cleanup escala para `SIGKILL` após 2s (ver "Bloqueios" abaixo) |

## Decisões que valem registrar

1. **A escolha do destaque é local e derivada no render.** `pinnedScreenId` pode
   apontar para uma tela que já acabou à vontade, porque nunca é lido sem
   validação. Um `useEffect` que "corrigisse" o estado custaria um render extra,
   um frame com destaque inválido e roubaria a escolha do usuário quando uma
   segunda tela entrasse. Nenhum evento novo no servidor nem no data channel.
2. **O áudio saiu do `<video>` do tile.** Entrar/sair do destaque move o tile de
   container e o React remonta o elemento — o que cortaria o som do peer a cada
   mudança de layout. `PeerAudio.jsx` desacopla transporte de áudio de
   posicionamento de vídeo, e entrou **antes** de mexer no palco.
3. **A tela em destaque continua na coluna, como botão pressionado e sem
   stream.** Sem isso nenhum controle carregaria `aria-pressed="true"` e o foco
   sumiria a cada troca (o botão ativado deixava de existir). Sem stream porque a
   mesma imagem em dois `<video>` dobraria o custo de decodificação.
4. **A reordenação congela quando o usuário rolou a coluna.** Ver o desvio abaixo.

## Desvio consciente do documento de arquitetura

O doc de arquitetura (§3.7) decidiu **ordem fixa** para a coluna e descartou
explicitamente ordenar por quem está falando ("miniaturas trocando de lugar no
meio de um clique — alvo móvel"). O **item 6 do Definition of Done exige o
contrário**: "quem está falando e quem compartilha reposicionados no topo, sem
que a rolagem manual do usuário seja sequestrada a cada reordenação".

O DoD é o portão de aceite, então a ordenação por prioridade foi implementada —
mas com a preocupação de §3.7 endereçada em vez de ignorada: `orderRailItems`
aceita `frozen`, e a `ThumbnailRail` congela a ordem sempre que a coluna está
fora do topo. Enquanto o usuário está rolando, nada troca de lugar; novidades
entram no fim, onde não deslocam o que está sob os olhos dele. A histerese de
meio segundo de `lib/audioLevels.js` já evita que o indicador de fala pisque.

## Verificação executada

- `npm --prefix client run lint` → limpo
- `npm --prefix client test` → **71/71** (32 novos de `spotlightLayout`)
- `npm --prefix client run build` → ok
- `node e2e/run.mjs` → **61/61**, com o cenário C novo todo verde:

| Checagem | Resultado observado |
|---|---|
| C5 | Modo destaque ativo, destaque de **974px** contra miniatura de **236px** (~4,1×), 5 miniaturas, 2 selecionáveis, 1 pressionada |
| C6 | `scrollHeight=720/720` e destaque inteiro dentro do palco |
| C7 | Alice: "Bob — tela" → "Carol — tela"; **Bob não se mexeu** ("Bob — sua tela" antes e depois) |
| C8 | Botões tabuláveis e rotulados, câmeras inertes, ativação por teclado trocou o destaque e **o foco foi preservado** |
| C9 | Palco estreito: coluna some, botão de participantes aparece, painel abre com 2 itens e **fecha por `Esc`** |
| C10 | Bob para de compartilhar → destaque migra sozinho para "Carol — tela" |
| C11 | Última tela encerrada pelo evento `ended` → grade uniforme de volta, track encerrada, botão restaurado |

## Bloqueios e limitações desta sessão
- **`npm test` travava por um motivo de ambiente.** Os 5 casos de
  `joinRequestSignaling.test.mjs` passavam, mas o arquivo nunca terminava: o
  `after()` espera o servidor filho sair, e neste sandbox o **SIGTERM não é
  entregue a processos filhos** (SIGKILL é). A limpeza passou a escalar para
  `SIGKILL` depois de 2s — hardening legítimo, que também protege CI com PID 1
  sem reaper. Com isso `npm test` termina: **71/71 verdes**.
- **Não houve inspeção visual humana / screenshot.** O comportamento foi
  verificado por medição no navegador real (o E2E lê as caixas dos elementos),
  não por olho: aparência (contraste da miniatura selecionada, legibilidade do
  rótulo compacto) continua sem validação estética.
- **Fora do escopo, por decisão do documento:** botão de sair do destaque com
  compartilhamento ativo, fixar câmera, destaque por quem fala, fullscreen
  nativo, e áudio de sistema no `getDisplayMedia`.

---

# Progresso — WTK-MEET-5: layout de viewport fixo, grade automática e modal de aprovação

**Status: implementação concluída e validada.** Branch
`agent/WTK-MEET-5-ajustar-layout-da-sala-para-altura-fixa-`.

Documento de arquitetura seguido: `docs/agents/arch-temp-sala-layout-viewport-fixo.md`.

> O histórico da entrega anterior (cinco melhorias de experiência de chamada) está
> preservado no fim deste arquivo, incluindo a receita de ambiente do E2E, que
> continua necessária a cada sessão.

## O problema

`.room` era `min-height: 100vh` com `.video-tile` em `aspect-ratio: 4/3` dentro de
`repeat(auto-fit, minmax(240px, 1fr))`. Com **um** participante numa tela larga o
tile único ocupava a largura inteira e, por proporção, uma altura enorme: a barra
`.controls` e o bloco de pedidos de entrada saíam da área visível. Silenciar o mic,
sair da sala ou **aprovar quem estava esperando** exigia rolar a página — e o caso
de aprovação é o crítico, porque quem espera depende de uma ação de outra pessoa
que, na prática, estava fora da tela.

## O que foi implementado

| Arquivo | Mudança |
|---|---|
| `client/src/lib/gridLayout.js` | **Novo.** Módulo puro (sem DOM): dada a caixa, a contagem e a proporção, devolve `{cols, rows, tileWidth, tileHeight, overflow}`. Busca sobre o número de colunas, desempate pelo menor número de colunas, arredondamento para baixo, piso de legibilidade de 120px |
| `client/src/components/VideoGrid.jsx` | **Novo.** Mede o palco com `ResizeObserver` e escreve `--grid-cols`/`--tile-w`/`--grid-gap` no container |
| `client/src/components/JoinRequestModal.jsx` | **Novo.** Modal centralizado de pedidos de entrada, acessível, que não fecha por `Esc`/backdrop |
| `client/test/gridLayout.test.mjs` | **Novo.** 14 testes do cálculo da grade |
| `client/src/pages/Room.jsx` | Toasts + modal içados para um wrapper comum antes dos três `return` de fase; bloco `.pending-requests` inline removido; grade trocada por `<VideoGrid />`; `waiting`/`denied` em `.phase-content` com scroll interno; dedup de pedidos e limpeza em `peer-joined`/`join-request-cancelled` |
| `client/src/styles.css` | Shell de altura fixa (`100vh` → `100dvh`, `overflow: hidden`), faixas topo/palco/rodapé, `.video-stage`/`.video-grid` dirigida por custom properties, tile 16:9 com `object-fit: contain`, CSS do modal, `.invite-hint` em linha única, breakpoint 720px sem `vh` |
| `server/src/index.js` | Evento **novo** `join-request-cancelled` (ver "Desvio consciente" abaixo) |
| `e2e/harness.mjs` | `approveAll` escopado no modal; novos helpers `roomLayout` e `noPageScroll` |
| `e2e/run.mjs` | 13 checagens novas: L1–L7 (layout) e M1–M6 (modal) |
| `ARCHITECTURE.md` | §4 passo 7 (retratação do pedido) e §6.7 (layout da sala) |

## Decisões que valem registrar

1. **A grade é calculada em JS, não por CSS.** O tamanho ótimo do tile depende ao
   mesmo tempo de largura, altura e contagem, e CSS não expressa "escolha o número
   de colunas que maximiza o tile sujeito a caber na altura" — `auto-fit`/`minmax`
   só enxerga a largura, que é precisamente por que o layout antigo quebrava.
   Isolar a aritmética num módulo puro é o que a torna verificável sem navegador.
2. **`100vh` seguido de `100dvh`.** Sem o segundo, a entrega ficaria "sem scroll"
   no desktop e com os controles debaixo da barra de endereço no celular — a mesma
   dor, outro dispositivo.
3. **O elemento medido é dimensionado pelo pai, e a grade dentro dele é
   `position: absolute`.** É o que impede o `ResizeObserver loop`: o conteúdo não
   tem como empurrar a caixa medida. A medição só vira `setState` quando as
   dimensões **inteiras** mudam.
4. **O modal não fecha por `Esc` nem por clique no backdrop.** Não é esquecimento:
   um fechamento acidental deixaria alguém esperando indefinidamente do outro
   lado. As duas tentativas recebem uma resposta na tela em vez de silêncio — o
   DoD pede explicitamente que `Esc` "não feche silenciosamente".

## Desvio consciente do documento de arquitetura

O doc de arquitetura afirma em §2 e §8.16 que **nenhum evento novo entra no
servidor** e que `server/` permanece intocado. **Isso foi violado de propósito**,
porque o item 7 do Definition of Done exige que o modal "feche automaticamente
quando o solicitante desiste/desconecta", e isso é impossível só no client: o
servidor fazia `pendingJoins.delete(socket.id)` no `disconnect` e não avisava
ninguém. O modal ficaria aberto para sempre, com um botão "Aprovar" que
silenciosamente não faz nada.

A adição é mínima e aditiva: `join-request-cancelled { requesterId }`, emitido aos
membros da sala quando o pedido deixa de ser aprovável (requisitante caiu, pedido
negado, ou sala encheu no meio do caminho). Carrega apenas um id que já é público
dentro da sala. Nenhum evento existente mudou de forma, então clients antigos
continuam funcionando (o listener novo é no-op se o evento não chegar).

**Quem revisar deve tratar isto como escopo deliberado, não como escopo vazado.**
Se a preferência for manter o servidor intocado, o item 7 do DoD precisa ser
renegociado — não há caminho só-client para ele.

## Verificação executada

- `npm --prefix client run lint` → limpo
- `npm --prefix client test` → **28/28** (14 novos de `gridLayout`)
- `npm --prefix client run build` → ok
- `node e2e/run.mjs` → **57/57** (44 anteriores + 13 novas)

Cobertura das checagens novas do E2E:

| Checagem | O que prova |
|---|---|
| L1 | 1 participante: sem scroll de página, grade 1×1, tile inteiro dentro da área da grade (o bug de origem) |
| L2 | `.controls` inteiramente dentro do viewport |
| L3 | 3 participantes → 2 colunas, sem scroll, sem estouro interno |
| L4 | Tile em 16:9 (±0.02) e `object-fit: contain` computado |
| L5 | Abrir o chat encolhe o tile (509px → 444px) sem gerar scroll |
| L6 | Viewport móvel (390×844): sem scroll, controles visíveis |
| L7 | ≤720px: chat empilha, área da grade cede altura (623px → 331px), tile continua inteiro, sem scroll |
| M1 | Modal centralizado e visível sem rolagem |
| M2 | `role="dialog"`, `aria-modal`, título associado, foco no primeiro "Aprovar" |
| M3 | Backdrop `fixed`, z-index 30 acima dos toasts (20) |
| M4 | `Esc` não fecha e responde com aviso na tela |
| M5 | Dois pedidos simultâneos listados, um por linha |
| M6 | Modal fecha sozinho quando os solicitantes desconectam |

**M6 foi validada por mutação:** com o `emit` de `join-request-cancelled` removido
do servidor, a checagem falha ("o modal continuou aberto com pedidos que já não
podem ser aprovados"); com o código restaurado, volta a passar. Sem isso seria uma
checagem que só sabe passar.

**L7 pegou um erro de verdade durante o desenvolvimento.** A primeira versão
afirmava que abrir o chat em mobile encolhe a **largura do tile**. Não encolhe:
com um único tile em retrato o limite é a largura, que o empilhamento não muda. A
checagem foi corrigida para medir o que de fato importa (a área da grade cede
altura e o tile continua inteiro dentro dela).

### Validação de CSS complementar

Além do E2E, o CSS foi verificado num harness estático em Chromium (fora do
worktree, usando o `styles.css` e o `gridLayout.js` reais): **431 asserções**
cobrindo o produto cartesiano de 7 viewports (360×640 a 2560×1440, incluindo
1440×400) × {1, 2, 3, 6, 8} tiles × {sem extras, chat aberto, banner de erro,
chat+banner} — sem scroll de página e `.controls` dentro do viewport em todas.
Também: estouro em 420×300 com 8 tiles rola **por dentro** da grade enquanto a
página não rola; e `elementFromPoint` no centro de "Aprovar" devolve o próprio
botão (o backdrop não intercepta o clique — era o risco apontado em §7 do doc).

## Pendências

**Nenhuma no código.**

**Bloqueio no board (persiste das execuções anteriores).** As ferramentas MCP
(`update_task`, `move_task_forward`, `add_task_log`, `list_tasks`) continuam **não
expostas** nesta sessão — `ToolSearch` não encontra nenhuma delas, e a API REST de
tasks segue inacessível (o board devolve 401/500). Portanto **os checkboxes do DoD
e a movimentação da task continuam pendentes** e precisam ser feitos por quem tiver
acesso ao board. Nenhuma tentativa de contornar isso foi feita.

## Nota de execução: duas sessões no mesmo worktree

Esta task foi executada por **duas sessões Claude em paralelo, no mesmo worktree**,
o que só foi percebido depois que uma edição falhou com "file has been modified
since read". As duas foram derivadas do mesmo documento de arquitetura e chegaram
a desenhos compatíveis (inclusive aos mesmos nomes de custom properties, que o doc
fixa em §5.2). A colisão foi resolvida por divisão explícita de propriedade de
arquivos, negociada entre as sessões:

- sessão A: `client/src/styles.css`, `client/src/pages/Room.jsx`;
- sessão B: `client/src/lib/`, `client/src/components/`, `client/test/`, `server/`,
  `e2e/`, `ARCHITECTURE.md`, `claude-progress.md`.

Nenhum trabalho foi perdido, mas houve esforço duplicado antes da descoberta.
**Se o orquestrador do board puder despachar só uma sessão por task, deve.**

---

# Histórico — cinco melhorias de experiência de chamada (entrega anterior)

**Status: concluído.** Commit `2a17de5` na branch
`agent/3-implementar-cinco-melhorias-de-experi-nc`.

## O que foi implementado

| Arquivo | Mudança |
|---|---|
| `client/src/lib/webrtcMesh.js` | Reescrito: 3 transceivers `sendonly` por conexão (mic/câmera/tela), perfect negotiation, `RTCDataChannel` negociado fora de banda, `setCameraTrack`/`setScreenTrack`/`setAudioTrack` via `replaceTrack`, teardown completo |
| `client/src/lib/audioLevels.js` | Novo: um `AudioContext` + um loop de rAF para a sala, histerese 500ms, bipe sintetizado |
| `client/src/lib/chat.js` | Novo: modelo de mensagem, sanitização de entrada remota, teto de histórico em memória |
| `client/src/components/{VideoTile,ChatPanel,Toasts}.jsx` | Novos |
| `client/src/pages/Room.jsx` | Orquestração: estado de participantes/chat/toasts/níveis, toggles de câmera e tela, limpeza no unmount |
| `client/src/styles.css` | Anel de fala, placeholder, painel de chat, toasts, badge |
| `client/test/*.test.mjs` | 14 testes unitários (`node:test`) |
| `e2e/{harness,run}.mjs` | Teste ponta a ponta com 3 Chromium + TURN local, 44 verificações |
| `client/.eslintrc.json` | Linter (não existia no projeto) |
| `ARCHITECTURE.md`, `README.md`, `docs/` | Documentação |

`server/src/index.js` **não foi tocado** — `peer-joined`/`peer-left` já bastavam.
(Isso deixou de valer em WTK-MEET-5; ver "Desvio consciente" acima.)

## Descobertas que mudaram o desenho

1. **Transceivers de `addTransceiver()` não pareiam com m-lines remotas.** A spec
   só permite associação implícita para transceivers criados por `addTrack()`.
   O layout real é 3 `sendonly` + 3 `recvonly` por conexão. A identificação do
   que chega usa identidade de objeto para os nossos transceivers e posição
   entre os remotos (`_classifyTransceiver`). Descoberto pelo E2E — a primeira
   versão colocava a tela remota no stream da câmera.
2. **Estado de câmera/tela vai pelo data channel**, não é inferido de
   `track.muted` (que demora segundos no Chromium).
3. **Compartilhar tela não renegocia SDP** — o transceiver já existe. O perfect
   negotiation continua necessário para a negociação inicial simétrica e para
   `restartIce()`.

## Verificação executada (entrega anterior)

- `npm --prefix client run lint` → limpo
- `npm --prefix client test` → 14/14
- `npm --prefix client run build` → ok
- `node e2e/run.mjs` → **41/41**, 5 execuções consecutivas limpas

## Passada de QA (2026-08-11)

Três buracos de cobertura fechados, todos em `e2e/`, sem tocar em código de
produção: `A4` (toast de entrada com nome e classe), `A5` (bipe de entrada,
distinto do de saída) e `C7` (parar compartilhamento pela barra do navegador, via
evento `ended`). **Cada uma foi validada por mutação.**

O que não dá para cobrir em headless está listado como checklist manual em
`docs/teste-3-participantes.md` (LED físico da webcam, `chrome://webrtc-internals`,
barra nativa "Parar compartilhamento", diálogo de escolha de tela, Firefox/Safari).

## Passada de QA do player de música (2026-08-13)

Os módulos puros do player já vinham com teste. O que faltava era tudo o que toca
DOM, WebAudio e `RTCPeerConnection` — que é exatamente onde as falhas deste
recurso são **silenciosas**. Três arquivos novos, 53 casos, nenhuma linha de
produção alterada:

- `client/test/musicEngine.test.mjs` (22) — sonda de CORS nas quatro respostas
  possíveis, os **dois** ramos do grafo (sem o de monitoração, só o dono não
  ouve), ordem `crossOrigin` → `src`, modo `local` sem WebAudio, `objectURL`
  revogado ao trocar de faixa/parar/destruir, autoplay bloqueado virando aviso, e
  o track de saída estável entre faixas.
- `client/test/musicMeshRouting.test.mjs` (17) — a ordem dos quatro transceivers,
  a classificação por posição das m-lines remotas, música no `musicStream` (nunca
  no de voz), autoria pela conexão e não pelo payload, snapshot no `onopen`, teto
  de 96 kbps e microfone intocado ao assumir a faixa.
- `client/test/youtubePlayer.test.mjs` (14) — API carregada sob demanda e uma vez
  só, hook global encadeado, erro do player virando "faixa pulada com aviso",
  volume 0–1 → 0–100.

`npm --prefix client test` → **148/148**; `npm --prefix client run lint` → limpo.

**Validação por mutação:** 10 mutantes plantados nos três módulos de produção
(ramo de monitoração removido, `crossOrigin` depois do `src`, falha de CORS
tratada como capturável, música criada antes da tela, lista de classificação sem
`'music'`, música roteada para o stream de voz, autoria vinda do payload,
snapshot não enviado no `onopen`, teto de banda não aplicado, erro do YouTube
engolido) — **10 detectados**.

### E2E: verde, mas intermitente **nas duas pontas**

`node e2e/run.mjs` na branch → **67/67** (os 57 do roteiro existente + N1–N10 da
música). O roteiro de música passou em todas as execuções que chegaram até ele.

A primeira execução da sessão falhou com o mesh sem fechar ICE, o que levantou a
suspeita da quarta m-line (risco §7 do documento de arquitetura). Não é: rodando
em série e sem contenção, **o merge-base falha na mesma proporção**.

| | passou | falhou |
|---|---|---|
| branch (com música) | 67/67, 67/67 | 1× mesh não reconectou após reload de Bob |
| merge-base / `main` | 57/57, 61/61 | 1× `B3` (contagem de `requestAnimationFrame`) |

Duas observações que valem mais que a estatística:

1. **Execuções concorrentes contaminam a medição.** Duas rodadas simultâneas
   disputam CPU e portas, e o sintoma é ICE que nunca conecta — idêntico ao de
   uma regressão de negociação. Antes de concluir qualquer coisa a partir de uma
   falha de mesh, varrer `/proc/*/cmdline` por `e2e/run.mjs` órfão (não há `ps`
   aqui) e repetir em primeiro plano.
2. As falhas da branch foram de ICE e a do base foi de temporização, então um
   efeito marginal da quarta m-line sobre o TURN local **não está descartado** —
   só não há evidência dele. Com `iceTransportPolicy: 'relay'` e o `node-turn`
   em `debugLevel: 'ERROR'`, um TURN que não sobe não aparece no log: some a
   malha inteira, sem mensagem.

### O que ficou sem cobertura automatizada

Tudo o que resta mora em `lib/useMusicRoom.js`, um hook React — o projeto não tem
infraestrutura de teste de componente (nem `jsdom` nem testing-library nas
devDependencies), e adicionar dependência não cabia a esta passada:

- §8.8 — proponente que fecha a aba durante a votação (o código existe, em
  `useMusicRoom.js`, no efeito que reage a quem saiu).
- §8.20 — fim da faixa avançando para a próxima e fila vazia virando "nada
  tocando".
- §8.21 — sucessão do dono que fecha a aba no meio da faixa.
- §8.23 — desvio de posição do YouTube abaixo de 2s após 60s.

Os quatro estão no checklist manual de `docs/teste-3-participantes.md` (itens 7 a
11), junto de arquivo local pelo seletor nativo e URL sem CORS.

## Notas para rodar o E2E neste ambiente

Num ambiente normal, `npx playwright install-deps chromium` resolve tudo — o que
segue só vale para este sandbox, que não tem as bibliotecas de sistema nem as
fontes do Chromium e não dá root. `/tmp` não persiste entre sessões, então isto
precisa ser refeito a cada vez. Receita completa, validada de novo nesta sessão:

```bash
# 1. As listas do apt vêm vazias e `apt-get update` não pode escrever em /var.
#    Redirecionar todos os diretórios de estado para /tmp resolve sem root.
mkdir -p /tmp/apt/{lists/partial,cache/archives/partial,state} && touch /tmp/apt/state/status
APTOPT="-o Dir::State::Lists=/tmp/apt/lists -o Dir::Cache=/tmp/apt/cache \
        -o Dir::State::status=/tmp/apt/state/status -o Acquire::Languages=none"
apt-get $APTOPT update

# 2. `apt-get download` não resolve dependências: a lista tem que vir do
#    apt-cache com --recurse (128 pacotes, contra os 23 de topo).
mkdir -p /tmp/pwlibs/debs && cd /tmp/pwlibs/debs
PKGS="libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdbus-1-3 \
      libdrm2 libxcb1 libxkbcommon0 libatspi2.0-0t64 libx11-6 libxcomposite1 libxdamage1 \
      libxext6 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 \
      libglib2.0-0t64 fonts-liberation fonts-dejavu-core"
apt-get $APTOPT download $(apt-cache $APTOPT depends --recurse --no-recommends \
  --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances $PKGS \
  | grep '^[a-z0-9]' | sort -u)
for d in *.deb; do dpkg-deb -x "$d" /tmp/pwlibs/root; done

# 3. Fontconfig só varre caminhos que ele conhece — copiar para ~/.fonts, que já
#    está no fonts.conf, evita ter que reescrever a config.
cp -r /tmp/pwlibs/root/usr/share/fonts/truetype/* $HOME/.fonts/

# 4. Ambiente de execução do e2e:
export LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu:/tmp/pwlibs/root/lib/x86_64-linux-gnu
export FONTCONFIG_PATH=$HOME/.config/fonts-etc FONTCONFIG_FILE=$HOME/.config/fonts-etc/fonts.conf
```

Sem as fontes, o processo do Chromium **crasha** ao renderizar texto (HarfBuzz
sem nenhuma fonte disponível) — o sintoma é `browserType.launch: Target page,
context or browser has been closed`, o mesmo erro de biblioteca faltando.
`ldd .../chrome-linux64/chrome | grep -c 'not found'` distingue os dois casos:
se der 0, o que falta é fonte.

Duas armadilhas do ambiente headless que estão documentadas no próprio harness:
injeção de teclado via CDP não chega ao renderer (usar o setter nativo de
`value` + evento `input` — e, para teclas, despachar o `KeyboardEvent` de dentro
da página, como faz a checagem M4), e o Chrome não entrega o áudio de uma track a
um segundo `AudioContext` (por isso a temporização da histerese é verificada em
teste unitário, não no navegador).

---

# WTK-MEET-12 — Troca de faixa do player de música (sessão do Arquiteto)

> 2026-08-13. Papel desta sessão: **Arquiteto de Software**. O entregável é o
> documento técnico, não a implementação. Nenhum arquivo de código foi tocado.

## O que foi entregue

`docs/agents/arch-temp-troca-de-faixa-e-playlist-longa.md` — documento de
arquitetura completo da demanda (contexto, escopo, 10 decisões arquiteturais,
componentes afetados, contratos de interface, ordem de implementação em 12
passos, 10 riscos com anti-patterns e 26 critérios de aceite técnicos).

## Diagnóstico registrado no documento

A causa vai além do que a descrição da task já apontava. A cadeia completa:

1. `load()` no caminho de reuso zera `this.ready` e nunca o restaura — `onReady`
   é evento de **construção** do `YT.Player`, não dispara em `loadVideoById`.
2. Todo comando (`play`/`pause`/`seek`/`setVolume`/`stop`) vira no-op.
3. **Todo getter também**: `positionSec → 0`, `playing → false`. E aí o dano sai
   do arquivo — o temporizador de 5s do dono passa a publicar
   `{ positionSec: 0, playing: false }` **para a sala inteira**, como estado
   autoritativo, enquanto o iframe continua tocando. É por isso que o sintoma
   atinge quem não pulou.
4. `stop()` zera `videoId` sem derrubar o iframe → a próxima faixa de YouTube
   cai no caminho de reuso, o que explica a falha também em YouTube↔arquivo/URL.
5. Corrida: o ramo do YouTube em `reconcilePlayback` **não** confere o
   `loadTokenRef` depois do `await` (o ramo de arquivo/URL confere).

## Decisões que o implementador precisa conhecer antes de abrir o editor

- **D1/D3:** destruir e recriar o `YT.Player` a cada faixa; `stop()` vira
  teardown completo (zero iframe) mas deixa o envelope reutilizável.
- **D2:** o envelope passa a receber o **host** (`youtubeHostRef`) e a criar o nó
  de mount por faixa — `YT.Player` substitui o elemento que recebe, então um
  container fixo não sobrevive ao segundo `load()`.
- **D4/D5:** geração monotônica no envelope (evento de iframe morto não pode
  avançar a faixa nova) e intenção de reprodução que sobrevive à janela de
  `loading`; o publicador de posição pula o tique enquanto carrega.
- **D6:** extrair `planAdvance` puro para `musicSession.js`. É o que torna
  `ended`/`error`/`owner-left` testáveis sem navegador — o projeto não tem
  renderer de DOM em `node --test`, só `react-dom/server`.
- **D7:** `parseSource` continua puro; `resolveSourceTitle` por injeção; o
  `fetch` do oEmbed mora em `youtubePlayer.js`. Divergência declarada com o DoD 5
  (ver abaixo).
- **D8:** o título é decidido por quem enfileira e replicado; ninguém reescreve
  título de entrada existente (divergiria a fila entre participantes).

**Dois testes de `client/test/youtubePlayer.test.mjs` fixam hoje o comportamento
que a correção remove** e precisam ser invertidos, não conciliados:
`'a faixa seguinte reaproveita o mesmo iframe…'` e
`'parar a faixa larga o vídeo corrente sem derrubar o player'`.

## Divergência com o DoD, declarada

**DoD 5** pede que `parseSource` resolva o título via oEmbed. `musicSources.js`
declara-se "Módulo **puro**: sem DOM, sem rede" e é o módulo que valida entrada
hostil vinda do data channel. A recomendação (D7) entrega o **efeito observável**
exigido — o caminho de enfileiramento resolve o título, a UI mostra o nome do
vídeo, falha mantém o fallback com o id — sem colocar rede na função pura.
Se a leitura literal for obrigatória, é decisão do Nicolas e muda a assinatura de
um módulo de validação; confirmar **antes** de implementar.

É o terceiro DoD seguido a contradizer a arquitetura do repo (ver os registros da
WTK-MEET-10 e da WTK-MEET-11).

## Pendente

Toda a implementação. Nenhum código, teste ou documentação de produto foi
alterado nesta sessão — por definição do papel.

## Bloqueios

- **Board não gravável.** As ferramentas MCP do board não estão disponíveis nesta
  sessão e `GET/POST /api/tasks/<id>` responde 404. Não houve como usar
  `add_task_log`, `update_task` ou `move_task_forward`. O registro da verificação
  vive neste arquivo, no documento de arquitetura e no commit.

## Próximo passo recomendado

Acionar o **agente de desenvolvimento (client)** com
`docs/agents/arch-temp-troca-de-faixa-e-playlist-longa.md` como referência,
começando pelos passos 1 e 3 do §6 (`planAdvance` puro e o ciclo de vida do
envelope) — são independentes entre si e podem correr em paralelo. O agente de
QA pode iniciar o passo 2 imediatamente: o contrato de `planAdvance` está fechado
no §5 e não depende do envelope.
