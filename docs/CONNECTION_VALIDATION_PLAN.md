# Connection Validation Implementation Plan

## Scope: Basic Parts Only

**Basic parts:** 1x1, 1x2, 1x3, 1x4, 2x2, 2x3, 2x4, 2x6, 2x8, plates (1-height), bricks (3-height)

These parts have simple geometry:
- Studs on top (fixed grid positions)
- Anti-studs/tubes on bottom (hollow cylinders)
- Standard dimensions (LDU units)
- No rotation (or only 90° increments)

---

## Implementation Steps

### Phase 1: Part Metadata (2-3 hours)

Create a simple database of basic part connection points:

```python
BASIC_PARTS = {
    "3001": {  # 2x4 brick
        "name": "Brick 2x4",
        "width": 2,
        "length": 4,
        "height": 3,  # plates
        "studs": [
            (0, 0), (0, 1), (0, 2), (0, 3),
            (1, 0), (1, 1), (1, 2), (1, 3)
        ],
        "tubes": True  # Has anti-studs on bottom
    },
    "3003": {  # 2x2 brick
        "name": "Brick 2x2",
        "width": 2,
        "length": 2,
        "height": 3,
        "studs": [(0, 0), (0, 1), (1, 0), (1, 1)],
        "tubes": True
    },
    # ... add ~20 basic parts
}
```

**Work:**
- Define 20-30 most common basic parts
- Document stud positions (easy - regular grid)
- LDU constants (1 stud = 20 LDU spacing)

---

### Phase 2: MPD Parser (3-4 hours)

Parse LDraw MPD to extract:
- Part instances (part number, position, rotation matrix)
- Transform chains (submodel → parent)
- World-space coordinates for each part

```python
def parse_mpd(mpd_content):
    """
    Returns: [
        {
            "part_id": "3001",
            "position": [x, y, z],
            "rotation": [[...], [...], [...]],
            "world_position": [x, y, z],  # computed
            "world_rotation": [[...], [...], [...]]  # computed
        },
        ...
    ]
    """
```

**Work:**
- Parse type 1 lines (part placement)
- Handle transform matrices (position + rotation)
- Calculate world-space positions through submodel hierarchy
- Can reuse existing LDraw parsers or write minimal one

---

### Phase 3: Connection Detection (4-5 hours)

For each part, calculate:
1. World-space stud positions (top surface)
2. World-space anti-stud positions (bottom surface)
3. Check if studs from one part align with tubes from part above

```python
def check_connections(parts_list, part_metadata):
    connections = []
    issues = []
    
    for part_a in parts_list:
        if part_a not in part_metadata:
            continue
            
        # Get stud positions in world space
        studs_world = transform_studs_to_world(
            part_a["part_id"],
            part_a["world_position"],
            part_a["world_rotation"]
        )
        
        # Find parts that could connect below (within 1 plate height)
        for part_b in parts_list:
            if part_b not in part_metadata:
                continue
                
            if is_below(part_b, part_a):
                # Check if studs align with tubes
                alignment = check_stud_tube_alignment(
                    studs_world,
                    part_b
                )
                
                if alignment["connected"]:
                    connections.append(alignment)
                elif alignment["near_miss"]:
                    issues.append({
                        "type": "misaligned",
                        "parts": [part_a, part_b],
                        "offset": alignment["offset"]
                    })
    
    return connections, issues
```

**Checks:**
- Stud-to-tube vertical alignment (Z-axis)
- Horizontal position match (X, Y within tolerance)
- Proper spacing (20 LDU = 1 stud)
- No invalid rotations (must be 0°, 90°, 180°, 270°)

---

### Phase 4: Validation Rules (2-3 hours)

Implement validation logic:

1. **Floating parts** - Parts with no connections below (except base layer)
2. **Misaligned connections** - Studs don't line up with tubes (within tolerance)
3. **Invalid rotations** - Parts rotated at weird angles (not 90° increments)
4. **Spacing issues** - Parts too close/far (not on standard grid)

```python
def validate_structure(connections, issues, parts_list):
    errors = []
    
    # Check for floating parts
    base_layer = get_base_layer(parts_list)
    for part in parts_list:
        if part not in base_layer:
            if not has_connection_below(part, connections):
                errors.append({
                    "type": "floating_part",
                    "part": part,
                    "severity": "error"
                })
    
    # Check alignment issues
    for issue in issues:
        if issue["offset"] > TOLERANCE:
            errors.append({
                "type": "misaligned",
                "severity": "warning",
                **issue
            })
    
    return errors
```

**Tolerances:**
- Position: ±0.5 LDU (very tight)
- Rotation: Must be exactly 0°, 90°, 180°, or 270°

---

### Phase 5: Integration (2-3 hours)

Create CLI tool and integrate with existing validation:

```typescript
// src/lib/connectionValidator.ts
export async function validateConnections(mpdPath: string): Promise<{
  isValid: boolean;
  connections: Connection[];
  issues: ConnectionIssue[];
}> {
  // Call Python script
  const result = spawnSync("python3", [
    path.join(__dirname, "../../scripts/validate-connections.py"),
    mpdPath
  ], { encoding: "utf8" });
  
  return JSON.parse(result.stdout);
}
```

**Work:**
- Create Python CLI script
- Add TypeScript wrapper
- Integrate into existing validation flow
- Add tests

---

## Total Effort Estimate

| Phase | Hours | Description |
|-------|-------|-------------|
| Part Metadata | 2-3 | Define 20-30 basic parts |
| MPD Parser | 3-4 | Parse and transform coordinates |
| Connection Detection | 4-5 | Core validation logic |
| Validation Rules | 2-3 | Floating parts, misalignment |
| Integration | 2-3 | CLI tool + TypeScript wrapper |
| **Total** | **13-18 hours** | ~2-3 days of focused work |

---

## What You Get

✅ **Detects:**
- Floating parts (not connected)
- Misaligned connections (studs don't line up)
- Invalid rotations (not on grid)
- Spacing errors (parts offset from standard positions)

✅ **Fast:** ~10-50ms per model (basic parts only)

✅ **Accurate:** For standard brick/plate constructions

❌ **Doesn't handle:**
- Technic parts (pins, axles, gears)
- Hinges, clips, special connections
- Flexible elements
- Complex rotations
- Non-standard techniques

---

## Alternative: Quick Win Approach (4-6 hours)

**Simpler version** - just check for obvious issues:

1. **Grid alignment check** (2 hours)
   - All parts must be on 20 LDU grid (X, Y)
   - All parts must be on plate-height multiples (Z)
   - Report anything off-grid

2. **Rotation validation** (1 hour)
   - Only allow 0°, 90°, 180°, 270° rotations
   - Report invalid angles

3. **Floating part detection** (2-3 hours)
   - Simple Z-coordinate analysis
   - Parts with nothing below = floating

This catches 60-70% of connection issues with much less work.

---

## Recommendation

**Start with Quick Win approach:**
- 4-6 hours of work
- Catches most obvious issues
- No complex geometry needed
- Easy to test and iterate

**Then expand if needed:**
- Add full stud/tube checking
- Better floating part detection
- Connection strength analysis

Want me to implement the Quick Win version first?
