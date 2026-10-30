# @novadeck/wire

RPC calls and streams between processes over a WebSocket or a MessagePort: channels, a client
generic over its contract, its transports, a connection that keeps itself alive and the streams it
follows across it, the server's sessions, transports and streams of state, and its errors. It
carries an oRPC contract it doesn't know: the app's procedures and their codes stay the app's,
beside the wire's own handshake.

## Subpaths

- `.`: what both ends share.
  - `Channel`, a bidirectional message channel (`open`, `send`, `listen`, `closed`, `close`),
    and `socketChannel` and `portChannel` over anything shaped like a WebSocket or a
    MessagePort (`WebSocketLike`, `MessagePortLike`: structural types, so DOM, Node.js, `ws`
    and Electron's ports all fit). Closing a channel here settles `closed` at once, as a port
    only tells its peer and a socket's close event can take a round trip.
  - `WireError`, the error a client reports, with a stable `code` (the wire's or the app's)
    and the contract's `data`; `normalize` turns an oRPC error into one, and `hasCode`
    matches one by code.
  - `wireErrors`, the codes the wire's own server side refuses with, as an oRPC error map
    for the app to spread into its contract's: `UNAUTHORIZED`, `INCOMPATIBLE_PROTOCOL`,
    `RESOURCE_LIMIT`, `CLOSING` (shutting down), `SLOW_CONSUMER`, `INVALID_CURSOR`. The client
    adds `DISCONNECTED` and `CLOSED`, and oRPC `BAD_REQUEST` and `INTERNAL_SERVER_ERROR`
    (`WireErrorCode`).
  - `wireContract`, the wire's own procedure for the app to spread into its contract:
    `wire.handshake({ protocolVersion, token?, clientId? })`, which opens every connection
    and answers `{ epoch, protocolVersion }`.
- `./client`: the client side, for browsers and Node.
  - `createWireClient<C>(channel)`, an oRPC client of contract `C` over a channel. Requests
    fail and streams end as soon as the channel closes. A call in flight when it closes
    fails as `DISCONNECTED`; a stream's pending read, and the call whose send threw, fail
    with oRPC's own error, so a caller that needs the cause asks the channel whether it's
    still open. A channel whose send throws is closed, so whoever holds it replaces it.
  - `connect({ contract, transport, protocolVersion, fatal, retryDelay, timeoutMs, signal })`,
    a supervised connection to a server of `contract` (which has `wireContract` in it),
    resolving after the first handshake. Each new channel's handshake sends `protocolVersion`,
    one `clientId` for every connection of the client (so a server can take over from a
    half-open one) and the transport's token; the server answers its `epoch`, its lifetime,
    which a stream's cursor belongs to, and a server that answers another protocol is
    `INCOMPATIBLE_PROTOCOL`. A connection that drops comes back on its own, after
    `retryDelay(attempt)` (`min(250·2ⁿ, 5000)` ms by default), until `close()` or a fatal
    code: `UNAUTHORIZED`, `INCOMPATIBLE_PROTOCOL`, `CLOSED` and whatever `fatal(code)` adds. A connection or handshake taking longer than `timeoutMs` (10 s) fails;
    the transport hears of it through its signal, and must give up when that aborts.
    The `Wire` it gives has:
    - `status`, the `WireStatus` as a `Watching` value: `connected` in an epoch,
      `reconnecting` with the error that dropped it, or `closed`, with why if it wasn't
      asked to;
    - `session()`, the live `{ client, epoch, channel }`, for calls that must not wait: it
      throws `DISCONNECTED` while reconnecting and why it closed (or `CLOSED`) once closed,
      and never queues;
    - `ready()`, which waits for a live session, and `close()`.
  - `follow(wire, { open, resume, gone })`, a stream followed across the connection's
    sessions, which its reader sees as one. `open(client, { after, signal })` opens it on a
    session. It resumes one of two ways:
    - from a cursor (`{ cursor, ack }`): a new session's stream picks up after the last item
      read (`after`), unless the epoch changed or the server refused the reader as too slow
      (`SLOW_CONSUMER`), which start it afresh. Each item counts as read once the next is
      asked for, and `ack` tells the server, one acknowledgement in flight at a time, a
      refused one retried after 50 ms. Its first stream opens on the live session or fails.
      Once it has yielded, only a lost connection is resumed: any other failure, or why the
      connection closed, ends it, thrown to the reader;
    - by starting over (`{ restart: true, reset, holdReset }`): each stream it opens says
      `reset` first, so the reader replaces what it has with what follows, up to its own
      marker (such as `synced`). With `holdReset`, `reset` waits for a stream opened again to
      yield its first item, and the first stream has none. It never throws: a lost connection or
      a closing server (`CLOSING`) is followed to the next session, and any other refusal is
      retried after `min(200·2ⁿ, 3000)` ms.

    For a restarting stream, `gone(error)` says its subject was removed, which ends it. One
    that can lose its subject is opened again as soon as its server ends it, to learn whether
    it's still there; one that can't is opened again on the next session. The `Following` it
    gives says which `session` its stream is open on, and why it `finished`: `ended` by the server,
    `stopped` by `return()` or the connection's close, or `failed`.

  - `Watching<T>`, a value and its changes, read-only: `value`, `next()` for the next change,
    and `watch()`, which yields the latest value after each change, coalescing quick ones,
    until a final one.
  - `Transport`, how a client opens a channel (`connect(signal)`) and the token it sends in
    its handshake, if any. `websocket(url, { token })` reaches a server deployed on its own,
    the token kept out of the URL; `messagePort(port)` reaches one bundled with the app, which
    hands it a port. A single port connects once; pass a function that asks for a fresh port
    to reconnect. `brokeredPort({ request, message, lateAnswerMs })` is such a transport for a
    page in Electron's renderer: `request(id)` asks the main process (through what the
    preload exposes), and the port comes back as a window message `{ type: message, id }`. A port that answers a
    request given up on is closed, if it comes within `lateAnswerMs`.
