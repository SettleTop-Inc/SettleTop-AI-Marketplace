import type { Metadata } from "next";
import "./globals.css";
// Loaded after globals.css so the design system wins at equal specificity.
import "./design.css";

export const metadata: Metadata = {
  title: "SettleTop — Know what you build, buy and borrow",
  description:
    "Understanding your software starts with knowing where it came from. SettleTop traces the provenance of every part of it: your code and the open source beneath it, the vendors behind it, the agents and AI apps you adopt, and the data they run on.",
  // Derived from the logo's alpha channel. The favicon published on
  // settletop.com is a 300x300 JPEG named .ico, which is not a format
  // browsers reliably accept.
  icons: {
    icon: [
      { url: "/brand/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/brand/icon-180.png", sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // suppressHydrationWarning: the inline script in <head> stamps data-theme
  // on <html> before React hydrates, so the server HTML and the client DOM
  // legitimately differ by that one attribute.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Poppins is the brand face and settletop.com's only loaded font:
            headings at 500, body and nav at 300. IBM Plex Mono is kept for
            values copied from a source and for tabular figures — a data
            convention rather than a second brand voice. See app/design.css. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {/* Resolve and stamp the theme before first paint. Stored choice
            wins, then the OS preference; the result is always an explicit
            data-theme, which is the only thing the stylesheet keys off.
            Running this in the body — or in an effect — would paint the
            light theme first and correct it, which is a visible flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('settletop-theme');var t=(s==='dark'||s==='light')?s:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
