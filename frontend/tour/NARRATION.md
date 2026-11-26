# The tour's narration: Nyx's voice-over

Every line the tour's caption box letters, as Nyx says it. Each line is one take, and the
caption shows the same words she says. `src/narration.test.ts` keeps this list and the tour's
code the same: a new or changed line comes here too, and gets a new take. How her lines are
written is in [VOICE.md](../../VOICE.md), "The tour".

## Making the takes

- **Her voice:** the saved Nyx voice from the owner's skits, in the owner's ElevenLabs Voices
  library (runner-skits, `skits/chirp/assets/voice/README.md`, has its ID and how it was made).
  Use the saved voice for every take: designing it again from the prompt makes a different voice.
- **The model:** Eleven v3, with its audio tags. Paste each take's text below as it stands: the
  tags in brackets say how she says it, and the words after them are the caption's, word for
  word. Don't change the words in ElevenLabs: change them here and in the code, or the caption
  and her voice say different things.
- **The plan:** Starter or above (it carries the commercial licence). MP3, 44.1 kHz.
- **The jokes:** lines marked ★ are the jokes. Make two or three takes of each, since the
  delivery makes or breaks them, and keep the best.
- **Files:** one file per line, named for its key: `start.mp3`, `files.cue.mp3`. Put them all
  in one folder, then run `node scripts/tour-voice/takes.ts <folder>`. It trims the silence
  around each take, brings them all to one loudness, and writes them to `src/voice/`, where the
  tour plays them. It also lists the lines with no take yet, files that match no line, and takes
  longer than their box stays on screen. A line with no take is shown and not spoken.
- **Length:** short and clipped, as in the skits. A cue gives way as soon as its subject is on
  screen, so keep cues under about 2 s. `start` shows for 3 s, so keep it under about 2.5 s.
  The others can run to about 3 s.
- **Pauses:** her full stops are the pauses. Don't add `...` or a pause tag: the caption
  doesn't have one.
- **The voice:** General American, never British. If a take drifts, record it again rather
  than fixing it in the edit.

A cue and its line can play back to back: the cue while the person goes to look, the line once
it's there. So a cue never says what its line says. Only the lines are spoken. The note under
the box (what to press, and where) stays text.

## The story

- [ ] `start`: `[smug, offhand] That's your agent. It does the work. [smug] I talk.` ★
- [ ] `ask`: `[curious] Your call. What game? [teasing] Make it a good one.`
- [ ] `run`: `[flat] It wants to run the game. [sighs] Fine. Say yes.` ★
- [ ] `page.cue`: `[impatient] Your game's running. Go look.`
- [ ] `page`: `[deadpan] There. Nothing in it yet. [dismissive] Give it time.`
- [ ] `team.cue`: `[suspicious] New agents. Go find them.`
- [ ] `team`: `[impressed] Look. It hired its own help. [offended] Without asking me.` ★
- [ ] `shape.cue`: `[casual] Its first model's done. Have a look.`
- [ ] `shape`: `[proud] A model, made from nothing. [bossy] Go on. Spin it.`
- [ ] `files.cue`: `[bored, bratty] Open your Files. I'll wait.` ★
- [ ] `files`: `[quietly impressed] See the files blink? That's an agent, writing.`
- [ ] `diff.cue`: `[teasing] The code's in. Want to read it?`
- [ ] `diff`: `[smug] Every line it wrote. Nothing hidden.`
- [ ] `finish`: `[relaxed] They're finishing it. [smug] Relax.`
- [ ] `play.cue`: `[excited, hiding it] Your game's done. Go open it.`
- [ ] `play`: `[proud] Three agents, one game. [warm] Go play.`
- [ ] `play-model.cue`: `[excited, hiding it] Your model's done. Go open it.`
- [ ] `play-model`: `[proud] Three agents, one model. [warm] Yours.`
- [ ] `closing`: `[warm] It's yours now. [teasing] Don't break it.` ★

## Off the story

What she says while something outside the story holds the tour up.

- [ ] `screen`: `[impatient] It wants an answer first. [pointed] From you.`
- [ ] `team-screen`: `[impatient] A teammate wants an answer first. [pointed] From you.`
- [ ] `question`: `[flat] A teammate has a question. [mock offended] For you, not me.` ★
- [ ] `permission`: `[serious for once] It's asking your permission. Read it first.`
- [ ] `ended`: `[flat] Your agent stopped. [offended] Rude.` ★
- [ ] `left`: `[puzzled] It didn't even start.`
- [ ] `left.team`: `[flat, unimpressed] A teammate quit.`

The act wipes ("Act 2, Your call") aren't spoken.

## How the tour plays them

`src/voice.ts` plays a line's take as its caption box shows, cues included. A new line stops the
one before it where it is, since the box it belonged to has gone. A box drawn again for the same
line doesn't say it twice. She stops while the person is in another project, and when the tour
ends. The Narration button beside End tour turns her off or on, and the choice is kept for every
tour after.
