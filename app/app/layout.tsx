import type { Metadata } from "next";

import PwaRegistration from "@/components/PwaRegistration";
import SolanaProviders from "@/components/SolanaProviders";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cipher Memory Match",
  description: "Onchain memory game using Arcium confidential pair checks",
  manifest: "/manifest.webmanifest",
  themeColor: "#020617",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Cipher Match",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <PwaRegistration />
        <SolanaProviders>{children}</SolanaProviders>
      </body>
    </html>
  );
}
