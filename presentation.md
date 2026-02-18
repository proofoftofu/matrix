---
marp: true
theme: default
paginate: true
---

# 🧩 Cipher Memory Match

Encrypted on-chain 4x4 memory game on **Solana**  
Confidential pair verification via **Arcium**

---

## Problem & Approach

- Traditional memory games trust client-side logic
- We move match verification fully on-chain
- Card values stay encrypted during verification

---

## How It Works

1. Connect wallet
2. Register encrypted round (`register_round`, `set_round_slot_b`)
3. Every 2 picks call `verify_pair`
4. Arcium MPC verifies pair confidentially
5. Encrypted callback updates UI
6. Finalize score (`settle_round_score`)

---

## Why It Matters

- Fair gameplay (no client manipulation)
- Privacy-preserving game state
- Verifiable on-chain logic
- Scalable for leaderboard/rewards

---

## PSG1 Status

- Unity + PSG1 simulator tested
- Core gameplay loop works
- On-chain logic compatible
- Wallet SDK integration pending

---

## Links

- Live App: https://matrix-ebon-seven.vercel.app
- Video: https://youtu.be/KYu_1GtY1JE
- On-chain Proof: https://explorer.solana.com/tx/3VKiPWKjntKYrpLTt63cmY46g5uAeUeuPAAWjXwfbC6Dt6fVGdvoyfpTyunoUBh4mA3UegxsCZrkQkvCXgtKRZgs?cluster=devnet
