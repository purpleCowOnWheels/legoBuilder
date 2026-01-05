export function countLDrawSteps(ldrawMpd: string) {
  // Count "0 STEP" directives; if none, treat as 1 step (single model state).
  const matches = ldrawMpd.match(/^\s*0\s+STEP\s*$/gim);
  const count = matches ? matches.length : 0;
  return Math.max(1, count + 1);
}


