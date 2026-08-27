import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server, type Socket } from 'socket.io';
import { RoomStore, MAX_PARTICIPANTS } from './rooms.js';
import { fetchCloudflareIceServers, isTurnConfigured } from './turnCredentials.js';
import { initTelemetry } from './telemetry.js';
import { parseBeacon } from './telemetryEvents.js';
import 'dotenv/config';

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const allowedOrigins = CLIENT_ORIGIN.split(',').map(o => o.trim());
const corsOrigin = allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins;

const rooms = new RoomStore();

/**
 * A telemetria sobe **antes** do primeiro handler, e depois do `RoomStore` —
 * ela lê o store, e não o contrário. Sem `OTEL_EXPORTER_OTLP_ENDPOINT` isto é
 * um no-op absoluto: nenhum `MeterProvider`, nenhum timer, nenhum socket, e um
 * aviso só no boot.
 */
const telemetry = initTelemetry({ snapshot: () => rooms.snapshot() });

const app = express();
app.use(cors({ origin: corsOrigin }));
/**
 * `turn.configured` e `telemetry.enabled` são aditivos: `ok` continua onde
 * estava, e quem só lê `ok` não quebra. Os dois são booleanos puros — não
 * dizem qual token, não validam credencial, não chamam a Cloudflare e, no caso
 * da telemetria, **nunca** dizem para onde as métricas vão nem com que headers.
 * O endpoint do collector e o `OTEL_EXPORTER_OTLP_HEADERS` não aparecem aqui
 * justamente porque este endpoint é público.
 */
app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    turn: { configured: isTurnConfigured() },
    telemetry: { enabled: telemetry.enabled },
  }),
);

/**
 * Short-lived TURN credentials via Cloudflare TURN API — nunca persistidas.
 *
 * Três desfechos, três status. Isto **era** um endpoint que respondia `200
 * {"iceServers": []}` nos três casos, o que tornava um deploy sem
 * `CF_TURN_TOKEN_ID`/`CF_TURN_API_TOKEN` bit-a-bit indistinguível de uma sala
 * saudável — para o client, para um probe externo e para qualquer proxy no
 * caminho. Como o client roda `iceTransportPolicy: 'relay'`, lista vazia é
 * garantia de que nenhuma conexão fecha; anunciá-la como sucesso é a falha
 * silenciosa que esta entrega remove.
 *
 * 503 é "não estou provisionado para servir isto" e 502 é "meu upstream
 * falhou": ações de resposta diferentes, distinguíveis na aba de rede sem
 * ninguém precisar ler log. Nenhuma das mensagens carrega valor de segredo.
 */
app.get('/turn-credentials', async (_req, res) => {
  try {
    const credentials = await fetchCloudflareIceServers();
    if (!credentials) {
      console.error(
        '[turn] /turn-credentials: CF_TURN_TOKEN_ID/CF_TURN_API_TOKEN ausentes — nenhuma conexão vai fechar.',
      );
      return res.status(503).json({
        error: 'turn-unconfigured',
        message: 'Servidor sem credenciais de TURN configuradas.',
      });
    }
    return res.json(credentials);
  } catch (err) {
    console.error(
      '[turn] /turn-credentials: falha no upstream:',
      err instanceof Error ? err.message : err,
    );
    return res.status(502).json({
      error: 'turn-upstream',
      message: 'Falha ao obter credenciais de TURN na Cloudflare.',
    });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin },
});

