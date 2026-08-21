# Recusar no ato links do YouTube que não podem ser incorporados — Documento de Arquitetura Técnica

> Gerado em: 2026-08-21
> Task: WTK-MEET-14
> Status: Rascunho

---

## 1. Contexto e Objetivo [obrigatório]

**Problema atual.** Um link de vídeo removido, privado ou com incorporação bloqueada pelo dono entra na fila como qualquer outro. A sala só descobre quando a faixa chega a tocar: o `YT.Player` dispara `onError`, `handlePlayerError` (`client/src/lib/useMusicRoom.js:270-281`) mostra o aviso *"não pode ser tocada aqui (vídeo indisponível ou sem incorporação)"* para todo mundo e o dono pula a faixa. Entre colar o link e o erro podem passar minutos e várias faixas; quem colou já não está na tela de adicionar e não liga uma coisa à outra.

**A informação já está em mãos.** `addToQueue` (`useMusicRoom.js:678-714`) já faz a requisição ao oEmbed público do YouTube — `resolveSourceTitle(parsed, { fetchTitle: (videoId) => fetchYouTubeTitle(videoId) })`, linha 714 — no instante em que a pessoa cola o link. O status HTTP dessa resposta distingue os casos (401/403 = incorporação desabilitada; 404 = removido/privado/inexistente; 200 = tocável), mas `fetchYouTubeTitle` (`youtubePlayer.js:118`) faz `if (!response?.ok) return null` e colapsa tudo num `null` indistinguível de timeout de rede. **O diagnóstico é feito e jogado fora.**

**Comportamento esperado após a entrega.** Ao submeter o link, se o oEmbed responder 401, 403 ou 404, a faixa **não entra na fila**: o campo de adicionar mostra o motivo, o texto colado continua lá para correção, e nenhuma mensagem `music-queue-add` é enviada à sala. Qualquer outro desfecho da requisição — inclusive erro de rede, timeout, 429 ou 5xx — mantém exatamente o comportamento de hoje: a faixa entra na fila.

**Sem nenhuma requisição a mais.** A recusa reaproveita a resposta que já era buscada. Não há nova sonda, nem para quem enfileira nem para os outros participantes — a promessa do §6.9 do `ARCHITECTURE.md` ("só quem enfileira fala com a Google") continua intacta.

---

## 2. Escopo [obrigatório]

**Dentro do escopo:**

- Preservar o status HTTP do oEmbed do YouTube, hoje descartado, e classificá-lo em um veredito de disponibilidade.
- Recusar em `addToQueue` os links cujo veredito prove indisponibilidade, com mensagem distinta para "vídeo indisponível" e para "incorporação bloqueada pelo dono".
- Manter o caminho de título inalterado: o título continua sendo enfeite e continua sendo replicado no `music-queue-add`.
- Cobertura unitária do mapa status → veredito e da recusa fail-open.

**Fora do escopo:**

- **Remover ou enfraquecer o caminho de erro em tempo de execução** (`handlePlayerError`, `useMusicRoom.js:270`). Ele continua obrigatório: cobre o vídeo que fica privado *depois* de entrar na fila, a entrada replicada de outro peer que este cliente nunca sondou, e o erro de player que não é de disponibilidade.
- Sondar entradas que chegam pelo data channel (`music-queue-add`) — seria N requisições à Google por faixa e quebraria a política de privacidade do §6.9.
- Validar URLs diretas de áudio para além da sonda `probeDelivery` que já existe.
- Qualquer verificação de restrição regional, faixa etária ou vídeo agendado: o oEmbed não distingue esses casos com status próprio, e adivinhar produziria falso positivo.
- Retentativa, cache de veredito ou backoff de oEmbed.

---

## 3. Decisões Arquiteturais [obrigatório]

### 3.1 A mesma requisição, com o resultado preservado

- **Decisão:** manter uma única chamada ao oEmbed por link adicionado. A função que faz a rede passa a devolver `{ title, availability, status }` em vez de só o título.
- **Motivação:** a informação já vem na resposta que já é buscada; o custo da feature é zero requisições novas. Uma segunda sonda dobraria a exposição do IP do usuário à Google, dobraria a latência do enfileiramento e criaria a possibilidade de as duas respostas discordarem.
- **Alternativas descartadas:**
  - *Sonda dedicada de embeddability antes do enfileiramento* — duas requisições onde uma basta.
  - *`HEAD` no `youtube.com/watch?v=`* — a página responde 200 mesmo para vídeo privado; não distingue nada.
  - *IFrame Player API "de mentira", carregada escondida só para ver se dá erro* — carrega script de terceiro fora do fluxo de reprodução, contradiz o carregamento sob demanda documentado em `youtubePlayer.js:41-45`, e leva segundos.

