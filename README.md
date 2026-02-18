# Cipher Memory Match (Matrix)

## Description
A Next.js App Router game where users play a 4x4 memory match board, connect a Solana wallet, and run each pair-check through Arcium confidential computation.

## Benefit
- Demonstrates a full user-side blockchain flow (wallet-signed transactions).
- Keeps pair verification in confidential compute instead of plain client logic.
- Gives judges an easy-to-test game loop with visible onchain actions.

## How It Works
- User connects Phantom in the web app.
- App creates a randomized deck and registers encrypted board state onchain (`register_round` + `set_round_slot_b`).
- Every two selected cards trigger `verify_pair`; Arcium MPC callback emits encrypted match result.
- Client decrypts the callback output and updates the board.
- On win/timeout, app settles round score onchain with `settle_round_score`.

## How To Run
1. In `workspace/app`, install dependencies.
2. Set RPC URL if needed:
   - `NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com`
3. Start app:
   - `npm run dev`
4. Open browser, connect Phantom, click `RST` to start an onchain round.
