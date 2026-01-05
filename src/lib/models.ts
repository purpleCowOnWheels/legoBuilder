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

export type BuildIdeaResult = {
  title: string;
  description: string;
  number_of_parts: number;
  difficulty: "easy" | "medium" | "hard";
  estimated_time_minutes: number;
  // Full build in LDraw MPD format (use 0 STEP directives).
  ldraw_mpd: string;
  thumbnail: string | null; // URL (served from /public)
  instructions_pdf: string | null; // URL (served from /public)
};

export type IdeaCandidateSpec = {
  // Compact “build spec” used to drive LDraw generation later.
  // Keep this short and deterministic.
  concept: string;
  key_features: string[];
  color_palette: string[];
  step_count_estimate: number;
};

export type IdeaCandidate = {
  title: string;
  description: string; // short (1–2 sentences)
  estimated_time_minutes: number; // rough estimate for build time
  spec: IdeaCandidateSpec;
  // Auto-generated quick preview (micro MPD + thumbnail)
  previewStatus?: "not_started" | "queued" | "running" | "done" | "error";
  previewJobId?: Id;
  previewError?: string;
  preview_mpd?: string;
  preview_thumbnail?: string | null;
  // Filled in after "Generate LDraw" is run for this idea
  ldrawStatus?: "not_started" | "queued" | "running" | "done" | "error";
  ldrawJobId?: Id;
  ldrawError?: string;
  ldrawStage?: string;
  ldrawProgress?: { current?: number; total?: number; label?: string };
  ldrawArtifacts?: {
    part_palette?: unknown;
    structure_plan?: unknown;
    step_outline?: unknown;
    chunks?: Array<{ index: number; stepsFrom?: number; stepsTo?: number; charLen?: number }>;
  };
  ldraw_mpd?: string;
  thumbnail?: string | null;
  instructions_pdf?: string | null;
};

export type IdeaSearch = {
  id: Id;
  createdAt: string;
  preferences?: string;
  // New (range); leave undefined for "Any"
  targetPartsMin?: number;
  targetPartsMax?: number;
  difficulty?: "easy" | "medium" | "hard";
  age?: number;
  buildTimeMinutes?: number;
  count?: number; // number of ideas requested (defaults to 2)
  model?: string;
  status?: "queued" | "running" | "done" | "error";
  jobId?: Id;
  updatedAt?: string;
  error?: string;
  ideas: IdeaCandidate[]; // defaults to 2
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
  status: "queued" | "running" | "done" | "error";
  stage:
    | "palette"
    | "plan"
    | "outline"
    | "mpd_chunking"
    | "validate"
    | "thumbnail"
    | "pdf"
    | "done";
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
  description: string;
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


