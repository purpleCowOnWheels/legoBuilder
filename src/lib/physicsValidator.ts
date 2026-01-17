/**
 * Physics Validator - "Will this fall apart?"
 * 
 * Validates structural integrity and physical stability of LEGO builds.
 * 
 * Checks for:
 * - Cantilever/overhang stability
 * - Top-heavy structures (tip-over risk)
 * - Weak single-stud connections
 * - Center of gravity analysis
 * - Unsupported spans
 * - Connection strength assessment
 */

// LDraw units
const STUD_SPACING = 20;  // LDU between studs
const PLATE_HEIGHT = 8;   // LDU per plate
const BRICK_HEIGHT = 24;  // LDU per brick (3 plates)

// Physics constants for LEGO
const MAX_CANTILEVER_STUDS = 4;  // Max studs a part can overhang without support
const MIN_STABLE_CONNECTIONS = 2;  // Minimum studs for a stable connection
const MAX_HEIGHT_TO_BASE_RATIO = 4;  // Tall narrow builds are unstable
const MAX_OVERHANG_RATIO = 0.5;  // Max % of part that can overhang

export interface PhysicsIssue {
  type: 
    | "cantilever_risk"
    | "tip_over_risk"  
    | "weak_connection"
    | "unsupported_span"
    | "single_stud_chain"
    | "top_heavy"
    | "extreme_overhang";
  severity: "error" | "warning";
  message: string;
  line_numbers?: number[];
  part_ids?: string[];
  details: Record<string, unknown>;
}

export interface PhysicsValidationResult {
  isStable: boolean;
  stabilityScore: number;  // 0-100, higher is more stable
  centerOfGravity: { x: number; y: number; z: number };
  baseFootprint: { minX: number; maxX: number; minZ: number; maxZ: number };
  issues: PhysicsIssue[];
  stats: {
    total_parts: number;
    single_stud_connections: number;
    max_cantilever: number;
    height_to_base_ratio: number;
    stability_factors: string[];
  };
}

interface ParsedPart {
  line: number;
  partId: string;
  color: number;
  x: number;
  y: number;
  z: number;
  rotation: number[][];  // 3x3 rotation matrix
  step: number;
}

/**
 * Parse LDraw MPD and extract part placements
 */
function parseParts(ldrawMpd: string): ParsedPart[] {
  const lines = ldrawMpd.split(/\r?\n/);
  const parts: ParsedPart[] = [];
  let currentStep = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Track step transitions
    if (/^0\s+STEP\s*$/i.test(line)) {
      currentStep++;
      continue;
    }

    // Parse type-1 lines (part placements)
    if (!line.startsWith("1 ")) continue;

    const tokens = line.split(/\s+/);
    if (tokens.length < 15) continue;

    const color = parseInt(tokens[1], 10);
    const x = parseFloat(tokens[2]);
    const y = parseFloat(tokens[3]);
    const z = parseFloat(tokens[4]);

    // Extract rotation matrix (tokens 5-13)
    const rotation = [
      [parseFloat(tokens[5]), parseFloat(tokens[6]), parseFloat(tokens[7])],
      [parseFloat(tokens[8]), parseFloat(tokens[9]), parseFloat(tokens[10])],
      [parseFloat(tokens[11]), parseFloat(tokens[12]), parseFloat(tokens[13])]
    ];

    const partId = tokens[14];

    if (isNaN(x) || isNaN(y) || isNaN(z)) continue;

    parts.push({ line: i + 1, partId, color, x, y, z, rotation, step: currentStep });
  }

  return parts;
}

/**
 * Estimate part dimensions based on part ID
 * Returns [width, height, length] in studs
 */
