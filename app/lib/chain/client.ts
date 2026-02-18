import * as anchor from "@coral-xyz/anchor/dist/browser/index.js";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { Buffer } from "buffer";

import blockchainIdl from "@/lib/idl/blockchain.json";
import { CARD_COUNT, type Card } from "@/lib/game/logic";

const ROUND_STATE_SEED = "round_state";
const LOG_PREFIX = "[arcium-client]";

type Program = anchor.Program;
type Provider = anchor.AnchorProvider;

type DeriveAccountsResponse = {
  computationAccount: string;
  clusterAccount: string;
  mxeAccount: string;
  mempoolAccount: string;
  executingPool: string;
  compDefAccount: string;
  compDefExists: boolean;
};

type PrepareRoundResponse = {
  sharedSecretB64: string;
  boardNonce: number[];
  publicKey: number[];
  encryptedBoardSlotA: number[][];
  encryptedBoardSlotB: number[][];
};

function debug(message: string, data?: Record<string, unknown>): void {
  if (data) {
    console.log(`${LOG_PREFIX} ${message}`, data);
    return;
  }
  console.log(`${LOG_PREFIX} ${message}`);
}

export type RoundSession = {
  program: Program;
  provider: Provider;
  roundId: anchor.BN;
  roundState: PublicKey;
  sharedSecretB64: string;
};

export type WalletLike = {
  publicKey: PublicKey;
  signTransaction: <T>(tx: T) => Promise<T>;
  signAllTransactions: <T>(txs: T[]) => Promise<T[]>;
};

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function randomU64BN(): anchor.BN {
  const bytes = randomBytes(8);
  return new anchor.BN(Buffer.from(bytes).toString("hex"), 16);
}

function getRoundStatePda(
  programId: PublicKey,
  payer: PublicKey,
  roundId: anchor.BN
): PublicKey {
  const roundIdLE = roundId.toArrayLike(Buffer, "le", 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ROUND_STATE_SEED), payer.toBuffer(), roundIdLE],
    programId
  )[0];
}

function createProgram(wallet: WalletLike, connection: anchor.web3.Connection): {
  provider: Provider;
  program: Program;
} {
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = blockchainIdl as anchor.Idl;
  const program = new anchor.Program(idl, provider);
  return { provider, program };
}

async function postArcium<T>(body: Record<string, unknown>): Promise<T> {
  const action =
    typeof body.action === "string" ? body.action : "unknown";
  const startedAt = performance.now();
  debug("api request", { action, body });
  const response = await fetch("/api/arcium", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    debug("api request failed", {
      action,
      status: response.status,
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      error: payload.error ?? "unknown",
    });
    throw new Error(payload.error ?? `API request failed (${response.status})`);
  }

  const json = (await response.json()) as T;
  debug("api request success", {
    action,
    status: response.status,
    elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
  });
  return json;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSignatureConfirmedLowLevel(
  connection: anchor.web3.Connection,
  signature: string,
  timeoutMs = 45_000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const statuses = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = statuses.value[0];

    if (status?.err) {
      throw new Error(`verifyPair transaction failed: ${JSON.stringify(status.err)}`);
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return;
    }

    await sleep(1_200);
  }

  throw new Error(`Timed out waiting tx confirmation for ${signature}`);
}

