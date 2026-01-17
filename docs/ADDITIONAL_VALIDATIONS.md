# Additional LEGO Model Validations

## Already Implemented ✅

1. **Structure Validation** - Syntax, file format, part placement lines
2. **Image Similarity** - Visual accuracy (SSIM, MSE, PSNR)
3. **Collision Detection** - Overlapping/intersecting parts (LDInspector)
4. **Connection Validation** - Stud-to-tube alignment, floating parts, grid alignment, rotation validity

---

## Feasible Next Validations

### 1. **Inventory Compliance** ⭐⭐⭐ (High Value)

**What:** Check if the model only uses parts available in the user's inventory.

**Complexity:** EASY (2-3 hours)

**Implementation:**
```python
def validate_inventory_compliance(parts_used, inventory):
    """Check if all parts are available in inventory."""
    issues = []
    part_count = {}
    
    # Count parts used in model
    for part in parts_used:
        key = (part.part_id, part.color)
        part_count[key] = part_count.get(key, 0) + 1
    
    # Check against inventory
    for (part_id, color), count in part_count.items():
        available = inventory.get((part_id, color), 0)
        if count > available:
            issues.append({
                "type": "insufficient_parts",
                "part": part_id,
                "color": color,
                "needed": count,
                "available": available,
                "missing": count - available
            })
    
    return issues
```

**Value:**
- Ensures model is actually buildable with available parts
- Critical for real-world builds
- Easy to understand errors

---

### 2. **Color Validation** ⭐⭐ (Medium Value)

**What:** Verify all colors used are valid LDraw colors.

**Complexity:** EASY (1-2 hours)

**Implementation:**
- Load LDraw color table (LDConfig.ldr)
- Check each part's color against valid colors
- Flag unknown or deprecated colors

**Value:**
- Prevents rendering errors
- Catches AI hallucinated colors
- Quick validation

---

### 3. **Build Stability Analysis** ⭐⭐⭐ (High Value)