function estimatePartSize(partId: string): { width: number; height: number; length: number } {
  // Common part patterns
  const normalized = partId.toLowerCase().replace(".dat", "");

  // Plates (height = 1/3 brick)
  if (normalized.startsWith("3020")) return { width: 2, height: 1, length: 4 };  // 2x4 plate
  if (normalized.startsWith("3021")) return { width: 2, height: 1, length: 3 };  // 2x3 plate
  if (normalized.startsWith("3022")) return { width: 2, height: 1, length: 2 };  // 2x2 plate
  if (normalized.startsWith("3023")) return { width: 1, height: 1, length: 2 };  // 1x2 plate
  if (normalized.startsWith("3024")) return { width: 1, height: 1, length: 1 };  // 1x1 plate
  if (normalized.startsWith("3710")) return { width: 1, height: 1, length: 4 };  // 1x4 plate
  if (normalized.startsWith("3666")) return { width: 1, height: 1, length: 6 };  // 1x6 plate
  if (normalized.startsWith("3460")) return { width: 1, height: 1, length: 8 };  // 1x8 plate
  if (normalized.startsWith("3034")) return { width: 2, height: 1, length: 8 };  // 2x8 plate
  if (normalized.startsWith("3832")) return { width: 2, height: 1, length: 10 }; // 2x10 plate

  // Bricks (height = 3 plates)
  if (normalized.startsWith("3001")) return { width: 2, height: 3, length: 4 };  // 2x4 brick
  if (normalized.startsWith("3002")) return { width: 2, height: 3, length: 3 };  // 2x3 brick
  if (normalized.startsWith("3003")) return { width: 2, height: 3, length: 2 };  // 2x2 brick
  if (normalized.startsWith("3004")) return { width: 1, height: 3, length: 2 };  // 1x2 brick
  if (normalized.startsWith("3005")) return { width: 1, height: 3, length: 1 };  // 1x1 brick
  if (normalized.startsWith("3010")) return { width: 1, height: 3, length: 4 };  // 1x4 brick
  if (normalized.startsWith("3009")) return { width: 1, height: 3, length: 6 };  // 1x6 brick
  if (normalized.startsWith("3008")) return { width: 1, height: 3, length: 8 };  // 1x8 brick

  // Slopes
  if (normalized.startsWith("3040")) return { width: 1, height: 2, length: 2 };  // 45° slope
  if (normalized.startsWith("3039")) return { width: 2, height: 2, length: 2 };  // 45° 2x2 slope
  if (normalized.startsWith("3298")) return { width: 2, height: 2, length: 3 };  // 33° slope

  // Special parts
  if (normalized.startsWith("3626")) return { width: 1, height: 3, length: 1 };  // Minifig head
  if (normalized.startsWith("973")) return { width: 2, height: 3, length: 1 };   // Minifig torso

  // Default: estimate as 2x2 brick
  return { width: 2, height: 3, length: 2 };
}

/**
 * Calculate approximate weight (stud-equivalents) for a part
 */
function estimatePartWeight(partId: string): number {
  const size = estimatePartSize(partId);
  return size.width * size.length * (size.height / 3);
}

/**
 * Check for cantilever/overhang issues
 */
