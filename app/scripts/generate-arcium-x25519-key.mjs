import { x25519 } from "@arcium-hq/client";

const privateKey = x25519.utils.randomSecretKey();
const hex = Buffer.from(privateKey).toString("hex");
const base64 = Buffer.from(privateKey).toString("base64");
const jsonArray = JSON.stringify(Array.from(privateKey));

console.log("ARCIUM X25519 private key generated.");
console.log("");
console.log("Recommended (.env, hex):");
console.log(`ARCIUM_X25519_PRIVATE_KEY=${hex}`);
console.log("");
console.log("Other supported formats:");
console.log(`base64: ${base64}`);
console.log(`json:   ${jsonArray}`);
