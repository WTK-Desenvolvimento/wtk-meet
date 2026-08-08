# wtk-meet

Sala de chamada em WebRTC com cinco coisas que a maioria das implementações
caseiras erra.

```bash
npm install
npm run dev       # http://localhost:5173
```

Abra duas abas, entre com nomes diferentes na mesma sala. `localhost` é origem
segura — câmera e microfone funcionam sem HTTPS.

## O que tem aqui

- **Halo azul reativo ao volume** — a intensidade acompanha o nível de áudio de
  forma contínua, com ondas e partículas. A 60 fps sem re-render, e com o
  analisador desligado quando ninguém fala.
- **Compartilhamento de tela** — tile próprio (câmera continua visível), um por
  vez com trava no servidor, e encerrar pelo botão nativo do navegador funciona.
- **Chat efêmero** — nada persiste, quem chega depois não vê o passado, texto
  renderizado sem uma única linha de `innerHTML`.
- **Câmera que desliga de verdade** — `track.stop()`, o LED do dispositivo apaga.
  Religar reabre o mesmo `deviceId`.
- **Avisos de entrada e saída** — modal na entrada, toast na saída, sons
  sintetizados e silenciáveis, com debounce que ignora oscilação de rede.

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de signaling + app (serve o fonte direto) |
| `npm run build` | Bundle de produção em `dist/` |
| `npm run preview` | Build + servidor servindo `dist/` |
| `npm test` | 165 testes (lógica pura, protocolo, módulos de navegador, chamada ponta a ponta) |
| `npm run lint` | ESLint |

## Documentação

- [`docs/ARQUITETURA-MIDIA.md`](docs/ARQUITETURA-MIDIA.md) — stack, mapa de
  arquivos, decisões e pontos de extensão de cada feature.
- [`docs/TESTE-MANUAL.md`](docs/TESTE-MANUAL.md) — roteiro de verificação com 2+
  navegadores.
- [`docs/architecture.md`](docs/architecture.md) — a análise que precedeu a
  implementação.

## Antes de expor na internet

Só STUN (sem TURN), sem autenticação de sala, sem HTTPS no servidor embutido e
topologia mesh — que satura acima de ~5 participantes. Os limites estão listados
na seção 9 do documento de arquitetura.
