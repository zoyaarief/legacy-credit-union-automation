import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Northstar Computer-Use Automation",
  description: "Goal-driven discovery, typed capability replay, structured evidence, and same-session human handoff for a synthetic legacy credit-union application.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
