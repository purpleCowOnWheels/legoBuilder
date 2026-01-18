"""
Connection Detection - Core validation logic

Checks for valid stud-to-tube connections between LEGO parts.
"""

import numpy as np
from typing import List, Dict, Tuple, Optional
from part_metadata import get_part_metadata, STUD_SPACING, PLATE_HEIGHT, BRICK_HEIGHT
from mpd_parser import LDrawPart


class Connection:
    """Represents a valid connection between two parts."""
    
    def __init__(self, upper_part: LDrawPart, lower_part: LDrawPart, stud_positions: List[Tuple[float, float]]):
        self.upper_part = upper_part
        self.lower_part = lower_part
        self.stud_positions = stud_positions  # List of (x, y) positions where they connect
        self.strength = len(stud_positions)  # Number of studs connecting
    
    def __repr__(self):
        return f"Connection({self.upper_part.part_id} -> {self.lower_part.part_id}, {self.strength} studs)"


class ConnectionIssue:
    """Represents a connection problem."""
    
    def __init__(self, issue_type: str, severity: str, message: str, parts: List[LDrawPart], details: Dict = None):
        self.type = issue_type
        self.severity = severity  # "error" or "warning"
        self.message = message
        self.parts = parts
        self.details = details or {}
    
    def to_dict(self):
        return {
            "type": self.type,
            "severity": self.severity,
            "message": self.message,
            "part_ids": [p.part_id for p in self.parts],
            "details": self.details
        }


def get_stud_positions_world(part: LDrawPart, metadata: Dict) -> List[np.ndarray]:
    """
    Calculate world-space positions of all studs on a part.
    
    LDraw convention:
    - Part origin is at the TOP CENTER of the part
    - Y axis is positive going DOWN
    - Studs are on the TOP surface (at the origin level, Y=0 locally)
    
    Returns: List of [x, y, z] positions in world space
    """
    if not metadata or 'studs' not in metadata:
        return []
    
    stud_positions_world = []
    
    for stud_grid_x, stud_grid_y in metadata['studs']:
        # Convert grid position to LDU (centered on part origin)
        width = metadata['width']
        length = metadata['length']
        
        # Calculate local stud position (LDU)
        # X: width direction, Z: length direction
        local_x = (stud_grid_x - (width - 1) / 2.0) * STUD_SPACING
        local_z = (stud_grid_y - (length - 1) / 2.0) * STUD_SPACING
        local_y = 0  # Studs are at the TOP surface (origin level)
        
        local_pos = np.array([local_x, local_y, local_z])
        
        # Transform to world space
        world_pos = part.world_rotation @ local_pos + part.world_position
        
        stud_positions_world.append(world_pos)
    
    return stud_positions_world


def get_tube_positions_world(part: LDrawPart, metadata: Dict) -> List[np.ndarray]:
    """
    Calculate world-space positions of tube centers on the bottom of a part.
    
    LDraw convention:
    - Part origin is at the TOP CENTER of the part
    - Y axis is positive going DOWN
    - Tubes are on the BOTTOM surface (height * PLATE_HEIGHT below origin)
    
    For basic parts, tubes align with studs (same grid positions).
    Returns: List of [x, y, z] positions in world space
    """
    if not metadata or not metadata.get('has_tubes', False):
        return []
    
    # For basic parts, tubes are at the same grid positions as studs, just on the bottom
    tube_positions_world = []
    height = metadata['height']
    
    for stud_grid_x, stud_grid_y in metadata['studs']:
        width = metadata['width']
        length = metadata['length']
        
        # Calculate local tube position (bottom surface)
        local_x = (stud_grid_x - (width - 1) / 2.0) * STUD_SPACING
        local_z = (stud_grid_y - (length - 1) / 2.0) * STUD_SPACING
        local_y = height * PLATE_HEIGHT  # Bottom surface (positive Y = down)
        
        local_pos = np.array([local_x, local_y, local_z])
        
        # Transform to world space
        world_pos = part.world_rotation @ local_pos + part.world_position
        
        tube_positions_world.append(world_pos)
    
    return tube_positions_world


