export type Id = string;

export type LegoSet = {
  id: Id;
  setNum: string; // e.g. "10328-1"
  name: string;
  year?: number;
  theme?: string;
  createdAt: string;
  parts: SetPart[];
};

export type SetPart = {
  partNum: string; // e.g. "3001"
  partName: string;
  colorName: string; // keep human-readable for MVP
  quantity: number;
};

export type InventoryItem = {
  id: Id;
  partNum: string;
  partName: string;
  colorName: string;
  quantity: number;
  updatedAt: string;
};

export type BuildGuide = {
  id: Id;
  goal: string;
  createdAt: string;
  inventorySnapshot: InventoryItem[];
  draftGuideMarkdown: string;
  expandedGuideMarkdown?: string;
  model?: string;
};

// DEPRECATED: BuildIdeaResult is legacy (from old structured ideas approach).
// Saved builds now just store title + assets (no description/spec).
export type BuildIdeaResult = {
  title: string;
  ldraw_mpd: string;
  thumbnail: string | null; // URL (served from /public)
  instructions_pdf: string | null; // URL (served from /public)
};

// Simplified: IdeaCandidate is now just a preview image variant for a given search.
// All metadata (title, user prompt, constraints) lives on IdeaSearch.
export type IdeaCandidate = {
  // Just the title for this variant (e.g., "Space Shuttle 1", "Space Shuttle 2")
  title: string;
  // Preview thumbnail (generated directly from user prompt)
  preview_thumbnail?: string | null;
  previewStatus?: "not_started" | "queued" | "running" | "done" | "error";
  previewJobId?: Id;
  previewError?: string;
  // Filled in after "Generate Instructions" is clicked
  ldrawStatus?: "not_started" | "queued" | "running" | "done" | "error" | "cancelled";
  ldrawJobId?: Id;
  ldrawError?: string;
  ldrawStage?: string;
  ldrawProgress?: { current?: number; total?: number; label?: string };
  ldrawArtifacts?: {
    structure_plan?: unknown;
    step_outline?: unknown;
    chunks?: Array<{ index: number; stepsFrom?: number; stepsTo?: number; charLen?: number }>;
    partial_mpd?: string;
    partial_thumbnail?: string | null;
    partial_instructions_pdf?: string | null;
    partial_pdf_updated_at?: string;
    partial_updated_at?: string;
  };
  ldraw_mpd?: string;
  thumbnail?: string | null;
  instructions_pdf?: string | null;
};

export type IdeaSearch = {
  id: Id;
  createdAt: string;
  preferences?: string; // Original user prompt/request
  // Extracted title (once available, after preview generation)
  title?: string;
  // Constraints/filters from the user
  targetPartsMin?: number;
  targetPartsMax?: number;
  difficulty?: "easy" | "medium" | "hard";
  age?: number;
  buildTimeMinutes?: number;
  count?: number; // number of preview variants to generate (defaults to 2)
  // Inventory mode for instruction generation: basic parts only (core bricks/plates/tiles) or full inventory.
  inventoryMode?: "basic" | "full";
  // Optional: bucket color names to a smaller palette (reduces prompt size). Only applied when inventoryMode=basic.
  colorMode?: "exact" | "bucketed";
  model?: string;
  status?: "queued" | "running" | "done" | "error";
  jobId?: Id;
  updatedAt?: string;
  error?: string;
  ideas: IdeaCandidate[]; // Preview image variants (e.g., 2 different angles/interpretations)
};

export type IdeaJobLogEvent = {
  at: string;
  type:
    | "queued"
    | "started"
    | "heartbeat"
    | "openai_round_start"
    | "openai_tool_calls"
    | "openai_tool_results"
    | "openai_round_done"
    | "lpub3d_start"
    | "lpub3d_done"
    | "done"
    | "error";
  message: string;
  data?: unknown;
};

export type IdeaGenerationJob = {
  id: Id;
  ideaSearchId: Id;
  status: "queued" | "running" | "done" | "error";
  stage: "openai" | "lpub3d" | "done";
  maxRounds?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  logs: IdeaJobLogEvent[];
};

export type LDrawJobLogEvent = {
  at: string;
  type:
    | "queued"
    | "started"
    | "heartbeat"
    | "openai_round_start"
    | "openai_tool_calls"
    | "openai_tool_results"
    | "openai_round_done"
    | "lpub3d_start"
    | "lpub3d_done"
    | "done"
    | "error";
  message: string;
  data?: unknown;
};

export type LDrawGenerationJob = {
  id: Id;
  ideaSearchId: Id;
  ideaIndex: number;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  stage:
    | "palette"
    | "preview"
    | "preview_thumbnail"
    | "plan"
    | "outline"
    | "mpd"
    | "validate"
    | "final_thumbnail"
    | "pdf"
    | "done";
  progress?: { current?: number; total?: number; label?: string };
  cancelRequestedAt?: string;
  cancelledAt?: string;
  maxRounds?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  logs: LDrawJobLogEvent[];
};

export type PreviewJobLogEvent = {
  at: string;
  type: "queued" | "started" | "heartbeat" | "openai" | "lpub3d" | "done" | "error";
  message: string;
  data?: unknown;
};

export type PreviewGenerationJob = {
  id: Id;
  ideaSearchId: Id;
  ideaIndex: number;
  // Captures the preview mode used for this job (helps debug)
  reasoningEffort?: "low" | "medium" | "high" | "image";
  status: "queued" | "running" | "done" | "error";
  stage: "openai" | "thumbnail" | "done";
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  logs: PreviewJobLogEvent[];
};

export type SavedBuild = {
  id: Id;
  createdAt: string;
  title: string;
  // description removed: saved builds only need title + assets
  ldraw_mpd: string;
  thumbnail: string | null;
  instructions_pdf: string | null;
  // Where this build came from (optional but useful for dedupe/debug)
  sourceIdeaSearchId?: Id;
  sourceIdeaIndex?: number;
};

export type DbShape = {
  sets: LegoSet[];
  inventory: InventoryItem[];
  builds: BuildGuide[];
  ideaSearches: IdeaSearch[];
  ideaGenerationJobs: IdeaGenerationJob[];
  ldrawGenerationJobs: LDrawGenerationJob[];
  previewGenerationJobs: PreviewGenerationJob[];
  savedBuilds: SavedBuild[];
};


