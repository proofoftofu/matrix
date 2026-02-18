import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";

import {
  getArciumAccountBaseSeed,
  getArciumProgram,
  getArciumProgramId,
  getCompDefAccOffset,
  getLookupTableAddress,
  getMXEAccAddress,
  getRawCircuitAccAddress,
  uploadCircuit,
} from "@arcium-hq/client";
import { Blockchain } from "../target/types/blockchain";

describe("init verify_pair comp-def", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Blockchain as Program<Blockchain>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumProgram = getArciumProgram(provider);

  it("initializes verify_pair comp-def (and uploads circuit)", async () => {
    const owner = readKpJson(process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`);
    const lamports = await provider.connection.getBalance(owner.publicKey, "confirmed");
    const providerWallet = provider.wallet.publicKey.toBase58();
    console.log("[init] wallet:", owner.publicKey.toBase58());
    console.log("[init] provider wallet:", providerWallet);
    console.log("[init] wallet balance (SOL):", lamports / anchor.web3.LAMPORTS_PER_SOL);
    console.log("[init] program id:", program.programId.toBase58());
    if (providerWallet !== owner.publicKey.toBase58()) {
      throw new Error(
        `[init] Provider wallet (${providerWallet}) does not match owner signer (${owner.publicKey.toBase58()}). Set ANCHOR_WALLET to the signer you want to pay upload/resize fees.`
      );
    }

    const baseSeedCompDefAcc = getArciumAccountBaseSeed("ComputationDefinitionAccount");
    const offset = getCompDefAccOffset("verify_pair");

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgramId()
    )[0];

    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);

    const existingCompDef = await provider.connection.getAccountInfo(compDefPDA, "confirmed");
    if (!existingCompDef) {
      const sig = await program.methods
        .initVerifyPairCompDef()
        .accounts({
          compDefAccount: compDefPDA,
          payer: owner.publicKey,
          mxeAccount,
          addressLookupTable: lutAddress,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });
      console.log("[init] init_verify_pair_comp_def tx:", sig);
    } else {
      console.log("[init] comp-def already exists:", compDefPDA.toBase58());
    }

    if (process.env.SKIP_UPLOAD_CIRCUIT === "1") {
      console.log("[init] skipped uploadCircuit because SKIP_UPLOAD_CIRCUIT=1");
      return;
    }

    const rawCircuit = fs.readFileSync("build/verify_pair.arcis");
    const compDef = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPDA);
    const sourceVariant = "onChain" in compDef.circuitSource
      ? "OnChain"
      : "offChain" in compDef.circuitSource
        ? "OffChain"
        : "Local";
    const finalizationAuthority = compDef.finalizationAuthority
      ? compDef.finalizationAuthority.toBase58()
      : "None";
    console.log("[init] comp-def finalization authority:", finalizationAuthority);
    console.log("[init] comp-def circuit source:", sourceVariant);

    try {
      await uploadCircuit(
        provider,
        "verify_pair",
        program.programId,
        rawCircuit,
        true,
        500,
        {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          commitment: "confirmed",
        }
      );
      console.log("[init] verify_pair circuit uploaded");
    } catch (error) {
      console.error("[init] uploadCircuit failed:", error);
      console.error(
        "[init] If this still says 'Unknown action undefined', treat it as a wrapped transaction failure. Check wallet SOL/rent and comp-def authority logs above."
      );
      throw error;
    }

    await verifyCircuitHashConsistency({
      provider,
      compDefPDA,
      localRawCircuit: rawCircuit,
      localHashPath: "build/verify_pair.hash",
    });
  });
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

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(new Uint8Array(JSON.parse(file.toString())));
}
