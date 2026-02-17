import {
  CARD_COUNT,
  GAME_PHASE,
  GRID_COLS,
  GRID_ROWS,
  PAIR_COUNT,
  createDeck,
  createRoundState,
  resolveTurn,
  selectCard,
  tickRound
} from "./game/logic.js";

const pairColors = [
  "#ff7aa2",
  "#ffaf66",
  "#ffe27a",
  "#91ffb2",
  "#79f5ff",
  "#8ea7ff",
  "#d29eff",
  "#ff8be8"
];

const pairGlyphs = ["A", "B", "C", "D", "E", "F", "G", "H"];

const boardEl = document.getElementById("board");
const statusEl = document.getElementById("status");
const timerEl = document.getElementById("timer");
const scoreEl = document.getElementById("score");
const progressEl = document.getElementById("progress");
const restartEl = document.getElementById("restart");

let gameState = createRoundState({ deck: createDeck() });
let cursorIndex = 0;
let resolveDelaySeconds = 0;
let lastTick = performance.now();

const cardEls = [];
for (let i = 0; i < CARD_COUNT; i += 1) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card hidden";
  button.dataset.index = String(i);

  const face = document.createElement("span");
  face.textContent = "?";
  button.append(face);

  button.addEventListener("click", () => {
    cursorIndex = i;
    flipCursorCard();
  });

  cardEls.push(button);
  boardEl.append(button);
}

restartEl.addEventListener("click", () => startRound());

function startRound() {
  gameState = createRoundState({ deck: createDeck() });
  cursorIndex = 0;
  resolveDelaySeconds = 0;
  render();
}

function computeScore(state) {
  const turnPenalty = state.turnsUsed * 26;
  const actionPenalty = state.actions * 8;
  const timeBonus = Math.floor(state.timeLeft * 7);
  const pairBonus = state.pairsFound * 80;
  const clearBonus = state.phase === GAME_PHASE.WON ? 1800 : 0;
  return Math.max(0, clearBonus + pairBonus + timeBonus - turnPenalty - actionPenalty);
}

function flipCursorCard() {
  if (gameState.phase !== GAME_PHASE.PLAYING) return;
  if (gameState.selectedCards.length >= 2) return;

  const prevSelected = gameState.selectedCards.length;
  gameState = selectCard(gameState, cursorIndex);
  if (gameState.selectedCards.length === 2 && prevSelected !== 2) {
    resolveDelaySeconds = 0.55;
  }
  render();
}

function resolvePending(deltaSeconds) {
  if (resolveDelaySeconds <= 0) return;
  resolveDelaySeconds = Math.max(0, resolveDelaySeconds - deltaSeconds);
  if (resolveDelaySeconds === 0) {
    gameState = resolveTurn(gameState);
  }
}

function renderHud() {
  timerEl.textContent = `${gameState.timeLeft.toFixed(1)}s`;
  scoreEl.textContent = `SCORE ${computeScore(gameState)}`;
  progressEl.textContent = `P ${gameState.pairsFound}/${PAIR_COUNT} | T ${gameState.turnsUsed} | A ${gameState.actions}`;

  if (gameState.phase === GAME_PHASE.WON) {
    statusEl.textContent = "CLEAR! MEMORY MATRIX STABLE.";
    statusEl.style.color = "#79ffa1";
  } else if (gameState.phase === GAME_PHASE.TIMEOUT) {
    statusEl.textContent = "TIMEOUT. TRY AGAIN.";
    statusEl.style.color = "#ff7aa2";
  } else if (gameState.selectedCards.length === 2) {
    statusEl.textContent = "CHECKING PAIR...";
    statusEl.style.color = "#56f6ff";
  } else {
    statusEl.textContent = `SELECT CARD ${cursorIndex + 1}`;
    statusEl.style.color = "#56f6ff";
  }
}

function renderCards() {
  for (let i = 0; i < CARD_COUNT; i += 1) {
    const cardState = gameState.deck[i];
    const el = cardEls[i];
    const face = el.firstElementChild;
    const isOpen = cardState.revealed || cardState.matched;

    el.classList.toggle("cursor", i === cursorIndex);
    el.classList.toggle("revealed", isOpen);
    el.classList.toggle("hidden", !isOpen);
    el.classList.toggle("matched", cardState.matched);

    el.disabled = gameState.phase !== GAME_PHASE.PLAYING;

    if (isOpen) {
      const color = pairColors[cardState.pairId % pairColors.length];
      el.style.background = color;
      face.textContent = pairGlyphs[cardState.pairId % pairGlyphs.length];
      face.style.color = "#0e1732";
    } else {
      el.style.background = "";
      face.textContent = "?";
      face.style.color = "#e8f0ff";
    }
  }
}

function render() {
  renderHud();
  renderCards();
}

function moveCursor(dx, dy) {
  const row = Math.floor(cursorIndex / GRID_COLS);
  const col = cursorIndex % GRID_COLS;
  const nextRow = (row + dy + GRID_ROWS) % GRID_ROWS;
  const nextCol = (col + dx + GRID_COLS) % GRID_COLS;
  cursorIndex = nextRow * GRID_COLS + nextCol;
}

window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "r") {
    startRound();
    return;
  }

  if (event.key === "ArrowLeft") {
    moveCursor(-1, 0);
  } else if (event.key === "ArrowRight") {
    moveCursor(1, 0);
  } else if (event.key === "ArrowUp") {
    moveCursor(0, -1);
  } else if (event.key === "ArrowDown") {
    moveCursor(0, 1);
  } else if (event.key === "Enter" || event.code === "Space") {
    event.preventDefault();
    flipCursorCard();
  }

  render();
});

function loop(now) {
  const deltaSeconds = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;

  gameState = tickRound(gameState, deltaSeconds);
  resolvePending(deltaSeconds);
  render();

  requestAnimationFrame(loop);
}

startRound();
requestAnimationFrame(loop);
