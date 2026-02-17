export const GRID_COLS = 4;
export const GRID_ROWS = 4;
export const CARD_COUNT = GRID_COLS * GRID_ROWS;
export const PAIR_COUNT = CARD_COUNT / 2;
export const ROUND_SECONDS = 90;

export const GAME_PHASE = Object.freeze({
  PLAYING: "playing",
  WON: "won",
  TIMEOUT: "timeout"
});

function shuffle(list, rng = Math.random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function createDeck(rng = Math.random) {
  const pairs = Array.from({ length: PAIR_COUNT }, (_, pairId) => [pairId, pairId]).flat();
  const shuffledPairs = shuffle(pairs, rng);

  return shuffledPairs.map((pairId, index) => ({
    id: index,
    pairId,
    revealed: false,
    matched: false
  }));
}

export function createRoundState({ deck = createDeck(), roundSeconds = ROUND_SECONDS } = {}) {
  return {
    deck,
    roundSeconds,
    timeLeft: roundSeconds,
    phase: GAME_PHASE.PLAYING,
    selectedCards: [],
    turnsUsed: 0,
    actions: 0,
    pairsFound: 0,
    lastResult: null
  };
}

export function incrementActions(state, amount = 1) {
  if (amount <= 0) return state;
  return { ...state, actions: state.actions + amount };
}

function canSelectCard(state, cardIndex) {
  if (state.phase !== GAME_PHASE.PLAYING) return false;
  if (state.selectedCards.length >= 2) return false;
  const card = state.deck[cardIndex];
  if (!card) return false;
  if (card.matched || card.revealed) return false;
  if (state.selectedCards.includes(cardIndex)) return false;
  return true;
}

export function selectCard(state, cardIndex) {
  if (!canSelectCard(state, cardIndex)) return state;

  const nextDeck = state.deck.map((card, idx) =>
    idx === cardIndex ? { ...card, revealed: true } : card
  );

  return {
    ...state,
    deck: nextDeck,
    selectedCards: [...state.selectedCards, cardIndex],
    actions: state.actions + 1,
    lastResult: null
  };
}

function isMatchForSelected(deck, selectedCards) {
  if (selectedCards.length !== 2) return false;
  const [a, b] = selectedCards;
  return deck[a].pairId === deck[b].pairId;
}

export function completeRound(state) {
  if (state.pairsFound >= PAIR_COUNT) {
    return { ...state, phase: GAME_PHASE.WON };
  }
  return state;
}

export function resolveTurn(state) {
  if (state.phase !== GAME_PHASE.PLAYING) return state;
  if (state.selectedCards.length !== 2) return state;

  const [a, b] = state.selectedCards;
  const match = isMatchForSelected(state.deck, state.selectedCards);

  let nextDeck;
  let pairsFound = state.pairsFound;
  if (match) {
    nextDeck = state.deck.map((card, idx) =>
      idx === a || idx === b ? { ...card, matched: true, revealed: true } : card
    );
    pairsFound += 1;
  } else {
    nextDeck = state.deck.map((card, idx) =>
      idx === a || idx === b ? { ...card, revealed: false } : card
    );
  }

  const nextState = {
    ...state,
    deck: nextDeck,
    selectedCards: [],
    turnsUsed: state.turnsUsed + 1,
    pairsFound,
    lastResult: { isMatch: match, cards: [a, b] }
  };

  return completeRound(nextState);
}

export function tickRound(state, deltaSeconds) {
  if (state.phase !== GAME_PHASE.PLAYING) return state;
  const timeLeft = Math.max(0, state.timeLeft - deltaSeconds);
  const phase = timeLeft <= 0 ? GAME_PHASE.TIMEOUT : state.phase;
  return { ...state, timeLeft, phase };
}
