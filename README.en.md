> 🌐 [Versão em português](README.md)

# wtk-meet

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/WTK-Desenvolvimento/wtk-meet/actions/workflows/ci.yml/badge.svg)](https://github.com/WTK-Desenvolvimento/wtk-meet/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg)](https://nodejs.org/)

Group video calls (up to 6 people) over a P2P WebRTC mesh, with an extra layer of
E2EE on top of native DTLS-SRTP. Nothing that happens in a call is recorded — the
only preference that survives the tab is which camera/microphone/output you chose to
use (see below). No third-party infrastructure: self-owned signaling (Node.js) and
self-hosted STUN/TURN (coturn).

See `ARCHITECTURE.md` for architecture decisions and trade-offs.

## Running locally

**Requires Node.js >= 22.18** (or >= 24). The source code is TypeScript and runs
without a build step during development and testing: types are erased by Node's native
*type stripping*, which only exists from that version onward. On Node 20, neither
`npm test` nor `node e2e/run.ts` work. Only the **production artifact** is compiled
(`npm run build` on the server, `vite build` on the client) — and then any Node 20+
can run the `dist/`.

### 1. Signaling server

```bash
cd packages/server
cp .env.example .env
cd ../..
npm install
npm run dev:server     # runs src/index.ts directly, with --watch
```

Listens on `http://localhost:4000`. State is 100% in-memory — restarting the process
clears all rooms.

To run as in production — which is what the container and E2E do:

```bash
npm run build:server   # tsc → dist/
npm -w wtk-meet-server start
```

### 2. Client

```bash
cd packages/client
cp .env.example .env
cd ../..
npm run dev:client
```

Opens at `http://localhost:5173`.

### 3. TURN — **required**, even on `localhost`

The client runs with `iceTransportPolicy: 'relay'` (a privacy decision: no local IP
leaks between participants — see `ARCHITECTURE.md` §5 and §6.1). The consequence is
that **TURN is not a fallback, it is the only path**: without an accessible TURN server
the browser generates *no* candidates — not host, not srflx — and no connection
completes, not even between two tabs on the same machine. There is no degraded mode.

The signaling server does not host TURN: it issues **ephemeral credentials** via the
Cloudflare TURN API and delivers them at `GET /turn-credentials`. No credential is
baked into the client bundle.

```bash
# packages/server/.env
CF_TURN_TOKEN_ID=...      # required
CF_TURN_API_TOKEN=...     # required — never appears in logs or responses
CF_TURN_TTL=3600          # optional: credential validity, in seconds
CF_TURN_TIMEOUT_MS=5000   # optional: timeout for the Cloudflare call
```

| Variable | Default | Notes |
|---|---|---|
| `CF_TURN_TOKEN_ID` | — | Without it, `/turn-credentials` responds **503** and `/health` reports `turn.configured: false`. |
| `CF_TURN_API_TOKEN` | — | Same. Redacted (`***`) in any error message or log line. |
| `CF_TURN_TTL` | **3600** (1h) | Clamped to the range `[600, 86400]`, with a log warning when clamping occurs or when the value is invalid. |
| `CF_TURN_TIMEOUT_MS` | **5000** | Without it, an upstream that accepts the connection but never responds would block room entry. |

> **Behavior change:** the default for `CF_TURN_TTL` was **86400 (24h)** and is now
> **3600 (1h)**. `docs/architecture.md` §7 always specified "short TTL, e.g. 1h", and the
> 24h window was precisely what allowed a tab open since yesterday to create new connections
> with an expired credential. The client now renews on its own, so a short TTL costs nothing
> in usability. To restore the old behavior, set `CF_TURN_TTL=86400` in your `.env`.

`GET /turn-credentials` has **three outcomes, three statuses** — never `200` with an empty
list, which was bit-for-bit indistinguishable from a healthy room:

| Status | Body | When |
|---|---|---|
| **200** | `{ iceServers, ttl, expiresAt }` | Credential obtained. `ttl` (seconds) is **authoritative** — the client adds it to its own clock; `expiresAt` is informational. |
| **503** | `{ error: 'turn-unconfigured', … }` | `CF_TURN_TOKEN_ID`/`CF_TURN_API_TOKEN` missing. Capability not provisioned. |
| **502** | `{ error: 'turn-upstream', … }` | Cloudflare responded with a non-OK status, threw, returned an empty list, or timed out. |

`GET /health` responds with `{ ok: true, turn: { configured: boolean } }` — a plain
boolean, without calling Cloudflare and without revealing which token. Starting the server
without the variables prints **one** explicit warning at boot. Quick diagnostics:

```bash
curl -s  localhost:4000/health             # {"ok":true,"turn":{"configured":true}}
curl -si localhost:4000/turn-credentials   # 200 / 503 / 502
```

The full credential lifecycle (client-side renewal, what happens when it expires, and how
a dropped connection recovers) is in `ARCHITECTURE.md` §6.12.

> **Documentation drift, recorded on purpose:** `infra/coturn/` and §7 of
> `docs/architecture.md` describe a self-hosted TURN with TURN REST API (shared secret +
> HMAC, `TURN_SHARED_SECRET`) that **is not the path the code uses** —
> `server/src/turnCredentials.js` talks to Cloudflare. The `infra/coturn/` config remains
> valid as a reference for anyone who wants to self-host (and is what the E2E spins up on
> `127.0.0.1`), but anyone debugging TURN in production should look at the `CF_*` variables
> above, not a `turnserver.conf`. Reconciling the two remains open.

## Call flow

1. The room creator generates the address + 128-bit passphrase in the browser itself — the
   passphrase is never sent to the server, it lives only in the URL fragment (`/:room#key`).
   The address sits at the **root**, with no prefix: either a randomly drawn 9-character slug
   (`/k7m2xq9tp#key`), or one chosen on the spot (`/my-private-room#key`).
2. The link is shared outside the app (message, etc.). Share it **in full**, including the
   part after the `#`: the address alone leads to the right room, but without the key the
   person enters with a different one.
3. Whoever opens the link lands on a **pre-entry screen**: name, self-camera preview, and
   the toggle for joining with the camera on or off — **the default is off**, and nothing
   there connects anything. Only after choosing does the request to join go out; if the room
   already has people, any present participant approves or denies the request. A full room (6)
   rejects automatically.
4. Once approved, WebRTC negotiation (full mesh) begins between the new peer and each
   peer already present. Media never passes through the signaling server.
5. Each connection is born with four send channels — microphone, camera, screen, and music —
   plus an `RTCDataChannel`. All four are always created, even if empty: someone who joins
   with the camera off negotiates the camera channel **with no track inside**, and that is why
   turning the camera on later does not require a new SDP. Toggling the camera, entering/exiting
   screen sharing, and taking over the currently playing track are track swaps on those
   channels, without renegotiating SDP. Those already in the room are notified by a toast with
   a short beep (silenceable) — and see the newcomer's tile in placeholder from the first
   frame, with no video flash and no "camera off" notice: joining with the camera off is not
   a state change.
6. During the call: **screen sharing** puts the room in spotlight mode — the screen takes
   up ~80% of the stage and the cameras (plus other screens) sit in a scrollable side column;
   with more than one screen, each participant locally chooses which one to spotlight by
   clicking the thumbnail. **Text chat** travels P2P over the data channel, and the tile of
   whoever is speaking gets a blue ring reactive to volume.
7. **Music (optional):** the "Music" button opens a room-wide vote; if approved, it unlocks
   a player with a collaborative queue. Any participant adds tracks from a local file, an
   audio URL, or YouTube, and anyone can skip or remove (authorship is visible). The audio
   from a local file is retransmitted through the music channel of whoever added the track —
   the file itself never leaves their machine. Volume is per listener and never transmitted.
8. Each audio/video frame is encrypted with AES-GCM (key derived from the passphrase via
   PBKDF2) before leaving, using Insertable Streams — works fully in Chromium-based browsers;
   in Firefox/Safari the UI warns that only standard WebRTC encryption is active.

### Room address

The link **is** the product: there is no account, room directory, or email invite. That is
why the address lives at the root, in a single segment, and `/room/` no longer exists.

| Path | What it is |
|---|---|
| `/` and `/app` | Home — create a room or paste an invite |
| `/app/*` | Application screens namespace (no child screens yet) |
| `/room/:id#key` | Legacy link: redirects to `/:id#key`, with the fragment intact |
| `/anything-else` | **Room** |

- **Random slug:** 9 characters in base32 without confusable characters
  (`0123456789abcdefghjkmnpqrstvwxyz` — no `i`, `l`, `o`, or `u`), 45 bits. Designed to
  be dictated over the phone without spelling out "is that an L or a one?".
- **Chosen address:** type it in the Home field or directly in the address bar. It is
  normalized, not rejected: `Sala do Nícolas!` becomes `sala-do-nicolas`. Uppercase is
  lowered, accents are stripped, spaces and `_` become hyphens. Up to 64 characters are
  allowed, in `[a-z0-9-]` starting with a letter or digit — beyond that the field warns
  instead of truncating, because a truncated room would be a **different** room.
- **Reserved** (never become rooms): `app`, `room`, `api`, `health`,
  `turn-credentials`, plus the paths nginx serves before the SPA — `assets`,
  `static`, `public`, `favicon-ico`, `robots-txt`, `index-html`, and the like. Paths with
  more than one segment (`/time/daily`) are also not rooms: they redirect to the Home.
- **Opening an address without `#`** — typing `/daily` in the bar and pressing enter — **is**
  creating the room: the client generates the passphrase on the spot and rewrites the URL to
  `/daily#key` with `replace` (the Back button does not go back to the keyless path).
  Consequence to be aware of: two people who open the same address without `#` receive
  **different** keys. They end up in the same signaling room, but with E2EE enabled they
  would not decode each other's video. That is why the link must be shared in full.
- **A short slug does not weaken E2EE.** What protects the call is the 128-bit passphrase,
  which is still born in the client and lives only in the fragment — the server never sees
  it, and shortening the address does not change that. The address is public by nature (the
  server needs it to bring people together); someone who guesses `/daily` still depends on
  the approval of those already in the room to enter, and without the key they would not
  decode the media. A chosen address is easier to guess than a random one — the UI warns.

### What stays out of the server

- **Chat**: no chat event exists on the Socket.IO server. Messages go through the
  `RTCDataChannel` of each mesh connection.
- **History**: exists only in the tab's memory. Reloading the page or leaving the room
  erases the conversation entirely — the chat does not use `localStorage`, `sessionStorage`,
  or any database.
- **Speaking indicator**: audio levels are measured locally with
  `AudioContext` + `AnalyserNode`. No level is transmitted.
- **Camera off / screen on**: announced via the data channel, not the server.
- **Music player**: queue, current track, position, and votes live in the clients and
  travel over the same data channel, with a snapshot for latecomers. No new route or event
  on the server, and nothing in storage — the queue dies with the room.

### Joining the room: the pre-entry screen

Opening a room link **does not turn on the webcam LED**. Whoever arrives without a name
in the session first sees a pre-entry screen with a name field, a mirrored local preview,
the **Join with camera on** toggle, and the Settings button.

- **The factory default is to join with the camera off.** Without a saved preference,
  no `getUserMedia` with video occurs — not in the lobby, not after joining. The
  microphone keeps its usual behavior: you join speaking, not muted.
- **The preview is opt-in.** The camera only opens if the toggle is on, and the lobby
  stream dies upon leaving the screen by any path (joining, navigating, closing). It is
  never handed to the room: the call setup does its own capture.
- **The choice is saved** in `wtk-meet:devices` (field `startCameraOff`) on toggle click,
  not on the Join button — closing the tab before joining does not lose the decision, and
  it applies to future rooms.
- **Reloading the page does not go through the lobby again:** the name is already in
  `sessionStorage` and the preference decides the camera. Same for whoever creates the room
  from the Home — that path enters directly, with the factory default, and the camera is
  turned on via the "Enable camera" button inside the room. (Exposing the toggle in the
  Settings modal, which is reachable from the Home, is future work.)
- If the camera fails to open in the preview, a warning line appears and **nothing is
  blocked**: you can enter as-is and turn on the camera from inside.

### Choosing camera, microphone, and audio output

The **Settings** button opens the same modal in three places: on the Home, on the
waiting screen, and on the room's control bar. It lists devices with system labels,
shows a live video preview and a microphone level meter, and also includes the sound
notifications toggle (which moved out of the control bar).

- Saving during a call swaps the track on all peers via `replaceTrack`, **without
  renegotiating SDP** and without dropping media that did not change. Switching
  microphones while muted does not unmute; switching cameras with the camera off only
  saves the choice, without turning on the LED.
- The choice is saved in `localStorage`, under the key `wtk-meet:devices`
  (`videoInputId`, `audioInputId`, `audioOutputId`, `soundsEnabled`, and
  `startCameraOff` — the latter is the pre-entry screen choice, and defaults to `true`
  when nothing is saved) — and noise
  suppression, below, under `wtk-meet:audio`. **These are the only exceptions to the
  zero-persistence rule** — the rule applies to call content and metadata, not to which
  peripheral of your own equipment to use. Clearing site data erases the preference.
- If the saved device no longer exists (different machine, undocked dock), the call
  opens with the system default **with no on-screen error** and the preference corrects
  itself. Disconnecting a device in use falls back to the default and warns.
- Audio output depends on `setSinkId`: where the browser does not implement it (Firefox
  by default), the selector appears disabled with an explanation. Where it does, the
  choice applies to participant voices **and** to the music player — both go through
  dedicated `<audio>` elements, and the preference is applied to them.

**I can't hear anyone, but they hear me.** Two likely causes, in this order:

1. **Audio output.** If your system default is the monitor speaker, an HDMI output, or a
   paired-but-idle Bluetooth headset, the sound is going there. Choose the right device
   in **Settings → Audio output**.
2. **The browser blocked sound.** This happens when the room is opened without any click
   — reloading the page with the name already filled enters directly. In that case a
   notice appears in the room saying sound was blocked; **clicking it** unblocks
   everyone's voice and the music at once.

If the problem is connection rather than playback, the person's tile says: "No connection"
(`failed`), "Unstable" (`disconnected`), or "Connecting…". A tile with no indicator means
a healthy connection.

### Noise suppression

The same modal includes the **Noise suppression** toggle, **on by default** — fan,
keyboard, and the neighbor's construction stop going along with your voice, without
anyone needing to discover the option.

- The engine is chosen by the browser, not by you: where native suppression exists, it
  is used; where it does not, a project-specific `AudioWorklet` takes over. If the browser
  has neither, the toggle appears disabled with an explanation. The hint below the control
  says which engine is active.
- **Everything happens in your browser.** The audio is processed before encoding:
  no new route, no signaling event, nothing on the data channel, and nothing the server
  sees. No third-party service is involved.
- Toggling during a call does not renegotiate the connection or drop anyone, and does
  not unmute someone who is muted.
- The choice is saved under the key `wtk-meet:audio`, separate from the device choice:
  it describes your **environment**, not your hardware, and therefore is not overwritten
  when a microphone is swapped or disappears.

See `ARCHITECTURE.md` §6 for the design and trade-offs (§6.9 for music, §6.10 for
devices, §6.11 for noise suppression).

### A declared exception: YouTube

Local files and direct URLs work without any third party involved. **YouTube does not.**
Google's player runs in a cross-origin iframe and there is no API that gives access to
its audio, so the track is loaded in **each participant's** browser — and Google gets to
see everyone's IP in the room and what the room is listening to. This contradicts the
"no third-party infrastructure" statement at the top of this README, and that is why the
entire source is gated behind a variable:

```bash
VITE_ENABLE_YOUTUBE=false   # removes the YouTube source from the UI and parser
```

The default is on, with an explicit warning in the UI when adding the first YouTube track
of the session. If the privacy promise is absolute in your deployment, turn it off.

## Tests

```bash
# everything from the root (npm workspaces):
npm test                    # client + server unit tests (node:test)
npm run typecheck           # tsc --noEmit on all three packages
npm run lint                # eslint 9 flat config + typescript-eslint

# E2E (end-to-end: 3 Chromium participants + local TURN):
npm run test:e2e
```

Typechecking is a **separate** gate from the build: `npm run build` on the client does
not run `tsc`, on purpose — the E2E builds the client on every run and should not pay for
it twice. Run `npm run typecheck` before committing.

The E2E spins up a TURN server on `127.0.0.1` (the client uses
`iceTransportPolicy: 'relay'`, so without TURN no connection completes even on loopback),
builds the client pointing at a randomly assigned port, opens three isolated Chromium
contexts with fake camera/microphone, and walks through the full scenario: connect, speak,
share screen (including two at the same time, to exercise glare), exchange messages,
disable/re-enable the camera, switch camera and microphone via the settings modal, and
leave the room. Requires Chromium system dependencies
(`npx playwright install-deps`).

Chromium's fake camera flag exposes **one** device of each type, and there is no flag for
a second — so the harness simulates a device registry (`enumerateDevices`, `devicechange`,
`setSinkId`) on top of it. Without this, "switch camera" would be impossible to run in the
browser.

## Structure

```
tsconfig.base.json       the strict type rigor shared by all three packages (strict: true)
tools/                   module hooks that let `node --test` see TypeScript
packages/server/         signaling (Express + Socket.IO), in-memory state, ephemeral TURN credentials
packages/server/dist/    compiled artifact (`npm run build`) — what the container runs
packages/client/         React app (Vite) — UI, WebRTC mesh, E2EE via insertable streams
packages/client/test/    unit tests
packages/e2e/            end-to-end test with 3 participants
infra/coturn/            reference config for self-hosted STUN/TURN
```

The repository uses **npm workspaces**: `npm install` at the root installs everything at
once. Common commands from the root: `npm test`, `npm run build`, `npm run lint`,
`npm run typecheck`. Only `tsconfig.base.json` is shared, and that is why
`docker compose build` uses the root as its context (see `docker-compose.yml`).

## Contributing

See [CONTRIBUTING.en.md](CONTRIBUTING.en.md) for the full contribution guide
([versão em português](CONTRIBUTING.md)).

## Security

To report vulnerabilities, **do not open public issues**. Follow the instructions in
[SECURITY.md](SECURITY.md).

## License

This project is licensed under the [Apache License 2.0](LICENSE).

Copyright 2024-2026 WTK Desenvolvimento.
