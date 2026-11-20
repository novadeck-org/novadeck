# @novadeck/tour

Novadeck's onboarding tour: the consent that offers it, starting a run (the tour's folder opened as
a project of its own, with the person's agent starting there), the driver that follows the run by
the workspace's signals and plays its steps, and what it draws over the workspace while it runs
(the spotlight and the closing card).

## Contract

- **It depends on `core` and the toolkit, and on no other frontend package.** The app hands it
  what it needs once, at `TourProvider`, as a `TourHost` (`src/tour-host.ts`): the backend's tour, the
  workspace, the app's hook for reading it, and the commands that move the view as the person's
  would. `scripts/workspace/graph.test.ts` holds it off the UI, the chat, the items package, every
  backend and every harness.
- **Its look is its own.** The tour is meant to stand apart from the app, so `tour.css` doesn't
  follow the app's themes: what it draws over the workspace takes its colours from the package's
  own properties, not the theme's tokens.