### 3.2 A rede continua confinada em `youtubePlayer.js`

- **Decisão:** o novo comportamento de rede nasce em `youtubePlayer.js`, ao lado de `fetchYouTubeTitle`. `musicSources.js` continua **puro** — sem DOM, sem rede — e recebe o resultado por injeção, como já recebe hoje.
- **Motivação:** é a razão de existir da separação, documentada em `musicSources.js:1-12` e `:145-152`. `musicSources.js` é o módulo que precisa valer para entrada hostil vinda do data channel e por isso é testado em `node:test`; rede dentro dele torna esse teste impossível. Além disso, a flag `VITE_ENABLE_YOUTUBE` desliga `youtubePlayer.js` inteiro — mover a chamada furaria a garantia de "nenhuma requisição à Google" no ponto onde a requisição nasce.
- **Alternativas descartadas:**
  - *`parseSource` fazendo a consulta* — quebra a pureza e torna síncrono-por-contrato um caminho que passaria a ter rede. Este mesmo ponto já foi conflito entre DoD e arquitetura na WTK-MEET-12; **aqui a arquitetura vale**.
  - *`addToQueue` classificando o status na mão* — espalha o conhecimento do protocolo oEmbed para dentro do hook e deixa a regra sem teste unitário próprio.

### 3.3 `fetchYouTubeTitle` sobrevive como envelope fino

- **Decisão:** introduzir a função rica (que devolve título **e** veredito) e reescrever `fetchYouTubeTitle` como um envelope de uma linha sobre ela, com o contrato de hoje intacto: devolve `string | null`, nunca lança.
- **Motivação:** o contrato "nunca lança, nunca é obrigatório" está documentado e coberto por testes (`client/test/youtubePlayer.test.mjs`, bloco AC10). Preservá-lo mantém a suíte existente verde e deixa o diff da task legível: o que muda é o que `addToQueue` consome, não o que já funcionava.
- **Alternativas descartadas:** *mudar o retorno de `fetchYouTubeTitle` para objeto* — renomeia semanticamente uma função pública, invalida testes que não têm nada a ver com esta demanda e obriga todo chamador futuro a desembrulhar o título.

### 3.4 Fail-open: só três status recusam

- **Decisão:** apenas 401, 403 e 404 produzem recusa. Todo o resto — 200, 429, 5xx, erro de rede, CORS, timeout, abort, JSON inválido, flag desligada, `fetch` ausente — produz o veredito `unknown`, e `unknown` **enfileira**.
- **Motivação:** um oEmbed fora do ar não pode virar "ninguém na sala consegue adicionar música". O custo de um falso negativo (link ruim entra na fila) é o comportamento que já existe hoje; o custo de um falso positivo (link bom recusado) é um recurso quebrado sem explicação e sem caminho de contorno.
- **Alternativas descartadas:** *tratar todo `!response.ok` como recusa* — 429 é resposta comum de rate-limit em sala movimentada e derrubaria o enfileiramento para todo mundo ao mesmo tempo.

### 3.5 A recusa acontece depois das duas esperas

- **Decisão:** a verificação do veredito fica **imediatamente após** o `Promise.all` de `addToQueue` e **antes** de `bumpLamport`. Ela não lê nada de `sessionRef.current`.
- **Motivação:** o comentário em `useMusicRoom.js:699-707` documenta a regra: nada que componha o estado a ser publicado pode ser lido antes das chamadas de rede, sob pena de uma faixa adicionada por outro participante durante a espera sumir da fila deste cliente. Uma recusa que só mostra aviso e retorna `false` não lê nem publica estado — é o ponto mais seguro possível para ela, e não altera a ordem existente.
- **Alternativas descartadas:** *recusar dentro do `Promise.all`, abortando a sonda de URL* — o caminho de YouTube nem usa `probeDelivery` (`delivery` é `'stream'` fixo), então não há nada a abortar; adicionaria complexidade sem ganho.

### 3.6 Duas mensagens, porque os dois casos têm saídas diferentes

