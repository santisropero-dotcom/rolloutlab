import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "RolloutLab",
  description: "Progressive delivery with release guardrails",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