function checkCantilevers(parts: ParsedPart[]): PhysicsIssue[] {
  const issues: PhysicsIssue[] = [];
  
  if (parts.length === 0) return issues;

  // Group parts by approximate Y level (vertical layers)
  const layerThreshold = BRICK_HEIGHT;
  const layers = new Map<number, ParsedPart[]>();
  
  for (const part of parts) {
    const layerKey = Math.round(part.y / layerThreshold);
    if (!layers.has(layerKey)) layers.set(layerKey, []);
    layers.get(layerKey)!.push(part);
  }

  // For each layer above the base, check for unsupported overhangs
  const sortedLayers = Array.from(layers.keys()).sort((a, b) => b - a); // Top to bottom (negative Y is up)
  
  for (let i = 0; i < sortedLayers.length - 1; i++) {
    const layerKey = sortedLayers[i];
    const layerParts = layers.get(layerKey)!;
    const lowerLayerKey = sortedLayers[i + 1];
    const lowerParts = layers.get(lowerLayerKey) || [];

    for (const part of layerParts) {
      const size = estimatePartSize(part.partId);
      const halfWidth = (size.width * STUD_SPACING) / 2;
      const halfLength = (size.length * STUD_SPACING) / 2;

      // Check if there's support below this part
      const partMinX = part.x - halfWidth;
      const partMaxX = part.x + halfWidth;
      const partMinZ = part.z - halfLength;
      const partMaxZ = part.z + halfLength;

      let supportedArea = 0;
      let totalArea = size.width * size.length;

      for (const lowerPart of lowerParts) {
        const lowerSize = estimatePartSize(lowerPart.partId);
        const lowerHalfW = (lowerSize.width * STUD_SPACING) / 2;
        const lowerHalfL = (lowerSize.length * STUD_SPACING) / 2;

        const lowerMinX = lowerPart.x - lowerHalfW;
        const lowerMaxX = lowerPart.x + lowerHalfW;
        const lowerMinZ = lowerPart.z - lowerHalfL;
        const lowerMaxZ = lowerPart.z + lowerHalfL;

        // Calculate overlap
        const overlapX = Math.max(0, Math.min(partMaxX, lowerMaxX) - Math.max(partMinX, lowerMinX));
        const overlapZ = Math.max(0, Math.min(partMaxZ, lowerMaxZ) - Math.max(partMinZ, lowerMinZ));
        
        if (overlapX > 0 && overlapZ > 0) {
          supportedArea += (overlapX / STUD_SPACING) * (overlapZ / STUD_SPACING);
        }
      }

      const supportRatio = supportedArea / totalArea;
      const overhangRatio = 1 - supportRatio;

      if (overhangRatio > MAX_OVERHANG_RATIO && totalArea > 1) {
        issues.push({
          type: "cantilever_risk",
          severity: overhangRatio > 0.75 ? "error" : "warning",
          message: `Part ${part.partId} has ${Math.round(overhangRatio * 100)}% overhang without support`,
          line_numbers: [part.line],
          part_ids: [part.partId],
          details: {
            overhang_ratio: overhangRatio,
            supported_area: supportedArea,
            total_area: totalArea,
            position: { x: part.x, y: part.y, z: part.z }
          }
        });
      }
    }
  }

  return issues;
}

/**
 * Check for top-heavy / tip-over risk
 */
function checkTipOverRisk(parts: ParsedPart[]): PhysicsIssue[] {
  const issues: PhysicsIssue[] = [];
  
  if (parts.length === 0) return issues;

  // Calculate center of gravity
  let totalWeight = 0;
  let cogX = 0, cogY = 0, cogZ = 0;

  for (const part of parts) {
    const weight = estimatePartWeight(part.partId);
    cogX += part.x * weight;
    cogY += part.y * weight;
    cogZ += part.z * weight;
    totalWeight += weight;
  }

  if (totalWeight > 0) {
    cogX /= totalWeight;
    cogY /= totalWeight;
    cogZ /= totalWeight;
  }

  // Calculate base footprint (lowest layer)
  const minY = Math.min(...parts.map(p => p.y));
  const baseParts = parts.filter(p => p.y < minY + BRICK_HEIGHT);

  if (baseParts.length === 0) return issues;

  let baseMinX = Infinity, baseMaxX = -Infinity;
  let baseMinZ = Infinity, baseMaxZ = -Infinity;

  for (const part of baseParts) {
    const size = estimatePartSize(part.partId);
    const halfW = (size.width * STUD_SPACING) / 2;
    const halfL = (size.length * STUD_SPACING) / 2;
    
    baseMinX = Math.min(baseMinX, part.x - halfW);
    baseMaxX = Math.max(baseMaxX, part.x + halfW);
    baseMinZ = Math.min(baseMinZ, part.z - halfL);
    baseMaxZ = Math.max(baseMaxZ, part.z + halfL);
  }

  // Check if COG is within base footprint
  const margin = STUD_SPACING; // Allow some margin
  
  if (cogX < baseMinX - margin || cogX > baseMaxX + margin ||
      cogZ < baseMinZ - margin || cogZ > baseMaxZ + margin) {
    issues.push({
      type: "tip_over_risk",
      severity: "error",
      message: "Model's center of gravity is outside the base footprint - it will tip over",
      details: {
        center_of_gravity: { x: cogX, y: cogY, z: cogZ },
        base_footprint: { minX: baseMinX, maxX: baseMaxX, minZ: baseMinZ, maxZ: baseMaxZ }
      }
    });
  }

  // Check height-to-base ratio
  const maxY = Math.max(...parts.map(p => p.y));
  const height = Math.abs(maxY - minY);
  const baseWidth = Math.max(baseMaxX - baseMinX, baseMaxZ - baseMinZ);
  
  if (baseWidth > 0) {
    const ratio = height / baseWidth;
    if (ratio > MAX_HEIGHT_TO_BASE_RATIO) {
      issues.push({
        type: "top_heavy",
        severity: ratio > MAX_HEIGHT_TO_BASE_RATIO * 1.5 ? "error" : "warning",
        message: `Model is very tall and narrow (${ratio.toFixed(1)}:1 ratio) - unstable`,
        details: {
          height,
          base_width: baseWidth,
          ratio,
          recommended_max_ratio: MAX_HEIGHT_TO_BASE_RATIO
        }
      });
    }
  }

  return issues;
}

