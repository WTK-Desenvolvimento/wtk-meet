# Arquitetura — wtk-meet

> Documento de arquitetura técnica. Autor: Winston (Arquiteto). Status: proposta para implementação.

## 1. Objetivo e restrições inegociáveis

Aplicação de videochamada em grupo (até **6 participantes**), estilo Google Meet simplificado, com os seguintes requisitos não-funcionais que dirigem toda decisão abaixo:

- **Zero persistência de dados** — nenhuma sala, mensagem, mídia ou metadado de chamada é gravado em disco ou banco de dados, em nenhum momento.
- **Zero dependência de infraestrutura de terceiros** — sem Google STUN público, sem serviços de nuvem de terceiros para sinalização, TURN ou storage. Tudo self-hosted.
- **E2EE além do SRTP nativo do WebRTC** — mesmo o operador da infraestrutura (TURN relay, servidor de sinalização) não deve conseguir decifrar o conteúdo de áudio/vídeo.
- **Controle de acesso social** — entrar em uma sala exige aprovação explícita de quem já está presente (não é só "link + senha").

Essas restrições eliminam de saída qualquer arquitetura baseada em SFU/MCU de terceiros (LiveKit Cloud, Daily, Twilio, etc.) e qualquer backend com banco de dados.

## 2. Visão de alto nível

```
┌─────────────┐        WSS (sinalização efêmera)        ┌─────────────┐
│  Cliente A   │◄───────────────────────────────────────►│  Cliente B   │
│  (React)     │                                          │  (React)     │
└──────┬───────┘                                          └──────┬───────┘
       │                     ▲                                   │
       │        Node.js signaling server (stateless em disco,    │
       │        estado só em memória de processo)                │
       │                     │                                   │
       │                     ▼                                   │
       │            ┌─────────────────┐                          │
       │            │  Signaling (WS) │                          │
       │            │  sem DB, sem    │                          │
       │            │  log de conteúdo│                          │
       │            └─────────────────┘                          │
       │                                                          │
       └───────────────── mesh P2P (DTLS-SRTP + E2EE) ───────────┘
                     (mídia nunca passa pelo servidor,
                      exceto quando NAT exige TURN relay)

                    ┌───────────────────────┐
                    │  coturn self-hosted    │
                    │  STUN + TURN (com TLS) │
                    └───────────────────────┘
```

- **Frontend (React + TS)**: UI, gestão de `RTCPeerConnection`, criptografia E2EE via Insertable Streams, lógica de aprovação de entrada.
- **Backend de sinalização (Node.js)**: só troca de SDP/ICE/mensagens de controle (join request, approve, deny). Estado 100% em memória do processo, nunca em disco.
- **coturn**: STUN para descoberta de candidatos e TURN como fallback de relay de mídia quando NAT simétrico impede P2P direto. TURN nunca decifra a mídia (SRTP) nem a camada extra de E2EE.

## 3. Topologia de chamada: mesh completo (full-mesh)

Com o teto de **6 participantes**, mesh é a escolha correta e deliberada — **não** um SFU:

| Critério | Mesh (escolhido) | SFU |
|---|---|---|
| Servidor vê fluxos de mídia | Não (só relay opaco via TURN, se necessário) | Sim (decifra SRTP para rotear) |
| Infra adicional | Nenhuma (só sinalização + TURN) | Precisa de servidor de mídia dedicado |
| Custo de banda no cliente | O(n-1) uploads simultâneos | O(1) upload |
| Viável para 6 participantes | Sim (5 conexões de saída por peer, testado na prática até ~6-8) | — |
| Alinhado com "privacidade total" | Sim — nenhum componente central vê conteúdo | Não — SFU é um MITM funcional de mídia |

Cada cliente mantém `n-1` `RTCPeerConnection`s (até 5). O limite de 6 é **hard cap** aplicado tanto no client quanto no signaling server, porque custo de banda de upload cresce O(n) por participante e CPU de encode/decode cresce junto — acima disso a experiência degrada e a proposta deixa de ser mesh.

## 4. Sinalização efêmera (Node.js)

- Protocolo: WebSocket (`ws`), sem Socket.IO (evita overhead de reconexão/rooms que não precisamos e reduz superfície).
- Estado: um único `Map<roomId, RoomState>` em memória do processo. `RoomState` contém apenas: lista de conexões WS ativas, identificadores efêmeros de participante (UUID gerado no client, descartado ao sair) e nomes de exibição (não persistidos, não associados a identidade real).
- **Nada é gravado em disco.** Sem banco, sem Redis, sem arquivo de log com conteúdo de sinalização (SDP/ICE não são logados — no máximo eventos operacionais agregados tipo "sala X: 3 participantes", sem payload).
- Ciclo de vida da sala: criada no primeiro `join`, destruída (removida do `Map`) no momento em que o último participante desconecta. Não existe sala "agendada" ou persistente — o servidor não sabe que uma sala existirá até alguém entrar.
- Mensagens trafegadas: `join-request`, `join-approved`, `join-denied`, `offer`, `answer`, `ice-candidate`, `peer-left`, `pubkey-announce` (ver E2EE). O servidor é um **relay cego** — não interpreta SDP/ICE, apenas encaminha para o destinatário correto pelo `roomId` + `peerId`.
- Transporte: WSS obrigatório (TLS), nunca WS puro em produção.
- Rate limiting simples em memória por IP/conexão para mitigar flood de `join-request` (proteção operacional, não armazenamento de dados de usuário).

