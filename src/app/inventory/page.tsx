"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/Button";

type InventoryItem = {
  id: string;
  partNum: string;
  partName: string;
  colorName: string;
  quantity: number;
  updatedAt: string;
};

export default function InventoryPage() {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/inventory", { cache: "no-store" });
      const json = (await res.json()) as { inventory: InventoryItem[]; error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to load inventory");
      setInventory(json.inventory);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return inventory;
    return inventory.filter((i) => {
      const hay = `${i.partName} ${i.partNum} ${i.colorName}`.toLowerCase();
      return hay.includes(term);
    });
  }, [inventory, q]);

  const totalQty = useMemo(() => inventory.reduce((sum, i) => sum + i.quantity, 0), [inventory]);

  return (
    <main className="space-y-6">
      <div className="card p-6">
        <h1 className="text-xl font-semibold">Inventory</h1>
        <p className="mt-1 text-sm text-black/70">This is the aggregated total across all sets you’ve added.</p>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <label className="text-xs font-medium text-black/70">Search</label>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. 2x4, 3001, red..."
              className="mt-1 w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10"
            />
          </div>
          <Button variant="secondary" onClick={load} disabled={loading}>
            Refresh
          </Button>
        </div>

        {err && <p className="mt-3 text-sm text-red-700">{err}</p>}
      </div>

      <div className="card p-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Parts</h2>
            <p className="mt-1 text-xs text-black/60">
              {inventory.length} unique part+color entries • {totalQty} total quantity
            </p>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="text-xs text-black/60">
              <tr>
                <th className="py-2">Part</th>
                <th className="py-2">Part #</th>
                <th className="py-2">Color</th>
                <th className="py-2">Qty</th>
                <th className="py-2">Updated</th>
              </tr>
            </thead>
            <tbody className="border-t border-black/10">
              {loading ? (
                <tr>
                  <td className="py-3 text-black/60" colSpan={5}>
                    Loading...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td className="py-3 text-black/60" colSpan={5}>
                    No inventory items.
                  </td>
                </tr>
              ) : (
                filtered.map((i) => (
                  <tr key={i.id} className="border-t border-black/5">
                    <td className="py-3">{i.partName}</td>
                    <td className="py-3 font-mono text-xs">{i.partNum}</td>
                    <td className="py-3">{i.colorName}</td>
                    <td className="py-3 font-semibold">{i.quantity}</td>
                    <td className="py-3 text-xs text-black/60">{new Date(i.updatedAt).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}


