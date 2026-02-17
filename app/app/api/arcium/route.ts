import { randomBytes } from "node:crypto";

import * as anchor from "@coral-xyz/anchor";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  RescueCipher,
  x25519,
} from "@arcium-hq/client";
import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

export const runtime = "nodejs";

const CARD_COUNT = 16;

type Body = {
  action?: string;
  programId?: string;
  deckPairIds?: number[];
  computationOffset?: string;
  sharedSecretB64?: string;
  isMatchCipher?: number[];
  nonce?: number[];
};

function getProvider(): anchor.AnchorProvider {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new anchor.web3.Connection(endpoint, "confirmed");
  const kp = anchor.web3.Keypair.generate();

  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async <T>(tx: T): Promise<T> => tx,
    signAllTransactions: async <T>(txs: T[]): Promise<T[]> => txs,
  };

  return new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
}

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) {
        return mxePublicKey;
      }
    } catch {
      // retry
    }
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;

    switch (body.action) {
      case "prepareRound": {
        if (!body.programId || !Array.isArray(body.deckPairIds)) {
          throw new Error("Missing programId or deckPairIds");
        }
        if (body.deckPairIds.length !== CARD_COUNT) {
          throw new Error(`Expected ${CARD_COUNT} deck entries`);
        }

        const provider = getProvider();
        const programId = new PublicKey(body.programId);
        const mxePublicKey = await getMXEPublicKeyWithRetry(provider, programId);

        const privateKey = x25519.utils.randomSecretKey();
        const publicKey = x25519.getPublicKey(privateKey);
        const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
        const cipher = new RescueCipher(sharedSecret);

        const boardNonce = randomBytes(16);
        const encryptedBoardSlotA = body.deckPairIds.map((pairId) =>
          Array.from(cipher.encrypt([BigInt(pairId), BigInt(pairId)], boardNonce)[0])
        );
        const encryptedBoardSlotB = body.deckPairIds.map((pairId) =>
          Array.from(cipher.encrypt([BigInt(pairId), BigInt(pairId)], boardNonce)[1])
        );

        return NextResponse.json({
          sharedSecretB64: Buffer.from(sharedSecret).toString("base64"),
          publicKey: Array.from(publicKey),
          boardNonce: Array.from(boardNonce),
          encryptedBoardSlotA,
          encryptedBoardSlotB,
        });
      }

      case "deriveVerifyAccounts": {
        if (!body.programId || !body.computationOffset) {
          throw new Error("Missing programId or computationOffset");
        }

        const programId = new PublicKey(body.programId);
        const computationOffset = new anchor.BN(body.computationOffset);
        const arciumClusterOffset = getArciumEnv().arciumClusterOffset;

        return NextResponse.json({
          computationAccount: getComputationAccAddress(arciumClusterOffset, computationOffset).toBase58(),
          clusterAccount: getClusterAccAddress(arciumClusterOffset).toBase58(),
          mxeAccount: getMXEAccAddress(programId).toBase58(),
          mempoolAccount: getMempoolAccAddress(arciumClusterOffset).toBase58(),
          executingPool: getExecutingPoolAccAddress(arciumClusterOffset).toBase58(),
          compDefAccount: getCompDefAccAddress(
            programId,
            Buffer.from(getCompDefAccOffset("verify_pair")).readUInt32LE()
          ).toBase58(),
        });
      }

      case "awaitFinalization": {
        if (!body.programId || !body.computationOffset) {
          throw new Error("Missing programId or computationOffset");
        }

        const provider = getProvider();
        await awaitComputationFinalization(
          provider,
          new anchor.BN(body.computationOffset),
          new PublicKey(body.programId),
          "confirmed"
        );

        return NextResponse.json({ ok: true });
      }

      case "decryptPairResult": {
        if (!body.sharedSecretB64 || !body.isMatchCipher || !body.nonce) {
          throw new Error("Missing decrypt inputs");
        }
        if (!Array.isArray(body.isMatchCipher) || !Array.isArray(body.nonce)) {
          throw new Error("decrypt inputs must be number arrays");
        }

        const sharedSecret = Buffer.from(body.sharedSecretB64, "base64");
        const cipher = new RescueCipher(sharedSecret);
        const value = cipher.decrypt([body.isMatchCipher], Uint8Array.from(body.nonce))[0];

        return NextResponse.json({ isMatch: value === BigInt(1) });
      }

      default:
        throw new Error("Unsupported action");
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Unexpected server error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