- **Decisão:** mensagens distintas para "removido/privado" e para "o dono não permite incorporação", ambas em `SOURCE_ERRORS` (`musicSources.js:195`).
- **Motivação:** o lugar único de mensagens de recusa já é convenção do arquivo ("UI e testes leem daqui"). E a ação do usuário difere: no primeiro caso o link está errado ou morto e há o que corrigir; no segundo o vídeo existe mas nunca vai tocar fora do YouTube, e insistir não adianta.
- **Alternativas descartadas:** *mensagem única* — devolve ao usuário a mesma ambiguidade que o `null` de hoje devolve ao código.

---

## 4. Componentes Afetados [obrigatório]

### Camada de origem YouTube — `client/src/lib/youtubePlayer.js`

| Componente | O que muda | Por quê |
|---|---|---|
| Nova função exportada (sugestão: `fetchYouTubeOEmbed`) | Faz a requisição ao oEmbed que hoje mora dentro de `fetchYouTubeTitle` e devolve `{ title, availability, status }`. Herda integralmente o comportamento atual: guarda de `isYouTubeEnabled()`, validação do `videoId` contra o alfabeto de 11 caracteres, `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, timeout de `OEMBED_TIMEOUT_MS`, `signal` externo, **nunca lança**. | É onde a dependência do terceiro está confinada e onde o status ainda existe. |
| `fetchYouTubeTitle` | Passa a delegar à função acima e devolver só o `title`. Contrato externo (`string \| null`, nunca lança) inalterado. | Mantém verde a suíte AC10 e não obriga chamadores futuros a desembrulhar objeto. |
| Cabeçalho do arquivo / docstring | Registrar que o oEmbed agora serve a dois propósitos — título (enfeite) e veredito de disponibilidade (decisão) — e que os dois vêm da mesma resposta. | O arquivo é fortemente documentado; uma função com dois papéis precisa dizer isso. |

### Camada pura de parsing — `client/src/lib/musicSources.js`

| Componente | O que muda | Por quê |
|---|---|---|
| `resolveSourceTitle` → generalizada (sugestão: `resolveSourceMeta`) | Continua **pura e por injeção**; o buscador injetado passa a devolver `{ title, availability }` e a função passa a devolver `{ title, availability }`. O tratamento de título é idêntico ao de hoje: `clampTitle`, fallback em qualquer erro, valor não-textual ou título vazio. Para origem não-YouTube ou sem buscador: `{ title: fallback, availability: 'unknown' }`. | O veredito precisa chegar a `addToQueue` junto com o título, sem que a decisão de "o que é recusável" vaze para dentro do hook. |
| `SOURCE_ERRORS` | Duas chaves novas: uma para vídeo indisponível (removido/privado) e uma para incorporação bloqueada pelo dono. | Lugar único de mensagens de recusa, já usado por `addToQueue` e pelos testes. |

> Se a implementação preferir manter o nome `resolveSourceTitle` e adicionar a função rica ao lado, tudo bem — o que **não** pode acontecer é sobrar uma função exportada sem chamador. Um dos dois caminhos, não os dois.

### Hook da sala — `client/src/lib/useMusicRoom.js`

| Componente | O que muda | Por quê |
|---|---|---|
| `addToQueue` (`:678-714`) | O segundo item do `Promise.all` passa a resolver `{ title, availability }`. Logo após o `await`, e **antes de qualquer leitura de `sessionRef.current`**, um bloco novo: se o veredito for de indisponibilidade comprovada, `showNotice` com a mensagem correspondente e `return false`. O resto do corpo segue idêntico, lendo `title` do objeto. | É o único ponto do sistema onde o usuário está olhando para a ação que gerou o link. |
| Comentário de `:699-707` | Estender para dizer que a recusa por veredito também mora depois das esperas e por quê. | A regra de ordenação é sutil e já custou um bug; o comentário é a defesa dela. |

### Camada de apresentação — `client/src/components/MusicPanel.jsx`

Sem mudança de código. `handleSubmit` (`:49-57`) já preserva o `draft` quando `onAdd` devolve `false` e o aviso já aparece pelo canal de `notice`. **Verificar, não alterar** — a preservação do texto colado é parte do critério de aceite.

### Documentação

| Arquivo | O que muda |
|---|---|
| `ARCHITECTURE.md` §6.9 | Um parágrafo na linha da tabela do YouTube: o mesmo oEmbed que busca o título decide, no ato, se o vídeo é incorporável; 401/403/404 recusam, qualquer outro desfecho enfileira. |
| `claude-progress.md` | Registro da WTK-MEET-14, no formato já usado pelas tasks anteriores. |

---

## 5. Contratos de Interface

Sem endpoints REST, sem eventos novos no data channel, sem schema de banco. **Nenhuma mensagem `music-*` muda de formato** — a recusa acontece antes de qualquer envio, e o que trafega continua sendo a entrada de fila já sanitizada.

### Veredito de disponibilidade (contrato interno)

| Valor | Origem | Efeito em `addToQueue` |
|---|---|---|
| `ok` | HTTP 200 (com ou sem título legível no corpo) | Enfileira |
| `unavailable` | HTTP 404 | **Recusa** — vídeo removido, privado ou ID inexistente |
| `embed-blocked` | HTTP 401 ou 403 | **Recusa** — dono desabilitou a incorporação |
| `unknown` | Erro de rede, CORS, timeout, abort, JSON inválido, qualquer outro status (429, 5xx, 400…), flag `VITE_ENABLE_YOUTUBE` desligada, `fetch` indisponível, origem não-YouTube, buscador não injetado | Enfileira (comportamento de hoje) |

Os nomes dos valores são sugestão; o que é contrato é **o mapa de status para decisão** e o fato de `unknown` ser o padrão de tudo que não for prova.

### Retorno do buscador de oEmbed

| Campo | Tipo | Observações |
|---|---|---|
| `title` | `string \| null` | Título já aparado; `null` quando ausente, vazio ou não-textual. **Independente do veredito**: um 200 sem título legível é `{ title: null, availability: 'ok' }`. |
| `availability` | um dos quatro valores acima | Nunca ausente |
| `status` | `number \| null` | O status HTTP cru, `null` quando não houve resposta. Existe para diagnóstico e teste; nenhuma decisão de produto deve reler o número. |

### Retorno do resolvedor puro

`{ title: string, availability: <veredito> }` — `title` sempre preenchido (fallback `YouTube · <id>` quando não veio nada), nunca `null`, como já é hoje.

---

## 6. Dependências e Ordem de Implementação [obrigatório]

1. **`youtubePlayer.js`** — extrair a requisição para a função rica, definir o mapa status → veredito, reescrever `fetchYouTubeTitle` como envelope. *Fundação; não depende de nada.*
2. **`musicSources.js`** — generalizar o resolvedor por injeção e acrescentar as duas mensagens em `SOURCE_ERRORS`. *Independente do passo 1 (só consome o formato acordado) — **pode rodar em paralelo**.*
3. **`useMusicRoom.js`** — ligar os dois no `addToQueue` e inserir a recusa depois do `Promise.all`. *Depende de 1 e 2.*
4. **Testes unitários** — `client/test/youtubePlayer.test.mjs` (mapa de status, fail-open, flag desligada sem requisição, contrato do envelope preservado) e `client/test/musicSources.test.mjs` (propagação do veredito, pureza, fallback de título). *Depende de 1 e 2; **pode rodar em paralelo com 3**.*
5. **Verificação em navegador do comportamento de CORS nas respostas de erro** — ver risco 7.1. *Depende de 3 e determina se a feature entrega o efeito prometido ou degrada para o comportamento atual.*
6. **Documentação** — `ARCHITECTURE.md` §6.9 e `claude-progress.md`, com o resultado da verificação do passo 5 registrado. *Por último.*

---

## 7. Riscos e Armadilhas [obrigatório]

### 7.1 CORS nas respostas de erro do oEmbed — o risco que decide a feature

- **Risco:** o navegador só expõe `response.status` a JavaScript se a resposta trouxer `Access-Control-Allow-Origin`. Se o oEmbed do YouTube emitir esse cabeçalho no 200 mas **não** nos 401/403/404, o `fetch` rejeita com `TypeError` antes de haver status a ler, a execução cai no `catch`, o veredito vira `unknown` e a recusa nunca dispara em produção — mesmo com toda a suíte unitária verde, porque `fetchImpl` injetado nos testes não simula CORS.
- **Mitigação:** verificar empiricamente em navegador real, com um vídeo de cada categoria, **antes de dar a task por concluída**. O desenho já é fail-open, então o pior caso é exatamente o comportamento de hoje — mas é obrigatório registrar o resultado no `claude-progress.md` em vez de deixar a suíte verde sugerindo que funciona.
- **Anti-pattern a evitar:** contornar com `mode: 'no-cors'`. A resposta opaca resultante tem `status === 0` e `ok === false` **sempre**, inclusive para vídeos perfeitamente tocáveis — recusaria todo mundo. Também não vale roteirizar a requisição por um proxy: o `ARCHITECTURE.md` §1 e §5 vetam componente de servidor para o player.

### 7.2 Confundir "sem título" com "indisponível"

- **Risco:** vídeo que responde 200 com JSON sem `title` legível vira recusa, e um vídeo tocável é rejeitado.
- **Mitigação:** os dois campos são independentes por construção. `title: null` com `availability: 'ok'` é um estado válido e deve ter teste próprio.
- **Anti-pattern a evitar:** derivar o veredito do título (`if (!title) return 'unavailable'`) — é exatamente o colapso de informação que esta task existe para desfazer, reintroduzido do outro lado.

### 7.3 Mover a rede para `musicSources.js`

- **Risco:** parece natural que "o módulo que decide se o link presta" faça a consulta.
- **Mitigação:** injeção, como já é hoje. A regra está escrita em `musicSources.js:1-12` e `:145-152`.
- **Anti-pattern a evitar:** `import { fetchYouTubeOEmbed } from './youtubePlayer.js'` dentro de `musicSources.js`. Mesmo sem chamar, o import arrasta a dependência e mata a testabilidade em `node:test`. Sinal de alarme: se `client/test/musicSources.test.mjs` precisar de mock de `fetch` para passar, a pureza foi quebrada.

### 7.4 Ler estado da sessão antes das esperas

- **Risco:** a recusa acaba escrita antes do `Promise.all`, ou o autor "aproveita a viagem" e move as verificações de duplicata/limite para depois, ou lê `sessionRef.current` para compor a mensagem de recusa. Qualquer um reabre o bug de faixa de outro participante sumindo da fila deste cliente.
- **Mitigação:** o bloco de recusa fica entre o `await` e o `bumpLamport`, usa apenas `parsed` e o veredito, e não toca em `sessionRef`.
- **Anti-pattern a evitar:** enriquecer o aviso com dado da fila ("já há 3 faixas antes desta"). Custa um `sessionRef.current` no lugar errado e não acrescenta nada ao usuário.

### 7.5 Fail-open virando fail-closed por descuido

- **Risco:** classificar por `!response.ok` em vez de por lista explícita de status. Um 429 em sala movimentada bloquearia o enfileiramento para todos ao mesmo tempo, e o sintoma ("ninguém consegue adicionar música") seria difícil de rastrear até aqui.
- **Mitigação:** lista explícita `{401, 403, 404}`; o `default` do mapa é `unknown`.
- **Anti-pattern a evitar:** `if (!response.ok) return 'unavailable'`.

### 7.6 Recusa com efeito colateral pendurado

- **Risco:** a recusa acontece depois de algum registro já ter sido criado, deixando lixo em `localFilesRef` ou `deliveryHintRef`.
- **Mitigação:** no ponto proposto nada foi criado ainda — `newId()`, `localFilesRef.current.set` e `deliveryHintRef.current.set` são todos posteriores. Manter assim.
- **Anti-pattern a evitar:** mover a criação do `entry` para antes da recusa "para reaproveitar o título".

### 7.7 Remover o aviso de tempo de execução por parecer redundante

- **Risco:** com a recusa no ato, `handlePlayerError` parece código morto. Não é: cobre o vídeo que fica indisponível depois de enfileirado, a entrada replicada de outro peer, o `unknown` que passou (rede caída, CORS, flag desligada) e erros de player que não são de disponibilidade.
- **Mitigação:** deixá-lo intacto e dizer isso no comentário.
- **Anti-pattern a evitar:** trocar a mensagem dele por uma que afirme "isso não deveria acontecer".

### 7.8 Latência de enfileiramento

- **Risco:** o enfileiramento passa a *depender* de uma resposta que antes era opcional, e uma pessoa com rede ruim espera até `OEMBED_TIMEOUT_MS` para ver a faixa entrar.
- **Mitigação:** manter os 2,5s atuais. O `Promise.all` já é o caminho crítico de hoje; a task não acrescenta espera nenhuma.
- **Anti-pattern a evitar:** aumentar o timeout "para dar mais chance de classificar". Estender a espera para ganhar precisão numa recusa é trocar o problema visível de poucos pelo atraso de todos.

---

## 8. Critérios de Aceite Técnicos [obrigatório]

**Recusa**

1. Colar um link de YouTube cujo oEmbed responde **404** não adiciona faixa à fila, não envia `music-queue-add`, e mostra aviso de vídeo indisponível (removido ou privado).
2. Colar um link cujo oEmbed responde **401** ou **403** não adiciona faixa à fila, não envia `music-queue-add`, e mostra aviso de incorporação bloqueada pelo dono — mensagem **diferente** da do critério 1.
3. Em ambos os casos `addToQueue` devolve `false` e o texto colado permanece no campo de adicionar, pronto para correção.
4. Em ambos os casos nada é criado nem deixado para trás: sem entrada na sessão, sem registro em `localFilesRef` ou `deliveryHintRef`, sem `lamport` consumido.

**Fail-open**

5. Erro de rede, timeout, abort, resposta que não é JSON, 429 e 5xx enfileiram normalmente, com o título de fallback `YouTube · <id>`.
6. Com `VITE_ENABLE_YOUTUBE` desligada nenhuma requisição nasce e nenhum link é recusado por veredito (a recusa aplicável continua sendo a de `parseSource`, `youtube-disabled`).
7. Sem `fetch` disponível no ambiente, enfileira.

**Não-regressão**

8. Link válido (oEmbed 200) enfileira com o título real, exatamente como hoje.
9. oEmbed 200 sem título legível no corpo **enfileira** com o fallback — não é recusa.
10. Exatamente **uma** requisição ao oEmbed por link adicionado; nenhuma requisição para os demais participantes ao receber `music-queue-add`.
11. `fetchYouTubeTitle` continua devolvendo `string | null` e continua não lançando: a suíte AC10 de `youtubePlayer.test.mjs` passa **sem edição**.
12. `client/test/musicSources.test.mjs` passa sem nenhum mock de `fetch` nem de DOM.
13. Arquivo local e URL direta seguem inalterados — o veredito nunca recusa origem que não seja YouTube.
14. A ordem de `addToQueue` é preservada: nada que componha o estado publicado é lido antes das duas esperas de rede.

**Documentação**

15. `ARCHITECTURE.md` §6.9 descreve a recusa no ato e o mapa de status; `claude-progress.md` registra a task e o resultado da verificação de CORS (7.1).

---

## 9. Notas para os Agentes de Implementação

**Divisão sugerida.** Um único agente de desenvolvimento dá conta: os três arquivos são pequenos e o passo 3 depende dos dois primeiros. Se houver paralelização, a fronteira natural é `youtubePlayer.js` + seus testes de um lado e `musicSources.js` + `useMusicRoom.js` do outro, com o formato `{ title, availability, status }` acordado antes de qualquer edição.

**Pitfalls específicos desta demanda, que não estão na documentação geral:**

- A suíte unitária **não prova** que a recusa funciona no navegador — ela injeta `fetchImpl` e nunca exercita CORS. Verde aqui não é entrega. Ver 7.1.
- `fetchYouTubeTitle` tem contrato público documentado e testado. Envelope fino, não substituição.
- Os dois arquivos de origem têm densidade de comentário alta e explicam o **porquê**, não o **o quê**. Acompanhar esse padrão: cada decisão nova (por que só três status recusam, por que a recusa fica depois das esperas) merece a frase que impede a próxima pessoa de "simplificar" de volta.
- Não introduzir dependência nova, biblioteca de HTTP nem camada de cache. `fetch` cru, como já é.

**Ordem de validação após implementação:**

1. `node --test` na suíte de `client/test` — em especial `youtubePlayer.test.mjs` e `musicSources.test.mjs`, com atenção a testes preexistentes que tenham sido editados (não deveriam ser, fora do resolvedor renomeado).
2. Conferir por inspeção que `musicSources.js` não ganhou nenhum import de rede/DOM.
3. Conferir por inspeção que em `addToQueue` nenhuma leitura de `sessionRef.current` migrou para antes do `Promise.all`.
4. Navegador, com três links reais: um tocável, um removido/privado, um com incorporação desabilitada. Registrar o status observado e se ele chegou legível ao JavaScript.
5. E2E (`e2e/run.mjs`) para garantir que o fluxo de fila e votação não regrediu. Atenção: `F4a` é falha pré-existente e não pertence a este diff.

**Se a verificação do passo 4 mostrar que o status não chega legível por CORS:** não force a barra. Entregue o código como está (fail-open, comportamento idêntico ao de hoje), registre a constatação no `claude-progress.md` e no `ARCHITECTURE.md`, e reporte — é uma decisão de produto, não de implementação.
