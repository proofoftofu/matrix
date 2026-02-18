export const GRID_COLS = 4;
export const GRID_ROWS = 4;
export const CARD_COUNT = GRID_COLS * GRID_ROWS;
export const PAIR_COUNT = CARD_COUNT / 2;

export const GAME_PHASE = Object.freeze({
  PLAYING: "playing",
  WON: "won",
});

export type GamePhase = (typeof GAME_PHASE)[keyof typeof GAME_PHASE];

export type Card = {
  id: number;
  pairId: number;
  revealed: boolean;
  matched: boolean;
};

export type RoundState = {
  deck: Card[];
  phase: GamePhase;
  selectedCards: number[];
  turnsUsed: number;
  actions: number;
  pairsFound: number;
  lastResult: { isMatch: boolean; cards: [number, number] } | null;
};

function shuffle<T>(list: T[], rng: () => number = Math.random): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function createDeck(rng: () => number = Math.random): Card[] {
  const pairs = Array.from({ length: PAIR_COUNT }, (_, pairId) => [pairId, pairId]).flat();
  const shuffledPairs = shuffle(pairs, rng);

  return shuffledPairs.map((pairId, index) => ({
    id: index,
    pairId,
    revealed: false,
    matched: false,
  }));
}

export function createRoundState({
  deck = createDeck(),
}: {
  deck?: Card[];
} = {}): RoundState {
  return {
    deck,
    phase: GAME_PHASE.PLAYING,
    selectedCards: [],
    turnsUsed: 0,
    actions: 0,
    pairsFound: 0,
    lastResult: null,
  };
}

function canSelectCard(state: RoundState, cardIndex: number): boolean {
  if (state.phase !== GAME_PHASE.PLAYING) return false;
  if (state.selectedCards.length >= 2) return false;
  const card = state.deck[cardIndex];
  if (!card) return false;
  if (card.matched || card.revealed) return false;
  if (state.selectedCards.includes(cardIndex)) return false;
  return true;
}

export function selectCard(state: RoundState, cardIndex: number): RoundState {
  if (!canSelectCard(state, cardIndex)) return state;

  const nextDeck = state.deck.map((card, idx) =>
    idx === cardIndex ? { ...card, revealed: true } : card
  );

  return {
    ...state,
    deck: nextDeck,
    selectedCards: [...state.selectedCards, cardIndex],
    actions: state.actions + 1,
    lastResult: null,
  };
}

export function completeRound(state: RoundState): RoundState {
  if (state.pairsFound >= PAIR_COUNT) {
    return { ...state, phase: GAME_PHASE.WON };
  }
  return state;
}

export function resolveTurnWithResult(state: RoundState, isMatch: boolean): RoundState {
  if (state.phase !== GAME_PHASE.PLAYING) return state;
  if (state.selectedCards.length !== 2) return state;

  const [a, b] = state.selectedCards;
  let nextDeck: Card[];
  let pairsFound = state.pairsFound;

  if (isMatch) {
    nextDeck = state.deck.map((card, idx) =>
      idx === a || idx === b ? { ...card, matched: true, revealed: true } : card
    );
    pairsFound += 1;
  } else {
    nextDeck = state.deck.map((card, idx) =>
      idx === a || idx === b ? { ...card, revealed: false } : card
    );
  }

  const nextState: RoundState = {
    ...state,
    deck: nextDeck,
    selectedCards: [],
    turnsUsed: state.turnsUsed + 1,
    pairsFound,
    lastResult: { isMatch, cards: [a, b] },
  };

  return completeRound(nextState);
}

export function computeScore(state: RoundState): number {
  const turnPenalty = state.turnsUsed * 26;
  const actionPenalty = state.actions * 8;
  const pairBonus = state.pairsFound * 80;
  const clearBonus = state.phase === GAME_PHASE.WON ? 1800 : 0;
  return Math.max(0, clearBonus + pairBonus - turnPenalty - actionPenalty);
}
