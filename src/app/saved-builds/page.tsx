"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/Button";

type SavedBuild = {
  id: string;
  createdAt: string;
  title: string;
  description: string;
  ldraw_mpd: string;
  thumbnail: string | null;
  instructions_pdf: string | null;
};

export default function SavedBuildsPage() {
  const [builds, setBuilds] = useState<SavedBuild[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/saved-builds", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as { builds?: SavedBuild[]; error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to load saved builds");
      setBuilds(json.builds || []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function unfavorite(id: string) {
    // Optimistic remove
    setBuilds((prev) => prev.filter((b) => b.id !== id));
    const res = await fetch(`/api/saved-builds/${id}`, { method: "DELETE" });
    if (!res.ok) {
      // If it failed, re-sync from server
      await load();
    }
  }

  return (
    <main className="space-y-6">
      <div className="card p-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold">Saved Builds</h1>
            <p className="mt-1 text-sm text-black/70">Favorited ideas with downloadable LDraw + PDF.</p>
          </div>
          <Button variant="secondary" onClick={load} disabled={loading}>
            Refresh
          </Button>
        </div>
        {err && <p className="mt-3 text-sm text-red-700">{err}</p>}
      </div>

      <div className="card p-6">
        {loading ? (
          <div className="text-sm text-black/60">Loading…</div>
        ) : builds.length === 0 ? (
          <div className="text-sm text-black/60">No saved builds yet. Go to Ideas and click the heart.</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {builds.map((b) => (
              <div key={b.id} className="rounded-2xl border border-black/10 bg-white/60 p-4">
                {b.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={b.thumbnail} alt={b.title} className="h-40 w-full rounded-xl object-cover" />
                ) : (
                  <div className="flex h-40 w-full items-center justify-center rounded-xl border border-dashed border-black/20 text-xs text-black/50">
                    No thumbnail
                  </div>
                )}
                <div className="mt-3 flex items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold">{b.title}</div>
                    <p className="mt-1 text-sm text-black/75">
                      {b.description.split(".")[0]}
                      {b.description.includes(".") ? "." : ""}
                    </p>
                  </div>
                  <button
                    className="rounded-full border border-black/10 bg-white/70 px-2 py-1 text-xs text-red-700"
                    title="Unfavorite"
                    aria-label="Unfavorite"
                    onClick={() => void unfavorite(b.id)}
                  >
                    ♥
                  </button>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const blob = new Blob([b.ldraw_mpd], { type: "text/plain" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `${b.title.replaceAll(" ", "_")}.mpd`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Download LDraw
                  </Button>
                  {b.instructions_pdf ? (
                    <a
                      href={b.instructions_pdf}
                      className="inline-flex items-center justify-center rounded-xl bg-ink-950 px-4 py-2 text-sm font-medium text-white"
                      download
                    >
                      Download PDF
                    </a>
                  ) : (
                    <Button variant="secondary" disabled>
                      PDF not available
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}


