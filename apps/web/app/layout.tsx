import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme";
import "./globals.css";

// Self-hosted by next/font at build time: browsers never contact Google (CSP stays font-src 'self').
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit-family", display: "swap" });

export const metadata: Metadata = {
  title: "Jonathon",
  description: "Local-first client knowledge and requirements platform",
  robots: { index: false, follow: false },
};

/**
 * Applies the saved theme before first paint so there is no light/dark flash. Static string, no user data.
 * "auto" (default) follows the operating system.
 */
const THEME_BOOT = `(function(){try{var m=localStorage.getItem("jonathon-theme")||"auto";var d=m==="dark"||(m==="auto"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning covers only these two elements' own attributes: the theme class is set before
    // hydration, and browser extensions (e.g. ColorZilla's cz-shortcut-listen) add attributes to <body>.
    <html lang="en" className={outfit.variable} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme bootstrap, contains no user data */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body suppressHydrationWarning>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
