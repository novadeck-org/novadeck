# @novadeck/wire

RPC calls and streams between processes over a WebSocket or a MessagePort: channels, a client
generic over its contract, its transports, a connection that keeps itself alive, the server's streams
of state, and its errors. It carries an oRPC contract it doesn't know: the app's procedures and their
codes stay the app's.

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
    `RESOURCE_LIMIT`, `SLOW_CONSUMER`, `INVALID_CURSOR`. The client adds `DISCONNECTED` and
    `CLOSED`, and oRPC `BAD_REQUEST` and `INTERNAL_SERVER_ERROR` (`WireErrorCode`).
- `./client`: the client side, for browsers and Node.
  - `createWireClient<C>(channel)`, an oRPC client of contract `C` over a channel. Requests
    fail and streams end as soon as the channel closes. A call in flight when it closes
    fails as `DISCONNECTED`; a stream's pending read, and the call whose send threw, fail
    with oRPC's own error, so a caller that needs the cause asks the channel whether it's
    still open. A channel whose send throws is closed, so whoever holds it replaces it.
  - `connect({ contract, transport, handshake, fatal, retryDelay, timeoutMs, signal })`, a
    supervised connection, resolving after the first handshake. It runs `handshake` on each
    new channel with one `clientId` for every connection of the client (so a server can take
    over from a half-open one) and the transport's token; the handshake answers the server's
    `epoch`, its lifetime, which a stream's cursor belongs to. A connection that drops comes
    back on its own, after `retryDelay(attempt)` (`min(250·2ⁿ, 5000)` ms by default), until
    `close()` or a fatal code: `UNAUTHORIZED`, `INCOMPATIBLE_PROTOCOL`, `CLOSED` and whatever
    `fatal(code)` adds. A connection or handshake taking longer than `timeoutMs` (10 s) fails;
    the transport hears of it through its signal, and must give up when that aborts.
    The `Wire` it gives has:
    - `status`, the `WireStatus` as a read-only `Watched` value: `connected` in an epoch,
      `reconnecting` with the error that dropped it, or `closed`, with why if it wasn't
      asked to;
    - `session()`, the live `{ client, epoch, channel }`, for calls that must not wait: it
      throws `DISCONNECTED` while reconnecting and why it closed (or `CLOSED`) once closed,
      and never queues;
    - `ready()`, which waits for a live session, and `close()`.
  - `Watched<T>`, a value and its changes: `value`, `next()` for the next change, and
    `watch()`, which yields the latest value after each change, coalescing quick ones, until
    a final one.
  - `Transport`, how a client opens a channel (`connect(signal)`) and the token it sends in
    its handshake, if any. `websocket(url, { token })` reaches a server deployed on its own,
    the token kept out of the URL; `messagePort(port)` reaches one its host hands a port to.
    A single port connects once; pass a function that asks for a fresh port to reconnect.
    `hostTransport({ request, message, lateAnswerMs })` is that function for a page in
    Electron's renderer: `request(id)` asks the host (through what its preload exposes), and
    the port comes back as a window message `{ type: message, id }`. A port that answers a
    request given up on is closed, if it comes within `lateAnswerMs`.
- `./electron` (Node only: Electron's main process and preload): the host's side of
  `hostTransport`, with `electron` as an optional peer.
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
  reads, and cuts off a reader whose unsent bytes outgrow its send budget (the app's, for
  now).

- `./testing`: channels held in memory, for tests that need no socket or port.
  `memoryPorts()` is the two ends of a port, delivering on a microtask, cloned, in the same
  order every run; `fakeChannel()` is a channel whose far end is the test, which sees what
  was sent and can deliver, drop the channel and make sends fail.

## Pins

`@orpc/client`, `@orpc/contract`, `@orpc/standard-server-peer` and `@orpc/server` come from
the pnpm catalog in the root `pnpm-workspace.yaml`, which every package that uses oRPC takes
them from too, so a client and its server can't drift apart.
