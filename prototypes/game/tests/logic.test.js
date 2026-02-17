import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CARD_COUNT,
  GAME_PHASE,
  PAIR_COUNT,
  completeRound,
  createRoundState,
  incrementActions,
  resolveTurn,
  selectCard,
  tickRound
} from "../src/game/logic.js";

function fixtureDeck() {
  return [
    { id: 0, pairId: 0, revealed: false, matched: false },
    { id: 1, pairId: 1, revealed: false, matched: false },
    { id: 2, pairId: 0, revealed: false, matched: false },
    { id: 3, pairId: 1, revealed: false, matched: false },
    { id: 4, pairId: 2, revealed: false, matched: false },
    { id: 5, pairId: 2, revealed: false, matched: false },
    { id: 6, pairId: 3, revealed: false, matched: false },
    { id: 7, pairId: 3, revealed: false, matched: false },
    { id: 8, pairId: 4, revealed: false, matched: false },
    { id: 9, pairId: 4, revealed: false, matched: false },
    { id: 10, pairId: 5, revealed: false, matched: false },
    { id: 11, pairId: 5, revealed: false, matched: false },
    { id: 12, pairId: 6, revealed: false, matched: false },
    { id: 13, pairId: 6, revealed: false, matched: false },
    { id: 14, pairId: 7, revealed: false, matched: false },
    { id: 15, pairId: 7, revealed: false, matched: false }
  ];
}

describe("memory round reducer", () => {
  it("keeps full deck size", () => {
    const state = createRoundState({ deck: fixtureDeck() });
    assert.equal(state.deck.length, CARD_COUNT);
  });

  it("selectCard reveals card and increments actions", () => {
    let state = createRoundState({ deck: fixtureDeck() });
    state = selectCard(state, 0);

    assert.equal(state.deck[0].revealed, true);
    assert.deepEqual(state.selectedCards, [0]);
    assert.equal(state.actions, 1);
  });

  it("resolveTurn marks pairs for matched cards", () => {
    let state = createRoundState({ deck: fixtureDeck() });
    state = selectCard(state, 0);
    state = selectCard(state, 2);
    state = resolveTurn(state);

    assert.equal(state.deck[0].matched, true);
    assert.equal(state.deck[2].matched, true);
    assert.equal(state.pairsFound, 1);
    assert.equal(state.turnsUsed, 1);
    assert.deepEqual(state.selectedCards, []);
    assert.equal(state.lastResult?.isMatch, true);
  });

  it("resolveTurn hides cards for mismatch", () => {
    let state = createRoundState({ deck: fixtureDeck() });
    state = selectCard(state, 0);
    state = selectCard(state, 1);
    state = resolveTurn(state);

    assert.equal(state.deck[0].revealed, false);
    assert.equal(state.deck[1].revealed, false);
    assert.equal(state.pairsFound, 0);
    assert.equal(state.lastResult?.isMatch, false);
  });

  it("completeRound transitions to won", () => {
    const state = createRoundState({ deck: fixtureDeck() });
    const finished = completeRound({ ...state, pairsFound: PAIR_COUNT });
    assert.equal(finished.phase, GAME_PHASE.WON);
  });

  it("tickRound times out", () => {
    const state = createRoundState({ deck: fixtureDeck(), roundSeconds: 1 });
    const out = tickRound(state, 2);
    assert.equal(out.phase, GAME_PHASE.TIMEOUT);
    assert.equal(out.timeLeft, 0);
  });

  it("incrementActions supports batch increments", () => {
    const state = createRoundState({ deck: fixtureDeck() });
    const out = incrementActions(state, 3);
    assert.equal(out.actions, 3);
  });
});
