#!/usr/bin/env tsx
/**
 * Tests for connection validation - verifies we catch all types of invalid placements
 * 
 * Categories of invalidity discovered during development:
 * 1. Between studs on even-width parts (no center stud)
 * 2. Rotated parts not aligned to parent studs
 * 3. Small part on large part at non-stud position
 * 4. Large part on small part (no valid connection point)
 * 5. Offset too large (no overlap at all)
 * 6. Cross-beam rotation without proper offset
 * 7. Spanning parts that don't reach valid studs
 */

const PART_STUDS: Record<string, Array<[number, number]>> = {
  // 1x1 parts - single center stud
  "3005": [[0, 0]], // 1x1 brick
  "3024": [[0, 0]], // 1x1 plate
  // 2x2 parts - 4 studs at corners (no center stud!)
  "3003": [[-1, -1], [1, -1], [-1, 1], [1, 1]], // 2x2 brick
  "3022": [[-1, -1], [1, -1], [-1, 1], [1, 1]], // 2x2 plate
  // 1x2 parts - 2 studs along length (X axis by default)
  "3004": [[-1, 0], [1, 0]], // 1x2 brick
  "3023": [[-1, 0], [1, 0]], // 1x2 plate
  // 1x4 parts - 4 studs along length
  "3010": [[-3, 0], [-1, 0], [1, 0], [3, 0]], // 1x4 brick
  // 2x4 parts - 8 studs in 2x4 grid
  "3001": [[-3, -1], [-1, -1], [1, -1], [3, -1], [-3, 1], [-1, 1], [1, 1], [3, 1]], // 2x4 brick
  // 4x4 plate - 16 studs
  "3031": [
    [-3, -3], [-1, -3], [1, -3], [3, -3],
    [-3, -1], [-1, -1], [1, -1], [3, -1],
    [-3, 1], [-1, 1], [1, 1], [3, 1],
    [-3, 3], [-1, 3], [1, 3], [3, 3]
  ],
};

function getRotatedStuds(partId: string, rotation: 0 | 90 | 180 | 270): Array<[number, number]> {
  const studs = PART_STUDS[partId] || [[0, 0]];
  return studs.map(([x, z]) => {
    switch (rotation) {
      case 90: return [z, -x] as [number, number];
      case 180: return [-x, -z] as [number, number];
      case 270: return [-z, x] as [number, number];
      default: return [x, z] as [number, number];
    }
  });
}

function validateConnection(
  parentPartId: string,
  parentRotation: 0 | 90 | 180 | 270,
  childPartId: string,
  childRotation: 0 | 90 | 180 | 270,
  offsetX: number,
  offsetZ: number
): { valid: boolean; sharedStuds: number; error?: string } {
  const parentStuds = getRotatedStuds(parentPartId, parentRotation);
  const childStuds = getRotatedStuds(childPartId, childRotation);
  
  const childStudsAbsolute = childStuds.map(([cx, cz]) => [cx + offsetX, cz + offsetZ]);
  
  let sharedStuds = 0;
  for (const [cx, cz] of childStudsAbsolute) {
    for (const [px, pz] of parentStuds) {
      if (cx === px && cz === pz) {
        sharedStuds++;
        break;
      }
    }
  }
  
  if (sharedStuds === 0) {
    return {
      valid: false,
      sharedStuds: 0,
      error: `No stud overlap: child at offset (${offsetX},${offsetZ}) doesn't align with any parent studs`
    };
  }
  
  return { valid: true, sharedStuds };
}

// Test infrastructure
interface TestCase {
  name: string;
  category: string;
  parentPart: string;
  parentRotation: 0 | 90 | 180 | 270;
  childPart: string;
  childRotation: 0 | 90 | 180 | 270;
  offsetX: number;
  offsetZ: number;
  expectedValid: boolean;
  description: string;
}