def check_rotation_valid(rotation_matrix: np.ndarray, tolerance: float = 0.01) -> bool:
    """
    Check if rotation is a valid 90-degree increment (0°, 90°, 180°, 270°).
    
    For basic LEGO parts, only these rotations are valid.
    """
    # Check if rotation is close to identity or 90/180/270 degree rotation around Y axis
    valid_rotations = [
        np.eye(3),  # 0°
        np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]]),  # 90° around Y
        np.array([[-1, 0, 0], [0, 1, 0], [0, 0, -1]]),  # 180° around Y
        np.array([[0, 0, -1], [0, 1, 0], [1, 0, 0]])   # 270° around Y
    ]
    
    for valid_rot in valid_rotations:
        if np.allclose(rotation_matrix, valid_rot, atol=tolerance):
            return True
    
    return False


def find_connections(parts: List[LDrawPart], tolerance: float = 1.0) -> Tuple[List[Connection], List[ConnectionIssue]]:
    """
    Detect connections between parts.
    
    Args:
        parts: List of parts with world-space transforms
        tolerance: Maximum distance (LDU) for connection alignment
    
    Returns:
        (connections, issues)
    """
    connections = []
    issues = []
    
    # Group parts by approximate height for efficiency
    parts_with_metadata = []
    for part in parts:
        metadata = get_part_metadata(part.part_id)
        if metadata:
            parts_with_metadata.append((part, metadata))
    
    # Check each pair of parts
    for i, (part_a, meta_a) in enumerate(parts_with_metadata):
        studs_a = get_stud_positions_world(part_a, meta_a)
        
        if not studs_a:
            continue
        
        for j, (part_b, meta_b) in enumerate(parts_with_metadata):
            if i == j:
                continue
            
            tubes_b = get_tube_positions_world(part_b, meta_b)
            
            if not tubes_b:
                continue
            
            # Check if part_a's studs align with part_b's tubes
            # part_a provides studs (from its top surface)
            # part_b provides tubes (from its bottom surface)
            # If they align, part_b is sitting ON TOP of part_a
            # So part_a is the LOWER part, part_b is the UPPER part
            connected_positions = []
            
            for stud_pos in studs_a:
                for tube_pos in tubes_b:
                    # Check horizontal alignment (X, Z)
                    dx = abs(stud_pos[0] - tube_pos[0])
                    dz = abs(stud_pos[2] - tube_pos[2])
                    
                    # Check vertical alignment (Y)
                    # Stud and tube should be at same Y when connected
                    dy = abs(stud_pos[1] - tube_pos[1])
                    
                    if dx < tolerance and dz < tolerance and dy < tolerance:
                        connected_positions.append((stud_pos[0], stud_pos[2]))
            
            if connected_positions:
                # part_b is upper (sitting on top), part_a is lower (providing studs)
                connection = Connection(part_b, part_a, connected_positions)
                connections.append(connection)
    
    return connections, issues


def find_nearest_potential_connection(part: LDrawPart, part_meta: Dict, 
                                       all_parts_with_meta: List[Tuple[LDrawPart, Dict]]) -> Optional[Dict]:
    """
    For a floating part, find the nearest potential connection and explain the gap.
    """
    tubes = get_tube_positions_world(part, part_meta)
    
    # If part has no tubes, it needs to sit on something via its bottom
    # Calculate where its bottom would need studs
    if not tubes:
        # Part has no tubes - can only connect if another part's studs reach its bottom
        # For now, just use the part position + height as the connection point
        height = part_meta['height']
        bottom_y = part.world_position[1] + height * PLATE_HEIGHT
        tubes = [part.world_position + np.array([0, height * PLATE_HEIGHT, 0])]
    
    best_match = None
    best_distance = float('inf')
    
    for other_part, other_meta in all_parts_with_meta:
        if other_part == part:
            continue
        
        other_studs = get_stud_positions_world(other_part, other_meta)
        if not other_studs:
            continue
        
        for tube_pos in tubes:
            for stud_pos in other_studs:
                dx = tube_pos[0] - stud_pos[0]
                dy = tube_pos[1] - stud_pos[1]
                dz = tube_pos[2] - stud_pos[2]
                
                # Only consider parts that are somewhat close
                if abs(dx) <= STUD_SPACING * 3 and abs(dz) <= STUD_SPACING * 3 and abs(dy) <= PLATE_HEIGHT * 6:
                    total_dist = abs(dx) + abs(dy) + abs(dz)
                    if total_dist < best_distance:
                        best_distance = total_dist
                        best_match = {
                            "other_part": other_part,
                            "other_meta": other_meta,
                            "dx": float(dx),
                            "dy": float(dy),
                            "dz": float(dz),
                            "tube_pos": tube_pos.tolist(),
                            "stud_pos": stud_pos.tolist()
                        }
    
    return best_match


