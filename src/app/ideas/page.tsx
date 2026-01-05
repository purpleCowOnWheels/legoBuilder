"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { countLDrawSteps } from "@/lib/ldraw";

type Idea = {
  title: string;
  description: string;
  estimated_time_minutes: number;
  spec: { concept: string; key_features: string[]; color_palette: string[]; step_count_estimate: number };
  previewStatus?: "not_started" | "queued" | "running" | "done" | "error";
  previewJobId?: string;
  previewError?: string;
  preview_mpd?: string;
  preview_thumbnail?: string | null;
  ldrawStatus?: "not_started" | "queued" | "running" | "done" | "error";
  ldrawJobId?: string;
  ldrawError?: string;
  ldraw_mpd?: string;
  thumbnail: string | null;
  instructions_pdf: string | null;
};

type SavedBuild = {
  id: string;
  sourceIdeaSearchId?: string;
  sourceIdeaIndex?: number;
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
  count?: number;
  model?: string;
  status?: "queued" | "running" | "done" | "error";
  updatedAt?: string;
  error?: string;
  jobId?: string;
  ideas: Idea[];
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
  const [history, setHistory] = useState<IdeaSearch[]>([]);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [activeSearchId, setActiveSearchId] = useState<string | null>(null);
  const [favoriteMap, setFavoriteMap] = useState<Record<string, string>>({});
  const [activeStatus, setActiveStatus] = useState<{
    status: "queued" | "running" | "done" | "error";
    updatedAt?: string;
    error?: string;
    job?: {
      updatedAt?: string;
      startedAt?: string;
      maxRounds?: number;
      logs?: Array<{ at: string; type: string; message: string; data?: any }>;
    } | null;
  } | null>(null);
  const [nowTick, setNowTick] = useState(0);

  useEffect(() => {
    // Update runtime display about every 15 seconds.
    const t = window.setInterval(() => setNowTick((x) => x + 1), 15000);
    return () => window.clearInterval(t);
  }, []);

  function formatElapsed(startIso?: string) {
    if (!startIso) return "";
    const start = Date.parse(startIso);
    if (!Number.isFinite(start)) return "";
    const ms = Math.max(0, Date.now() - start);
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const remS = s % 60;
    if (m <= 0) return `${remS}s`;
    return `${m}m ${String(remS).padStart(2, "0")}s`;
  }

  const activeJobSummary = useMemo(() => {
    const logs = activeStatus?.job?.logs || [];
    const last = logs[logs.length - 1];
    const elapsed = formatElapsed(activeStatus?.job?.startedAt);
    if (!last) return { message: elapsed ? `Ideating... (${elapsed})` : "Ideating..." };
    if (last.type === "heartbeat") return { message: elapsed ? `Ideating... (${elapsed})` : "Ideating..." };
    const msg = last.message || "";
    return { message: elapsed ? `${msg} (${elapsed})` : msg };
  }, [activeStatus, nowTick]);

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

  async function loadFavorites() {
    try {
      const res = await fetch("/api/saved-builds", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as { builds?: SavedBuild[] };
      const next: Record<string, string> = {};
      for (const b of json.builds || []) {
        if (b.sourceIdeaSearchId != null && b.sourceIdeaIndex != null) {
          next[`${b.sourceIdeaSearchId}:${b.sourceIdeaIndex}`] = b.id;
        }
      }
      setFavoriteMap(next);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void loadHistory();
    void loadFavorites();
  }, []);

  useEffect(() => {
    if (!activeSearchId) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`/api/ideas/${activeSearchId}`, { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as { search?: IdeaSearch; ideationJob?: any; ldrawJobs?: any[] };
        if (!res.ok) return;
        const s = json.search;
        if (!s || cancelled) return;
        setActiveStatus({ status: s.status || "done", updatedAt: s.updatedAt, error: s.error, job: json.ideationJob || null });
        if (s.ideas && s.ideas.length > 0) {
          setIdeas(s.ideas);
          setModel(s.model || "");
        }
      } catch {
        // ignore polling errors
      }
    }

    void poll();
    const t = window.setInterval(() => void poll(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [activeSearchId]);

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
              : undefined,
          count: 2
        })
      });
      const json = (await res.json()) as { searchId?: string; jobId?: string; error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to generate ideas");
      setActiveSearchId(json.searchId || null);
      setIdeas([]);
      setModel("");
      setActiveStatus({ status: "queued" });
      await loadHistory();
      await loadFavorites();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function toggleFavorite(ideaIndex: number) {
    if (!activeSearchId) return;
    const idea = ideas[ideaIndex];
    if (!idea || idea.ldrawStatus !== "done" || !idea.ldraw_mpd) return;
    const key = `${activeSearchId}:${ideaIndex}`;
    const existingId = favoriteMap[key];
    if (existingId) {
      await fetch(`/api/saved-builds/${existingId}`, { method: "DELETE" }).catch(() => {});
      await loadFavorites();
      return;
    }
    await fetch("/api/saved-builds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ideaSearchId: activeSearchId, ideaIndex })
    }).catch(() => {});
    await loadFavorites();
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
                      const nextIdeas = (h.ideas || []).map((i) => ({
                        title: i.title,
                        description: i.description,
                        estimated_time_minutes: (i as any).estimated_time_minutes ?? 0,
                        spec: i.spec,
                        previewStatus: (i as any).previewStatus,
                        previewJobId: (i as any).previewJobId,
                        previewError: (i as any).previewError,
                        preview_mpd: (i as any).preview_mpd,
                        preview_thumbnail: (i as any).preview_thumbnail ?? null,
                        ldrawStatus: i.ldrawStatus,
                        ldrawJobId: i.ldrawJobId,
                        ldrawError: i.ldrawError,
                        ldraw_mpd: i.ldraw_mpd,
                        thumbnail: i.thumbnail ?? null,
                        instructions_pdf: i.instructions_pdf ?? null
                      }));
                      setIdeas(nextIdeas);
                      setModel(h.model || "");
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

        {activeStatus && (activeStatus.status === "queued" || activeStatus.status === "running") && (
          <div className="mt-3 rounded-xl border border-black/10 bg-white/50 px-3 py-3 text-black/80">
            <div className="flex items-center gap-3 font-semibold">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black/70" />
              <span>{activeStatus.status === "queued" ? "Queued" : "Generating"}</span>
            </div>
            <div className="mt-1 text-xs text-black/70">{activeJobSummary.message}</div>
          </div>
        )}
        {activeStatus?.status === "error" && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
            {activeStatus.error || "Generation failed"}
          </div>
        )}

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
                ) : idea.preview_thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={idea.preview_thumbnail}
                    alt={`${idea.title} (preview)`}
                    className="h-40 w-full rounded-xl object-cover"
                  />
                ) : (
                  <div className="flex h-40 w-full items-center justify-center rounded-xl border border-dashed border-black/20 text-xs text-black/50">
                    {idea.previewStatus === "queued" || idea.previewStatus === "running" ? "Generating preview…" : "Thumbnail not available"}
                  </div>
                )}
                <div className="mt-3">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-base font-semibold">{idea.title}</h3>
                    <button
                      className={[
                        "rounded-full border border-black/10 bg-white/70 px-2 py-1 text-xs",
                        activeSearchId && favoriteMap[`${activeSearchId}:${idx}`] ? "text-red-700" : "text-black/60 hover:text-black",
                        idea.ldrawStatus !== "done" ? "opacity-40" : ""
                      ].join(" ")}
                      title="Save build"
                      onClick={() => void toggleFavorite(idx)}
                      disabled={!activeSearchId || idea.ldrawStatus !== "done"}
                    >
                      {activeSearchId && favoriteMap[`${activeSearchId}:${idx}`] ? "♥" : "♡"}
                    </button>
                  </div>
                  <p className="mt-2 text-sm text-black/75">
                    {idea.description.split(".")[0]}
                    {idea.description.includes(".") ? "." : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {typeof idea.estimated_time_minutes === "number" && idea.estimated_time_minutes > 0 && (
                      <span className="rounded-full bg-black/5 px-2 py-1 text-xs">~{idea.estimated_time_minutes} min</span>
                    )}
                    {idea.spec?.step_count_estimate ? (
                      <span className="rounded-full bg-black/5 px-2 py-1 text-xs">~{idea.spec.step_count_estimate} steps</span>
                    ) : null}
                    {idea.ldrawStatus === "done" && idea.ldraw_mpd && (
                      <span className="rounded-full bg-black/5 px-2 py-1 text-xs">{countLDrawSteps(idea.ldraw_mpd)} steps</span>
                    )}
                  </div>
                  {idea.ldrawStatus && idea.ldrawStatus !== "done" && (
                    <div className="mt-2 text-xs text-black/70">
                      {idea.ldrawStatus === "queued"
                        ? "LDraw queued…"
                        : idea.ldrawStatus === "running"
                          ? "Generating LDraw…"
                          : idea.ldrawStatus === "error"
                            ? `LDraw failed: ${idea.ldrawError || "Unknown error"}`
                            : "LDraw not generated"}
                    </div>
                  )}
                  {idea.ldrawStatus === "done" && idea.ldraw_mpd && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <span className="rounded-full bg-black/5 px-2 py-1 text-xs">{countLDrawSteps(idea.ldraw_mpd)} steps</span>
                    </div>
                  )}
                  <div className="mt-3">
                    <div className="flex flex-wrap gap-2">
                      {idea.ldrawStatus !== "done" ? (
                        <Button
                          onClick={async () => {
                            if (!activeSearchId) return;
                            await fetch(`/api/ideas/${activeSearchId}/ldraw`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ ideaIndex: idx })
                            }).catch(() => {});
                          }}
                          disabled={!activeSearchId || idea.ldrawStatus === "running" || idea.ldrawStatus === "queued"}
                        >
                          {idea.ldrawStatus === "running" || idea.ldrawStatus === "queued" ? "Generating…" : "Generate LDraw"}
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        onClick={() => {
                          if (!idea.ldraw_mpd) return;
                          const blob = new Blob([idea.ldraw_mpd], { type: "text/plain" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `${idea.title.replaceAll(" ", "_")}.mpd`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                        disabled={!idea.ldraw_mpd}
                      >
                        Download LDraw
                      </Button>
                      {idea.instructions_pdf ? (
                        <a
                          href={idea.instructions_pdf}
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
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}


