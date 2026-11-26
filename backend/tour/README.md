# @novadeck/tour-runner

Novadeck's onboarding tour on the runner's side: the folder each run gets (`~/.novadeck/tour`,
then `tour-2` and on where the person kept one), made a git repo of the seed project
(`assets/seed`, with Phaser and three.js written under `vendor/`), the line that starts
Novadeck's own pi there on the model Novadeck pays for, the ticket that pays for it, and the
briefs the doorbell rings its lead and artist. The UI's half is `frontend/tour`
(`@novadeck/tour`); the contract between them is protocol's `tour.*` procedures.

## Contract

- **It reaches nothing of the runner.** The runner builds a `Tour` with what it needs of it, as
  a `TourHost` (`src/tour.ts`): its git, the program finder, the projects, the notices it rings,
  and each terminal's folder, lead and handle. The runner depends on this package, never the
  other way round.
- **Its refusals are a `TourError`** (`src/errors.ts`), always the contract's `CONFLICT`, which
  the runner's `apiError` sends its clients as its own.
- **Its briefs are notices that are a task** (`src/notices.ts`): each starts with a mark only
  Novadeck's own notices can carry, and comes with its own rules, which the runner's messaging
  gives in place of the notice rules (`briefOf`). That a brief fits one delivery, and that its
  launch line reads the same in every shell, are the runner's tests (`backend/runner/src/tour.test.ts`).
- **The seed's files are real files**, read from `assets/seed` in the repository and from the
  app's resources when packaged (`TourAssets`, which `apps/desktop` names);
  `assets/make-shapes.mjs` regenerates the seed's `models/shapes.bin` and is never written.