- `./electron` (Node only: Electron's main process and preload): the other side of
  `brokeredPort`, with `electron` as an optional peer.
  - `brokerPorts({ channel, allow, deliver })`, in the main process: a page that asks on the
    IPC `channel` (and that `allow` lets ask: a port is whatever access the service gives)
    gets one end of a fresh `MessageChannelMain` under its request id; `deliver` hands the
    other end to the service, or returns false while there's none, and the request is
    dropped.
  - `relayPorts({ channel, message })`, in the preload: ports can't cross the context bridge,
    so it relays each one to the page as a window message, and returns the request function
    for the bridge to expose.

  Forking, restarting and closing the service's process stay the app's.

- `./server` (Node only): the server's side.
  - `createSessions({ protocolVersion, router, admit, closed, error, failed, epoch })`, a
    server's sessions, and the router its transports serve: the wire's handshake beside the
    app's `router`, whose context is `{ session }`. The handshake refuses a session whose token its
    transport doesn't accept (`UNAUTHORIZED`) or that speaks another protocol
    (`INCOMPATIBLE_PROTOCOL`), then asks `admit`, which may refuse with a code of the app's.
    A session whose client connects again is closed, and its transport ended, as the new
    one's handshake takes over: a client notices a dead link before the server does.
    `closed(session)` tells the app a session ended, to release what it held, and
    `failed(path, error)` tells it, for a log, each failure of a call or a stream before
    `error` maps it, and each handshake refused, whether for its input, by the wire or by
    `admit`.
  - The gate, in front of every procedure of the app's `router`: a session that hasn't
    authenticated, or has closed, is `UNAUTHORIZED`; one with `maxCalls` calls running is
    `RESOURCE_LIMIT`. A failure is mapped with `error`, the app's codes beside the wire's. A
    stream a procedure returns is guarded too: it ends once its session closes, even one
    that closed before it began, and its failures are mapped the same way. A stream holds
    its call only until the procedure hands it back: open streams don't count against
    `maxCalls`.
  - `serveWebSocket(sessions, { path, token | verify, origins, maxPayloadBytes,
    sendBudgetBytes, maxConnections, maxCalls, heartbeatMs, authMs })`, sockets for clients
    that authenticate in their handshake: its `upgrade` takes an HTTP server's upgrade
    requests. The token is compared as a SHA-256 digest in constant time; a socket has
    `authMs` (10 s) to authenticate, answers a ping each `heartbeatMs` (30 s) or is dropped,
    and is cut off once its unsent bytes outgrow `sendBudgetBytes`. Unknown paths are 404,
    other origins 403, and sockets beyond `maxConnections` (32) 429. A peer's close frame
    releases its session before the reply, so it can reconnect at once.
  - `servePort(sessions, port, { maxCalls })`, one trusted client over a DOM `MessagePort`
    or Electron's `MessagePortMain`: holding the port is the credential, so no token.
  - `KeyedChanges<Key, Change>`, one reader's stream of keyed state: the current state, then
    `synced`, then later changes, holding only the latest unread change per key, each in the
    place its key first changed. A key the reader was never told of leaves without a removal.
  - `Versioned<State>`, whole state for any number of readers: each reads it now and again
    after every change, however many changes came between; `progress()` tells a change in
    progress at most once every `throttleMs`. `release(owner)` ends one owner's streams.
  - `Latest<T>`, one reader's stream of snapshots that keeps only the newest unread one, and
    never sends again the one the reader has.

  None holds changes for a reader: changes made while it hasn't read yet come to it as one
  (one per key, for `KeyedChanges`).
  A remote reader that can't keep up isn't slowed either: the server's socket sends what it
  reads, and cuts off a reader whose unsent bytes outgrow its send budget.

- `./testing`: channels held in memory, for tests that need no socket or port.
  `memoryPorts()` is the two ends of a port, delivering on a microtask, cloned, in the same
  order every run; `fakeChannel()` is a channel whose far end is the test, which sees what
  was sent and can deliver, drop the channel and make sends fail.

## Pins

`@orpc/client`, `@orpc/contract`, `@orpc/standard-server-peer` and `@orpc/server` come from
the pnpm catalog in the root `pnpm-workspace.yaml`, which every package that uses oRPC takes
them from too, so a client and its server can't drift apart. `ws` comes from it as well.
`@orpc/server` and `ws` are optional peers: only a server that uses `./server` installs them.
