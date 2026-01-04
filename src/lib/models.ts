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
  thumbnail: string | null; // URL (served from /public)
  thumbnail_prompt: string;
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
  model?: string;
  imageModel?: string;
  ideas: BuildIdeaResult[]; // max 2
};

export type DbShape = {
  sets: LegoSet[];
  inventory: InventoryItem[];
  builds: BuildGuide[];
  ideaSearches: IdeaSearch[];
};


