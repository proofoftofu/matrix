"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";

import {
  CARD_COUNT,
  GAME_PHASE,
  GRID_COLS,
  GRID_ROWS,
  PAIR_COUNT,
  ROUND_SECONDS,
  computeScore,
  createDeck,
  createRoundState,
  resolveTurnWithResult,
  selectCard,
  tickRound,
  type RoundState,
} from "@/lib/game/logic";
import {
  registerRoundOnchain,
  settleRoundOnchain,
  verifyPairOnchain,
  type RoundSession,
} from "@/lib/chain/client";

const pairColors = [
  "#ff7aa2",
  "#ffaf66",
  "#ffe27a",
  "#91ffb2",
  "#79f5ff",
  "#8ea7ff",
  "#d29eff",
  "#ff8be8",
];

const pairGlyphs = ["A", "B", "C", "D", "E", "F", "G", "H"];

export default function MatrixGame() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const [gameState, setGameState] = useState<RoundState>(() => createRoundState({ deck: createDeck() }));
  const [session, setSession] = useState<RoundSession | null>(null);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Connect wallet and start an onchain round.");
  const [roundStartMs, setRoundStartMs] = useState<number | null>(null);

  const settlingRef = useRef(false);

  const progressLabel = useMemo(
    () => `P ${gameState.pairsFound}/${PAIR_COUNT} | T ${gameState.turnsUsed} | A ${gameState.actions}`,
    [gameState.actions, gameState.pairsFound, gameState.turnsUsed]
  );

  const hudScore = useMemo(() => computeScore(gameState), [gameState]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const deltaSeconds = Math.min(0.05, (now - last) / 1000);
      last = now;
      setGameState((prev) => tickRound(prev, deltaSeconds));
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!session || busy) return;
    if (gameState.phase !== GAME_PHASE.PLAYING) return;
    if (gameState.selectedCards.length !== 2) return;

    let cancelled = false;
    const [cardA, cardB] = gameState.selectedCards;

    const run = async () => {
      try {
        setBusy(true);
        setStatus("CHECKING PAIR ONCHAIN...");
        const isMatch = await verifyPairOnchain(session, cardA, cardB);
        if (cancelled) return;

        setGameState((prev) => resolveTurnWithResult(prev, isMatch));
        setStatus(isMatch ? "MATCH CONFIRMED ONCHAIN." : "NO MATCH. TRY AGAIN.");
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "verify_pair failed";
        setError(message);
        setStatus("ONCHAIN VERIFY FAILED.");
      } finally {
        if (!cancelled) {
          setBusy(false);
        }
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [busy, gameState.phase, gameState.selectedCards, session]);

  useEffect(() => {
    if (!session || !roundStartMs) return;
    if (settlingRef.current) return;
    if (gameState.phase === GAME_PHASE.PLAYING) return;

    settlingRef.current = true;
    const completed = gameState.phase === GAME_PHASE.WON;
    const solveMs = Math.max(0, Math.round((ROUND_SECONDS - gameState.timeLeft) * 1000));

    settleRoundOnchain(session, {
      turnsUsed: gameState.turnsUsed,
      pairsFound: gameState.pairsFound,
      completed,
      solveMs,
      pointsDelta: hudScore,
    })
      .then(() => {
        setStatus(completed ? "ROUND SETTLED ONCHAIN: CLEAR." : "ROUND SETTLED ONCHAIN: TIMEOUT.");
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : "settle_round_score failed";
        setError(message);
        setStatus("SETTLEMENT FAILED.");
      });
  }, [gameState.pairsFound, gameState.phase, gameState.timeLeft, gameState.turnsUsed, hudScore, roundStartMs, session]);

  const startRound = useCallback(async () => {
    if (!wallet) {
      setError("Connect Phantom first.");
      return;
    }

    try {
      setBusy(true);
      setError(null);
      setStatus("REGISTERING ROUND ONCHAIN...");
      settlingRef.current = false;

      const deck = createDeck();
      setGameState(createRoundState({ deck }));
      setCursorIndex(0);

      const nextSession = await registerRoundOnchain({
        wallet,
        connection,
        deck,
      });

      setSession(nextSession);
      setRoundStartMs(Date.now());
      setStatus("ROUND ACTIVE. FLIP TWO CARDS TO VERIFY WITH ARCIUM.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "register_round failed";
      setError(message);
      setStatus("ROUND INIT FAILED.");
    } finally {
      setBusy(false);
    }
  }, [connection, wallet]);

  const moveCursor = useCallback((dx: number, dy: number) => {
    setCursorIndex((prev) => {
      const row = Math.floor(prev / GRID_COLS);
      const col = prev % GRID_COLS;
      const nextRow = (row + dy + GRID_ROWS) % GRID_ROWS;
      const nextCol = (col + dx + GRID_COLS) % GRID_COLS;
      return nextRow * GRID_COLS + nextCol;
    });
  }, []);

  const flipCursorCard = useCallback(() => {
    if (!session || busy) return;
    setGameState((prev) => selectCard(prev, cursorIndex));
  }, [busy, cursorIndex, session]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "r") {
        void startRound();
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
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flipCursorCard, moveCursor, startRound]);

  return (
    <main id="app" aria-label="Cipher Memory Match">
      <section className="info" aria-live="polite">
        <header className="topbar">
          <h1>CIPHER MATCH</h1>
          <div className="topbar-actions">
            <WalletMultiButton />
            <button id="restart" type="button" onClick={() => void startRound()} disabled={busy}>
              {busy ? "..." : "RST"}
            </button>
          </div>
        </header>

        <div id="status">{status}</div>
        <div className="stats-row">
          <span>{`${gameState.timeLeft.toFixed(1)}s`}</span>
          <span>{`SCORE ${hudScore}`}</span>
          <span id="progress">{progressLabel}</span>
        </div>
        <div className="hint">
          ARROWS MOVE | ENTER/SPACE/CLICK FLIP | R START ROUND | {CARD_COUNT} CARDS ONCHAIN
        </div>
        {error ? <div className="error">{error}</div> : null}
      </section>

      <section id="board" aria-label="4 by 4 memory board">
        {gameState.deck.map((card, i) => {
          const isOpen = card.revealed || card.matched;
          const classes = ["card"];
          classes.push(isOpen ? "revealed" : "hidden");
          if (card.matched) classes.push("matched");
          if (i === cursorIndex) classes.push("cursor");

          return (
            <button
              key={card.id}
              type="button"
              className={classes.join(" ")}
              onClick={() => {
                setCursorIndex(i);
                setGameState((prev) => (session && !busy ? selectCard(prev, i) : prev));
              }}
              disabled={busy || !session || gameState.phase !== GAME_PHASE.PLAYING}
              style={
                isOpen
                  ? { background: pairColors[card.pairId % pairColors.length], color: "#0e1732" }
                  : undefined
              }
            >
              <span>{isOpen ? pairGlyphs[card.pairId % pairGlyphs.length] : "?"}</span>
            </button>
          );
        })}
      </section>
    </main>
  );
}
