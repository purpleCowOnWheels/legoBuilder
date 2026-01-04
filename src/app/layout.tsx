import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "legoBuilder",
  description: "Track LEGO sets, extract parts, and maintain an inventory."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="mx-auto max-w-5xl px-4 py-6">
          <div className="card mb-6 px-5 py-4">
            <Nav />
          </div>
          {children}
          <footer className="mt-10 text-xs text-black/50">
            Data is stored locally in <code className="font-mono">data/db.json</code>.
          </footer>
        </div>
      </body>
    </html>
  );
}


