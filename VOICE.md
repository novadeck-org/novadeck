# Voice

How Novadeck's copy sounds: every line the app shows people, from the tour to a setting's
description to an error. It has one voice, Nyx's, the tour's narrator: short, dry, sure of
itself, talking straight to you. Readability comes first: a line that's fun but needs a second
read is wrong. Names come from [GLOSSARY.md](GLOSSARY.md).

Texts that agents read (tool descriptions, notices, the "You notice…" lines) have their own
rules in docs/agent-messaging.md and stay out of this.

## The rules

- **Short.** One idea a sentence. A description is one or two sentences; split a long one
  rather than chain it with commas and colons.
- **Fact, then what to do.** Say what happened or what a thing does, then the next step, if
  there is one. Nothing before the fact: no "Note that", "Please", "Sorry", "Oops".
- **Talk to you.** "You", "your". An agent is "it" or "the agent", Novadeck is "Novadeck".
- **Present tense, plain verbs.** A setting says what it does when on, with its thing as the
  subject: "Terminals come back with their recent output", not "Enable this to show…".
- **Dry, not cute.** Deadpan beats cheerful. A short aside ("Fine.", "Go on.") is welcome where
  it lands at a glance, one at most per line, and never in place of the fact or the fix. Never
  joke about something the person lost.
- **No hype.** No "great", "powerful", "seamless", "simply", "just", "successfully", no
  exclamation marks.
- **Fragments are fine when they read at once.** "Nothing running here." "Off: nothing named."
  If a fragment makes you stop and decode it, write the whole sentence.
- **Plain English for everyone.** Many people read Novadeck in their second language: no
  idioms or slang ("on our dime", "under the hood"), no abbreviations a stranger wouldn't know.
- **Errors own up and point on.** What didn't work, why if it's known, what to try. "Couldn't
  copy. Select it and copy it yourself."
- **Labels stay plain.** Buttons, menu items, tabs and setting names are the plain words for the
  thing or the act ("Keep recent output", "Restart"). The voice lives in sentences.
- **Proper casing.** Sentence case everywhere; names keep their own capitals.

## Before and after

| Before                                                                                                    | After                                                                         |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Nothing in it is running now. It stays in History, so it can be restored.                                 | Nothing's running here. It's in History if you want it back.                  |
| Copy failed. Select the command to copy it.                                                               | Couldn't copy. Select it and copy it yourself.                                |
| What Novadeck recorded of its recent runs, never what your terminals showed. Attach them to a bug report. | Novadeck's own logs, never your terminal output. Attach them to a bug report. |
| Speak prompts into a terminal. Speech is turned into text on this computer and never leaves it.           | Speak your prompts. Speech becomes text on this computer and never leaves it. |
| A second pair of eyes, right beside your work.                                                            | Reading them now. Two things look off.                                        |

In the tour, Nyx goes furthest ("It wants to run the game. Fine. Say yes."); everywhere else
the same voice says a little less and explains a little more.
