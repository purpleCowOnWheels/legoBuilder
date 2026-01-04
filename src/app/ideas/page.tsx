"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/Button";

type Idea = {
  title: string;
  description: string;
  number_of_parts: number;
  difficulty: "easy" | "medium" | "hard";
  thumbnail: string | null;
};

type IdeaSearch = {
  id: string;
  createdAt: string;
  preferences?: string;
  targetPartsMin?: number;
  targetPartsMax?: number;
  difficulty?: "easy" | "medium" | "hard";
  age?: number;
  buildTimeMinutes?: number;
  model?: string;
  imageModel?: string;
  ideas: Array<Idea & { thumbnail_prompt?: string }>;
};

export default function IdeasPage() {
  const [preferences, setPreferences] = useState("");
  const [targetPartsMin, setTargetPartsMin] = useState<string>("");
  const [targetPartsMax, setTargetPartsMax] = useState<string>("");
  const [difficulty, setDifficulty] = useState<"" | "easy" | "medium" | "hard">("");
  const [age, setAge] = useState<string>("");
  const [buildTimeMinutes, setBuildTimeMinutes] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [model, setModel] = useState<string>("");
  const [imageModel, setImageModel] = useState<string>("");
  const [history, setHistory] = useState<IdeaSearch[]>([]);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [activeSearchId, setActiveSearchId] = useState<string | null>(null);
  const [generatingThumbIndex, setGeneratingThumbIndex] = useState<number | null>(null);

  async function loadHistory() {
    setLoadingHistory(true);
    setHistoryErr(null);
    try {
      const res = await fetch("/api/ideas", { cache: "no-store" });
      const json = (await res.json()) as { history?: IdeaSearch[]; error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to load history");
      setHistory(json.history || []);
    } catch (e) {
      setHistoryErr(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoadingHistory(false);
    }
  }

  useEffect(() => {
    void loadHistory();
  }, []);

  async function generate() {
    setLoading(true);
    setErr(null);
    try {
      const min = targetPartsMin.trim() ? Number(targetPartsMin) : undefined;
      const max = targetPartsMax.trim() ? Number(targetPartsMax) : undefined;
      const parsedAge = age.trim() ? Number(age) : undefined;
      const parsedBuildTime = buildTimeMinutes.trim() ? Number(buildTimeMinutes) : undefined;

      const res = await fetch("/api/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferences: preferences.trim() || undefined,
          targetPartsMin: typeof min === "number" && Number.isFinite(min) && min > 0 ? Math.floor(min) : undefined,
          targetPartsMax: typeof max === "number" && Number.isFinite(max) && max > 0 ? Math.floor(max) : undefined,
          difficulty: difficulty || undefined,
          age: typeof parsedAge === "number" && Number.isFinite(parsedAge) && parsedAge > 0 ? Math.floor(parsedAge) : undefined,
          buildTimeMinutes:
            typeof parsedBuildTime === "number" && Number.isFinite(parsedBuildTime) && parsedBuildTime > 0
              ? Math.floor(parsedBuildTime)
              : undefined
        })
      });
      const json = (await res.json()) as {
        ideas?: Idea[];
        model?: string;
        imageModel?: string;
        searchId?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "Failed to generate ideas");
      setIdeas(json.ideas || []);
      setModel(json.model || "");
      setImageModel(json.imageModel || "");
      setActiveSearchId(json.searchId || null);
      await loadHistory();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function generateThumb(index: number) {
    if (!activeSearchId) {
      setErr("No active search selected. Click a Past search row (or generate ideas again).");
      return;
    }
    setGeneratingThumbIndex(index);
    setErr(null);
    try {
      const res = await fetch(`/api/ideas/${activeSearchId}/thumbnail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index })
      });
      const json = (await res.json()) as { thumbnail?: string | null; imageModel?: string; error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to generate thumbnail");
      setIdeas((prev) => prev.map((i, idx) => (idx === index ? { ...i, thumbnail: json.thumbnail ?? null } : i)));
      if (json.imageModel) setImageModel(json.imageModel);
      await loadHistory();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setGeneratingThumbIndex(null);
    }
  }

  return (
    <main className="space-y-6">
      <div className="card p-6">
        <h1 className="text-xl font-semibold">Build ideas</h1>
        <p className="mt-1 text-sm text-black/70">
          Uses your current inventory to ask ChatGPT for ideas you can build.
        </p>

        <div className="mt-4 grid gap-3">
          <div>
            <label className="text-xs font-medium text-black/70">Preferences (optional)</label>
            <textarea
              value={preferences}
              onChange={(e) => setPreferences(e.target.value)}
              placeholder='Example: "small desk toys, no vehicles, mostly symmetrical, under 30 minutes"'
              className="mt-1 min-h-[80px] w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10"
            />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="text-xs font-medium text-black/70">Parts range (optional)</label>
              <input
                value={targetPartsMin}
                onChange={(e) => setTargetPartsMin(e.target.value)}
                inputMode="numeric"
                placeholder="Min (Any)"
                className="mt-1 w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10"
              />
              <input
                value={targetPartsMax}
                onChange={(e) => setTargetPartsMax(e.target.value)}
                inputMode="numeric"
                placeholder="Max (Any)"
                className="mt-2 w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-black/70">Difficulty (optional)</label>
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as "" | "easy" | "medium" | "hard")}
                className="mt-1 w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10"
              >
                <option value="">Any</option>
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-black/70">Age (optional)</label>
              <input
                value={age}
                onChange={(e) => setAge(e.target.value)}
                inputMode="numeric"
                placeholder="e.g. 8"
                className="mt-1 w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10"
              />
              <div className="mt-2">
                <label className="text-xs font-medium text-black/70">Build time (minutes) (optional)</label>
                <input
                  value={buildTimeMinutes}
                  onChange={(e) => setBuildTimeMinutes(e.target.value)}
                  inputMode="numeric"
                  placeholder="Any"
                  className="mt-1 w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10"
                />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={generate} disabled={loading}>
              {loading ? "Generating..." : "Generate ideas"}
            </Button>
            {model && (
              <span className="text-xs text-black/50">
                model: {model}
                {imageModel ? ` • image: ${imageModel}` : ""}
              </span>
            )}
          </div>
        </div>

        {err && <p className="mt-3 text-sm text-red-700">{err}</p>}
      </div>

      <div className="card p-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Past searches</h2>
            <p className="mt-1 text-xs text-black/60">Click a row to restore its filters + results.</p>
          </div>
          <Button variant="secondary" onClick={loadHistory} disabled={loadingHistory}>
            Refresh
          </Button>
        </div>

        {historyErr && <p className="mt-3 text-sm text-red-700">{historyErr}</p>}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="text-xs text-black/60">
              <tr>
                <th className="py-2">When</th>
                <th className="py-2">Parts range</th>
                <th className="py-2">Difficulty</th>
                <th className="py-2">Age</th>
                <th className="py-2">Build time</th>
                <th className="py-2">Titles</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody className="border-t border-black/10">
              {loadingHistory ? (
                <tr>
                  <td className="py-3 text-black/60" colSpan={6}>
                    Loading...
                  </td>
                </tr>
              ) : history.length === 0 ? (
                <tr>
                  <td className="py-3 text-black/60" colSpan={7}>
                    No past searches yet.
                  </td>
                </tr>
              ) : (
                history.map((h) => (
                  <tr
                    key={h.id}
                    className="cursor-pointer border-t border-black/5 hover:bg-white/40"
                    onClick={() => {
                      setActiveSearchId(h.id);
                      setPreferences(h.preferences || "");
                      setTargetPartsMin(h.targetPartsMin != null ? String(h.targetPartsMin) : "");
                      setTargetPartsMax(h.targetPartsMax != null ? String(h.targetPartsMax) : "");
                      setDifficulty(h.difficulty || "");
                      setAge(h.age ? String(h.age) : "");
                      setBuildTimeMinutes(h.buildTimeMinutes != null ? String(h.buildTimeMinutes) : "");
                      setIdeas(h.ideas || []);
                      setModel(h.model || "");
                      setImageModel(h.imageModel || "");
                      setErr(null);
                    }}
                  >
                    <td className="py-3 text-xs text-black/60">{new Date(h.createdAt).toLocaleString()}</td>
                    <td className="py-3">
                      {h.targetPartsMin != null || h.targetPartsMax != null
                        ? `${h.targetPartsMin ?? "?"}–${h.targetPartsMax ?? "?"}`
                        : "-"}
                    </td>
                    <td className="py-3">{h.difficulty ?? "-"}</td>
                    <td className="py-3">{h.age ?? "-"}</td>
                    <td className="py-3">{h.buildTimeMinutes != null ? `${h.buildTimeMinutes} min` : "-"}</td>
                    <td className="py-3">
                      {(h.ideas || []).map((i) => i.title).filter(Boolean).join(" • ") || "-"}
                    </td>
                    <td className="py-3 text-right">
                      <Button
                        variant="secondary"
                        onClick={async (e) => {
                          e.stopPropagation();
                          setDeletingId(h.id);
                          try {
                            const res = await fetch(`/api/ideas/${h.id}`, { method: "DELETE" });
                            const json = (await res.json()) as { error?: string };
                            if (!res.ok) throw new Error(json.error || "Failed to delete");
                            await loadHistory();
                          } catch (e2) {
                            setHistoryErr(e2 instanceof Error ? e2.message : "Unknown error");
                          } finally {
                            setDeletingId(null);
                          }
                        }}
                        disabled={deletingId === h.id}
                      >
                        {deletingId === h.id ? "Deleting..." : "Delete"}
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-6">
        <h2 className="text-sm font-semibold">Results</h2>
        {ideas.length === 0 ? (
          <div className="mt-3 text-sm text-black/60">No results yet.</div>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {ideas.map((idea, idx) => (
              <div key={idea.title} className="rounded-2xl border border-black/10 bg-white/60 p-4">
                {idea.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={idea.thumbnail}
                    alt={idea.title}
                    className="h-40 w-full rounded-xl object-cover"
                  />
                ) : (
                  <div className="flex h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-black/20 text-xs text-black/50">
                    <div>No thumbnail</div>
                    <Button
                      variant="secondary"
                      onClick={() => void generateThumb(idx)}
                      disabled={generatingThumbIndex === idx}
                    >
                      {generatingThumbIndex === idx ? `Generating...` : "Generate thumbnail"}
                    </Button>
                  </div>
                )}
                <div className="mt-3">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-base font-semibold">{idea.title}</h3>
                    <span className="rounded-full bg-black/5 px-2 py-1 text-xs">
                      {idea.difficulty} • ~{idea.number_of_parts} parts
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-black/75">{idea.description}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}


