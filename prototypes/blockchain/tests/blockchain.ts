import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";

import {
  awaitComputationFinalization,
  deserializeLE,
  getArciumAccountBaseSeed,
  getArciumEnv,
  getArciumProgram,
  getArciumProgramId,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getLookupTableAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  getRawCircuitAccAddress,
  RescueCipher,
  uploadCircuit,
  x25519,
} from "@arcium-hq/client";
import { Blockchain } from "../target/types/blockchain";

const ROUND_STATE_SEED = "round_state";

function fixtureDeck(): number[] {
  return [0, 1, 0, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7];
}

describe("Blockchain", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Blockchain as Program<Blockchain>;
  const provider = anchor.getProvider();
  const arciumProgram = getArciumProgram(provider as anchor.AnchorProvider);

  type Event = anchor.IdlEvents<(typeof program)["idl"]>;
  const awaitEvent = async <E extends keyof Event>(
    eventName: E
  ): Promise<Event[E]> => {
    let listenerId: number;
    const event = await new Promise<Event[E]>((res) => {
      listenerId = program.addEventListener(eventName, (payload) =>
        res(payload)
      );
    });
    await program.removeEventListener(listenerId);
    return event;
  };

  const arciumEnv = getArciumEnv();
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);

  it("registers encrypted cards, verifies pair matches/non-matches, and settles round", async () => {
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
    const roundId = new anchor.BN(randomBytes(8), "hex");
    const roundState = getRoundStatePda(
      program.programId,
      owner.publicKey,
      roundId
    );

    await initVerifyPairCompDef(program, owner);

    const mxePublicKey = await getMXEPublicKeyWithRetry(
      provider as anchor.AnchorProvider,
      program.programId
    );
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

    const boardNonce = randomBytes(16);
    const deck = fixtureDeck();
    // Arcium encrypted args are position-bound; precompute per card variants
    // for slot A (input field 0) and slot B (input field 1).
    const encryptedBoardSlotA = deck.map(
      (value) => cipher.encrypt([BigInt(value), BigInt(value)], boardNonce)[0]
    );
    const encryptedBoardSlotB = deck.map(
      (value) => cipher.encrypt([BigInt(value), BigInt(value)], boardNonce)[1]
    );
    console.log("[debug] fixture deck:", deck.join(","));

    await program.methods
      .registerRound(
        roundId,
        encryptedBoardSlotA.map((cell) => Array.from(cell)),
        Array.from(publicKey),
        Array.from(boardNonce)
      )
      .accounts({
        payer: owner.publicKey,
        roundState,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    console.log("[debug] register_round done");

    await program.methods
      .setRoundSlotB(
        roundId,
        encryptedBoardSlotB.map((cell) => Array.from(cell))
      )
      .accounts({
        payer: owner.publicKey,
        roundState,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    console.log("[debug] set_round_slot_b done");

    const matchValue = await verifyPairAndDecrypt({
      program,
      roundId,
      roundState,
      owner,
      cardAIndex: 0,
      cardBIndex: 2,
      cipher,
      clusterAccount,
      arciumClusterOffset: arciumEnv.arciumClusterOffset,
    });
    console.log("[debug] match result card(0,2):", matchValue.toString());
    expect(matchValue).to.equal(1n);

    const nonMatchValue = await verifyPairAndDecrypt({
      program,
      roundId,
      roundState,
      owner,
      cardAIndex: 0,
      cardBIndex: 1,
      cipher,
      clusterAccount,
      arciumClusterOffset: arciumEnv.arciumClusterOffset,
    });
    console.log("[debug] non-match result card(0,1):", nonMatchValue.toString());
    expect(nonMatchValue).to.equal(0n);

    const nonceHash = randomBytes(32);
    const settleEventPromise = awaitEvent("roundSettled");
    await program.methods
      .settleRoundScore(
        roundId,
        2,
        1,
        false,
        new anchor.BN(30000),
        new anchor.BN(120),
        Array.from(nonceHash)
      )
      .accounts({
        payer: owner.publicKey,
        roundState,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    const settleEvent = await settleEventPromise;
    expect(settleEvent.roundId.toString()).to.equal(roundId.toString());
    expect(settleEvent.turnsUsed).to.equal(2);
    expect(settleEvent.pairsFound).to.equal(1);

    const roundAcc = await program.account.roundState.fetch(roundState);
    expect(roundAcc.turnsUsed).to.equal(2);
    expect(roundAcc.pairsFound).to.equal(1);
  });

  async function initVerifyPairCompDef(
    targetProgram: Program<Blockchain>,
    owner: anchor.web3.Keypair
  ): Promise<void> {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset("verify_pair");

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, targetProgram.programId.toBuffer(), offset],
      getArciumProgramId()
    )[0];

    const mxeAccount = getMXEAccAddress(targetProgram.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(
      targetProgram.programId,
      mxeAcc.lutOffsetSlot
    );

    const existingCompDef = await provider.connection.getAccountInfo(
      compDefPDA,
      "confirmed"
    );
    if (!existingCompDef) {
      await targetProgram.methods
        .initVerifyPairCompDef()
        .accounts({
          compDefAccount: compDefPDA,
          payer: owner.publicKey,
          mxeAccount,
          addressLookupTable: lutAddress,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });
    }

    const rawCircuit = fs.readFileSync("build/verify_pair.arcis");
    await uploadCircuit(
      provider as anchor.AnchorProvider,
      "verify_pair",
      targetProgram.programId,
      rawCircuit,
      true,
      500,
      {
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
      }
    );

    await verifyCircuitHashConsistency({
      provider: provider as anchor.AnchorProvider,
      compDefPDA,
      localRawCircuit: rawCircuit,
      localHashPath: "build/verify_pair.hash",
    });
  }
});

async function verifyCircuitHashConsistency(params: {
  provider: anchor.AnchorProvider;
  compDefPDA: PublicKey;
  localRawCircuit: Buffer;
  localHashPath: string;
}): Promise<void> {
  const { provider, compDefPDA, localRawCircuit, localHashPath } = params;

  const localHashFromRaw = createHash("sha256").update(localRawCircuit).digest();
  const localHashFromFile = Buffer.from(JSON.parse(fs.readFileSync(localHashPath, "utf8")) as number[]);
  if (!localHashFromRaw.equals(localHashFromFile)) {
    throw new Error(
      `[verify] Local hash mismatch: sha256(build/verify_pair.arcis)=${localHashFromRaw.toString("hex")} build/verify_pair.hash=${localHashFromFile.toString("hex")}`
    );
  }

  const arciumProgram = getArciumProgram(provider);
  const compDef = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPDA);
  const circuitLenRaw = compDef.definition.circuitLen as number | { toNumber?: () => number; toString: () => string };
  const circuitLen =
    typeof circuitLenRaw === "number"
      ? circuitLenRaw
      : typeof circuitLenRaw.toNumber === "function"
        ? circuitLenRaw.toNumber()
        : Number(circuitLenRaw.toString());

  if (!Number.isFinite(circuitLen) || circuitLen <= 0) {
    throw new Error(`[verify] Invalid on-chain circuitLen: ${String(circuitLenRaw)}`);
  }

  const chunks: Buffer[] = [];
  let collectedBytes = 0;
  for (let rawIndex = 0; collectedBytes < circuitLen; rawIndex += 1) {
    const rawPda = getRawCircuitAccAddress(compDefPDA, rawIndex);
    const rawAcc = await provider.connection.getAccountInfo(rawPda, "confirmed");
    if (!rawAcc) {
      throw new Error(
        `[verify] Missing raw circuit account index=${rawIndex} (${rawPda.toBase58()}) before reaching circuitLen=${circuitLen}`
      );
    }
    if (rawAcc.data.length <= 9) {
      throw new Error(
        `[verify] Raw circuit account index=${rawIndex} has invalid length ${rawAcc.data.length}`
      );
    }
    const payload = rawAcc.data.subarray(9);
    chunks.push(Buffer.from(payload));
    collectedBytes += payload.length;
  }

  const onchainRaw = Buffer.concat(chunks).subarray(0, circuitLen);
  const onchainHash = createHash("sha256").update(onchainRaw).digest();

  console.log("[verify] local circuit hash:", localHashFromRaw.toString("hex"));
  console.log("[verify] onchain circuit hash:", onchainHash.toString("hex"));
  console.log("[verify] circuit bytes local/onchain:", localRawCircuit.length, onchainRaw.length);

  if (!onchainHash.equals(localHashFromRaw)) {
    throw new Error(
      `[verify] On-chain circuit hash mismatch. local=${localHashFromRaw.toString("hex")} onchain=${onchainHash.toString("hex")}`
    );
  }

  console.log("[verify] on-chain circuit hash matches local build.");
}

async function verifyPairAndDecrypt({
  program,
  roundId,
  roundState,
  owner,
  cardAIndex,
  cardBIndex,
  cipher,
  clusterAccount,
  arciumClusterOffset,
}: {
  program: Program<Blockchain>;
  roundId: anchor.BN;
  roundState: PublicKey;
  owner: anchor.web3.Keypair;
  cardAIndex: number;
  cardBIndex: number;
  cipher: RescueCipher;
  clusterAccount: PublicKey;
  arciumClusterOffset: number;
}): Promise<bigint> {
  type Event = anchor.IdlEvents<(typeof program)["idl"]>;
  const awaitEvent = async <E extends keyof Event>(
    eventName: E
  ): Promise<Event[E]> => {
    let listenerId: number;
    const event = await new Promise<Event[E]>((res) => {
      listenerId = program.addEventListener(eventName, (payload) =>
        res(payload)
      );
    });
    await program.removeEventListener(listenerId);
    return event;
  };

  const pairEventPromise = awaitEvent("pairVerified");
  const computationOffset = new anchor.BN(randomBytes(8), "hex");
  const turnNonce = randomBytes(16);
  console.log(
    `[debug] verify_pair request round=${roundId.toString()} cardA=${cardAIndex} cardB=${cardBIndex} offset=${computationOffset.toString()}`
  );

  await program.methods
    .verifyPair(
      roundId,
      cardAIndex,
      cardBIndex,
      computationOffset,
      new anchor.BN(deserializeLE(turnNonce).toString())
    )
    .accountsPartial({
      payer: owner.publicKey,
      roundState,
      computationAccount: getComputationAccAddress(
        arciumClusterOffset,
        computationOffset
      ),
      clusterAccount,
      mxeAccount: getMXEAccAddress(program.programId),
      mempoolAccount: getMempoolAccAddress(arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(arciumClusterOffset),
      compDefAccount: getCompDefAccAddress(
        program.programId,
        Buffer.from(getCompDefAccOffset("verify_pair")).readUInt32LE()
      ),
    })
    .signers([owner])
    .rpc({ skipPreflight: true, commitment: "confirmed" });

  await awaitComputationFinalization(
    anchor.getProvider() as anchor.AnchorProvider,
    computationOffset,
    program.programId,
    "confirmed"
  );

  const pairEvent = await pairEventPromise;
  const decrypted = cipher.decrypt([pairEvent.isMatchCipher], pairEvent.nonce)[0];
  console.log(
    `[debug] verify_pair response round=${pairEvent.roundId.toString()} turns=${pairEvent.turnsUsed} pairs=${pairEvent.pairsFound} decrypted=${decrypted.toString()}`
  );
  return decrypted;
}

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries: number = 20,
  retryDelayMs: number = 500
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
  throw new Error(
    `Failed to fetch MXE public key after ${maxRetries} attempts`
  );
}

function getRoundStatePda(
  programId: PublicKey,
  payer: PublicKey,
  roundId: anchor.BN
): PublicKey {
  const roundIdLE = Buffer.alloc(8);
  roundIdLE.writeBigUInt64LE(BigInt(roundId.toString()));
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ROUND_STATE_SEED), payer.toBuffer(), roundIdLE],
    programId
  )[0];
}

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(file.toString()))
  );
}
