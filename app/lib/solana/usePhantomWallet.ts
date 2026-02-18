"use client";

import { useCallback, useMemo, useState } from "react";
import { Keypair } from "@solana/web3.js";

import type { WalletLike } from "@/lib/chain/client";

const STORAGE_KEY = "matrix_local_wallet_secret_v1";
const LOG_PREFIX = "[local-wallet]";

type UsePhantomWalletResult = {
  wallet: WalletLike | null;
  resetWallet: () => void;
};

function debug(message: string, data?: Record<string, unknown>): void {
  if (data) {
    console.log(`${LOG_PREFIX} ${message}`, data);
    return;
  }
  console.log(`${LOG_PREFIX} ${message}`);
}

function loadOrCreateKeypair(): Keypair {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as number[];
    if (Array.isArray(parsed) && parsed.length === 64) {
      const loaded = Keypair.fromSecretKey(Uint8Array.from(parsed));
      debug("loaded existing keypair from localStorage", {
        publicKey: loaded.publicKey.toBase58(),
      });
      return loaded;
    }
  }

  const keypair = Keypair.generate();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(keypair.secretKey)));
  debug("generated new keypair and saved to localStorage", {
    publicKey: keypair.publicKey.toBase58(),
  });
  return keypair;
}

function toWalletLike(keypair: Keypair): WalletLike {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async <T>(tx: T): Promise<T> => {
      debug("signTransaction called");
      const anyTx = tx as { sign?: (s: Keypair[]) => void; partialSign?: (s: Keypair) => void };
      if (typeof anyTx.sign === "function") {
        anyTx.sign([keypair]);
      } else if (typeof anyTx.partialSign === "function") {
        anyTx.partialSign(keypair);
      }
      return tx;
    },
    signAllTransactions: async <T>(txs: T[]): Promise<T[]> => {
      debug("signAllTransactions called", { txCount: txs.length });
      for (const tx of txs) {
        const anyTx = tx as { sign?: (s: Keypair[]) => void; partialSign?: (s: Keypair) => void };
        if (typeof anyTx.sign === "function") {
          anyTx.sign([keypair]);
        } else if (typeof anyTx.partialSign === "function") {
          anyTx.partialSign(keypair);
        }
      }
      return txs;
    },
  };
}

export function usePhantomWallet(): UsePhantomWalletResult {
  const [keypair, setKeypair] = useState<Keypair | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const kp = loadOrCreateKeypair();
      debug("wallet ready", { publicKey: kp.publicKey.toBase58() });
      return kp;
    } catch (error) {
      console.error("[local-wallet] failed to init keypair", error);
      return null;
    }
  });

  const resetWallet = useCallback(() => {
    if (typeof window === "undefined") return;
    const next = Keypair.generate();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(next.secretKey)));
    debug("wallet reset with new keypair", { publicKey: next.publicKey.toBase58() });
    setKeypair(next);
  }, []);

  const wallet = useMemo<WalletLike | null>(() => {
    if (!keypair) return null;
    return toWalletLike(keypair);
  }, [keypair]);

  return {
    wallet,
    resetWallet,
  };
}
