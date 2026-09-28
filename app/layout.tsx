import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// SF on Apple devices, Inter everywhere else, as on yourpersona.com.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

// Social cards need absolute URLs. The page is prerendered at build, where the worker's SITE_URL secret does not
// exist, so a production build falls back to the public URL itself; otherwise every link preview would point at
// localhost.
const PUBLIC_URL = "https://persona-demo.personademobuild.workers.dev";
const site = process.env.SITE_URL ?? (process.env.NODE_ENV === "production" ? PUBLIC_URL : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(site),
  title: "Persona Onboarding",
  description: "Name your assistant over text, then take a quick call to finish setup.",
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f5f5f7",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
