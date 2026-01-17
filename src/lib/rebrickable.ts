import { SetPart } from "@/lib/models";

type RebrickablePartResponse = {
  results: Array<{
    quantity: number;
    part: { part_num: string; name: string };
    color: { name: string };
  }>;
  next: string | null;
};

type RebrickableSetSearchResponse = {
  results: Array<{
    set_num: string;
    name: string;
    year?: number;
    num_parts?: number;
  }>;
  next: string | null;
};

type RebrickableColorListResponse = {
  results: Array<{
    id: number;
    name: string;
    external_ids?: { [k: string]: unknown };
  }>;
  next: string | null;
};

type RebrickablePartDetailsResponse = {
  part_num: string;
  name: string;
  part_cat_id?: number;
  external_ids?: { [k: string]: unknown };
};

export type SetSearchResult = {
  setNum: string;
  name: string;
  year?: number;
  numParts?: number;
};

async function fetchAllSetPartsFromRebrickable(setNum: string, apiKey: string): Promise<SetPart[]> {
  // Docs: https://rebrickable.com/api/
  // Endpoint example:
  // GET /api/v3/lego/sets/{set_num}/parts/
  const base = `https://rebrickable.com/api/v3/lego/sets/${encodeURIComponent(setNum)}/parts/`;

  let url: string | null = base;
  const parts: SetPart[] = [];
  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `key ${apiKey}`
      },
      cache: "no-store"
    });
    if (!res.ok) {
      throw new Error(`Rebrickable error ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as RebrickablePartResponse;
    for (const row of json.results) {
      parts.push({
        partNum: row.part.part_num,
        partName: row.part.name,
        colorName: row.color.name,
        quantity: row.quantity
      });
    }
    url = json.next;
  }
  return parts;
}

export async function searchSets(query: string): Promise<SetSearchResult[]> {
  const apiKey = process.env.REBRICKABLE_API_KEY;
  const q = query.trim();
  if (!q) return [];

  if (!apiKey) {
    // Offline/No-key fallback.
    return [
      { setNum: `${q}-1`, name: `Mock set for "${q}"`, year: 2024, numParts: 123 }
    ];
  }

  const url = new URL("https://rebrickable.com/api/v3/lego/sets/");
  url.searchParams.set("search", q);
  url.searchParams.set("page_size", "25");

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `key ${apiKey}`
    },
    cache: "no-store"
  });
  if (!res.ok) {
    throw new Error(`Rebrickable error ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as RebrickableSetSearchResponse;
  return (json.results || []).map((s) => ({
    setNum: s.set_num,
    name: s.name,
    year: s.year,
    numParts: s.num_parts
  }));
}

export async function getPartsForSet(setNum: string): Promise<SetPart[]> {
  const apiKey = process.env.REBRICKABLE_API_KEY;
  if (apiKey) {
    return await fetchAllSetPartsFromRebrickable(setNum, apiKey);
  }

  // Offline/No-key fallback so the app is usable immediately.
  return [
    { partNum: "3001", partName: "Brick 2 x 4", colorName: "Red", quantity: 10 },
    { partNum: "3003", partName: "Brick 2 x 2", colorName: "Blue", quantity: 14 },
    { partNum: "3023", partName: "Plate 1 x 2", colorName: "Black", quantity: 30 }
  ];
}

function getApiKeyOrThrow() {
  const apiKey = process.env.REBRICKABLE_API_KEY;
  if (!apiKey) throw new Error("REBRICKABLE_API_KEY is not set");
  return apiKey;
}

async function fetchRebrickableJson<T>(url: string, apiKey: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `key ${apiKey}` },
    cache: "no-store"
  });
  if (!res.ok) throw new Error(`Rebrickable error ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function getAllRebrickableColors(): Promise<Array<{ name: string; ldrawColorId: number | null }>> {
  const apiKey = getApiKeyOrThrow();
  let url: string | null = "https://rebrickable.com/api/v3/lego/colors/?page_size=100";
  const out: Array<{ name: string; ldrawColorId: number | null }> = [];
  while (url) {
    const currentUrl: string = url;
    const json: RebrickableColorListResponse = await fetchRebrickableJson(currentUrl, apiKey);
    for (const c of json.results) {
      const ext = (c.external_ids || {}) as any;
      // Rebrickable typically exposes LDraw color id under external_ids.LDraw
      const ldraw = ext?.LDraw;
      const ldrawColorId =
        typeof ldraw === "number"
          ? ldraw
          : typeof ldraw === "string" && /^\d+$/.test(ldraw)
            ? Number(ldraw)
            : null;
      out.push({ name: c.name, ldrawColorId });
    }
    url = json.next;
  }
  return out;
}

export async function getPartLDrawFile(partNum: string): Promise<{ ldrawFile: string | null; partCatId?: number; name?: string }> {
  const apiKey = getApiKeyOrThrow();
  const url = `https://rebrickable.com/api/v3/lego/parts/${encodeURIComponent(partNum)}/`;
  const json = await fetchRebrickableJson<RebrickablePartDetailsResponse>(url, apiKey);
  const ext = (json.external_ids || {}) as any;
  const ldraw = ext?.LDraw;
  const candidates: string[] =
    Array.isArray(ldraw) ? ldraw.map((x) => String(x)) : typeof ldraw === "string" ? [ldraw] : [];
  // Prefer .dat
  const dat = candidates.find((x) => /\.dat$/i.test(x)) || candidates[0] || null;
  return { ldrawFile: dat, partCatId: json.part_cat_id, name: json.name };
}


