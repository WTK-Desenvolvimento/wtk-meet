# Changelog

Todas as mudancas relevantes deste projeto serao documentadas neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
e o projeto adere ao [Versionamento Semantico](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Adicionado

- Soundboard: painel recolhivel a esquerda com favoritos locais
  (`localStorage`, chave `wtk-meet:soundboard`, ate 50 itens com titulo
  editavel) e disparo de efeitos para a sala inteira, sem votacao. O audio e
  mixado no canal de musica de quem dispara e sobe pelo transceiver ja
  negociado — sem `replaceTrack` por disparo e sem renegociacao de SDP.
- Rate limit do soundboard de 3 disparos por 5s por participante, aplicado no
  envio e na recepcao; um efeito por vez, com corte em 15s.
- Mute local do soundboard, global ou por participante: a escolha vale so para
  quem ouve e nunca trafega pelo data channel.
- Recusa visivel para URL sem CORS (sonda `Range: bytes=0-0` antes de mixar),
  no lugar do silencio digital sem erro.

### Corrigido

- Pagina em branco causada por duas copias de React no bundle
  (`resolve.dedupe` no Vite).

## [1.1.0] - 2026-08-27

### Adicionado

- Videochamadas em grupo (ate 6 participantes) via mesh P2P WebRTC.
- Camada extra de E2EE (AES-GCM-256) sobre DTLS-SRTP nativo.
- Sala de espera com aprovacao de entrada pelos participantes.
- Chat em tempo real via RTCDataChannel (P2P, sem passar pelo servidor).
- Compartilhamento de tela com layout spotlight.
- Player de musica colaborativo (arquivo local, URL, YouTube).
- Supressao de ruido client-side.
- Selecao de dispositivos (camera, microfone, saida de audio).
- Servidor de sinalizacao efemero (sem persistencia).
- Credenciais TURN efemeras via Cloudflare.

[Unreleased]: https://github.com/WTK-Desenvolvimento/wtk-meet/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/WTK-Desenvolvimento/wtk-meet/releases/tag/v1.1.0
