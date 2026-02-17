import * as anchor from "@coral-xyz/anchor/dist/browser/index.js";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { Buffer } from "buffer";

import blockchainIdl from "@/lib/idl/blockchain.json";
import { CARD_COUNT, type Card } from "@/lib/game/logic";

const ROUND_STATE_SEED = "round_state";

type Program = anchor.Program;
type Provider = anchor.AnchorProvider;

type DeriveAccountsResponse = {
  computationAccount: string;
  clusterAccount: string;
  mxeAccount: string;
  mempoolAccount: string;
  executingPool: string;
  compDefAccount: string;
};

type PrepareRoundResponse = {
  sharedSecretB64: string;
  boardNonce: number[];
  publicKey: number[];
  encryptedBoardSlotA: number[][];
  encryptedBoardSlotB: number[][];
};

export type RoundSession = {
  program: Program;
  provider: Provider;
  roundId: anchor.BN;
  roundState: PublicKey;
  sharedSecretB64: string;
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

function createProgram(wallet: AnchorWallet, connection: anchor.web3.Connection): {
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
  const response = await fetch("/api/arcium", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `API request failed (${response.status})`);
  }

  return (await response.json()) as T;
}

export async function registerRoundOnchain(params: {
  wallet: AnchorWallet;
  connection: anchor.web3.Connection;
  deck: Card[];
}): Promise<RoundSession> {
  const { wallet, connection, deck } = params;
  if (deck.length !== CARD_COUNT) {
    throw new Error(`Deck must contain exactly ${CARD_COUNT} cards`);
  }

  const { provider, program } = createProgram(wallet, connection);
  const roundCrypto = await postArcium<PrepareRoundResponse>({
    action: "prepareRound",
    programId: program.programId.toBase58(),
    deckPairIds: deck.map((card) => card.pairId),
  });

  const roundId = randomU64BN();
  const roundState = getRoundStatePda(program.programId, wallet.publicKey, roundId);

  await program.methods
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

  await program.methods
    .setRoundSlotB(roundId, roundCrypto.encryptedBoardSlotB)
    .accounts({
      payer: wallet.publicKey,
      roundState,
    })
    .rpc({ commitment: "confirmed" });

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
  const pairEventPromise = awaitPairVerifiedEvent(session.program);
  const computationOffset = randomU64BN();
  const turnNonce = randomBytes(16);

  const accountMeta = await postArcium<DeriveAccountsResponse>({
    action: "deriveVerifyAccounts",
    programId: session.program.programId.toBase58(),
    computationOffset: computationOffset.toString(),
  });

  await session.program.methods
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

  await postArcium({
    action: "awaitFinalization",
    programId: session.program.programId.toBase58(),
    computationOffset: computationOffset.toString(),
  });

  const pairEvent = await pairEventPromise;
  const payload = await postArcium<{ isMatch: boolean }>({
    action: "decryptPairResult",
    sharedSecretB64: session.sharedSecretB64,
    isMatchCipher: Array.from(pairEvent.isMatchCipher),
    nonce: Array.from(pairEvent.nonce),
  });

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

  await session.program.methods
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
}

type PairVerifiedEvent = {
  isMatchCipher: ArrayLike<number>;
  nonce: ArrayLike<number>;
};

async function awaitPairVerifiedEvent(program: Program): Promise<PairVerifiedEvent> {
  let listenerId = -1;
  try {
    const payload = await new Promise<PairVerifiedEvent>((resolve) => {
      listenerId = program.addEventListener("pairVerified", (event) => {
        resolve(event as PairVerifiedEvent);
      });
    });
    return payload;
  } finally {
    if (listenerId >= 0) {
      await program.removeEventListener(listenerId);
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
