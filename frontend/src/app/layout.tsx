import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pill ID — Pilot",
  description:
    "Experimental pilot tool that suggests possible matches for a pill image. Not for medical use.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
