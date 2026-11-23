# Your game

A blank start for a browser game. Nothing is built yet: the page shows a placeholder model
turning.

## The stack

Plain JavaScript modules, no build step and nothing to install: save a file and the page shows
it.

- [three.js](https://threejs.org) r187 for 3D: `import * as THREE from "three"`, and its addons
  from `"three/addons/..."` (`controls/PointerLockControls.js`, `controls/OrbitControls.js`,
  `loaders/GLTFLoader.js` and the rest of `examples/jsm`).
- [Phaser](https://phaser.io) 3.90 for 2D: the global `Phaser`, already loaded by `index.html`.

Use whichever suits the game, or both.

## What is where

- `index.html`: the page. It loads `src/main.js` into `<div id="game">`.
- `src/main.js`: the placeholder. Replace it with the game, and add more files beside it.
- `src/models.js`: loads the game's models, for a 3D scene or as pictures for a 2D game.
- `models/`: every character, unit, enemy and prop is a glTF model here, a short text file built
  of ready shapes. `models/README.md` says how to make one. `placeholder.gltf` is the one on the
  page now.
- `src/style.css`: the page's own style (a full-window game).
- `vendor/`: three.js and Phaser as files, kept out of git.

## Run it

```sh
node dev.mjs        # or: python3 dev.py
```

Then open http://127.0.0.1:5180/ (or name a port: `node dev.mjs 3000`). The page reloads by
itself when a file changes. The dev server lays the work of every git worktree of this repo over
this folder, so the page shows all of it at once, before any of it is merged. Where two worktrees
change the same file, the page shows the one changed last.
