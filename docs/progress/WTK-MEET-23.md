# WTK-MEET-23 — Soundboard (MyInstants) com favoritos locais e disparo para a sala

> Documento de arquitetura: `docs/agents/arch-temp-soundboard-myinstants.md`
> Branch: `agent/wtk-meet-23-quero-colocar-uma-se-o-do-myinstants-ond`
> Início: 2026-09-01 · Status: **COMPLETED**

O registro do que a implementação encontrou: linha de base medida, divergências
entre o documento de arquitetura e o DoD do board (o DoD venceu, item a item), e a
pendência de produto que sobra no fim.

---

## 1. Linha de base, medida nesta branch antes de qualquer alteração

| Portão | Valor | Observação |
|---|---|---|
| `npm test` (client) | 520/520 | |
| `npm test` (server) | 56/56 | |
| `npm run typecheck` | limpo | três pacotes |
| `npm run lint` | limpo | |
| `npm run test:e2e` | **140/141** | única falha: F4a, pré-existente (o botão "Silenciar avisos" restaurado por engano em `1baa707`) |

**Correção que precedeu tudo (`f719b86`):** a branch nasceu de uma `main` que
renderiza página em branco. O `react-router-dom@7` iça um `react@18` para a raiz e
o client declara `react@19` — duas cópias, dois dispatchers, `Cannot read
properties of null (reading 'useRef')` no primeiro hook do router. Sem o
`resolve.dedupe` do Vite o E2E fecha **0/141**, morrendo no primeiro passo, e a
falha se lê como regressão da task em curso. Mesmo conserto de uma linha já feito
(e ainda não mergeado) nas branches da WTK-MEET-21 e da WTK-MEET-22. **Continua
fora da `main`.**

---

## 2. Divergências entre o documento de arquitetura e o DoD do board

O documento foi escrito antes do DoD e diverge dele em seis pontos. Em todos, **o
DoD venceu** — é ele que fecha o portão.

| # | Documento de arquitetura | DoD do board | O que foi feito |
|---|---|---|---|
| 1 | §3.1: proxy no servidor (`/soundboard/resolve` e `/soundboard/media`), com aval explícito pendente | Item 12: sonda `Range: bytes=0-0` antes de mixar, e a falha vira **mensagem de erro visível** | Sem proxy. A sonda roda antes de mixar e a recusa aparece no painel. O aval de §3.1 nunca veio, e o proxy expande o que o servidor sabe — não é decisão de implementação (ver §5) |
| 2 | §4: `parseMyInstantsUrl` próprio, com allowlist de host | Item 2: a URL passa por `parseSource` de `musicSources.ts` | `lib/soundboard.ts` chama `parseSource(raw, { allowYouTube: false })`. Uma tabela de esquemas só, e é a que já protege a fila do player |
| 3 | §5: mensagem `soundboard-fire`, em módulo próprio, **fora** de `MUSIC_MESSAGE_TYPES` (§9, pitfall 6) | Item 9: `soundboard-play` em `musicProtocol.ts`, **dentro** de `MUSIC_MESSAGE_TYPES` | `soundboard-play` na tabela, com builder e caso próprio no sanitizador. O roteamento do mesh não precisou de predicado novo |
| 4 | §5: máximo de 40 favoritos | Item 4: **50** | 50 (`MAX_FAVORITES`) |
| 5 | §5: `MAX_CONCURRENT = 3` vozes simultâneas | Item 8: **um efeito por vez** por participante | Um por vez: o disparo novo corta o anterior daquele peer |
| 6 | §3.2/§3.3: `musicBus.ts` novo, injeção no `MusicEngine`, `setMusicSenderActive` | Item 6: sem `replaceTrack` por disparo e sem renegociação | `MusicEngine.ensureOutput()` — o `MediaStreamDestination` que o motor já criava uma vez passa a poder nascer sem faixa. Sem módulo novo, sem injeção, sem `active` no sender: 40 linhas em vez de um refactor no caminho mais coberto por testes da suíte |

Uma divergência **do DoD consigo mesmo** também precisa estar escrita:

- O item 6 manda mixar o efeito no canal de música de quem dispara (no fio, efeito
  e música viram **o mesmo sinal**) e o item 11 manda que silenciar o soundboard de
  alguém não altere o volume da música daquela pessoa. Os dois não podem valer ao
  mesmo tempo: nenhum receptor consegue separar dois sinais somados numa soma. O
  que foi implementado é o item 11 no que ele garante de fato — a escolha é local,
  não trafega, não mexe em volume nem em microfone de ninguém — com a janela de
  mute temporal de §3.4 do documento. **Enquanto o efeito dura**, a faixa que o peer
  silenciado estiver transmitindo também emudece. O painel diz isso, o
  `ARCHITECTURE.md` §6.13 diz isso, e os dois READMEs dizem isso.

---

## 3. O que foi entregue, por commit

| Commit | O quê |
|---|---|
| `f719b86` | `resolve.dedupe` do React no Vite (destrava o E2E) |
| `e892af3` | Módulos puros: `lib/soundboard.ts`, `lib/soundboardRate.ts`, `soundboard-play` em `musicProtocol.ts` + 24 casos |
| `4506b97` | `MusicEngine.ensureOutput`, `lib/soundboardPlayer.ts`, posse do canal e recepção em `useMusicRoom` |
| `cbff291` | UI: `useSoundboard`, `SoundboardPanel`, botão da barra, mute por peer no `RemoteMusicAudio`, CSS |
| `ef81365` | Cenário `SB` no E2E e documentação (ARCHITECTURE §6.13, READMEs, CHANGELOG, este arquivo) |
| `fb889fa` | A posse do canal passa a seguir o painel por efeito, não de dentro do atualizador de estado |

---

## 4. Números finais

| Portão | Antes | Depois |
|---|---|---|
| `npm test` (client) | 520 | 557 (+37: 24 do módulo puro, 13 da fiação do hook) |
| `npm test` (server) | 56 | 56 (intocado) |
| `typecheck` / `lint` | limpos | limpos |
| `npm run test:e2e` | 140/141 | 147/148 — mesma única falha, a F4a pré-existente |

O E2E ganhou sete checagens (`SB1`–`SB7`), com duas abas de verdade: Alice favorita
uma URL servida pelo próprio host do teste, dispara, e o roteiro confere **no lado
de Bob** a atribuição do anúncio e a energia no quarto canal (`rms=0.16`, de 0 para
36 KB recebidos). A prova é a segunda máquina, e não o monitor de quem clica — é o
monitor que engana quando o áudio sai silêncio digital.

O número foi confirmado em **duas execuções completas** (a última já sobre a árvore
final, com o refactor da posse do canal dentro).

**Duas execuções intermediárias morreram antes do fim** — uma na seção T ("timeout
esperando mesh da sala de ruído", as três conexões daquela sala em `new`) e outra
ainda na seção A, com um par parado em `conn: new, ice: new, sig: stable`. É a falha
ambiental conhecida deste sandbox (contenção derrubando o `node-turn`; sem TURN não há
conexão com `iceTransportPolicy: 'relay'`), e não regressão: as duas execuções
seguintes, sem nenhuma alteração de código entre elas, fecharam 147/148 com a mesma
única falha.

---

## 5. Pendência de produto (não é débito técnico)

**O recurso não toca URL do MyInstants**, que é o site citado no título da task. O
site não responde `Access-Control-Allow-Origin` (verificado em 2026-09-01, em
`GET`, `HEAD` e `OPTIONS`), e sem CORS não existe caminho no navegador que ponha
aquele áudio dentro de um `MediaStreamTrack` — `fetch` é bloqueado, `<audio
crossOrigin>` não carrega, e `<audio>` sem `crossOrigin` tinge o grafo e faz o
`MediaStreamDestination` emitir **silêncio digital sem erro nenhum**.

O que a entrega faz é o que o item 12 do DoD pede: sondar antes de mixar e recusar
**com mensagem visível**. Com qualquer host que libere CORS o recurso funciona
ponta a ponta (é o que o cenário `SB` do E2E prova).

Fazer o MyInstants funcionar exige o proxy de §3.1 do documento de arquitetura —
duas rotas no servidor de sinalização, com allowlist de host **e** de prefixo de
caminho, teto de bytes, timeout, `Content-Type` obrigatoriamente `audio/*` e rate
limit por IP. Isso **expande o que o servidor faz e o que ele sabe**: ele passa a
transportar bytes de mídia de terceiro e a ver "algum IP pediu o som X". O próprio
documento marca a decisão como pendente de aval, e ela não chegou — então não foi
implementada. Está registrada em `ARCHITECTURE.md` §9.
