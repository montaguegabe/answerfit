import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AnswerFit",
  description: "One answer, fitted to what you already know",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