## 5. Fluxo de entrada com aprovação (controle social de acesso)

1. Criador gera um `roomId` (aleatório, alta entropia, ex. UUID v4) e compartilha o link fora de banda (o próprio app não tem diretório de salas).
2. Novo participante conecta ao WS e envia `join-request { displayName }`.
3. Servidor faz broadcast do `join-request` a todos os peers **já admitidos** na sala (não existe "host" fixo — qualquer participante presente pode aprovar, reforçando o modelo descentralizado de confiança; opcionalmente pode-se restringir a aprovação ao criador original, configurável).
4. Qualquer participante presente responde `join-approved` ou `join-denied`. Critério simples: **maioria simples** dos presentes, ou **primeiro a responder** (mais simples, menos "comitê" — recomendado para v1: primeiro a responder decide, com timeout de 30s = deny automático).
5. Se aprovado, o servidor libera troca de SDP/ICE entre o novo peer e todos os já presentes (novo peer estabelece conexão com cada um — mesh).
6. Se negado ou timeout, a conexão WS do solicitante é encerrada e nenhum dado de sala é exposto a ele.

Isso significa que o servidor de sinalização nunca decide sozinho quem entra — ele só medeia a decisão social entre humanos já na sala.

## 6. E2EE adicional (além de DTLS-SRTP)

WebRTC já cifra mídia em trânsito via SRTP com chaves DTLS negociadas fim-a-fim entre os peers — **mas** quando o TURN precisa fazer relay (NAT simétrico), o TURN relaya os pacotes SRTP sem decifrar. Ou seja, tecnicamente o TURN self-hosted já não vê conteúdo. O requisito de E2EE adicional serve para:

- Garantir por **defesa em profundidade** que mesmo um bug/downgrade na negociação DTLS, ou um TURN comprometido, não exponha mídia em claro.
- Permitir **verificação de segurança visível ao usuário** (estilo Signal/WhatsApp), aumentando a confiança do usuário na privacidade "ponta a ponta" percebida.

### Mecanismo escolhido: WebRTC Encoded Transform (Insertable Streams) + SFrame-like framing

1. Ao entrar na sala, cada participante gera um par de chaves **ECDH efêmero** (Curve25519) no browser (Web Crypto API).
2. As chaves públicas são anunciadas via o canal de sinalização (`pubkey-announce`) — o servidor apenas repassa, nunca vê a chave privada.
3. Cada par de participantes deriva um **segredo compartilhado par-a-par** via ECDH, usado com HKDF para derivar uma chave AES-GCM por par de peers (chave de quadro/"frame key").
4. Essa chave é usada para cifrar cada frame de áudio/vídeo **antes** de entrar no pipeline SRTP, usando a API `RTCRtpScriptTransform` / `createEncodedStreams()` (Insertable Streams). O SRTP então cifra novamente por cima (dupla camada).
5. No lado receptor, o processo inverso decifra a camada E2EE após o SRTP nativo remover sua própria camada.
6. **Verificação de segurança (opcional, recomendado v1.1)**: exibir um código curto (SAS — Short Authentication String) derivado do hash combinado das chaves públicas de todos os participantes, para verificação visual/verbal fora de banda, prevenindo MITM na troca de chaves via sinalização.
7. Ao entrar um novo participante, as chaves de par são renegociadas (novo ECDH com o recém-chegado); ao sair, sua chave é descartada — não há "chave de sala" única de longa duração compartilhada por todos, e sim N-1 segredos por peer, minimizando blast radius.

Isso é essencialmente uma implementação simplificada do padrão usado por Google Meet E2EE / Zoom E2EE (que também usam Insertable Streams + MLS/ratchet). Para v1, ECDH par-a-par com HKDF é suficiente e muito mais simples que implementar MLS completo; pode evoluir para MLS se o produto crescer além de 6 participantes.

## 7. coturn self-hosted (STUN/TURN)

- STUN: usado para ICE candidate discovery (self-hosted, elimina dependência de `stun.l.google.com`).
- TURN: fallback de relay quando P2P direto falha (NAT simétrico / firewalls corporativos). Sempre necessário ter, mesmo em mesh, para os ~10-20% de casos de rede restritiva.
- **Credenciais efêmeras via TURN REST API** (shared secret + HMAC, TTL curto, ex. 1h) — nunca usuário/senha estático, nunca persistido.
- Forçar **TURN sobre TLS (porta 5349, `turns:`)** como opção para disfarçar tráfego de mídia como HTTPS genérico em redes hostis.
- coturn não decifra SRTP nem a camada E2EE — atua só como bit-relay. Isso deve ser validado explicitamente em testes (garantir que `relay` mode está ativo, sem `--use-auth-secret` vazado, sem logging de payload).
- Deploy: container Docker dedicado, sem volumes persistentes de log de conteúdo (só logs operacionais mínimos, rotacionados, sem payload de mídia — que aliás o coturn nunca vê em claro).

