import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";

import {
  getArciumAccountBaseSeed,
  getArciumProgram,
  getArciumProgramId,
  getCompDefAccOffset,
  getRawCircuitAccAddress,
} from "@arcium-hq/client";

async function main(): Promise<void> {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const programId = new PublicKey("HSPR8gNS9VN8hVRhRiDAWDo17WmTzENCZAdQeNepG8oy");
  const arciumProgram = getArciumProgram(provider);

  const baseSeedCompDefAcc = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("verify_pair");
  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, programId.toBuffer(), offset],
    getArciumProgramId()
  )[0];

  const localRawCircuit = fs.readFileSync("build/verify_pair.arcis");
  const localHashFromRaw = createHash("sha256").update(localRawCircuit).digest();
  const localHashFromFile = Buffer.from(
    JSON.parse(fs.readFileSync("build/verify_pair.hash", "utf8")) as number[]
  );

  console.log("[check] rpc endpoint:", provider.connection.rpcEndpoint);
  console.log("[check] program id:", programId.toBase58());
  console.log("[check] comp-def pda:", compDefPDA.toBase58());
  console.log("[check] local hash from arcis:", localHashFromRaw.toString("hex"));
  console.log("[check] local hash from .hash:", localHashFromFile.toString("hex"));

  if (!localHashFromRaw.equals(localHashFromFile)) {
    throw new Error("Local build mismatch: verify_pair.arcis != verify_pair.hash");
  }

  const compDef = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPDA);
  const circuitLenRaw = compDef.definition.circuitLen as number | { toNumber?: () => number; toString: () => string };
  const circuitLen =
    typeof circuitLenRaw === "number"
      ? circuitLenRaw
      : typeof circuitLenRaw.toNumber === "function"
        ? circuitLenRaw.toNumber()
        : Number(circuitLenRaw.toString());

  if (!Number.isFinite(circuitLen) || circuitLen <= 0) {
    throw new Error(`Invalid on-chain circuit length: ${String(circuitLenRaw)}`);
  }

  const chunks: Buffer[] = [];
  let collectedBytes = 0;
  for (let rawIndex = 0; collectedBytes < circuitLen; rawIndex += 1) {
    const rawPda = getRawCircuitAccAddress(compDefPDA, rawIndex);
    const rawAcc = await provider.connection.getAccountInfo(rawPda, "confirmed");
    if (!rawAcc) {
      throw new Error(`Missing raw circuit account index=${rawIndex} (${rawPda.toBase58()})`);
    }
    const payload = rawAcc.data.subarray(9);
    chunks.push(Buffer.from(payload));
    collectedBytes += payload.length;
  }

  const onchainRaw = Buffer.concat(chunks).subarray(0, circuitLen);
  const onchainHash = createHash("sha256").update(onchainRaw).digest();

  console.log("[check] on-chain hash:", onchainHash.toString("hex"));
  console.log("[check] bytes local/onchain:", localRawCircuit.length, onchainRaw.length);

  if (!onchainHash.equals(localHashFromRaw)) {
    throw new Error(
      `On-chain mismatch: local=${localHashFromRaw.toString("hex")} onchain=${onchainHash.toString("hex")}`
    );
  }

  console.log("[check] hash match: on-chain circuit equals local build");
}

main().catch((error) => {
  console.error("[check] failed:", error);
  process.exit(1);
});
