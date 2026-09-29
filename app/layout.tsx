import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Emori — Mateo",
  description: "A voice-first AI memory experience.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
