# 🧩 Cipher Memory Match

## Live App
https://matrix-ebon-seven.vercel.app

## Video
https://youtu.be/KYu_1GtY1JE

## On-chain Proof

Verify Pair => Requesting Queue Computation to Arcium
https://explorer.solana.com/tx/3VKiPWKjntKYrpLTt63cmY46g5uAeUeuPAAWjXwfbC6Dt6fVGdvoyfpTyunoUBh4mA3UegxsCZrkQkvCXgtKRZgs?cluster=devnet

## 🔐 Description

**Cipher Memory Match** is a fully on-chain, encrypted 4x4 memory card game built on **Solana**, with confidential pair verification powered by **Arcium**.

Players must match 8 hidden pairs (16 total cards). Unlike traditional memory games where matching logic runs locally, all pair verification and game state management are executed on-chain and encrypted via Arcium confidential computation.

This ensures:

- 🎮 Fair gameplay (no client-side manipulation)
- 🔒 Encrypted board state stored on-chain
- ⛓️ Transparent yet privacy-preserving transactions
- 🛡️ Verifiable match logic without exposing card values

For this hackathon, we implemented the core encrypted gameplay loop. The architecture also supports future extensions such as:

- 🏆 On-chain player ranking
- 🎯 Bonus rewards for minimum-step completion
- 📊 Competitive leaderboard system
- 💰 Incentive-based reward distribution

## 🎯 Key Innovation

This project demonstrates:

- A fully encrypted on-chain game loop
- Confidential verification using Arcium instead of client-side logic
- Practical integration of Solana smart contracts into an interactive game
- A scalable structure ready for ranking, rewards, and competitive gameplay

## ⚙️ How It Works

1. User connects a Solana wallet (e.g., Phantom).
2. The app:
   - Randomizes the 4x4 deck
   - Encrypts and registers the round state on-chain using:
     - `register_round`
     - `set_round_slot_b`
3. Every two selected cards trigger:
   - `verify_pair`
4. Arcium confidential MPC processes the verification.
5. An encrypted callback emits the match result.
6. The client decrypts the result and updates the board.
7. On win or timeout:
   - `settle_round_score` finalizes the round on-chain.

This demonstrates a complete:

User → Wallet → Signed Transaction → Confidential Compute → Encrypted Callback → UI Update

All match verification happens on-chain, not in the client.

## 🚀 PSG1 Integration (Solana Game Shift)

- Built to run natively on the Solana blockchain
- Encryption and confidential verification handled by Arcium
- Core gameplay actions executed fully on-chain

We successfully ported the gameplay logic into **Unity** and tested it using the **PSG1 simulator**.

### Current Status

- ✅ Core gameplay loop works inside PSG1
- ✅ On-chain logic compatible
- ⚠️ Full wallet integration not completed due to limited PSG1 wallet SDK documentation at the time

Testing focused on validating encrypted gameplay logic and transaction flow within the simulator.

The architecture is fully compatible with wallet integration once the proper SDK or documentation becomes available.
