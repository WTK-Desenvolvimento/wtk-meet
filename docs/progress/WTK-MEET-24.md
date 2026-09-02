# WTK-MEET-24 — Redesign (`Direcao A - Rail.dc.html`)

> Documento de arquitetura: **não existe** (a task foi de Backlog direto para Development)
> Branch: `agent/wtk-meet-24-redesign`
> Início: 2026-09-02 · Status: **BLOQUEADO — aguardando acesso ao comp**

## 1. O bloqueio

A task pede para implementar um comp de design específico,
`Direcao A - Rail.dc.html`, hospedado no projeto Claude Design
`3723de30-bf77-4a57-ac22-fa03592d832b`. **O comp é a especificação inteira** — o
card não traz DoD, `scope`, nem documento de arquitetura, e o texto não descreve o
layout. Sem o arquivo não há o que implementar, só o que adivinhar.

Todas as rotas de acesso foram testadas e estão fechadas:

| Rota | Resultado |
|---|---|
| MCP `DesignSync` (`list_files`) | `DesignSync needs design-system authorization, and /design-login cannot run in this non-interactive session` |
| Arquivos semeados no workspace ("Send to Claude Code Web") | ausentes — `find /` não acha `*.dc.html`, `_ds/`, `nocturne*` nem `support.js` |
| `WebFetch` na URL do projeto | **HTTP 403** (projeto privado; a ferramenta não carrega login) |
| `ANTHROPIC_API_KEY` no ambiente | vazia |
| Referência ao comp em tasks anteriores | nenhuma — `grep -rliE "nocturne\|direcao a\|dc\.html"` no repositório inteiro não retorna nada |

O `/design-login` é uma concessão de escopo OAuth que **só uma sessão interativa
do Claude Code nesta máquina** pode executar. Feito uma vez, sessões headless
como esta reutilizam a autorização.

## 2. Por que não implementei "um rail" mesmo assim

"Direção A" é uma entre várias direções desenhadas, e o design system que ela
importa (`nocturne`) carrega tokens de cor, tipografia e espaçamento próprios.
Inventar um rail a partir do nome produziria um diff que atravessa a UI toda e
que quase certamente não bate com o comp — trabalho para jogar fora, e um
"pronto" falso no board. O bloqueio é de insumo, não de esforço.

## 3. Estado atual da UI, para quando o comp chegar

Medido nesta branch (`f9caeae`), é o que a Direção A vai reorganizar:

- `packages/client/src/pages/Room.tsx` — a casca é `<main class="room in-call">`
  com uma `.stage` e uma **barra de controles inferior** (`.controls`, ~9
  `<button>`: mic, câmera, tela, chat, música, soundboard, configurações, sair).
  Os painéis laterais entram por classe na `<main>`: `with-chat`, `with-music`.
  É exatamente essa barra inferior que uma direção "Rail" tende a virar em rail
  vertical.
- `packages/client/src/styles.css` — 1495 linhas, folha única; os tokens do
  `nocturne` entrariam aqui.
- Componentes de UI já isolados: `VideoGrid`, `SpotlightStage`, `ThumbnailRail`,
  `ChatPanel`, `MusicPanel`, `SoundboardPanel`, `SettingsModal`, `PreJoin`,
  `Toasts`.

## 4. Para desbloquear

Qualquer um dos três:

1. Rodar `/design-login` uma vez numa sessão interativa do Claude Code nesta
   máquina e reenfileirar a task.
2. Usar o "Send to Claude Code Web" do Claude Design, que semeia os arquivos do
   projeto no workspace.
3. Colar/commitar os quatro arquivos no repositório: `Direcao A - Rail.dc.html`,
   `_ds/nocturne-9f40bfdf-cfcf-43c2-933c-a1689ac8f55a/_ds_bundle.js`,
   `_ds/nocturne-9f40bfdf-cfcf-43c2-933c-a1689ac8f55a/styles.css`, `support.js`.

Nenhum arquivo de `packages/` foi alterado nesta branch.
