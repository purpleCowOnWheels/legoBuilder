import { InventoryItem, SetPart } from "@/lib/models";
import { newId } from "@/lib/ids";

export function keyOf(partNum: string, colorName: string) {
  return `${partNum}::${colorName}`.toLowerCase();
}

export function applyPartsDelta(params: {
  inventory: InventoryItem[];
  parts: SetPart[];
  direction: "add" | "subtract";
}): InventoryItem[] {
  const map = new Map<string, InventoryItem>();
  for (const item of params.inventory) {
    map.set(keyOf(item.partNum, item.colorName), { ...item });
  }

  const now = new Date().toISOString();
  const mult = params.direction === "add" ? 1 : -1;

  for (const p of params.parts) {
    const k = keyOf(p.partNum, p.colorName);
    const existing = map.get(k);
    const nextQty = (existing?.quantity ?? 0) + mult * p.quantity;
    if (nextQty <= 0) {
      map.delete(k);
      continue;
    }
    map.set(k, {
      id: existing?.id ?? newId("inv"),
      partNum: p.partNum,
      partName: p.partName,
      colorName: p.colorName,
      quantity: nextQty,
      updatedAt: now
    });
  }

  return Array.from(map.values()).sort((a, b) => {
    const ak = a.partNum + a.colorName;
    const bk = b.partNum + b.colorName;
    return ak.localeCompare(bk);
  });
}


