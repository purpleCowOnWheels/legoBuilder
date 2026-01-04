export function newId(prefix: string) {
  // good-enough local ID; replace with UUID later if needed
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}


