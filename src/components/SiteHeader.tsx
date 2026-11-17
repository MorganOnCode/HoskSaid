"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

const NAV = [
  { href: "/", label: "Ask" },
  { href: "/library", label: "Library" },
  { href: "/analytics", label: "Analytics" },
  { href: "/timeline", label: "Timeline" },
  { href: "/agents", label: "Agents" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

// The pre-hydration inline script sets theme-dark/theme-light on <html>; read it
// as an external store so server and client render consistently.
function subscribeTheme(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => obs.disconnect();
}
const themeSnapshot = () => (document.documentElement.classList.contains("theme-light") ? "light" : "dark");
const serverTheme = () => "dark" as const;

/** Toggle theme-dark / theme-light on <html>, persisted to localStorage. */
function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, themeSnapshot, serverTheme);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    const el = document.documentElement;
    el.classList.toggle("theme-dark", next === "dark");
    el.classList.toggle("theme-light", next === "light");
    try { localStorage.setItem("hosk.theme", next); } catch { /* ignore */ }
  }

  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <button className="icon-btn" type="button" onClick={toggle} aria-label={label} title={label}>
      <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
    </button>
  );
}

export function SiteHeader() {
  const pathname = usePathname() || "/";
  // The menu is "open for" one pathname, so navigating anywhere closes it.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === pathname;

  return (
    <header
      className="appbar"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) setOpenFor(null);
      }}
    >
      <div className="appbar-in">
        <Link className="brand" href="/">
          <Image className="brand-mark" src="/images/logo-mark.png" alt="" width={40} height={40} priority />
          <span className="name"><b>thehosk</b>said<span className="tld">.com</span></span>
        </Link>
        <nav className={"nav" + (open ? " open" : "")} id="site-nav" aria-label="Main">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link key={item.href} href={item.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="spacer" />
        <div className="appbar-right">
          <span className="scope-chip"><span className="dotc" />LIVE INDEX</span>
          <ThemeToggle />
          <button
            type="button"
            className="icon-btn menu-btn"
            aria-expanded={open}
            aria-controls="site-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpenFor(open ? null : pathname)}
          >
            <span aria-hidden="true">{open ? "✕" : "☰"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
