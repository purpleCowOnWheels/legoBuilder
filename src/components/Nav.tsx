"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/", label: "Home" },
  { href: "/sets", label: "Sets" },
  { href: "/inventory", label: "Inventory" },
  { href: "/ideas", label: "Ideas" },
  { href: "/saved-builds", label: "Saved Builds" }
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap items-center justify-between gap-3">
      <Link href="/" className="font-semibold tracking-tight">
        legoBuilder
      </Link>
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => {
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={[
                "rounded-full px-3 py-1 text-sm transition",
                active ? "bg-ink-950 text-white" : "bg-white/70 hover:bg-white border border-black/10"
              ].join(" ")}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}


