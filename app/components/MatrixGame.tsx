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
  queueVerifyPairOnchain,
  registerRoundOnchain,
  settleRoundOnchain,
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
  const [verifyTxEnabled, setVerifyTxEnabled] = useState(false);

  const settlingRef = useRef(false);
  const resolveTimerRef = useRef<number | null>(null);
  const publicKeyBase58 = wallet?.publicKey.toBase58() ?? null;

  const progressLabel = useMemo(
    () => `P ${gameState.pairsFound}/${PAIR_COUNT} | T ${gameState.turnsUsed} | A ${gameState.actions}`,
    [gameState.actions, gameState.pairsFound, gameState.turnsUsed]
  );

  const hudScore = useMemo(() => computeScore(gameState), [gameState]);

  useEffect(() => {
    if (busy || !hasStarted) return;
    if (gameState.phase !== GAME_PHASE.PLAYING) return;
    if (gameState.selectedCards.length !== 2) return;

    let cancelled = false;
    const [cardA, cardB] = gameState.selectedCards;
    const isMatchLocal = gameState.deck[cardA]?.pairId === gameState.deck[cardB]?.pairId;
    const revealDelayMs = isMatchLocal ? 0 : 1400;

    const run = async () => {
      try {
        if (verifyTxEnabled) {
          if (!session) {
            setError("Onchain session missing.");
            setStatus("ROUND INIT FAILED.");
            return;
          }
          setStatus("SENDING VERIFY TX ONCHAIN...");
          void queueVerifyPairOnchain(session, cardA, cardB)
            .then((signature) => {
              if (cancelled) return;
              setStatus(`VERIFY TX CONFIRMED: ${signature.slice(0, 8)}...`);
            })
            .catch((cause) => {
              if (cancelled) return;
              const message = cause instanceof Error ? cause.message : "verify_pair tx failed";
              setError(message);
              setStatus("VERIFY TX FAILED.");
            });
        } else {
          setStatus("VERIFY TX BYPASSED.");
        }

        if (cancelled) return;
        if (!isMatchLocal) setStatus("NO MATCH. MEMORIZE THE CARDS...");

        resolveTimerRef.current = window.setTimeout(() => {
          if (cancelled) return;
          setGameState((prev) => resolveTurnWithResult(prev, isMatchLocal));
          setStatus(isMatchLocal ? "MATCH (FRONTEND CHECK)." : "NO MATCH. TRY AGAIN.");
        }, revealDelayMs);
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "local pair check failed";
        setError(message);
        setStatus("PAIR CHECK FAILED.");
      }
    };

    run();
    return () => {
      cancelled = true;
      if (resolveTimerRef.current !== null) {
        window.clearTimeout(resolveTimerRef.current);
        resolveTimerRef.current = null;
      }
    };
  }, [busy, gameState.deck, gameState.phase, gameState.selectedCards, hasStarted, session, verifyTxEnabled]);

  useEffect(() => {
    if (!verifyTxEnabled || !session || !roundStartMs) return;
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
  }, [gameState.pairsFound, gameState.phase, gameState.turnsUsed, hudScore, roundStartMs, session, verifyTxEnabled]);

  useEffect(() => {
    return () => {
      if (resolveTimerRef.current !== null) {
        window.clearTimeout(resolveTimerRef.current);
      }
    };
  }, []);

  const startRound = useCallback(async () => {
    if (verifyTxEnabled && !wallet) {
      setError("Local wallet not ready.");
      return;
    }

    try {
      setBusy(true);
      setError(null);
      settlingRef.current = false;
      if (resolveTimerRef.current !== null) {
        window.clearTimeout(resolveTimerRef.current);
        resolveTimerRef.current = null;
      }

      const deck = createDeck();
      setGameState(createRoundState({ deck }));
      setCursorIndex(0);
      setRoundStartMs(Date.now());
      setHasStarted(true);

      if (verifyTxEnabled) {
        setStatus("REGISTERING ROUND ONCHAIN...");
        const nextSession = await registerRoundOnchain({
          wallet: wallet!,
          connection,
          deck,
        });
        setSession(nextSession);
        setStatus("ROUND ACTIVE. FLIP TWO CARDS TO VERIFY WITH ARCIUM.");
      } else {
        setSession(null);
        setStatus("LOCAL ROUND ACTIVE. ONCHAIN TX BYPASSED.");
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "register_round failed";
      setError(message);
      setStatus("ROUND INIT FAILED.");
    } finally {
      setBusy(false);
    }
  }, [connection, verifyTxEnabled, wallet]);

  const backToMenu = useCallback(() => {
    setHasStarted(false);
    setSession(null);
    setStatus("Round finished. Configure options and press PLAY.");
    setError(null);
  }, []);

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
    if (busy) return;
    setGameState((prev) => selectCard(prev, cursorIndex));
  }, [busy, cursorIndex]);

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

      <section id="board" aria-label="4 by 4 memory board">
        {!hasStarted ? (
          <div className="menu-screen">
            <h2>ROUND MENU</h2>
            <p>Local private key is generated and stored in this browser.</p>
            <p>Deposit devnet SOL to this public key before pressing PLAY.</p>
            <code className="deposit-key">{publicKeyBase58 ?? "Preparing local key..."}</code>
            <div className="menu-switch">
              <span>ONCHAIN VERIFY</span>
              <button
                id="tx-toggle"
                type="button"
                aria-pressed={verifyTxEnabled}
                onClick={() => setVerifyTxEnabled((prev) => !prev)}
                disabled={busy}
              >
                {verifyTxEnabled ? "ON" : "OFF"}
              </button>
            </div>
            <p className="toggle-help">OFF mode bypasses register/verify/settle transactions for instant local play.</p>
            <button id="menu-play" type="button" onClick={() => void startRound()} disabled={busy}>
              {busy ? "STARTING..." : "PLAY"}
            </button>
          </div>
        ) : gameState.phase === GAME_PHASE.WON ? (
          <div className="menu-screen end-screen">
            <h2>ROUND CLEARED</h2>
            <p>All pairs found. Great run.</p>
            <p>{`FINAL SCORE ${hudScore} | TURNS ${gameState.turnsUsed} | ACTIONS ${gameState.actions}`}</p>
            <p>{verifyTxEnabled ? "Round settlement submitted onchain." : "Local mode result (no tx sent)."}</p>
            <button id="menu-play" type="button" onClick={() => void startRound()} disabled={busy}>
              {busy ? "STARTING..." : "PLAY AGAIN"}
            </button>
            <button id="menu-back" type="button" onClick={backToMenu} disabled={busy}>
              BACK TO MENU
            </button>
          </div>
        ) : (
          gameState.deck.map((card, i) => {
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
                  setGameState((prev) => (!busy ? selectCard(prev, i) : prev));
                }}
                disabled={busy || gameState.phase !== GAME_PHASE.PLAYING}
                style={
                  isOpen
                    ? { background: pairColors[card.pairId % pairColors.length], color: "#0e1732" }
                    : undefined
                }
              >
                <span>{isOpen ? pairGlyphs[card.pairId % pairGlyphs.length] : "?"}</span>
              </button>
            );
          })
        )}
      </section>
    </main>
  );
}