**What:** Check if the model is structurally stable (won't collapse).

**Complexity:** MEDIUM (8-12 hours)

**Checks:**
- **Center of gravity** - Is it within the base footprint?
- **Support distribution** - Are heavy parts properly supported?
- **Cantilevers** - Are overhangs too long without support?
- **Base size** - Is base large enough for model height?

**Implementation:**
```python
def validate_stability(parts, connections):
    """Check structural stability."""
    issues = []
    
    # Calculate center of mass
    total_mass = 0
    com_x, com_y, com_z = 0, 0, 0
    
    for part in parts:
        mass = get_part_mass(part.part_id)  # Estimate from size
        pos = part.world_position
        com_x += pos[0] * mass
        com_y += pos[1] * mass
        com_z += pos[2] * mass
        total_mass += mass
    
    com = np.array([com_x, com_y, com_z]) / total_mass
    
    # Find base footprint
    base_parts = get_base_layer(parts)
    base_bounds = get_bounding_box(base_parts)
    
    # Check if COM is within base
    if not is_point_in_bounds_2d(com, base_bounds):
        issues.append({
            "type": "unstable_center_of_gravity",
            "severity": "error",
            "com": com.tolist(),
            "base_bounds": base_bounds
        })
    
    # Check cantilevers
    for part in parts:
        overhang = calculate_overhang_distance(part, connections)
        if overhang > MAX_CANTILEVER_LENGTH:
            issues.append({
                "type": "excessive_cantilever",
                "severity": "warning",
                "part": part.part_id,
                "overhang": overhang
            })
    
    return issues
```

**Value:**
- Prevents models that would fall apart
- Important for tall/complex builds
- Helps identify weak points

---

### 4. **Step Buildability** ⭐⭐⭐ (High Value)

**What:** Validate that each build step is logical and physically possible.

**Complexity:** MEDIUM (6-8 hours)

**Checks:**
- **Part accessibility** - Can you reach the connection point?
- **Step complexity** - Not too many parts per step
- **Occlusion** - Are parts hidden behind others?
- **Step order** - Can each step actually be built?

**Implementation:**
```python
def validate_step_quality(steps):
    """Check if build steps are logical and buildable."""
    issues = []
    
    for i, step in enumerate(steps):
        # Check part count per step
        if len(step.parts) > MAX_PARTS_PER_STEP:
            issues.append({
                "type": "step_too_complex",
                "step": i + 1,
                "parts": len(step.parts),
                "max": MAX_PARTS_PER_STEP
            })
        
        # Check if parts are accessible
        for part in step.parts:
            if is_part_occluded(part, step.existing_parts):
                issues.append({
                    "type": "part_not_accessible",
                    "step": i + 1,
                    "part": part.part_id
                })
        
        # Check for trapped connections (can't add part)
        if requires_disassembly(step):
            issues.append({
                "type": "requires_disassembly",
                "step": i + 1
            })
    
    return issues
```

**Value:**
- Ensures instructions are actually followable
- Critical for instruction quality
- Improves user experience

---

### 5. **Part Count Accuracy** ⭐⭐ (Medium Value)

**What:** Verify bill of materials matches actual parts used.

**Complexity:** EASY (2 hours)

**Implementation:**
```python
def validate_part_count(mpd_content, bill_of_materials):
    """Compare BOM against actual parts in MPD."""
    actual_parts = count_parts_in_mpd(mpd_content)
    
    issues = []
    for part_id, expected in bill_of_materials.items():
        actual = actual_parts.get(part_id, 0)
        if actual != expected:
            issues.append({
                "type": "part_count_mismatch",
                "part": part_id,
                "expected": expected,
                "actual": actual,
                "diff": actual - expected
            })
    
    return issues
```

**Value:**
- Catches counting errors
- Ensures inventory accuracy
- Quick validation

---

### 6. **Symmetry Validation** ⭐ (Low Value)

**What:** Check if symmetric designs are actually symmetric.

**Complexity:** MEDIUM (4-6 hours)

**Checks:**
- Mirror symmetry (left/right)
- Rotational symmetry
- Pattern consistency

**Value:**
- Aesthetic quality
- Less critical for function
- Nice-to-have

---

### 7. **Legal LEGO Techniques** ⭐⭐⭐ (High Value, Hard)

**What:** Check for techniques that stress parts or violate LEGO design principles.

**Complexity:** HARD (15-20 hours)

**Checks:**
- **No forced connections** - Parts shouldn't require force
- **Living hinges** - Used within flex limits
- **Clip strain** - Clips not over-stressed
- **Stud pressure** - Not too many studs in confined space

**Implementation requires:**
- Part flexibility database
- Stress calculation
- Force analysis

**Value:**
- Prevents part damage
- Ensures longevity
- Professional quality

---

### 8. **Build Complexity Score** ⭐⭐ (Medium Value)

**What:** Calculate difficulty/complexity metrics.

**Complexity:** EASY (3-4 hours)

**Metrics:**
- SNOT (Studs Not On Top) count
- Hidden connections
- Overhangs
- Part variety
- Step count
- Techniques used

**Implementation:**
```python
def calculate_complexity(parts, connections, steps):
    """Calculate build complexity score."""
    
    complexity = {
        "snot_count": count_snot_connections(connections),
        "hidden_connections": count_hidden_connections(parts),
        "overhangs": count_overhangs(parts),
        "unique_parts": len(set(p.part_id for p in parts)),
        "total_parts": len(parts),
        "steps": len(steps),
        "difficulty": "easy"  # calculated from above
    }
    
    # Calculate difficulty
    score = (
        complexity["snot_count"] * 3 +
        complexity["hidden_connections"] * 5 +
        complexity["overhangs"] * 2 +
        complexity["steps"]
    )
    
    if score < 20:
        complexity["difficulty"] = "easy"
    elif score < 50:
        complexity["difficulty"] = "medium"
    else:
        complexity["difficulty"] = "hard"
    
    return complexity
```

**Value:**
- Helps users choose appropriate builds
- Matches difficulty settings
- Educational value

---

### 9. **Aesthetic Quality** ⭐ (Low Priority)

**What:** Check for aesthetic issues.

**Complexity:** MEDIUM (6-8 hours)

**Checks:**
- Gap coverage (no visible holes)
- Color distribution
- Smooth surfaces
- Exposed studs vs tiles

**Value:**
- Subjective
- Nice-to-have
- Lower priority

---

### 10. **Instruction Clarity** ⭐⭐ (Medium Value)

**What:** Validate instruction quality.

**Complexity:** MEDIUM (5-7 hours)

**Checks:**
- Step-to-step changes are clear
- Multiple views when needed
- Callouts for new parts
- No ambiguity in placement

**Value:**
- Better user experience
- Professional instructions
- Reduces errors

---

## Recommended Priority Order

### Phase 1: Quick Wins (Already have most validation)
1. ✅ Structure validation
2. ✅ Collision detection
3. ✅ Connection validation
4. ✅ Image similarity

### Phase 2: High-Value Additions (6-10 hours)
5. **Inventory compliance** ⭐⭐⭐
6. **Color validation** ⭐⭐
7. **Part count accuracy** ⭐⭐

### Phase 3: Quality Improvements (10-15 hours)
8. **Build stability** ⭐⭐⭐
9. **Step buildability** ⭐⭐⭐
10. **Build complexity score** ⭐⭐

### Phase 4: Advanced (20+ hours)
11. **Legal LEGO techniques** ⭐⭐⭐
12. **Symmetry validation** ⭐
13. **Instruction clarity** ⭐⭐
14. **Aesthetic quality** ⭐

---

## Summary Table

| Validation | Value | Complexity | Time | Status |
|------------|-------|------------|------|--------|
| Structure | ⭐⭐⭐ | Easy | 2h | ✅ Done |
| Collision | ⭐⭐⭐ | Easy | 2h | ✅ Done |
| Connections | ⭐⭐⭐ | Medium | 15h | ✅ Done |
| Image Similarity | ⭐⭐⭐ | Easy | 3h | ✅ Done |
| **Inventory** | ⭐⭐⭐ | Easy | 2-3h | 📋 Next |
| **Color** | ⭐⭐ | Easy | 1-2h | 📋 Next |
| **Part Count** | ⭐⭐ | Easy | 2h | 📋 Next |
| **Stability** | ⭐⭐⭐ | Medium | 8-12h | 🔮 Future |
| **Step Quality** | ⭐⭐⭐ | Medium | 6-8h | 🔮 Future |
| **Complexity** | ⭐⭐ | Easy | 3-4h | 🔮 Future |
| Legal Techniques | ⭐⭐⭐ | Hard | 15-20h | 🔮 Future |
| Symmetry | ⭐ | Medium | 4-6h | 🔮 Future |
| Instruction | ⭐⭐ | Medium | 5-7h | 🔮 Future |
| Aesthetic | ⭐ | Medium | 6-8h | 🔮 Future |

**Total implemented:** 4 validations, ~22 hours  
**Quick wins available:** 3 validations, ~5 hours  
**High-value future:** 4 validations, ~30 hours

---

Which validation would you like to implement next?
