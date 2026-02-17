# Cipher Memory Match Pixel Prototype

Gameplay-first square pixel-style prototype for the Matrix hackathon as a single-player card matching game.

## Run

```bash
npm install
npm run dev
```

## Test

```bash
node --test tests/*.test.js
```

Or:

```bash
npm test
```

## What it demonstrates

- Square-packed pixel UI for small embedded surfaces.
- 4x4 memory board with flip flow, cursor highlight, and click + keyboard controls.
- Single-player gameplay loop (4x4 grid, 8 hidden pairs, timer, turns/actions tracking).
- Pure reducer/game logic covered by unit tests for independent verification.