/**
 * "Já tem gente nesse endereço agora?" — booleano, e nada além disso.
 *
 * Existe para o aviso da Home quando alguém escolhe um endereço personalizado
 * (`/daily`) que já está em uso: sem ele, marcar uma reunião num nome óbvio cai
 * no meio da conversa de outro time, e a única pista é a fila de aprovação
 * deles. Responde `{ occupied }` e mais nada: sem nomes, sem contagem, sem
 * histórico — nada que diga *quem* está lá.
 *
 * Ressalva registrada, porque ela é real: o documento de arquitetura desta
 * entrega (§3.2 e §7) pede para **não** existir endpoint de existência de sala,
 * e `ARCHITECTURE.md` §5 classifica "que um roomId existe" como conhecimento
 * interno do servidor. Com endereços curtos e adivinháveis, isto é, no
 * agregado, um oráculo: varrer uma lista de nomes prováveis diz quais times
 * estão reunidos agora, sem entrar em sala nenhuma. Está aqui porque é item
 * explícito do DoD da WTK-MEET-10, e o commit que o introduz é isolado de
 * propósito — reverter só ele desliga o recurso, e o client trata a falha como
 * "não ocupado" e segue funcionando.
 */
app.get('/rooms/:roomId/occupancy', (req, res) => {
  res.json({ occupied: !rooms.isEmpty(req.params.roomId) });
});

// ─────────────────────────────────────────────────── POST /telemetry
//
// O beacon anônimo do client. Este servidor é o **único** ponto de saída do
// sistema para a stack de monitoramento: o navegador nunca fala com o
// collector. Três razões, todas concretas — o endpoint do collector nunca fica
// no bundle (onde qualquer um o leria no DevTools); o collector nunca vê o IP
// de cada participante (este servidor já o vê, por necessidade técnica de
// manter um WebSocket, então não há observador novo); e o que sai do processo
// continua sendo um formato só, por um cano só.

/** Janela do rate limit. Fixa, e o `Map` inteiro é descartado ao virar. */
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_MINUTE = Number(process.env.TELEMETRY_RATE_LIMIT_PER_MINUTE) > 0
  ? Math.floor(Number(process.env.TELEMETRY_RATE_LIMIT_PER_MINUTE))
  : 120;
/**
 * Teto de chaves por janela. Sem ele, o balde **é** o vazamento de memória:
 * um flood de IPs distintos cresce o `Map` sem limite até a virada da janela.
 * Estourado o teto, o limite passa a valer globalmente até a próxima virada —
 * mais restritivo, nunca menos.
 */
const RATE_LIMIT_MAX_KEYS = 10_000;

let rateWindowStartedAt = Date.now();
let rateBuckets = new Map<string, number>();
let rateWindowOverflowed = false;

/**
 * Agrupa o IP sem individualizar: IPv4 → /24, IPv6 → /48.
 *
 * O valor devolvido **nunca** vai para log, nunca vira atributo de métrica e
 * nunca sai do processo — ele só existe como chave de um `Map` que é jogado
 * fora a cada minuto. Truncar dá agrupamento suficiente para limitar sem
 * transformar o rate limit num registro de quem acessou.
 *
 * Nota honesta que precisa estar aqui: o servidor **não** habilita
 * `trust proxy`. Atrás de um reverse proxy, `req.ip` é o IP do proxy e o
 * limite degrada para um balde **global** — mais restritivo, nunca menos. Isso
 * é preferível a ler `X-Forwarded-For`, que é falsificável e que
 * reintroduziria o IP real do usuário num caminho de código novo.
 */
export function truncateIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  // `::ffff:1.2.3.4` é como o Node entrega um IPv4 num socket dual-stack.
  const bare = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (bare.includes('.')) return bare.split('.').slice(0, 3).join('.');
  return bare.split(':').slice(0, 3).join(':');
}

/** `true` quando o beacon deve ser barrado. Avança o balde da janela corrente. */
function overRateLimit(ip: string | undefined): boolean {
  const now = Date.now();
  if (now - rateWindowStartedAt >= RATE_WINDOW_MS) {
    rateWindowStartedAt = now;
    rateBuckets = new Map();
    rateWindowOverflowed = false;
  }
  if (rateWindowOverflowed) return true;

  const key = truncateIp(ip);
  const used = (rateBuckets.get(key) ?? 0) + 1;
  if (!rateBuckets.has(key) && rateBuckets.size >= RATE_LIMIT_MAX_KEYS) {
    rateWindowOverflowed = true;
    return true;
  }
  rateBuckets.set(key, used);
  return used > RATE_LIMIT_PER_MINUTE;
}

