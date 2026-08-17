import type { Metadata } from "next";
import "./globals.css";
// Loaded after globals.css so the design system wins at equal specificity.
import "./design.css";

export const metadata: Metadata = {
  title: "SettleTop — Intelligence your AI can cite",
  description:
    "Verified, timestamped intelligence about the software and AI you didn't write. Installs in your cluster, runs offline, answers your own model's questions with sources.",
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
  return (
    <html lang="en">
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
      </head>
      <body>{children}</body>
    </html>
  );
}