def validate_connections(parts: List[LDrawPart]) -> Dict:
    """
    Main validation function with detailed, actionable error messages.
    
    Returns:
        {
            "is_valid": bool,
            "connections": List[Dict],
            "issues": List[Dict],
            "stats": Dict,
            "summary": str  # Concise summary for GPT
        }
    """
    # Find connections
    connections, initial_issues = find_connections(parts)
    issues = list(initial_issues)
    
    # Build list of parts with metadata
    parts_with_metadata = []
    unsupported_parts = []
    for part in parts:
        metadata = get_part_metadata(part.part_id)
        if metadata:
            parts_with_metadata.append((part, metadata))
        else:
            unsupported_parts.append(part)
    
    # Track floating parts for detailed reporting
    floating_details = []
    
    # Find base layer (smallest Y = topmost in 3D space, since Y+ is down)
    if parts_with_metadata:
        min_y = min(part.world_position[1] for part, _ in parts_with_metadata)
        base_threshold = min_y + PLATE_HEIGHT  # Parts within 1 plate of top are "base"
        
        for part, metadata in parts_with_metadata:
            is_base = part.world_position[1] <= base_threshold
            
            if not is_base:
                # Check if this part has any connections below it
                has_connection_below = any(
                    conn.upper_part == part for conn in connections
                )
                
                if not has_connection_below:
                    x, y, z = part.world_position
                    part_name = metadata.get('name', part.part_id)
                    
                    # Find nearest potential connection
                    nearest = find_nearest_potential_connection(part, metadata, parts_with_metadata)
                    
                    if nearest:
                        other = nearest["other_part"]
                        other_meta = nearest["other_meta"]
                        other_name = other_meta.get('name', other.part_id)
                        dx, dy, dz = nearest["dx"], nearest["dy"], nearest["dz"]
                        
                        # Build specific fix suggestion
                        fix_parts = []
                        if abs(dy) > 0.5:
                            new_y = y - dy
                            fix_parts.append(f"Y: {y:.0f} → {new_y:.0f} (move by {-dy:.0f})")
                        if abs(dx) > 0.5:
                            new_x = x - dx
                            fix_parts.append(f"X: {x:.0f} → {new_x:.0f} (move by {-dx:.0f})")
                        if abs(dz) > 0.5:
                            new_z = z - dz
                            fix_parts.append(f"Z: {z:.0f} → {new_z:.0f} (move by {-dz:.0f})")
                        
                        fix_str = "; ".join(fix_parts) if fix_parts else "already aligned but not connecting"
                        
                        msg = (
                            f"FLOATING: {part_name} at ({x:.0f}, {y:.0f}, {z:.0f}) "
                            f"is not connected. Nearest part: {other_name} at Y={other.world_position[1]:.0f}. "
                            f"Gap: dx={dx:.0f}, dy={dy:.0f}, dz={dz:.0f}. "
                            f"FIX: {fix_str}"
                        )
                        
                        floating_details.append({
                            "part": part_name,
                            "position": [x, y, z],
                            "nearest": other_name,
                            "gap": {"dx": dx, "dy": dy, "dz": dz},
                            "fix": fix_str
                        })
                        
                        issues.append(ConnectionIssue(
                            "floating_part",
                            "error",
                            msg,
                            [part],
                            {
                                "position": [float(x), float(y), float(z)],
                                "nearest_part": other.part_id,
                                "gap": {"dx": dx, "dy": dy, "dz": dz},
                                "fix": fix_str
                            }
                        ))
                    else:
                        msg = (
                            f"FLOATING: {part_name} at ({x:.0f}, {y:.0f}, {z:.0f}) "
                            f"has no nearby parts to connect to. Remove or reposition significantly."
                        )
                        floating_details.append({
                            "part": part_name,
                            "position": [x, y, z],
                            "nearest": None,
                            "fix": "remove or reposition"
                        })
                        
                        issues.append(ConnectionIssue(
                            "floating_part",
                            "error",
                            msg,
                            [part],
                            {"position": [float(x), float(y), float(z)]}
                        ))
    
    # Summarize off-grid issues (don't list each one)
    off_grid_parts = []
    for part, metadata in parts_with_metadata:
        x, y, z = part.world_position
        x_rem = abs(x) % STUD_SPACING
        z_rem = abs(z) % STUD_SPACING
        y_rem = abs(y) % PLATE_HEIGHT
        tol = 0.5
        
        off_axes = []
        if x_rem > tol and x_rem < (STUD_SPACING - tol):
            off_axes.append(f"X={x:.0f}")
        if z_rem > tol and z_rem < (STUD_SPACING - tol):
            off_axes.append(f"Z={z:.0f}")
        if y_rem > tol and y_rem < (PLATE_HEIGHT - tol):
            off_axes.append(f"Y={y:.0f}")
        
        if off_axes:
            off_grid_parts.append((part, metadata, off_axes))
    
    if off_grid_parts:
        examples = off_grid_parts[:3]
        example_strs = [f"{m.get('name', p.part_id)} ({', '.join(axes)})" for p, m, axes in examples]
        msg = f"OFF-GRID: {len(off_grid_parts)} parts not aligned to LEGO grid. Examples: {'; '.join(example_strs)}. Use X/Z multiples of {STUD_SPACING}, Y multiples of {PLATE_HEIGHT}."
        
        issues.append(ConnectionIssue(
            "off_grid",
            "warning",
            msg,
            [p for p, _, _ in off_grid_parts[:3]],
            {"count": len(off_grid_parts), "examples": example_strs}
        ))
    
    # Check unsupported parts
    if unsupported_parts:
        part_ids = list(set(p.part_id for p in unsupported_parts))
        msg = f"UNSUPPORTED PARTS: {len(unsupported_parts)} parts not in validation database: {', '.join(part_ids[:5])}{'...' if len(part_ids) > 5 else ''}. Connection validation may be incomplete."
        issues.append(ConnectionIssue(
            "unsupported_part",
            "warning",
            msg,
            unsupported_parts[:3],
            {"part_ids": part_ids}
        ))
    
    # Compile results
    error_count = sum(1 for issue in issues if issue.severity == "error")
    warning_count = sum(1 for issue in issues if issue.severity == "warning")
    
    # Build concise summary for GPT
    summary_parts = []
    if error_count > 0:
        summary_parts.append(f"{error_count} ERROR(s)")
    if warning_count > 0:
        summary_parts.append(f"{warning_count} warning(s)")
    
    if floating_details:
        summary_parts.append(f"\n\nFLOATING PARTS ({len(floating_details)}):")
        for fd in floating_details[:5]:  # Limit to 5 for brevity
            if fd.get("nearest"):
                summary_parts.append(f"  - {fd['part']} at Y={fd['position'][1]:.0f}: FIX → {fd['fix']}")
            else:
                summary_parts.append(f"  - {fd['part']} at Y={fd['position'][1]:.0f}: no nearby parts, reposition or remove")
        if len(floating_details) > 5:
            summary_parts.append(f"  ... and {len(floating_details) - 5} more")
    
    if len(connections) > 0:
        summary_parts.append(f"\n\nVALID CONNECTIONS: {len(connections)}")
    else:
        summary_parts.append(f"\n\n⚠️ NO VALID CONNECTIONS FOUND - parts are not properly aligned to connect!")
    
    summary = " | ".join(summary_parts[:2]) + "".join(summary_parts[2:]) if summary_parts else "No issues found"
    
    return {
        "is_valid": error_count == 0,
        "connections": [
            {
                "upper_part": conn.upper_part.part_id,
                "lower_part": conn.lower_part.part_id,
                "strength": conn.strength
            }
            for conn in connections
        ],
        "issues": [issue.to_dict() for issue in issues],
        "stats": {
            "total_parts": len(parts),
            "supported_parts": len(parts_with_metadata),
            "unsupported_parts": len(unsupported_parts),
            "connections": len(connections),
            "errors": error_count,
            "warnings": warning_count
        },
        "summary": summary
    }