const telemetryRouter = express.Router();

telemetryRouter.post(
  '/',
  /**
   * `type: () => true` — aceita **qualquer** Content-Type, e valida o conteúdo.
   *
   * Não é frouxidão: é o que faz os três caminhos reais caírem no mesmo lugar.
   * O `sendBeacon` do client manda `text/plain;charset=UTF-8` de propósito (é
   * CORS-safelisted, então não gera preflight — e no `pagehide`, com a aba
   * morrendo, um preflight frequentemente não completa e o beacon some em
   * silêncio). E a receita de verificação do README usa `curl -d` sem header,
   * que manda `application/x-www-form-urlencoded`: com o parser default o
   * corpo chegaria vazio e a receita responderia 400.
   *
   * Consequência de segurança, e por que ela é aceitável: um endpoint que
   * aceita qualquer tipo, sem preflight, é chamável por qualquer página da
   * internet. O que se pode fazer com isso é incrementar um contador agregado
   * — não há estado, não há sessão, não há efeito colateral. O limite de 1 kB
   * e o rate limit acima cuidam do resto, e o README diz com todas as letras
   * que estes números são falsificáveis por construção.
   */
  express.json({ limit: '1kb', type: () => true }),
  (req, res) => {
    if (overRateLimit(req.ip)) {
      telemetry.recordBeacon('rejected');
      // Sem corpo: não há nada a dizer que o cliente possa usar, e o enum de
      // `outcome` é fechado em accepted|rejected — 429 conta como `rejected`.
      return res.status(429).end();
    }

    const beacon = parseBeacon(req.body);
    if (!beacon) {
      telemetry.recordBeacon('rejected');
      // A mensagem **não** ecoa o corpo recebido, de propósito.
      return res.status(400).json({ error: 'invalid-beacon' });
    }

    if (beacon.event === 'page_view') telemetry.recordPageView(beacon.route);
    else telemetry.recordClientSession(beacon.durationMs);

    telemetry.recordBeacon('accepted');
    return res.status(204).end();
  },
);

/**
 * Handler de erro **da rota**, e não global.
 *
 * O `express.json` rejeita com `SyntaxError` (JSON malformado) ou
 * `entity.too.large` (acima de 1 kB). Sem este handler, o default do Express
 * loga o erro no stderr — e a mensagem do body-parser **inclui um trecho do
 * corpo recebido**. É o vazamento mais provável desta entrega, e ele mora no
 * caminho de erro, que é justamente o que ninguém olha. Aqui não se loga nada.
 *
 * Montado no router, e não com `app.use`, para não espalhar comportamento novo
 * por `/turn-credentials` e `/rooms/:id/occupancy`, que hoje não parseiam corpo.
 */
telemetryRouter.use(
  (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    telemetry.recordBeacon('rejected');
    const tooLarge = (err as { type?: string })?.type === 'entity.too.large';
    return res
      .status(tooLarge ? 413 : 400)
      .json({ error: tooLarge ? 'payload-too-large' : 'invalid-beacon' });
  },
);

app.use('/telemetry', telemetryRouter);

/** Um pedido de entrada aguardando decisão. Nunca escrito em lugar durável. */
interface PendingJoin {
  roomId: string;
  displayName: string;
}

/** `requesterSocketId` → pedido pendente. Só quem espera aprovação. */
const pendingJoins = new Map<string, PendingJoin>();

/**
 * O que o client manda no `join-request`. Nada aqui é confiável: os dois campos
 * são validados antes de qualquer uso, e é por isso que chegam como `unknown`.
 */
interface JoinRequestPayload {
  roomId?: unknown;
  displayName?: unknown;
}

