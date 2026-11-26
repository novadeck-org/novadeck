# The tour's narration

Every line the tour's caption box letters, as Nyx will say it: the script for her voice-over.
The tour has no sound yet. When it gets some, each line here is one take, and the caption
shows the same words she says. `narration.test.ts` keeps this list and `src/steps.ts` the
same, so a new or changed line comes here too.

Nyx's voice is the one from the owner's skits (an ElevenLabs Voice Design voice, made with
Eleven v3 and its audio tags; how it was made and its saved voice are in runner-skits,
`skits/chirp/assets/voice/README.md`). Use the saved voice for every take: designing it again
makes a different voice. How her lines are written is in [VOICE.md](../../VOICE.md), "The tour".

Each entry is the line's key (its step, `.cue` for what it says while the subject isn't on
screen yet), then the v3 text: audio tags for how she says it, then the words, exactly as the
caption has them. Lines marked ★ are the jokes: make two or three takes, since the delivery makes
or breaks them. Only the lines are spoken. The note under the box (what to press, where) stays
text.

A cue and its line can play back to back (the cue while the person goes to look, the line once
it's there), so they never say the same thing twice. The two steps that hold their box 3 s
(`start`, `finish`) need takes under about 2.5 s.

## The story

- `start`: `[smug, offhand] That's your agent. It works. [beat] I talk.` ★
- `ask`: `[curious, then teasing] Your call. What game? Make it a good one.`
- `run`: `[flat] It wants to run the game. [sighs] Fine. Say yes.` ★
- `page.cue`: `[impatient] The game's up. Go look.`
- `page`: `[pleased, deadpan] There. It's live. Empty, but live.`
- `team.cue`: `[suspicious] Somebody's hiring. Go find them.`
- `team`: `[impressed, then offended] Look. It hired its own help. Without asking me.` ★
- `shape.cue`: `[casual] Its first model's done. Have a look.`
- `shape`: `[proud] A model, made from nothing. [bossy] Go on. Spin it.`
- `files.cue`: `[bored, bratty] Open your Files. I'll wait.` ★
- `files`: `[quietly impressed] See them blink? That's an agent, writing.`
- `diff.cue`: `[teasing] The code's in. Want to read it?`
- `diff`: `[smug] Every line it wrote. Nothing hidden.`
- `finish`: `[relaxed, smug] They're finishing it. Sit back.`
- `play.cue`: `[excited, hiding it] It's done. Go open it.`
- `play`: `[proud, warm] Three agents, one game. Yours. Go play.`
- `play-model`: `[proud, warm] Three agents, one game. Yours.`
- `closing`: `[warm, then teasing] It's yours now. Don't break it.` ★

## Off the story

What she says while something outside the story holds the tour up.

- `screen`: `[impatient] It wants an answer first. [pointed] From you.`
- `question`: `[mock offended] A teammate has a question. For you, not me.` ★
- `permission`: `[serious for once] It's asking your permission. Read it first.`
- `ended`: `[offended] Your agent stopped. [beat] Rude.` ★
- `left`: `[annoyed groan] It didn't start. Ugh.`
