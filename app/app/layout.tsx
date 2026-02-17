import type { Metadata } from "next";

import SolanaProviders from "@/components/SolanaProviders";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cipher Memory Match",
  description: "Onchain memory game using Arcium confidential pair checks",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <SolanaProviders>{children}</SolanaProviders>
      </body>
    </html>
  );
}
