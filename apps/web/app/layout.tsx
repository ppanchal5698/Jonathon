import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jonathon",
  description: "Local-first client knowledge and requirements platform",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning covers only these two elements' own attributes: browser extensions
    // (e.g. ColorZilla's cz-shortcut-listen) add attributes to <body> before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