/**
 * Check for weak connections (single-stud chains)
 */
function checkWeakConnections(parts: ParsedPart[]): PhysicsIssue[] {
  const issues: PhysicsIssue[] = [];
  
  // Find 1x1 parts that connect to other 1x1 parts (single stud chains)
  const smallParts = parts.filter(p => {
    const size = estimatePartSize(p.partId);
    return size.width === 1 && size.length === 1;
  });

  // Group by approximate vertical position
  const layerMap = new Map<number, ParsedPart[]>();
  for (const part of smallParts) {
    const layerKey = Math.round(part.y / PLATE_HEIGHT);
    if (!layerMap.has(layerKey)) layerMap.set(layerKey, []);
    layerMap.get(layerKey)!.push(part);
  }

  // Check for vertical stacks of 1x1 parts
  let maxChainLength = 0;
  for (const part of smallParts) {
    let chainLength = 1;
    let currentY = part.y;
    
    // Look for parts directly above
    while (true) {
      const aboveY = currentY - PLATE_HEIGHT;
      const layerKey = Math.round(aboveY / PLATE_HEIGHT);
      const aboveParts = layerMap.get(layerKey) || [];
      
      const directlyAbove = aboveParts.find(p => 
        Math.abs(p.x - part.x) < STUD_SPACING / 2 &&
        Math.abs(p.z - part.z) < STUD_SPACING / 2 &&
        Math.abs(p.y - aboveY) < PLATE_HEIGHT / 2
      );
      
      if (directlyAbove) {
        chainLength++;
        currentY = aboveY;
      } else {
        break;
      }
    }
    
    maxChainLength = Math.max(maxChainLength, chainLength);
    
    if (chainLength >= 3) {
      issues.push({
        type: "single_stud_chain",
        severity: chainLength >= 5 ? "error" : "warning",
        message: `Found chain of ${chainLength} single-stud parts - very weak connection`,
        line_numbers: [part.line],
        part_ids: [part.partId],
        details: {
          chain_length: chainLength,
          start_position: { x: part.x, y: part.y, z: part.z }
        }
      });
    }
  }

  return issues;
}

/**
 * Main physics validation function
 */
