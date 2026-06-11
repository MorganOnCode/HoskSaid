"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const NAV = [
  { href: "/", label: "Ask" },
  { href: "/library", label: "Library" },
  { href: "/topics", label: "Topics" },
  { href: "/timeline", label: "Timeline" },
  { href: "/agents", label: "Agents" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

/** Toggle theme-dark / theme-light on <html>, persisted to localStorage. */
function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  // Sync from whatever the no-FOUC inline script already applied.
  useEffect(() => {
    setTheme(document.documentElement.classList.contains("theme-light") ? "light" : "dark");
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    const el = document.documentElement;
    el.classList.toggle("theme-dark", next === "dark");
    el.classList.toggle("theme-light", next === "light");
    try { localStorage.setItem("hosk.theme", next); } catch { /* ignore */ }
    setTheme(next);
  }

  return (
    <button className="icon-btn" onClick={toggle} aria-label="Toggle theme" title="Toggle theme">
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}

export function SiteHeader() {
  const pathname = usePathname() || "/";
  return (
    <header className="appbar">
      <div className="appbar-in">
        <Link className="brand" href="/">
          <Image className="brand-mark" src="/images/logo-mark.png" alt="thehosksaid" width={40} height={40} priority />
          <span className="name"><b>thehosk</b>said<span className="tld">.com</span></span>
        </Link>
        <nav className="nav">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={isActive(pathname, item.href) ? "active" : ""}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="spacer" />
        <div className="appbar-right">
          <span className="scope-chip"><span className="dotc" />LIVE INDEX</span>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