const tests: TestCase[] = [
  // ============================================
  // CATEGORY 1: Between studs on even-width parts
  // Even-width parts (2x2, 4x4) have NO center stud
  // ============================================
  {
    name: "2x2_center_invalid",
    category: "between_studs_even_width",
    parentPart: "3003", parentRotation: 0,
    childPart: "3003", childRotation: 0,
    offsetX: 0, offsetZ: 0,
    expectedValid: true, // studs at ±1,±1 overlap perfectly
    description: "2x2 on 2x2 centered - VALID (corner studs align)"
  },
  {
    name: "2x2_offset_1_0_invalid",
    category: "between_studs_even_width",
    parentPart: "3003", parentRotation: 0,
    childPart: "3003", childRotation: 0,
    offsetX: 1, offsetZ: 0,
    expectedValid: false, // child studs at (0,-1),(2,-1),(0,1),(2,1) - parent has ±1,±1
    description: "2x2 on 2x2 offset (1,0) - INVALID (between studs in Z)"
  },
  {
    name: "2x2_offset_0_1_invalid",
    category: "between_studs_even_width",
    parentPart: "3003", parentRotation: 0,
    childPart: "3003", childRotation: 0,
    offsetX: 0, offsetZ: 1,
    expectedValid: false, // child studs at (-1,0),(1,0),(-1,2),(1,2) - no match
    description: "2x2 on 2x2 offset (0,1) - INVALID (between studs in X)"
  },
  {
    name: "2x2_offset_2_0_valid",
    category: "between_studs_even_width",
    parentPart: "3003", parentRotation: 0,
    childPart: "3003", childRotation: 0,
    offsetX: 2, offsetZ: 0,
    expectedValid: true, // child studs at (1,-1),(3,-1),(1,1),(3,1) - matches (1,-1),(1,1)
    description: "2x2 on 2x2 offset (2,0) - VALID (2-stud overlap)"
  },
  {
    name: "4x4_offset_1_1_invalid",
    category: "between_studs_even_width",
    parentPart: "3031", parentRotation: 0,
    childPart: "3003", childRotation: 0,
    offsetX: 1, offsetZ: 1,
    expectedValid: false, // 4x4 studs at odd positions, 2x2 offset by 1 puts studs at even positions
    description: "2x2 on 4x4 offset (1,1) - INVALID (studs land at even coords)"
  },
  {
    name: "4x4_offset_0_0_valid",
    category: "between_studs_even_width",
    parentPart: "3031", parentRotation: 0,
    childPart: "3003", childRotation: 0,
    offsetX: 0, offsetZ: 0,
    expectedValid: true, // 2x2 studs at ±1,±1 match 4x4's inner studs
    description: "2x2 on 4x4 centered - VALID (inner studs align)"
  },

  // ============================================
  // CATEGORY 2: Rotated parts not aligned
  // After rotation, stud positions change
  // ============================================
  {
    name: "1x2_rot90_offset_0_1_invalid",
    category: "rotation_misaligned",
    parentPart: "3003", parentRotation: 0,
    childPart: "3004", childRotation: 90,
    offsetX: 0, offsetZ: 1,
    expectedValid: false, // rotated 1x2 studs at (0,-1),(0,1), offset (0,1) puts them at (0,0),(0,2)
    description: "1x2 rot90 on 2x2 at (0,1) - INVALID (studs at z=0,2 not z=±1)"
  },
  {
    name: "1x2_rot90_offset_1_0_valid",
    category: "rotation_misaligned",
    parentPart: "3003", parentRotation: 0,
    childPart: "3004", childRotation: 90,
    offsetX: 1, offsetZ: 0,
    expectedValid: true, // rotated studs at (0,-1),(0,1), offset (1,0) puts them at (1,-1),(1,1) - match!
    description: "1x2 rot90 on 2x2 at (1,0) - VALID (studs at (1,±1))"
  },
  {
    name: "1x4_rot90_offset_0_0_invalid",
    category: "rotation_misaligned",
    parentPart: "3010", parentRotation: 0,
    childPart: "3010", childRotation: 90,
    offsetX: 0, offsetZ: 0,
    expectedValid: false, // base studs at x=±1,±3, z=0; rotated studs at x=0, z=±1,±3
    description: "1x4 rot90 on 1x4 at (0,0) - INVALID (perpendicular, no overlap)"
  },
  {
    name: "1x4_rot90_offset_1_-1_valid",
    category: "rotation_misaligned",
    parentPart: "3010", parentRotation: 0,
    childPart: "3010", childRotation: 90,
    offsetX: 1, offsetZ: -1,
    expectedValid: true, // rotated studs at (1,-4),(1,-2),(1,0),(1,2) - (1,0) matches base
    description: "1x4 rot90 on 1x4 at (1,-1) - VALID (one stud overlap)"
  },
  {
    name: "1x2_rot270_offset_0_-1_invalid",
    category: "rotation_misaligned",
    parentPart: "3003", parentRotation: 0,
    childPart: "3004", childRotation: 270,
    offsetX: 0, offsetZ: -1,
    expectedValid: false, // rot270 studs at (0,1),(0,-1), offset gives (0,0),(0,-2)
    description: "1x2 rot270 on 2x2 at (0,-1) - INVALID"
  },
  {
    name: "1x2_rot270_offset_-1_0_valid",
    category: "rotation_misaligned",
    parentPart: "3003", parentRotation: 0,
    childPart: "3004", childRotation: 270,
    offsetX: -1, offsetZ: 0,
    expectedValid: true, // rot270 studs at (0,1),(0,-1), offset (-1,0) gives (-1,1),(-1,-1) - match!
    description: "1x2 rot270 on 2x2 at (-1,0) - VALID"
  },

  // ============================================
  // CATEGORY 3: Small part on large part wrong position
  // 1x1 must be placed exactly on a stud
  // ============================================
  {
    name: "1x1_on_2x2_center_invalid",
    category: "small_on_large_wrong_pos",
    parentPart: "3003", parentRotation: 0,
    childPart: "3005", childRotation: 0,
    offsetX: 0, offsetZ: 0,
    expectedValid: false, // 2x2 has NO center stud
    description: "1x1 on 2x2 center - INVALID (no center stud on 2x2)"
  },
  {
    name: "1x1_on_2x2_offset_1_0_invalid",
    category: "small_on_large_wrong_pos",
    parentPart: "3003", parentRotation: 0,
    childPart: "3005", childRotation: 0,
    offsetX: 1, offsetZ: 0,
    expectedValid: false, // 2x2 studs at ±1,±1, not at (1,0)
    description: "1x1 on 2x2 at (1,0) - INVALID (between Z studs)"
  },
  {
    name: "1x1_on_2x2_offset_1_1_valid",
    category: "small_on_large_wrong_pos",
    parentPart: "3003", parentRotation: 0,
    childPart: "3005", childRotation: 0,
    offsetX: 1, offsetZ: 1,
    expectedValid: true, // exactly on corner stud
    description: "1x1 on 2x2 at (1,1) - VALID (corner stud)"
  },
  {
    name: "1x1_on_2x4_offset_0_0_invalid",
    category: "small_on_large_wrong_pos",
    parentPart: "3001", parentRotation: 0,
    childPart: "3005", childRotation: 0,
    offsetX: 0, offsetZ: 0,
    expectedValid: false, // 2x4 studs at x=±1,±3 and z=±1, not at origin
    description: "1x1 on 2x4 center - INVALID (no center stud)"
  },
  {
    name: "1x1_on_2x4_offset_1_1_valid",
    category: "small_on_large_wrong_pos",
    parentPart: "3001", parentRotation: 0,
    childPart: "3005", childRotation: 0,
    offsetX: 1, offsetZ: 1,
    expectedValid: true, // (1,1) is a valid 2x4 stud position
    description: "1x1 on 2x4 at (1,1) - VALID"
  },

  // ============================================
  // CATEGORY 4: Large part on small part
  // Can't place 2x2 centered on 1x1 (no center stud on 2x2)
  // ============================================
  {
    name: "2x2_on_1x1_center_invalid",
    category: "large_on_small",
    parentPart: "3005", parentRotation: 0,
    childPart: "3003", childRotation: 0,
    offsetX: 0, offsetZ: 0,
    expectedValid: false, // 2x2 studs at ±1,±1, parent stud at 0,0 - no overlap
    description: "2x2 on 1x1 centered - INVALID (2x2 has no center stud)"
  },
  {
    name: "2x2_on_1x1_offset_1_1_valid",
    category: "large_on_small",
    parentPart: "3005", parentRotation: 0,
    childPart: "3003", childRotation: 0,
    offsetX: 1, offsetZ: 1,
    expectedValid: true, // 2x2 stud at (-1+1,-1+1)=(0,0) matches 1x1
    description: "2x2 on 1x1 at (1,1) - VALID (corner stud on 1x1)"
  },
  {
    name: "1x2_on_1x1_center_invalid",
    category: "large_on_small",
    parentPart: "3005", parentRotation: 0,
    childPart: "3004", childRotation: 0,
    offsetX: 0, offsetZ: 0,
    expectedValid: false, // 1x2 studs at (-1,0),(1,0), parent at (0,0) - no match
    description: "1x2 on 1x1 centered - INVALID (1x2 has no center stud)"
  },
  {
    name: "1x2_on_1x1_offset_1_0_valid",
    category: "large_on_small",
    parentPart: "3005", parentRotation: 0,
    childPart: "3004", childRotation: 0,
    offsetX: 1, offsetZ: 0,
    expectedValid: true, // 1x2 stud at (-1+1,0)=(0,0) matches 1x1
    description: "1x2 on 1x1 at (1,0) - VALID (end stud on 1x1)"
  },
  {
    name: "1x4_on_1x1_offset_2_0_invalid",
    category: "large_on_small",
    parentPart: "3005", parentRotation: 0,
    childPart: "3010", childRotation: 0,
    offsetX: 2, offsetZ: 0,
    expectedValid: false, // 1x4 studs at (-3+2,-1+2,1+2,3+2)=(-1,1,3,5), parent at 0 - no match
    description: "1x4 on 1x1 at (2,0) - INVALID (no stud at x=0)"
  },
  {
    name: "1x4_on_1x1_offset_3_0_valid",
    category: "large_on_small",
    parentPart: "3005", parentRotation: 0,
    childPart: "3010", childRotation: 0,
    offsetX: 3, offsetZ: 0,
    expectedValid: true, // 1x4 stud at (-3+3,0)=(0,0) matches 1x1
    description: "1x4 on 1x1 at (3,0) - VALID (end stud on 1x1)"
  },

  // ============================================
  // CATEGORY 5: Offset too large (no overlap)
  // Parts completely disconnected
  // ============================================
  {
    name: "2x2_offset_4_4_invalid",
    category: "offset_too_large",
    parentPart: "3003", parentRotation: 0,
    childPart: "3003", childRotation: 0,
    offsetX: 4, offsetZ: 4,
    expectedValid: false, // way too far, no overlap possible
    description: "2x2 on 2x2 at (4,4) - INVALID (completely disconnected)"
  },
  {
    name: "2x2_offset_2_2_valid",
    category: "offset_too_large",
    parentPart: "3003", parentRotation: 0,
    childPart: "3003", childRotation: 0,
    offsetX: 2, offsetZ: 2,
    expectedValid: true, // 1-stud diagonal connection at (1,1)
    description: "2x2 on 2x2 at (2,2) - VALID (1-stud corner connection)"
  },
  {
    name: "1x1_offset_3_0_invalid",
    category: "offset_too_large",
    parentPart: "3003", parentRotation: 0,
    childPart: "3005", childRotation: 0,
    offsetX: 3, offsetZ: 0,
    expectedValid: false, // 1x1 at (3,0), 2x2 studs at ±1,±1 - no match
    description: "1x1 on 2x2 at (3,0) - INVALID (beyond stud range)"
  },
  {
    name: "2x4_offset_5_0_invalid",
    category: "offset_too_large",
    parentPart: "3001", parentRotation: 0,
    childPart: "3001", childRotation: 0,
    offsetX: 8, offsetZ: 0,
    expectedValid: false, // completely disconnected
    description: "2x4 on 2x4 at (8,0) - INVALID (no overlap)"
  },
  {
    name: "2x4_offset_4_0_valid",
    category: "offset_too_large",
    parentPart: "3001", parentRotation: 0,
    childPart: "3001", childRotation: 0,
    offsetX: 4, offsetZ: 0,
    expectedValid: true, // studs at (-3+4,-1+4,...)=(1,3,...) some overlap
    description: "2x4 on 2x4 at (4,0) - VALID (2-stud overlap)"
  },

  // ============================================
  // CATEGORY 6: Cross-beam rotation issues
  // Perpendicular parts need specific offsets to connect
  // ============================================
  {
    name: "cross_1x4_center_invalid",
    category: "crossbeam_rotation",
    parentPart: "3010", parentRotation: 0,
    childPart: "3010", childRotation: 90,
    offsetX: 0, offsetZ: 0,
    expectedValid: false, // perpendicular 1x4s, studs don't intersect at center
    description: "1x4 cross at center - INVALID (no stud intersection)"
  },
  {
    name: "cross_1x4_offset_valid",
    category: "crossbeam_rotation",
    parentPart: "3010", parentRotation: 0,
    childPart: "3010", childRotation: 90,
    offsetX: 1, offsetZ: 1,
    expectedValid: true, // rotated 1x4 stud lands on base stud
    description: "1x4 cross at (1,1) - VALID (stud intersection)"
  },
  {
    name: "cross_2x4_center_valid",
    category: "crossbeam_rotation",
    parentPart: "3001", parentRotation: 0,
    childPart: "3001", childRotation: 90,
    offsetX: 0, offsetZ: 0,
    expectedValid: true, // 2x4 has studs at ±1 in both dimensions, so rot90 still overlaps
    description: "2x4 cross at center - VALID (inner studs overlap)"
  },

  // ============================================
  // CATEGORY 7: Spanning parts wrong distance
  // Parts meant to span between supports must reach
  // ============================================
  {
    name: "1x2_span_too_far_invalid",
    category: "span_distance",
    parentPart: "3005", parentRotation: 0, // single 1x1 post
    childPart: "3023", childRotation: 0,   // 1x2 plate
    offsetX: 2, offsetZ: 0,
    expectedValid: false, // 1x2 studs at (1,0),(3,0), parent at (0,0) - no match
    description: "1x2 plate on 1x1 at (2,0) - INVALID (doesn't reach)"
  },
  {
    name: "1x2_span_correct_valid",
    category: "span_distance",
    parentPart: "3005", parentRotation: 0,
    childPart: "3023", childRotation: 0,
    offsetX: 1, offsetZ: 0,
    expectedValid: true, // 1x2 stud at (0,0) matches 1x1
    description: "1x2 plate on 1x1 at (1,0) - VALID (end stud connects)"
  },
  {
    name: "1x4_span_too_far_invalid", 
    category: "span_distance",
    parentPart: "3005", parentRotation: 0,
    childPart: "3010", childRotation: 0,
    offsetX: 5, offsetZ: 0,
    expectedValid: false, // 1x4 studs at (2,4,6,8) - none at 0
    description: "1x4 on 1x1 at (5,0) - INVALID (no stud reaches)"
  },
  {
    name: "1x4_span_correct_valid",
    category: "span_distance",
    parentPart: "3005", parentRotation: 0,
    childPart: "3010", childRotation: 0,
    offsetX: 3, offsetZ: 0,
    expectedValid: true, // 1x4 stud at (-3+3,0)=(0,0) matches
    description: "1x4 on 1x1 at (3,0) - VALID (end stud connects)"
  },
];

