# Doorbell recordings

Real PTY output of the three harnesses' TUIs in Novadeck's runner, which `src/doorbell.spec.ts` replays
into a terminal with the doorbell overlay: Claude Code 2.1.329, Codex 0.171.0 and Antigravity 1.5.13, at
80, 120 and 200 columns by 40 rows, against a scripted model.

- `<harness>/<columns>/ring.pty.jsonl`: an idle agent rung by another's message. Each line is
  `{"t": ms, "d": output}`; the first repaint draws the whole screen, then the doorbell tag is typed,
  Enter pressed, the hook's delivery and the reply drawn. The tag is the form the doorbell typed when
  these were recorded, `ring` before `from`; the overlay reads both orders.
- `recall.pty.jsonl`: the tag recalled into the box with Up, then cleared: it must stay raw.
- `turn-end.pty.jsonl`: a turn held, a message sent to it, its Stop hook delivering the message.
  Antigravity prints no block. `turn-end.ids.json` holds the ids of the messages the screens showed.

The tag in these is the form recorded then (`ring` first, a reply line the harness drew as `<novadeck-reply ring=...>`
is not kept). The shipped form was recorded later, in the same way, with `from` first:

- `ring2.pty.jsonl` (80, 120, 200 columns): a ring of two senders (`from="moth owl"`) into an idle agent;
  `ring2.handles.json` holds the three handles (sender, recipient, sender).
- `start.pty.jsonl` (120): a task's start prompt, `<novadeck-doorbell from='' ring='…'/>` as the helper
  agent's command-line prompt (Antigravity takes its task as a ring instead).
- `reply.pty.jsonl` (120): the person's Inbox reply, `<novadeck-reply>…</novadeck-reply><end ring="…"/>`.

They came from the e2e harness's probes (a throwaway probe file run with `NOVADECK_E2E_PROBES=1`, the
fake model, each harness in its own sandbox: nothing written to a harness's own settings).