function sanitizeDisplayName(name: unknown): string {
  if (typeof name !== 'string') return 'Guest';
  const trimmed = name.trim().slice(0, 40);
  return trimmed.length > 0 ? trimmed : 'Guest';
}

io.on('connection', (socket) => {
  socket.on('join-request', ({ roomId, displayName }: JoinRequestPayload = {}) => {
    if (typeof roomId !== 'string' || roomId.length === 0) {
      socket.emit('join-denied', { reason: 'invalid-room' });
      // Todo `record*` é síncrono, total e chamado **depois** dos `emit` deste
      // handler. A ordem observável dos eventos é o que `test/signaling.test.ts`
      // caracteriza, e telemetria não pode participar dela.
      telemetry.recordJoin('invalid_room');
      return;
    }
    const name = sanitizeDisplayName(displayName);

    if (rooms.isFull(roomId)) {
      socket.emit('join-denied', { reason: 'room-full' });
      telemetry.recordJoin('room_full');
      return;
    }

    if (rooms.isEmpty(roomId)) {
      // First person in — they *are* the room, no approval needed.
      admitToRoom(socket, roomId, name);
      telemetry.recordJoin('admitted');
      return;
    }

    // Daqui para baixo o desfecho ainda não existe: o pedido vai para a fila de
    // aprovação. `wtk_joins_total` conta **desfechos**, não tentativas — quem
    // desiste na fila não aparece em nenhum deles, e essa lacuna é declarada no
    // README, não um esquecimento.

    pendingJoins.set(socket.id, { roomId, displayName: name });
    const approvers = rooms.members(roomId);
    for (const [approverSocketId] of approvers) {
      io.to(approverSocketId).emit('join-request', {
        requesterId: socket.id,
        displayName: name,
      });
    }
  });

  socket.on('approve-join', ({ requesterId }: { requesterId?: string } = {}) => {
    const pending = requesterId ? pendingJoins.get(requesterId) : undefined;
    if (!pending || !requesterId) return; // already handled or expired

    const approverRoom = rooms.findRoomOf(socket.id);
    if (approverRoom !== pending.roomId) return; // spoofed/stale approval

    if (rooms.isFull(pending.roomId)) {
      io.to(requesterId).emit('join-denied', { reason: 'room-full' });
      cancelPendingJoin(requesterId, pending.roomId);
      telemetry.recordJoin('room_full');
      return;
    }

    const requesterSocket = io.sockets.sockets.get(requesterId);
    if (!requesterSocket) {
      // Requester disconnected while waiting: nobody is coming in, so the
      // approval prompt has to come down on every screen showing it.
      cancelPendingJoin(requesterId, pending.roomId);
      return;
    }

    pendingJoins.delete(requesterId);
    admitToRoom(requesterSocket, pending.roomId, pending.displayName);
    telemetry.recordJoin('approved');
  });

  socket.on('deny-join', ({ requesterId }: { requesterId?: string } = {}) => {
    const pending = requesterId ? pendingJoins.get(requesterId) : undefined;
    if (!pending || !requesterId) return;
    const approverRoom = rooms.findRoomOf(socket.id);
    if (approverRoom !== pending.roomId) return;

    cancelPendingJoin(requesterId, pending.roomId);
    io.to(requesterId).emit('join-denied', { reason: 'denied' });
    telemetry.recordJoin('denied');
  });

  socket.on('signal', ({ to, data }: { to?: unknown; data?: unknown } = {}) => {
    if (typeof to !== 'string') return;
    const myRoom = rooms.findRoomOf(socket.id);
    const targetRoom = rooms.findRoomOf(to);
    if (!myRoom || myRoom !== targetRoom) return; // only relay within same room
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('leave-room', () => {
    leaveCurrentRoom(socket);
  });

  socket.on('disconnect', () => {
    const pending = pendingJoins.get(socket.id);
    if (pending) cancelPendingJoin(socket.id, pending.roomId);
    leaveCurrentRoom(socket);
  });
});

/**
 * Drops a pending join and tells the room to stop asking about it.
 *
 * Approval is a modal on every member's screen, so a request that can no longer
 * be granted — the requester gave up, closed the tab, or someone else already
 * decided — must be retracted explicitly. Without this the modal would sit there
 * forever with a button that silently does nothing.
 *
 * Only membership metadata travels here: an id that is already public inside the
 * room, and no name, no room contents.
 */
function cancelPendingJoin(requesterId: string, roomId: string): void {
  pendingJoins.delete(requesterId);
  for (const [memberSocketId] of rooms.members(roomId)) {
    io.to(memberSocketId).emit('join-request-cancelled', { requesterId });
  }
}

function admitToRoom(socket: Socket, roomId: string, displayName: string): void {
  const existingMembers = rooms.members(roomId);
  rooms.addMember(roomId, socket.id, displayName);
  socket.join(roomId);

  socket.emit('join-approved', {
    selfId: socket.id,
    members: existingMembers.map(([id, info]) => ({ id, displayName: info.displayName })),
    maxParticipants: MAX_PARTICIPANTS,
  });

  socket.to(roomId).emit('peer-joined', { peerId: socket.id, displayName });
}

function leaveCurrentRoom(socket: Socket): void {
  const roomId = rooms.findRoomOf(socket.id);
  if (!roomId) return;

  // Lidos **antes** da remoção: `removeMember` deleta a sala quando ela esvazia,
  // e com ela a contabilidade. Depois não há de onde derivar nem a duração da
  // sessão nem o tempo de vida da sala.
  const joinedAt = rooms.memberJoinedAt(roomId, socket.id);
  const stats = rooms.roomStats(roomId);

  rooms.removeMember(roomId, socket.id);
  socket.leave(roomId);
  socket.to(roomId).emit('peer-left', { peerId: socket.id });

  // Depois dos `emit`, sempre. Nada aqui pode lançar (ver `telemetry.ts`), mas
  // a ordem é contrato de qualquer forma.
  const now = Date.now();
  if (joinedAt !== null) telemetry.recordSessionEnd(now - joinedAt);
  // `isEmpty` **depois** da remoção é a pergunta "a sala deixou de existir?".
  // O pico vem do snapshot lido antes, que é o único lugar onde ele ainda vive.
  if (stats && rooms.isEmpty(roomId)) {
    telemetry.recordRoomClosed(now - stats.openedAt, stats.peak);
  }
}

server.listen(PORT, () => {
  console.log(`wtk-meet signaling server listening on :${PORT} (in-memory only, no persistence)`);
  // O aviso é no boot, e não na primeira requisição, porque é no boot que
  // alguém está olhando: subir sem TURN não degrada o produto, desliga-o
  // inteiro (sob `relay` não há plano B), e descobrir isso pelo relato de um
  // usuário custa uma reunião.
  if (!isTurnConfigured()) {
    console.warn(
      '[turn] ATENÇÃO: CF_TURN_TOKEN_ID/CF_TURN_API_TOKEN não configurados. ' +
        'O client usa iceTransportPolicy:"relay" — sem TURN, NENHUMA chamada vai conectar. ' +
        '/turn-credentials responderá 503 e /health reportará turn.configured:false.',
    );
  }
});

/**
 * Saída limpa, com prazo.
 *
 * O reader tem até alguns segundos para empurrar o último intervalo de
 * contadores; passado isso, o processo morre de qualquer jeito. Um
 * `shutdown()` que **espere** um collector fora do ar deixaria o container
 * pendurado até o `SIGKILL` do orquestrador — perder até um minuto de
 * contadores é barato, um deploy que demora para morrer não é.
 */
let shuttingDown = false;
function gracefulShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  io.close();
  server.close();
  telemetry.shutdown().finally(() => process.exit(0));
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
