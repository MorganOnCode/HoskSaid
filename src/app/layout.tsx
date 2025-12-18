import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from "next/link";

const inter = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "HoskSaid - Charles Hoskinson Transcript Library",
  description: "Search and explore transcripts from Charles Hoskinson's YouTube videos. A research tool for the Cardano community.",
  keywords: ["Charles Hoskinson", "Cardano", "transcripts", "blockchain", "cryptocurrency", "research"],
  openGraph: {
    title: "HoskSaid - Charles Hoskinson Transcript Library",
    description: "Search and explore transcripts from Charles Hoskinson's YouTube videos.",
    type: "website",
  },
};

function Header() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 glass">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 group">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-primary)] flex items-center justify-center">
              <span className="text-white font-bold text-sm">H</span>
            </div>
            <span className="font-semibold text-lg">
              Hosk<span className="text-[var(--color-accent)]">Said</span>
            </span>
          </Link>

          {/* Navigation */}
          <nav className="flex items-center gap-6">
            <Link
              href="/videos"
              className="text-sm text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
            >
              Videos
            </Link>
            <Link
              href="/search"
              className="text-sm text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
            >
              Search
            </Link>
            <Link
              href="/search"
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-[var(--background-tertiary)] border border-[var(--border)] text-sm text-[var(--foreground-muted)] hover:border-[var(--color-primary)] transition-all"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <span className="hidden sm:inline">Quick Search</span>
            </Link>
          </nav>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[var(--border)] mt-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-primary)] flex items-center justify-center">
              <span className="text-white font-bold text-xs">H</span>
            </div>
            <span className="text-sm text-[var(--foreground-muted)]">
              HoskSaid — A community research tool
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm text-[var(--foreground-muted)]">
            <a
              href="https://www.youtube.com/@charleshoskinson"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--color-accent)] transition-colors"
            >
              Charles Hoskinson YouTube
            </a>
            <a
              href="https://cardano.org"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--color-accent)] transition-colors"
            >
              Cardano.org
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} antialiased min-h-screen`}>
        <Header />
        <main className="pt-16">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}
