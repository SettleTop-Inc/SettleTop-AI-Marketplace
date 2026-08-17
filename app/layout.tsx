import type { Metadata } from "next";
import "./globals.css";
// Loaded after globals.css so the design system wins at equal specificity.
import "./design.css";

export const metadata: Metadata = {
  title: "SettleTop AI Marketplace — Discover, Compare, Trust AI Agents",
  description:
    "Discover AI agents by use case, compare vendors and ratings, and inspect provenance across models, frameworks, tools, data, dependencies and deployment.",
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
        {/* Inter carries the UI, Source Serif 4 the display type, and IBM
            Plex Mono every value copied from a source — see app/design.css. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
