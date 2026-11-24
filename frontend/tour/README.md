# @novadeck/tour

Novadeck's onboarding tour: the consent that offers it, starting a run (the tour's folder opened as
a project of its own, with opencode starting there on a model Novadeck pays for), the driver that follows the run by
the workspace's signals and plays its steps, and what it draws over the workspace while it runs
(its stage, in four acts, and the closing card).

## Contract

- **It depends on `core` and the toolkit, and on no other frontend package.** The app hands it
  what it needs once, at `TourProvider`, as a `TourHost` (`src/tour-host.ts`): the backend's tour, the
  workspace, and the commands that move the view as the person's would. `scripts/workspace/graph.test.ts` holds it off the UI, the chat, the items package, every
  backend and every harness.
- **The tour runs opencode alone, and offers no choice of agent.** Its consent (`consent.ts`,
  `TourConsent.tsx`) says what runs and where the agents' words go, and where opencode isn't
  installed or connected it offers Install (the app's installer, handed in by the app) or Connect
  right there. The model is Novadeck's, so none of the person's own agents is spent.
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
