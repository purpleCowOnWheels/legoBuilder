"use client";

import { useState } from "react";
import { Button } from "@/components/Button";

export default function IdeasPage() {
  const [preferences, setPreferences] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ideasMarkdown, setIdeasMarkdown] = useState<string>("");
  const [model, setModel] = useState<string>("");

  async function generate() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferences: preferences.trim() || undefined })
      });
      const json = (await res.json()) as { ideasMarkdown?: string; model?: string; error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to generate ideas");
      setIdeasMarkdown(json.ideasMarkdown || "");
      setModel(json.model || "");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
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
          <div className="flex items-center gap-3">
            <Button onClick={generate} disabled={loading}>
              {loading ? "Generating..." : "Generate ideas"}
            </Button>
            {model && <span className="text-xs text-black/50">model: {model}</span>}
          </div>
        </div>

        {err && <p className="mt-3 text-sm text-red-700">{err}</p>}
      </div>

      <div className="card p-6">
        <h2 className="text-sm font-semibold">Results</h2>
        <div className="mt-3 whitespace-pre-wrap text-sm text-black/80">
          {ideasMarkdown ? ideasMarkdown : "No results yet."}
        </div>
      </div>
    </main>
  );
}


