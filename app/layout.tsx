import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Northstar Discovery & Replay Console",
  description: "Goal-driven computer-use discovery and deterministic capability replay for a synthetic legacy credit-union application.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
