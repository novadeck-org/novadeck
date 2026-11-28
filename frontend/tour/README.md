# @novadeck/tour

Novadeck's onboarding tour: the consent that offers it, starting a run (the tour's folder opened as
a project of its own, with Nova starting there on a model Novadeck pays for), the driver that follows the run by
the workspace's signals and plays its steps, and what it draws over the workspace while it runs
(its stage, in four acts, and the closing card).

## Contract

- **It depends on `core` and the toolkit, and on no other frontend package.** The app hands it
  what it needs once, at `TourProvider`, as a `TourHost` (`src/tour-host.ts`): the backend's tour, the
  workspace, and the commands that move the view as the person's would. `scripts/workspace/graph.test.ts` holds it off the UI, the chat, the items package, every
  backend and every harness.
- **The tour runs Nova alone, and offers no choice of agent.** Its consent
  (`consent.ts`, `TourConsent.tsx`) says what runs and where the agents' words go, and asks the
  backend to download Pi as it opens (`Tour.fetch`): it shows how far the download is, and a
  failed one's reason with Try again; Start waits for Pi to be in place. Nothing is installed or
  connected, and the model is Novadeck's, so none of the person's own agents is spent.
- **The person moves the view, never the tour.** Starting a run puts the person in Canvas on its
  lead's window; after that the tour opens, pans and zooms nothing of its own. A caption box whose
  subject can be off screen or behind another tab carries an eye button (`TourStep.show`) that
  brings it into view as the person presses it.
- **No beat before its subject.** A step says nothing until what it's about is there (`ready`),
  and a step with a `cue` says that (the person's part: open Files, open the pane) until its
  subject is on screen, its own line only then.
- **Nyx narrates it, in her own voice.** Every line the caption box letters is one she says
  (VOICE.md, "The tour"): `narration()` in `src/steps.ts` keys each line, `NARRATION.md` lists
  how she says it, and `narration.test.ts` fails when they differ. `src/voice.ts` plays a line's
  take (`src/voice/<key>.mp3`) as its box shows, and the Narration button beside End tour turns
  her off, kept in local storage. A line with no take is lettered only. Notes under the box stay
  text.
- **Its look is its own.** The tour is meant to stand apart from the app, so what it draws over
  the workspace (`print.css`) takes no colour from the app's themes: every colour set on
  `.tour-print` (and in the marks' own rules), none a theme token, and a theme's glow on text
  turned off. It has a night face and a day face, picked by the root's `data-scheme` and never by
  theme, both from the owner's skits: the night face is Nyx's night-panel caption box and the
  website's print; the day face (one commented block in `print.css`) is Nyx's yellow thought box,
  the skits' cream narration box, and paper-and-ink buttons and marks. (Phosphor's tube, drawn over the whole page, still covers it.) The stage and
  the closing card bring that sheet and its font (Bangers) with them, and the app loads both only
  as a tour runs, so its first load carries neither. `tour.css` holds the consent's few rules,
  which do follow the theme, as the consent is an ordinary dialog of the app.
