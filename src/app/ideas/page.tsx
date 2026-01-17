"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { countLDrawSteps } from "@/lib/ldraw";

type Idea = {
  title: string;
  preview_thumbnail?: string | null;
  previewStatus?: "not_started" | "queued" | "running" | "done" | "error";
  previewJobId?: string;
  previewError?: string;
  ldrawStatus?: "not_started" | "queued" | "running" | "done" | "error" | "cancelled";
  ldrawJobId?: string;
  ldrawError?: string;
  ldrawArtifacts?: any;
  ldraw_mpd?: string;
  thumbnail?: string | null;
  instructions_pdf?: string | null;
};

type SavedBuild = {
  id: string;
  sourceIdeaSearchId?: string;
  sourceIdeaIndex?: number;
};

type IdeaSearch = {
  id: string;
  createdAt: string;
  title?: string; // Extracted title (once available)
  preferences?: string; // Original user prompt
  targetPartsMin?: number;
  targetPartsMax?: number;
  difficulty?: "easy" | "medium" | "hard";
  age?: number;
  buildTimeMinutes?: number;
  count?: number;
  inventoryMode?: "basic" | "full";
  colorMode?: "exact" | "bucketed";
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
  const [inventoryMode, setInventoryMode] = useState<"basic" | "full">("basic");
  const [colorMode, setColorMode] = useState<"exact" | "bucketed">("exact");
  const [uploadedImage, setUploadedImage] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [model, setModel] = useState<string>("");
  const [debugOpenAi, setDebugOpenAi] = useState(false);
  const [history, setHistory] = useState<IdeaSearch[]>([]);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [activeSearchId, setActiveSearchId] = useState<string | null>(null);
  const [favoriteMap, setFavoriteMap] = useState<Record<string, string>>({});
  const [ldrawSubmittingIdx, setLdrawSubmittingIdx] = useState<number | null>(null);
  const [partialPdfSubmittingIdx, setPartialPdfSubmittingIdx] = useState<number | null>(null);
  const [ldrawJobs, setLdrawJobs] = useState<any[]>([]);
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

  const ldrawJobByIdeaIndex = useMemo(() => {
    const next: Record<number, any> = {};
    for (const j of ldrawJobs || []) {
      if (typeof j?.ideaIndex !== "number") continue;
      const idx = j.ideaIndex;
      const prev = next[idx];
      if (!prev) {
        next[idx] = j;
        continue;
      }

      const score = (x: any) => {
        const ts =
          (typeof x?.startedAt === "string" && Date.parse(x.startedAt)) ||
          (typeof x?.createdAt === "string" && Date.parse(x.createdAt)) ||
          (typeof x?.updatedAt === "string" && Date.parse(x.updatedAt)) ||
          0;
        return Number.isFinite(ts) ? ts : 0;
      };

      // Keep the most recent job per ideaIndex (prevents stale failed jobs from overriding new runs).
      if (score(j) >= score(prev)) next[idx] = j;
    }
    return next;
  }, [ldrawJobs]);

  function lastMeaningfulJobMessage(job: any) {
    const logs: Array<{ type?: string; message?: string }> = Array.isArray(job?.logs) ? job.logs : [];
    for (let i = logs.length - 1; i >= 0; i--) {
      const evt = logs[i];
      if (!evt) continue;
      if (evt.type === "heartbeat") continue;
      if (typeof evt.message === "string" && evt.message.trim().length > 0) return evt.message.trim();
    }
    return "";
  }

  async function loadHistory() {
    setLoadingHistory(true);
    setHistoryErr(null);
    try {
      const res = await fetch("/api/ideas", { cache: "no-store" });
      const json = (await res.json()) as { history?: IdeaSearch[]; error?: string; debugOpenAi?: boolean };
      if (!res.ok) throw new Error(json.error || "Failed to load history");
      setHistory(json.history || []);
      setDebugOpenAi(Boolean(json.debugOpenAi));
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
    try {
      const v = window.localStorage.getItem("inventoryMode");
      if (v === "basic" || v === "full") setInventoryMode(v);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("inventoryMode", inventoryMode);
    } catch {
      // ignore
    }
  }, [inventoryMode]);

  useEffect(() => {
    try {
      const v = window.localStorage.getItem("colorMode");
      if (v === "exact" || v === "bucketed") setColorMode(v);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("colorMode", colorMode);
    } catch {
      // ignore
    }
  }, [colorMode]);

  useEffect(() => {
    if (!activeSearchId) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`/api/ideas/${activeSearchId}`, { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as {
          search?: IdeaSearch;
          ideationJob?: any;
          ldrawJobs?: any[];
          previewJobs?: any[];
          debugOpenAi?: boolean;
        };
        if (!res.ok) return;
        const s = json.search;
        if (!s || cancelled) return;
        setActiveStatus({ status: s.status || "done", updatedAt: s.updatedAt, error: s.error, job: json.ideationJob || null });
        setDebugOpenAi(Boolean(json.debugOpenAi));
        if (s.inventoryMode === "basic" || s.inventoryMode === "full") {
          setInventoryMode(s.inventoryMode);
        }
        if (s.colorMode === "exact" || s.colorMode === "bucketed") {
          setColorMode(s.colorMode);
        }
        if (s.ideas && s.ideas.length > 0) {
          setIdeas(s.ideas);
          setModel(s.model || "");
        }
        if (Array.isArray(json.ldrawJobs)) setLdrawJobs(json.ldrawJobs);
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

      // If image is uploaded, use FormData; otherwise use JSON
      let res: Response;
      if (uploadedImage) {
        const formData = new FormData();
        formData.append("image", uploadedImage);
        formData.append("preferences", preferences.trim() || "");
        if (typeof min === "number" && Number.isFinite(min) && min > 0) formData.append("targetPartsMin", String(Math.floor(min)));
        if (typeof max === "number" && Number.isFinite(max) && max > 0) formData.append("targetPartsMax", String(Math.floor(max)));
        if (difficulty) formData.append("difficulty", difficulty);
        if (typeof parsedAge === "number" && Number.isFinite(parsedAge) && parsedAge > 0) formData.append("age", String(Math.floor(parsedAge)));
        if (typeof parsedBuildTime === "number" && Number.isFinite(parsedBuildTime) && parsedBuildTime > 0) formData.append("buildTimeMinutes", String(Math.floor(parsedBuildTime)));
        formData.append("count", "1"); // Only 1 idea when image is uploaded
        formData.append("inventoryMode", inventoryMode);
        formData.append("colorMode", colorMode);

        res = await fetch("/api/ideas", {
          method: "POST",
          body: formData
        });
      } else {
        res = await fetch("/api/ideas", {
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
            count: 2,
            inventoryMode,
            colorMode
          })
        });
      }

      const json = (await res.json()) as { searchId?: string; jobId?: string; error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to generate ideas");
      setActiveSearchId(json.searchId || null);
      setIdeas([]);
      setModel("");
      setActiveStatus({ status: "queued" });
      setUploadedImage(null); // Clear uploaded image after submission
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

  async function startInstructions(ideaIndex: number) {
    if (!activeSearchId) return;
    if (ldrawSubmittingIdx === ideaIndex) return;
    setLdrawSubmittingIdx(ideaIndex);
    try {
      const res = await fetch(`/api/ideas/${activeSearchId}/ldraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaIndex })
      });
      const json = (await res.json().catch(() => ({}))) as { jobId?: string; alreadyRunning?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to start LDraw job");

      // optimistic UI: show queued immediately
      setIdeas((prev) =>
        prev.map((it, i) =>
          i === ideaIndex
            ? {
                ...it,
                ldrawStatus: it.ldrawStatus === "done" ? "done" : "queued",
                ldrawJobId: json.jobId || it.ldrawJobId,
                ldrawError: undefined
              }
            : it
        )
      );

      // Fetch fresh status immediately (don't wait for the 15s poll tick)
      const res2 = await fetch(`/api/ideas/${activeSearchId}`, { cache: "no-store" });
      const json2 = (await res2.json().catch(() => ({}))) as { search?: IdeaSearch; ldrawJobs?: any[] };
      if (res2.ok && json2.search?.ideas) setIdeas(json2.search.ideas);
      if (res2.ok && Array.isArray(json2.ldrawJobs)) setLdrawJobs(json2.ldrawJobs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to start LDraw job";
      setIdeas((prev) => prev.map((it, i) => (i === ideaIndex ? { ...it, ldrawStatus: "error", ldrawError: msg } : it)));
    } finally {
      setLdrawSubmittingIdx(null);
    }
  }

  async function cancelInstructions(ideaIndex: number) {
    if (!activeSearchId) return;
    try {
      await fetch(`/api/ideas/${activeSearchId}/ldraw/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaIndex })
      });
    } finally {
      // Optimistic UX: mark cancelled immediately and re-enable Generate.
      setIdeas((prev) => prev.map((it, i) => (i === ideaIndex ? { ...it, ldrawStatus: "cancelled", ldrawError: "Cancelled by user" } : it)));
    }
  }

  function downloadBlueprint(ideaIndex: number) {
    if (!activeSearchId) return;
    window.location.href = `/api/ideas/${activeSearchId}/blueprint?ideaIndex=${ideaIndex}`;
  }

  async function downloadInstructions(ideaIndex: number, idea: Idea) {
    if (!activeSearchId) return;
    const running = idea.ldrawStatus === "queued" || idea.ldrawStatus === "running";
    const hasPartialMpd = Boolean((idea as any)?.ldrawArtifacts?.partial_mpd);

    // If we're running and have a partial MPD, generate a partial PDF on demand first.
    if (running && hasPartialMpd) {
      if (partialPdfSubmittingIdx === ideaIndex) return;
      setPartialPdfSubmittingIdx(ideaIndex);
      try {
        const res = await fetch(`/api/ideas/${activeSearchId}/ldraw/partial-pdf`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ideaIndex })
        });
        const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!res.ok) throw new Error(json.error || "Failed to generate partial PDF");

        // Refresh persisted URLs/state.
        const res2 = await fetch(`/api/ideas/${activeSearchId}`, { cache: "no-store" });
        const json2 = (await res2.json().catch(() => ({}))) as { search?: IdeaSearch; ldrawJobs?: any[] };
        if (res2.ok && json2.search?.ideas) setIdeas(json2.search.ideas);
        if (res2.ok && Array.isArray(json2.ldrawJobs)) setLdrawJobs(json2.ldrawJobs);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e);
      } finally {
        setPartialPdfSubmittingIdx(null);
      }
    }

    // Always download via API so filename can include partial/final.
    window.location.href = `/api/ideas/${activeSearchId}/instructions?ideaIndex=${ideaIndex}`;
  }

  return (
    <div className="space-y-6">
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

          <div className="mb-4">
            <label className="text-xs font-medium text-black/70">Upload image (optional)</label>
            <p className="mt-1 text-xs text-black/50">Skip preview generation by uploading an image of your desired build</p>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setUploadedImage(e.target.files?.[0] || null)}
              className="mt-2 w-full text-sm"
            />
            {uploadedImage && (
              <p className="mt-1 text-xs text-green-700">
                Selected: {uploadedImage.name} ({Math.round(uploadedImage.size / 1024)} KB)
              </p>
            )}
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
                      if (h.inventoryMode === "basic" || h.inventoryMode === "full") {
                        setInventoryMode(h.inventoryMode);
                      }
                      if (h.colorMode === "exact" || h.colorMode === "bucketed") {
                        setColorMode(h.colorMode);
                      }
                      const nextIdeas = (h.ideas || []).map((i) => ({
                        title: i.title,
                        preview_thumbnail: (i as any).preview_thumbnail ?? null,
                        previewStatus: (i as any).previewStatus,
                        previewJobId: (i as any).previewJobId,
                        previewError: (i as any).previewError,
                        ldrawStatus: i.ldrawStatus,
                        ldrawJobId: i.ldrawJobId,
                        ldrawError: i.ldrawError,
                        ldrawArtifacts: (i as any).ldrawArtifacts,
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Results</h2>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-black/70">
              <span>Inventory</span>
              <div className="inline-flex overflow-hidden rounded-lg border border-black/10 bg-white/70">
                <button
                  type="button"
                  className={[
                    "px-2 py-1 text-xs",
                    inventoryMode === "basic" ? "bg-black/10 text-black" : "text-black/60 hover:text-black"
                  ].join(" ")}
                  onClick={() => setInventoryMode("basic")}
                >
                  basic parts
                </button>
                <button
                  type="button"
                  className={[
                    "px-2 py-1 text-xs",
                    inventoryMode === "full" ? "bg-black/10 text-black" : "text-black/60 hover:text-black"
                  ].join(" ")}
                  onClick={() => setInventoryMode("full")}
                >
                  full inventory
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-black/70">
              <span>Colors</span>
              <div className="inline-flex overflow-hidden rounded-lg border border-black/10 bg-white/70">
                <button
                  type="button"
                  className={[
                    "px-2 py-1 text-xs",
                    colorMode === "exact" ? "bg-black/10 text-black" : "text-black/60 hover:text-black",
                    inventoryMode !== "basic" ? "opacity-40" : ""
                  ].join(" ")}
                  onClick={() => setColorMode("exact")}
                  disabled={inventoryMode !== "basic"}
                  title={inventoryMode !== "basic" ? "Color bucketing only applies to basic parts mode" : ""}
                >
                  exact
                </button>
                <button
                  type="button"
                  className={[
                    "px-2 py-1 text-xs",
                    colorMode === "bucketed" ? "bg-black/10 text-black" : "text-black/60 hover:text-black",
                    inventoryMode !== "basic" ? "opacity-40" : ""
                  ].join(" ")}
                  onClick={() => setColorMode("bucketed")}
                  disabled={inventoryMode !== "basic"}
                  title={inventoryMode !== "basic" ? "Color bucketing only applies to basic parts mode" : ""}
                >
                  bucketed
                </button>
              </div>
            </div>
          </div>
        </div>

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
                    className="h-40 w-full rounded-xl bg-white object-contain"
                  />
                ) : idea.preview_thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  debugOpenAi && idx !== 0 ? (
                    <div className="flex h-40 w-full items-center justify-center overflow-hidden rounded-xl border border-dashed border-black/20 bg-white text-xs text-black/50">
                      Preview hidden in debug mode
                    </div>
                  ) : (
                    <img
                      src={idea.preview_thumbnail}
                      alt={`${idea.title} (preview)`}
                      className="h-40 w-full rounded-xl bg-white object-contain"
                    />
                  )
                ) : (
                  <div className="relative flex h-40 w-full items-center justify-center overflow-hidden rounded-xl border border-dashed border-black/20 text-xs text-black/50">
                    {idea.previewStatus === "queued" || idea.previewStatus === "running" ? (
                      <>
                        <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-black/5 via-black/10 to-black/5" />
                        <div className="relative flex items-center gap-2 text-black/60">
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black/70" />
                          <span>Generating preview…</span>
                        </div>
                      </>
                    ) : (
                      <span>
                        {idea.previewStatus === "error"
                          ? `Preview failed: ${idea.previewError || "Unknown error"}`
                          : "Thumbnail not available"}
                      </span>
                    )}
                  </div>
                )}
                {(idea.ldrawStatus === "queued" || idea.ldrawStatus === "running") && (idea as any)?.ldrawArtifacts?.partial_thumbnail ? (
                  <div className="mt-3">
                    <div className="text-[11px] font-medium text-black/60">Build so far</div>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={(idea as any).ldrawArtifacts.partial_thumbnail}
                      alt={`${idea.title} (partial)`}
                      className="mt-1 h-40 w-full rounded-xl bg-white object-contain"
                    />
                  </div>
                ) : null}
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
                  <div className="mt-2 flex flex-wrap gap-2">
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
                          : idea.ldrawStatus === "cancelled"
                            ? `Cancelled: ${idea.ldrawError || "Cancelled by user"}`
                          : idea.ldrawStatus === "error"
                            ? `LDraw failed: ${idea.ldrawError || "Unknown error"}`
                            : "LDraw not generated"}
                      {(idea.ldrawStatus === "queued" || idea.ldrawStatus === "running") && ldrawJobByIdeaIndex[idx] ? (
                        <div className="mt-1 text-[11px] text-black/60">
                          <div className="flex items-center gap-2">
                            <span className="h-3 w-3 animate-spin rounded-full border-2 border-black/15 border-t-black/60" />
                            <span className="font-medium">Stage:</span>
                            <span>{String(ldrawJobByIdeaIndex[idx].stage || "working")}</span>
                            {ldrawJobByIdeaIndex[idx].startedAt ? (
                              <span className="text-black/40">({formatElapsed(ldrawJobByIdeaIndex[idx].startedAt)})</span>
                            ) : null}
                          </div>
                          {ldrawJobByIdeaIndex[idx]?.progress?.total ? (
                            <div className="mt-1 text-[11px] text-black/60">
                              <span className="font-medium">Progress:</span>{" "}
                              <span>
                                {String(ldrawJobByIdeaIndex[idx].progress.label || "working")}{" "}
                                ({String(ldrawJobByIdeaIndex[idx].progress.current ?? "?")}/{String(ldrawJobByIdeaIndex[idx].progress.total)})
                              </span>
                            </div>
                          ) : null}
                          {lastMeaningfulJobMessage(ldrawJobByIdeaIndex[idx]) ? (
                            <div className="mt-1">{lastMeaningfulJobMessage(ldrawJobByIdeaIndex[idx])}</div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )}
                  {idea.ldrawStatus === "done" && idea.ldraw_mpd && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <span className="rounded-full bg-black/5 px-2 py-1 text-xs">{countLDrawSteps(idea.ldraw_mpd)} steps</span>
                    </div>
                  )}
                  <div className="mt-3">
                    <div className="grid gap-2">
                      <div>
                        {idea.ldrawStatus !== "done" ? (
                          <Button
                            onClick={() => void startInstructions(idx)}
                            disabled={
                              !activeSearchId ||
                              ldrawSubmittingIdx === idx ||
                              idea.ldrawStatus === "running" ||
                              idea.ldrawStatus === "queued"
                            }
                          >
                            {ldrawSubmittingIdx === idx || idea.ldrawStatus === "running" || idea.ldrawStatus === "queued"
                              ? "Generating…"
                              : "Generate Instructions"}
                          </Button>
                        ) : null}
                        {(idea.ldrawStatus === "queued" || idea.ldrawStatus === "running") && (
                          <Button variant="secondary" onClick={() => void cancelInstructions(idx)} disabled={!activeSearchId}>
                            Cancel
                          </Button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          onClick={() => downloadBlueprint(idx)}
                          disabled={!activeSearchId || !(idea as any)?.ldrawArtifacts?.structure_plan}
                        >
                          Download blueprint
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => void downloadInstructions(idx, idea)}
                          disabled={
                            !activeSearchId ||
                            partialPdfSubmittingIdx === idx ||
                            (!idea.instructions_pdf && !(idea as any)?.ldrawArtifacts?.partial_instructions_pdf && !(idea as any)?.ldrawArtifacts?.partial_mpd)
                          }
                        >
                          {partialPdfSubmittingIdx === idx ? "Preparing…" : "Download Instructions"}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


