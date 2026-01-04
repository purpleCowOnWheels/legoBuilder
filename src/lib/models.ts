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

export type DbShape = {
  sets: LegoSet[];
  inventory: InventoryItem[];
  builds: BuildGuide[];
};


