"use client";

import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
export const THEME_KEY = "settletop-theme";

/**
 * Light / dark switch.
 *
 * The theme is already resolved and stamped on <html> by the inline script
 * in the root layout before first paint, so this component only has to read
 * that attribute and flip it. It deliberately does not decide the initial
 * value — doing that here would mean rendering one theme and correcting it
 * after hydration, which is the flash the inline script exists to prevent.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const stamped = document.documentElement.getAttribute("data-theme");
    setTheme(stamped === "dark" ? "dark" : "light");
  }, []);

  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode or blocked storage: the choice still applies to this
      // page, it just will not be remembered. Not worth failing over.
    }
    setTheme(next);
  };

  // Until the effect runs we do not know which way round it is. Render the
  // control with no state rather than guessing and flickering.
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="st-theme-toggle"
      onClick={flip}
      aria-pressed={theme === null ? undefined : isDark}
      aria-label={isDark ? "Switch to the light theme" : "Switch to the dark theme"}
      title={isDark ? "Switch to the light theme" : "Switch to the dark theme"}
    >
      <span aria-hidden="true">{isDark ? "☾" : "☀"}</span>
    </button>
  );
}