## 8. Frontend (React + TypeScript)

Estrutura sugerida (monorepo):

```
apps/
  web/                     # React + TS + Vite
    src/
      features/
        room/              # criação/entrada de sala, lobby de aprovação
        call/               # grid de vídeo, controles (mute, câmera, sair)
        e2ee/               # Web Crypto: ECDH, HKDF, Insertable Streams transform
      lib/
        signaling-client.ts # wrapper fino sobre WebSocket
        webrtc-mesh.ts      # gestão de N RTCPeerConnections
      state/                # Zustand ou Context — só em memória, sem persistência
  signaling-server/         # Node.js + ws, TypeScript
    src/
      rooms.ts              # Map em memória, TTL de limpeza
      handlers/             # join, approve, offer/answer/ice relay
infra/
  coturn/
    turnserver.conf
    docker-compose.yml
```

- Sem `localStorage`/cookies persistentes para dados de sessão; no máximo `sessionStorage` para o nome de exibição escolhido (limpo ao fechar a aba).
- Sem analytics/telemetria de terceiros (contra o requisito de zero dependência externa e privacidade).
- Grid de vídeo simples (CSS grid responsivo até 6 tiles), sem gravação local nem screenshot automatizado.

## 9. Modelo de ameaças (resumo)

**Protegido:**
- Conteúdo de áudio/vídeo contra o operador do TURN e contra o servidor de sinalização (E2EE + SRTP).
- Persistência: não há dado para vazar depois, porque nada é gravado.
- Entrada não autorizada em sala: mitigada pelo fluxo de aprovação social.

**Não totalmente protegido (documentar como limitação conhecida):**
- Metadados de sinalização (quem entrou em qual `roomId`, quando) trafegam pelo servidor de sinalização em trânsito — mitigado por não persistir, mas um servidor comprometido *em tempo real* poderia observar esses metadados (não o conteúdo).
- IPs dos participantes são visíveis entre si via ICE (inerente a WebRTC P2P) e ao TURN quando em relay — mitigável parcialmente forçando "relay-only" mode para esconder IP real de participantes entre si, com custo de sempre passar pelo TURN (trade-off privacidade vs. banda/latência — deixar como opção configurável por sala, "modo IP oculto").
- Verificação de identidade dos participantes é apenas visual/social (nome de exibição) — sem PKI de identidade real, por design (é anônimo por padrão).

## 10. Decisões-chave (ADR resumido)

| Decisão | Escolhida | Alternativa rejeitada | Motivo |
|---|---|---|---|
| Topologia | Mesh P2P | SFU | SFU decifraria mídia centralmente; contra "privacidade total" |
| Sinalização | WS puro em Node, estado em memória | Socket.IO / Redis pub-sub | Menos dependências, sem persistência acidental via Redis |
| Persistência | Nenhuma (in-memory, TTL = vida da sala) | SQLite/Postgres para histórico de salas | Requisito explícito de zero persistência |
| STUN/TURN | coturn self-hosted | STUN público Google / TURN gerenciado (Twilio, Xirsys) | Zero infraestrutura de terceiros |
| E2EE | ECDH par-a-par + Insertable Streams | MLS completo | Suficiente para 6 participantes, muito menor complexidade de implementação |
| Aprovação de entrada | Primeiro presente a responder decide (timeout = deny) | Host fixo único / votação por maioria | Simplicidade v1; sem SPOF de "host"; evoluível depois |
| Cap de participantes | 6, hard-coded client+server | Ilimitado | Acima disso, mesh degrada (banda O(n²)) |

## 11. Próximos passos sugeridos (para a fase de implementação)

1. Scaffold do `signaling-server` (Node + TS + `ws`) com handlers de `join-request`/`approve`/`deny`/relay de SDP-ICE e limpeza de sala por TTL/desconexão.
2. Scaffold do `apps/web` (Vite + React + TS): tela de criar/entrar em sala, lobby de aprovação, grid de chamada.
3. Módulo `webrtc-mesh.ts`: gestão de N `RTCPeerConnection`, renegociação ao entrar/sair participante.
4. Módulo `e2ee`: geração de chaves ECDH, HKDF, `RTCRtpScriptTransform` para cifrar/decifrar frames.
5. `infra/coturn`: `turnserver.conf` com TURN REST API (shared secret), TLS habilitado, docker-compose.
6. Testes manuais de rede: NAT simétrico forçando uso de TURN, verificar que mídia segue cifrada (E2EE) mesmo em relay.
7. (Opcional v1.1) SAS de verificação de segurança visível na UI.

---

*Este documento cobre as decisões de arquitetura. A implementação de código (scaffolding dos três componentes) é o próximo passo, a cargo do time de desenvolvimento.*
