import type { Metadata } from "next";
import { Newsreader, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

const display = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  weight: ["400", "500"],
  variable: "--font-display",
  display: "swap",
});
const ui = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://thehosksaid.com"),
  title: {
    default: "thehosksaid — Ask the archive of Charles Hoskinson's videos",
    template: "%s — thehosksaid",
  },
  description:
    "An independent, AI-generated transcript index of Charles Hoskinson's public videos. Ask a question and get a synthesized, citation-backed answer drawn from timestamped transcripts.",
  keywords: ["Charles Hoskinson", "Cardano", "transcripts", "AMA", "governance", "research"],
  openGraph: {
    title: "thehosksaid — Ask the archive",
    description: "Synthesized, citation-backed answers from timestamped transcripts of Charles Hoskinson's public videos.",
    type: "website",
    url: "https://thehosksaid.com",
  },
};

// Applied before hydration so there is no flash of the wrong theme.
const themeScript = `(function(){try{var e=document.documentElement;var t=localStorage.getItem('hosk.theme');e.classList.add(t==='light'?'theme-light':'theme-dark');if(localStorage.getItem('hosk.density')==='compact')e.classList.add('density-compact');}catch(_){document.documentElement.classList.add('theme-dark');}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${display.variable} ${ui.variable} ${mono.variable}`}>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
