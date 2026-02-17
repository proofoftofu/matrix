# Memory Match Blockchain Prototype (Arcium + Solana)

This prototype adapts the Arcium hello-world skeleton to Matrix memory-match game logic.

## What this prototype proves

- Encrypted round board cards can be registered onchain (`register_round`).
- Each match attempt queues confidential Arcium compute (`verify_pair`).
- Callback returns encrypted `is_match` via event (`pair_verified`).
- Round score can be settled and emitted onchain (`settle_round_score`).

## Project structure

- `encrypted-ixs/src/lib.rs`
  - `verify_pair(card_a, card_b) -> is_match`
- `programs/blockchain/src/lib.rs`
  - `register_round`
  - `init_verify_pair_comp_def`
  - `verify_pair`
  - `verify_pair_callback`
  - `settle_round_score`
- `tests/blockchain.ts`
  - e2e registration, pair verify (match/non-match), settlement

## Run

```bash
yarn install
arcium build
arcium test --skip-build
```

## Integration contract

- `register_round`: `{ roundId, encryptedCards[16], pubKey, boardNonce }`
- `verify_pair`: `{ roundId, cardAIndex, cardBIndex, computationOffset, nonce }`
- `pair_verified` event: `{ player, roundId, turnsUsed, pairsFound, isMatchCipher, nonce }`
- `settle_round_score`: `{ roundId, turnsUsed, pairsFound, completed, solveMs, pointsDelta, nonceHash }`

## Known gaps

- Settlement inputs are client-provided; anti-cheat proofing is not finalized.
- Key management is demo-oriented, not production hardened.