export async function registerRoundOnchain(params: {
  wallet: WalletLike;
  connection: anchor.web3.Connection;
  deck: Card[];
}): Promise<RoundSession> {
  const { wallet, connection, deck } = params;
  debug("registerRound start", {
    wallet: wallet.publicKey.toBase58(),
    deckSize: deck.length,
  });
  if (deck.length !== CARD_COUNT) {
    throw new Error(`Deck must contain exactly ${CARD_COUNT} cards`);
  }

  const { provider, program } = createProgram(wallet, connection);
  debug("program ready", {
    programId: program.programId.toBase58(),
    endpoint: connection.rpcEndpoint,
  });
  const roundCrypto = await postArcium<PrepareRoundResponse>({
    action: "prepareRound",
    programId: program.programId.toBase58(),
    deckPairIds: deck.map((card) => card.pairId),
  });
  debug("prepareRound response", {
    boardNonceLen: roundCrypto.boardNonce.length,
    publicKeyLen: roundCrypto.publicKey.length,
    slotALen: roundCrypto.encryptedBoardSlotA.length,
    slotBLen: roundCrypto.encryptedBoardSlotB.length,
  });

  const roundId = randomU64BN();
  const roundState = getRoundStatePda(program.programId, wallet.publicKey, roundId);
  debug("round ids generated", {
    roundId: roundId.toString(),
    roundState: roundState.toBase58(),
  });

  const registerSig = await program.methods
    .registerRound(
      roundId,
      roundCrypto.encryptedBoardSlotA,
      roundCrypto.publicKey,
      roundCrypto.boardNonce
    )
    .accounts({
      payer: wallet.publicKey,
      roundState,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  debug("registerRound tx confirmed", { signature: registerSig });

  const setSlotBSig = await program.methods
    .setRoundSlotB(roundId, roundCrypto.encryptedBoardSlotB)
    .accounts({
      payer: wallet.publicKey,
      roundState,
    })
    .rpc({ commitment: "confirmed" });
  debug("setRoundSlotB tx confirmed", { signature: setSlotBSig });

  return {
    program,
    provider,
    roundId,
    roundState,
    sharedSecretB64: roundCrypto.sharedSecretB64,
  };
}

export async function verifyPairOnchain(
  session: RoundSession,
  cardAIndex: number,
  cardBIndex: number
): Promise<boolean> {
  debug("verifyPair start", {
    roundId: session.roundId.toString(),
    roundState: session.roundState.toBase58(),
    cardAIndex,
    cardBIndex,
  });
  const pairEventPromise = awaitPairVerifiedEvent(session.program);
  const computationOffset = randomU64BN();
  const turnNonce = randomBytes(16);
  debug("verifyPair computed offsets", {
    computationOffset: computationOffset.toString(),
    turnNonceLen: turnNonce.length,
  });

  const accountMeta = await postArcium<DeriveAccountsResponse>({
    action: "deriveVerifyAccounts",
    programId: session.program.programId.toBase58(),
    computationOffset: computationOffset.toString(),
  });
  debug("deriveVerifyAccounts response", accountMeta);
  if (!accountMeta.compDefExists) {
    throw new Error(
      "verify_pair computation definition is missing on-chain. Run prototypes/blockchain init_verify_pair_comp_def + upload verify_pair circuit for this program ID."
    );
  }

  const verifySig = await session.program.methods
    .verifyPair(
      session.roundId,
      cardAIndex,
      cardBIndex,
      computationOffset,
      deserializeLEToBN(turnNonce)
    )
    .accountsPartial({
      payer: session.provider.wallet.publicKey,
      roundState: session.roundState,
      computationAccount: new PublicKey(accountMeta.computationAccount),
      clusterAccount: new PublicKey(accountMeta.clusterAccount),
      mxeAccount: new PublicKey(accountMeta.mxeAccount),
      mempoolAccount: new PublicKey(accountMeta.mempoolAccount),
      executingPool: new PublicKey(accountMeta.executingPool),
      compDefAccount: new PublicKey(accountMeta.compDefAccount),
    })
    .rpc({ skipPreflight: true, commitment: "confirmed" });
  debug("verifyPair tx submitted", { signature: verifySig });

  await waitForSignatureConfirmedLowLevel(session.provider.connection, verifySig);
  debug("verifyPair tx confirmed", { signature: verifySig });

  const finalizationPromise = postArcium({
    action: "awaitFinalization",
    programId: session.program.programId.toBase58(),
    computationOffset: computationOffset.toString(),
    verifySignature: verifySig,
  })
    .then(() => {
      debug("awaitFinalization done", { computationOffset: computationOffset.toString() });
      return true;
    })
    .catch((cause) => {
      const message = cause instanceof Error ? cause.message : "awaitFinalization failed";
      debug("awaitFinalization warning", {
        computationOffset: computationOffset.toString(),
        error: message,
      });
      return false;
    });

  let pairEvent: PairVerifiedEvent;
  try {
    pairEvent = await withTimeout(
      pairEventPromise,
      45_000,
      "Timed out waiting for pair verification event"
    );
  } catch (cause) {
    debug("pairVerified listener timed out; scanning recent confirmed logs", {
      roundState: session.roundState.toBase58(),
      roundId: session.roundId.toString(),
      computationAccount: accountMeta.computationAccount,
    });
    const recoveredEvent = await findPairVerifiedEventFromRecentLogs(
      session,
      new PublicKey(accountMeta.computationAccount),
      45_000
    );
    if (!recoveredEvent) {
      throw cause;
    }
    pairEvent = recoveredEvent;
  }
  debug("pairVerified event received", {
    isMatchCipherLen: Array.from(pairEvent.isMatchCipher).length,
    nonceLen: Array.from(pairEvent.nonce).length,
  });
  await finalizationPromise;

  const payload = await postArcium<{ isMatch: boolean }>({
    action: "decryptPairResult",
    sharedSecretB64: session.sharedSecretB64,
    isMatchCipher: Array.from(pairEvent.isMatchCipher),
    nonce: Array.from(pairEvent.nonce),
  });
  debug("decryptPairResult response", payload);

  return payload.isMatch;
}

export async function settleRoundOnchain(
  session: RoundSession,
  params: {
    turnsUsed: number;
    pairsFound: number;
    completed: boolean;
    solveMs: number;
    pointsDelta: number;
  }
): Promise<void> {
  const nonceHash = randomBytes(32);
  debug("settleRound start", {
    roundId: session.roundId.toString(),
    roundState: session.roundState.toBase58(),
    turnsUsed: params.turnsUsed,
    pairsFound: params.pairsFound,
    completed: params.completed,
    solveMs: params.solveMs,
    pointsDelta: params.pointsDelta,
    nonceHashLen: nonceHash.length,
  });

  const settleSig = await session.program.methods
    .settleRoundScore(
      session.roundId,
      params.turnsUsed,
      params.pairsFound,
      params.completed,
      new anchor.BN(params.solveMs),
      new anchor.BN(params.pointsDelta),
      Array.from(nonceHash)
    )
    .accounts({
      payer: session.provider.wallet.publicKey,
      roundState: session.roundState,
    })
    .rpc({ commitment: "confirmed" });
  debug("settleRoundScore tx confirmed", { signature: settleSig });
}

type PairVerifiedEvent = {
  isMatchCipher: ArrayLike<number>;
  nonce: ArrayLike<number>;
};

async function findPairVerifiedEventFromRecentLogs(
  session: RoundSession,
  computationAccount: PublicKey,
  timeoutMs: number
): Promise<PairVerifiedEvent | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const [roundStateSignatures, computationSignatures] = await Promise.all([
      session.provider.connection.getSignaturesForAddress(
        session.roundState,
        { limit: 30 },
        "finalized"
      ),
      session.provider.connection.getSignaturesForAddress(
        computationAccount,
        { limit: 30 },
        "finalized"
      ),
    ]);
    const seen = new Set<string>();
    const signatures = [...roundStateSignatures, ...computationSignatures].filter((sig) => {
      if (seen.has(sig.signature)) return false;
      seen.add(sig.signature);
      return true;
    });

    for (const signatureInfo of signatures) {
      const tx = await session.provider.connection.getTransaction(signatureInfo.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      const logs = tx?.meta?.logMessages;
      if (!logs || logs.length === 0) continue;

      const parsedEvents = session.program.coder.events.parseLogs(logs);
      for (const parsedEvent of parsedEvents) {
        if (parsedEvent.name !== "pairVerified") continue;
        const payload = parsedEvent.data as {
          roundId?: anchor.BN | { toString: () => string };
          isMatchCipher?: ArrayLike<number>;
          nonce?: ArrayLike<number>;
        };

        if (!payload.roundId || !payload.isMatchCipher || !payload.nonce) continue;
        if (payload.roundId.toString() !== session.roundId.toString()) continue;

        return {
          isMatchCipher: payload.isMatchCipher,
          nonce: payload.nonce,
        };
      }
    }

    await sleep(1_500);
  }

  return null;
}

async function awaitPairVerifiedEvent(program: Program): Promise<PairVerifiedEvent> {
  let listenerId = -1;
  try {
    debug("listening for pairVerified event");
    const payload = await new Promise<PairVerifiedEvent>((resolve) => {
      listenerId = program.addEventListener("pairVerified", (event) => {
        resolve(event as PairVerifiedEvent);
      });
    });
    debug("pairVerified event listener resolved");
    return payload;
  } finally {
    if (listenerId >= 0) {
      await program.removeEventListener(listenerId);
      debug("pairVerified event listener removed", { listenerId });
    }
  }
}

function deserializeLEToBN(bytes: Uint8Array): anchor.BN {
  let value = BigInt(0);
  for (let i = 0; i < bytes.length; i += 1) {
    value |= BigInt(bytes[i]) << BigInt(i * 8);
  }
  return new anchor.BN(value.toString());
}
