/**
 * Root Layout — the outermost wrapper for every page in the app.
 *
 * Responsibilities:
 * - Sets up the HTML document structure (<html>, <body>)
 * - Loads Google Fonts (Geist Sans + Geist Mono) as CSS variables
 * - Imports global styles (Tailwind, shadcn theme, CSS custom properties)
 * - Defines page metadata (title, description)
 *
 * This layout does NOT handle auth — that's done by middleware.ts and (dashboard)/layout.tsx.
 * All child routes (auth, dashboard, home) are rendered inside {children}.
 */

import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter, Instrument_Serif, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

// The company design system's type (docs/reference/design-system.md), used by Studio
// through .studio-brand. Not preloaded: no other page uses them yet.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  preload: false,
});

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  preload: false,
});

/** Page metadata shown in browser tab and search results */
export const metadata: Metadata = {
  title: "Scholera",
  description: "AI-native Learning Management System",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} ${inter.variable} ${jakarta.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