// Run tests
console.log("Connection Validation Tests\n" + "=".repeat(50) + "\n");

let passed = 0;
let failed = 0;
const failures: string[] = [];

const categories = [...new Set(tests.map(t => t.category))];

for (const category of categories) {
  console.log(`\n## ${category.toUpperCase().replace(/_/g, " ")}\n`);
  
  const categoryTests = tests.filter(t => t.category === category);
  
  for (const test of categoryTests) {
    const result = validateConnection(
      test.parentPart,
      test.parentRotation,
      test.childPart,
      test.childRotation,
      test.offsetX,
      test.offsetZ
    );
    
    const actualValid = result.valid;
    const testPassed = actualValid === test.expectedValid;
    
    if (testPassed) {
      passed++;
      const mark = test.expectedValid ? "✓ VALID" : "✓ INVALID (caught)";
      console.log(`  ${mark}: ${test.name}`);
    } else {
      failed++;
      const mark = test.expectedValid ? "✗ Expected VALID, got INVALID" : "✗ Expected INVALID, got VALID";
      console.log(`  ${mark}: ${test.name}`);
      failures.push(`${test.name}: ${test.description}\n    Expected: ${test.expectedValid ? "valid" : "invalid"}, Got: ${actualValid ? "valid" : "invalid"}`);
    }
  }
}

console.log("\n" + "=".repeat(50));
console.log(`\nResults: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log("\nAll validation tests passed!");
  process.exit(0);
}
