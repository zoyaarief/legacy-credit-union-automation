import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Northstar Computer-Use Control Plane",
  description: "Goal-driven discovery, deterministic replay, durable evidence, and same-session human handoff for a synthetic legacy credit-union application.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
