# @novadeck/tour

Novadeck's onboarding tour: the consent that offers it, starting a run (the tour's folder opened as
a project of its own, with the person's agent starting there), the driver that follows the run by
the workspace's signals and plays its steps, and what it draws over the workspace while it runs
(its stage, in four acts, and the closing card).

## Contract

- **It depends on `core` and the toolkit, and on no other frontend package.** The app hands it
  what it needs once, at `TourProvider`, as a `TourHost` (`src/tour-host.ts`): the backend's tour, the
  workspace, the app's hook for reading it, and the commands that move the view as the person's
  would. `scripts/workspace/graph.test.ts` holds it off the UI, the chat, the items package, every
  backend and every harness.
- **Its look is its own.** The tour is meant to stand apart from the app, so what it draws over
  the workspace (`print.css`) takes no colour from the app's themes: Nyx's caption box from the
  skits and the website's print, every colour set on `.tour-print`, none a theme token, and a
  theme's glow on text turned off. (Phosphor's tube, drawn over the whole page, still covers it.) The stage and
  the closing card bring that sheet and its font (Bangers) with them, and the app loads both only
  as a tour runs, so its first load carries neither. `tour.css` holds the consent's few rules,
  which do follow the theme, as the consent is an ordinary dialog of the app.
