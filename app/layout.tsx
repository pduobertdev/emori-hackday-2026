import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Emori — Mateo",
  description: "A voice-first AI memory experience.",
};

export default function RootLayout({
  children,
  panel,
}: Readonly<{ children: React.ReactNode; panel: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        {panel}
      </body>
    </html>
  );
}
