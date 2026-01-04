"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/Button";

type SetPart = { partNum: string; partName: string; colorName: string; quantity: number };
type LegoSet = { id: string; setNum: string; name: string; createdAt: string; parts: SetPart[] };
type SetSearchResult = { setNum: string; name: string; year?: number; numParts?: number };

export default function SetsPage() {
  const [sets, setSets] = useState<LegoSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [searchQ, setSearchQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [matches, setMatches] = useState<SetSearchResult[]>([]);

  const [setNum, setSetNum] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [addingFromMatch, setAddingFromMatch] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/sets", { cache: "no-store" });
      const json = (await res.json()) as { sets: LegoSet[]; error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to load sets");
      setSets(json.sets);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function onSearch() {
    const q = searchQ.trim();
    if (!q) return;
    setSearching(true);
    setSearchErr(null);
    try {
      const res = await fetch(`/api/rebrickable/sets/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const json = (await res.json()) as { results?: SetSearchResult[]; error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to search sets");
      setMatches(json.results || []);
    } catch (e) {
      setSearchErr(e instanceof Error ? e.message : "Unknown error");
      setMatches([]);
    } finally {
      setSearching(false);
    }
  }

  async function onAdd() {
    const sn = setNum.trim();
    if (!sn) return;
    setAdding(true);
    setErr(null);
    try {
      const res = await fetch("/api/sets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setNum: sn, name: name.trim() || undefined })
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to add set");
      setSetNum("");
      setName("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setAdding(false);
    }
  }

  async function onAddMatch(m: SetSearchResult) {
    setAddingFromMatch(m.setNum);
    setErr(null);
    try {
      const res = await fetch("/api/sets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setNum: m.setNum, name: m.name })
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to add set");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setAddingFromMatch(null);
    }
  }

  async function onRemove(id: string) {
    setRemovingId(id);
    setErr(null);
    try {
      const res = await fetch(`/api/sets/${id}`, { method: "DELETE" });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to remove set");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setRemovingId(null);
    }
  }

  const totalParts = useMemo(() => sets.reduce((sum, s) => sum + s.parts.reduce((a, p) => a + p.quantity, 0), 0), [sets]);

  return (
    <main className="space-y-6">
      <div className="card p-6">
        <h1 className="text-xl font-semibold">Sets</h1>
        <p className="mt-1 text-sm text-black/70">
          Search Rebrickable to find the exact set number (like <span className="font-mono text-xs">10698-1</span>), then add it.
          Removing a set subtracts its parts from inventory.
        </p>

        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
          <div>
            <label className="text-xs font-medium text-black/70">Search set</label>
            <input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder='Try "10698" or "Lambo"'
              className="mt-1 w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10"
              onKeyDown={(e) => {
                if (e.key === "Enter") void onSearch();
              }}
            />
          </div>
          <div className="flex items-end">
            <Button onClick={onSearch} disabled={searching || !searchQ.trim()}>
              {searching ? "Searching..." : "Search"}
            </Button>
          </div>
        </div>

        {searchErr && <p className="mt-3 text-sm text-red-700">{searchErr}</p>}

        {matches.length > 0 && (
          <div className="mt-4 overflow-x-auto rounded-xl border border-black/10 bg-white/50">
            <table className="w-full min-w-[700px] text-left text-sm">
              <thead className="text-xs text-black/60">
                <tr>
                  <th className="px-3 py-2">Set #</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Year</th>
                  <th className="px-3 py-2"># Parts</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="border-t border-black/10">
                {matches.map((m) => (
                  <tr key={m.setNum} className="border-t border-black/5">
                    <td className="px-3 py-2 font-mono text-xs">{m.setNum}</td>
                    <td className="px-3 py-2">{m.name}</td>
                    <td className="px-3 py-2">{m.year ?? "-"}</td>
                    <td className="px-3 py-2">{m.numParts ?? "-"}</td>
                    <td className="px-3 py-2 text-right">
                      <Button onClick={() => onAddMatch(m)} disabled={addingFromMatch === m.setNum} title="Add this set">
                        {addingFromMatch === m.setNum ? "Adding..." : "Add"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer select-none text-sm text-black/70">Manual add (advanced)</summary>
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <div>
            <label className="text-xs font-medium text-black/70">Set number</label>
            <input
              value={setNum}
              onChange={(e) => setSetNum(e.target.value)}
              placeholder='e.g. "10328-1"'
              className="mt-1 w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-black/70">Name (optional)</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name"
              className="mt-1 w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10"
            />
          </div>
          <div className="flex items-end">
            <Button onClick={onAdd} disabled={adding || !setNum.trim()}>
              {adding ? "Adding..." : "Add set"}
            </Button>
          </div>
        </div>
        </details>

        {err && <p className="mt-3 text-sm text-red-700">{err}</p>}
      </div>

      <div className="card p-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Your sets</h2>
            <p className="mt-1 text-xs text-black/60">
              {sets.length} set(s) • {totalParts} total part quantity (summed across sets)
            </p>
          </div>
          <Button variant="secondary" onClick={load} disabled={loading}>
            Refresh
          </Button>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-sm">
            <thead className="text-xs text-black/60">
              <tr>
                <th className="py-2">Set</th>
                <th className="py-2">Name</th>
                <th className="py-2">Parts (qty sum)</th>
                <th className="py-2">Added</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody className="border-t border-black/10">
              {loading ? (
                <tr>
                  <td className="py-3 text-black/60" colSpan={5}>
                    Loading...
                  </td>
                </tr>
              ) : sets.length === 0 ? (
                <tr>
                  <td className="py-3 text-black/60" colSpan={5}>
                    No sets yet.
                  </td>
                </tr>
              ) : (
                sets.map((s) => (
                  <tr key={s.id} className="border-t border-black/5">
                    <td className="py-3 font-mono text-xs">{s.setNum}</td>
                    <td className="py-3">{s.name}</td>
                    <td className="py-3">{s.parts.reduce((a, p) => a + p.quantity, 0)}</td>
                    <td className="py-3 text-xs text-black/60">{new Date(s.createdAt).toLocaleString()}</td>
                    <td className="py-3 text-right">
                      <Button
                        variant="secondary"
                        onClick={() => onRemove(s.id)}
                        disabled={removingId === s.id}
                        title="Remove set and subtract parts from inventory"
                      >
                        {removingId === s.id ? "Removing..." : "Remove"}
                      </Button>
                    </td>
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


