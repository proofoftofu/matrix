"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection } from "@solana/web3.js";

import {
  CARD_COUNT,
  GAME_PHASE,
  GRID_COLS,
  GRID_ROWS,
  PAIR_COUNT,
  computeScore,
  createDeck,
  createRoundState,
  resolveTurnWithResult,
  selectCard,
  type RoundState,
} from "@/lib/game/logic";
import {
  registerRoundOnchain,
  settleRoundOnchain,
  verifyPairOnchain,
  type RoundSession,
} from "@/lib/chain/client";
import { usePhantomWallet } from "@/lib/solana/usePhantomWallet";

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
  const { wallet } = usePhantomWallet();
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const connection = useMemo(() => new Connection(endpoint, "confirmed"), [endpoint]);

  const [gameState, setGameState] = useState<RoundState>(() => createRoundState({ deck: createDeck() }));
  const [session, setSession] = useState<RoundSession | null>(null);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Local key generated on this device. Fund it with devnet SOL.");
  const [roundStartMs, setRoundStartMs] = useState<number | null>(null);
  const [hasStarted, setHasStarted] = useState(false);

  const settlingRef = useRef(false);
  const publicKeyBase58 = wallet?.publicKey.toBase58() ?? null;

  const progressLabel = useMemo(
    () => `P ${gameState.pairsFound}/${PAIR_COUNT} | T ${gameState.turnsUsed} | A ${gameState.actions}`,
    [gameState.actions, gameState.pairsFound, gameState.turnsUsed]
  );

  const hudScore = useMemo(() => computeScore(gameState), [gameState]);

  useEffect(() => {
    if (!session || busy || !hasStarted) return;
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
  }, [busy, gameState.phase, gameState.selectedCards, hasStarted, session]);

  useEffect(() => {
    if (!session || !roundStartMs) return;
    if (settlingRef.current) return;
    if (gameState.phase !== GAME_PHASE.WON) return;

    settlingRef.current = true;
    const solveMs = Math.max(0, Date.now() - roundStartMs);

    settleRoundOnchain(session, {
      turnsUsed: gameState.turnsUsed,
      pairsFound: gameState.pairsFound,
      completed: true,
      solveMs,
      pointsDelta: hudScore,
    })
      .then(() => {
        setStatus("ROUND SETTLED ONCHAIN: CLEAR.");
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : "settle_round_score failed";
        setError(message);
        setStatus("SETTLEMENT FAILED.");
      });
  }, [gameState.pairsFound, gameState.phase, gameState.turnsUsed, hudScore, roundStartMs, session]);

  const startRound = useCallback(async () => {
    if (!wallet) {
      setError("Local wallet not ready.");
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
      setHasStarted(true);
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

      if (!hasStarted || gameState.phase !== GAME_PHASE.PLAYING) {
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
  }, [flipCursorCard, gameState.phase, hasStarted, moveCursor, startRound]);

  return (
    <main id="app" aria-label="Cipher Memory Match">
      <section className="info" aria-live="polite">
        <header className="topbar">
          <h1>CIPHER MATCH</h1>
        </header>

        <div id="status">{status}</div>
        <div className="stats-row">
          <span>{`SCORE ${hudScore}`}</span>
          <span id="progress">{progressLabel}</span>
        </div>
        <div className="hint">
          ARROWS MOVE | ENTER/SPACE/CLICK FLIP | R START ROUND | {CARD_COUNT} CARDS ONCHAIN
        </div>
        {error ? <div className="error">{error}</div> : null}
      </section>

      {!hasStarted ? (
        <section id="board" aria-label="Round menu" className="menu-board">
          <div className="menu-screen">
            <h2>ROUND MENU</h2>
            <p>Local private key is generated and stored in this browser.</p>
            <p>Deposit devnet SOL to this public key before pressing PLAY.</p>
            <code className="deposit-key">{publicKeyBase58 ?? "Preparing local key..."}</code>
            <button id="menu-play" type="button" onClick={() => void startRound()} disabled={busy}>
              {busy ? "STARTING..." : "PLAY"}
            </button>
          </div>
        </section>
      ) : (
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
      )}
    </main>
  );
}
