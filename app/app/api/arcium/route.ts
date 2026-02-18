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
const LOG_PREFIX = "[arcium-api]";
const ENCRYPTION_ENV_KEYS = ["ARCIUM_X25519_PRIVATE_KEY", "PRIVATE_KEY"] as const;

type Body = {
  action?: string;
  programId?: string;
  deckPairIds?: number[];
  computationOffset?: string;
  sharedSecretB64?: string;
  isMatchCipher?: number[];
  nonce?: number[];
};

function debug(message: string, data?: Record<string, unknown>): void {
  if (data) {
    console.log(`${LOG_PREFIX} ${message}`, data);
    return;
  }
  console.log(`${LOG_PREFIX} ${message}`);
}

function parsePrivateKey(raw: string): Uint8Array | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // JSON numeric array: [1,2,...]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed) as number[];
      if (Array.isArray(parsed) && parsed.length === 32) {
        return Uint8Array.from(parsed);
      }
    } catch {
      // continue to other formats
    }
  }

  // comma separated numeric array: 1,2,3,...
  if (trimmed.includes(",")) {
    const parts = trimmed.split(",").map((part) => Number(part.trim()));
    if (parts.length === 32 && parts.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
      return Uint8Array.from(parts);
    }
  }

  // hex string (with or without 0x)
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }

  // base64
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) {
      return Uint8Array.from(decoded);
    }
  } catch {
    // ignore
  }

  return null;
}

function getEncryptionPrivateKeyFromEnv(): {
  privateKey: Uint8Array | null;
  source: string;
} {
  for (const envKey of ENCRYPTION_ENV_KEYS) {
    const value = process.env[envKey];
    if (!value) continue;
    const parsed = parsePrivateKey(value);
    if (parsed) {
      return { privateKey: parsed, source: envKey };
    }
    return { privateKey: null, source: `${envKey}:invalid` };
  }
  return { privateKey: null, source: "random" };
}

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
  const startedAt = Date.now();
  try {
    const body = (await request.json()) as Body;
    debug("request received", {
      action: body.action ?? "unknown",
      programId: body.programId ?? null,
    });

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
        debug("prepareRound start", {
          endpoint: provider.connection.rpcEndpoint,
          programId: programId.toBase58(),
          deckSize: body.deckPairIds.length,
        });
        const mxePublicKey = await getMXEPublicKeyWithRetry(provider, programId);
        debug("prepareRound mxe key fetched", { mxePublicKeyLen: mxePublicKey.length });

        const envPrivateKey = getEncryptionPrivateKeyFromEnv();
        const privateKey = envPrivateKey.privateKey ?? x25519.utils.randomSecretKey();
        const publicKey = x25519.getPublicKey(privateKey);
        const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
        const cipher = new RescueCipher(sharedSecret);
        debug("prepareRound encryption key source", {
          source: envPrivateKey.source,
          keyLen: privateKey.length,
          publicKeyLen: publicKey.length,
        });

        const boardNonce = randomBytes(16);
        const encryptedBoardSlotA = body.deckPairIds.map((pairId) =>
          Array.from(cipher.encrypt([BigInt(pairId), BigInt(pairId)], boardNonce)[0])
        );
        const encryptedBoardSlotB = body.deckPairIds.map((pairId) =>
          Array.from(cipher.encrypt([BigInt(pairId), BigInt(pairId)], boardNonce)[1])
        );
        debug("prepareRound encrypted board", {
          boardNonceLen: boardNonce.length,
          slotALen: encryptedBoardSlotA.length,
          slotBLen: encryptedBoardSlotB.length,
        });

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
        debug("deriveVerifyAccounts start", {
          programId: programId.toBase58(),
          computationOffset: computationOffset.toString(),
          arciumClusterOffset,
        });

        const accounts = {
          computationAccount: getComputationAccAddress(arciumClusterOffset, computationOffset).toBase58(),
          clusterAccount: getClusterAccAddress(arciumClusterOffset).toBase58(),
          mxeAccount: getMXEAccAddress(programId).toBase58(),
          mempoolAccount: getMempoolAccAddress(arciumClusterOffset).toBase58(),
          executingPool: getExecutingPoolAccAddress(arciumClusterOffset).toBase58(),
          compDefAccount: getCompDefAccAddress(
            programId,
            Buffer.from(getCompDefAccOffset("verify_pair")).readUInt32LE()
          ).toBase58(),
        };
        debug("deriveVerifyAccounts result", accounts);
        return NextResponse.json(accounts);
      }

      case "awaitFinalization": {
        if (!body.programId || !body.computationOffset) {
          throw new Error("Missing programId or computationOffset");
        }

        const provider = getProvider();
        debug("awaitFinalization start", {
          endpoint: provider.connection.rpcEndpoint,
          programId: body.programId,
          computationOffset: body.computationOffset,
        });
        await awaitComputationFinalization(
          provider,
          new anchor.BN(body.computationOffset),
          new PublicKey(body.programId),
          "confirmed"
        );
        debug("awaitFinalization completed");

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
        const isMatch = value === BigInt(1);
        debug("decryptPairResult completed", {
          sharedSecretBytes: sharedSecret.length,
          cipherLen: body.isMatchCipher.length,
          nonceLen: body.nonce.length,
          isMatch,
        });

        return NextResponse.json({ isMatch });
      }

      default:
        throw new Error("Unsupported action");
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Unexpected server error";
    debug("request failed", {
      error: message,
      elapsedMs: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status: 400 });
  } finally {
    debug("request completed", {
      elapsedMs: Date.now() - startedAt,
    });
  }
}
