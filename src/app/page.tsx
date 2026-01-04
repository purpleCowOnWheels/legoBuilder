import Link from "next/link";

export default function HomePage() {
  return (
    <main className="space-y-6">
      <div className="card p-6">
        <h1 className="text-2xl font-semibold tracking-tight">LEGO Sets → Parts → Inventory</h1>
        <p className="mt-2 text-sm text-black/70">
          Add a set by model number, fetch its parts list, and roll it into your inventory. Remove a set to subtract
          those parts back out.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link className="rounded-xl bg-ink-950 px-4 py-2 text-sm font-medium text-white" href="/sets">
            Manage sets
          </Link>
          <Link className="rounded-xl border border-black/10 bg-white/70 px-4 py-2 text-sm font-medium" href="/inventory">
            View inventory
          </Link>
        </div>
      </div>

      <div className="card p-6 text-sm text-black/70">
        <p className="font-medium text-black">Quick note</p>
        <p className="mt-2">
          If you add <code className="font-mono">REBRICKABLE_API_KEY</code> in <code className="font-mono">.env.local</code>,
          the set parts will be fetched from Rebrickable. Otherwise the app uses a small mock parts list so you can test the
          flow immediately.
        </p>
      </div>
    </main>
  );
}