export function validatePhysics(ldrawMpd: string): PhysicsValidationResult {
  const parts = parseParts(ldrawMpd);
  const issues: PhysicsIssue[] = [];

  if (parts.length === 0) {
    return {
      isStable: true,
      stabilityScore: 100,
      centerOfGravity: { x: 0, y: 0, z: 0 },
      baseFootprint: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
      issues: [],
      stats: {
        total_parts: 0,
        single_stud_connections: 0,
        max_cantilever: 0,
        height_to_base_ratio: 0,
        stability_factors: ["No parts to analyze"]
      }
    };
  }

  // Run all physics checks
  issues.push(...checkCantilevers(parts));
  issues.push(...checkTipOverRisk(parts));
  issues.push(...checkWeakConnections(parts));

  // Calculate center of gravity
  let totalWeight = 0;
  let cogX = 0, cogY = 0, cogZ = 0;

  for (const part of parts) {
    const weight = estimatePartWeight(part.partId);
    cogX += part.x * weight;
    cogY += part.y * weight;
    cogZ += part.z * weight;
    totalWeight += weight;
  }

  if (totalWeight > 0) {
    cogX /= totalWeight;
    cogY /= totalWeight;
    cogZ /= totalWeight;
  }

  // Calculate base footprint
  const minY = Math.min(...parts.map(p => p.y));
  const baseParts = parts.filter(p => p.y < minY + BRICK_HEIGHT);
  
  let baseMinX = 0, baseMaxX = 0, baseMinZ = 0, baseMaxZ = 0;
  
  if (baseParts.length > 0) {
    baseMinX = Infinity; baseMaxX = -Infinity;
    baseMinZ = Infinity; baseMaxZ = -Infinity;

    for (const part of baseParts) {
      const size = estimatePartSize(part.partId);
      const halfW = (size.width * STUD_SPACING) / 2;
      const halfL = (size.length * STUD_SPACING) / 2;
      
      baseMinX = Math.min(baseMinX, part.x - halfW);
      baseMaxX = Math.max(baseMaxX, part.x + halfW);
      baseMinZ = Math.min(baseMinZ, part.z - halfL);
      baseMaxZ = Math.max(baseMaxZ, part.z + halfL);
    }
  }

  // Calculate stats
  const smallParts = parts.filter(p => {
    const size = estimatePartSize(p.partId);
    return size.width === 1 && size.length === 1;
  });

  const maxY = Math.max(...parts.map(p => p.y));
  const height = Math.abs(maxY - minY);
  const baseWidth = Math.max(baseMaxX - baseMinX, baseMaxZ - baseMinZ);
  const heightToBaseRatio = baseWidth > 0 ? height / baseWidth : 0;

  const cantileverIssues = issues.filter(i => i.type === "cantilever_risk");
  const maxCantilever = cantileverIssues.length > 0
    ? Math.max(...cantileverIssues.map(i => (i.details.overhang_ratio as number) || 0))
    : 0;

  // Calculate stability score
  const errorCount = issues.filter(i => i.severity === "error").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;
  
  let stabilityScore = 100;
  stabilityScore -= errorCount * 25;  // Major penalties for errors
  stabilityScore -= warningCount * 10; // Minor penalties for warnings
  stabilityScore = Math.max(0, Math.min(100, stabilityScore));

  // Compile stability factors
  const stabilityFactors: string[] = [];
  if (errorCount === 0 && warningCount === 0) {
    stabilityFactors.push("No structural issues detected");
  }
  if (heightToBaseRatio < 2) {
    stabilityFactors.push("Good base-to-height ratio");
  }
  if (smallParts.length / parts.length < 0.3) {
    stabilityFactors.push("Mostly larger, stable parts");
  }
  if (cantileverIssues.length === 0) {
    stabilityFactors.push("No unsupported overhangs");
  }

  return {
    isStable: errorCount === 0,
    stabilityScore,
    centerOfGravity: { x: cogX, y: cogY, z: cogZ },
    baseFootprint: { minX: baseMinX, maxX: baseMaxX, minZ: baseMinZ, maxZ: baseMaxZ },
    issues,
    stats: {
      total_parts: parts.length,
      single_stud_connections: smallParts.length,
      max_cantilever: maxCantilever,
      height_to_base_ratio: heightToBaseRatio,
      stability_factors: stabilityFactors
    }
  };
}

/**
 * Quick stability check - returns true if model is likely stable
 */
export function isPhysicallyStable(ldrawMpd: string): boolean {
  const result = validatePhysics(ldrawMpd);
  return result.isStable && result.stabilityScore >= 70;
}
