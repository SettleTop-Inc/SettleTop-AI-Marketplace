import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SettleTop Agent Registry — Discover, Compare, Trust AI Agents",
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
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
