# Changelog

Todas as mudancas relevantes deste projeto serao documentadas neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
e o projeto adere ao [Versionamento Semantico](https://semver.org/lang/pt-BR/).

## [Unreleased]

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
