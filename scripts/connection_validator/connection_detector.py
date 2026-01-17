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
    
    Returns: List of [x, y, z] positions in world space
    """
    if not metadata or 'studs' not in metadata:
        return []
    
    stud_positions_world = []
    
    for stud_grid_x, stud_grid_y in metadata['studs']:
        # Convert grid position to LDU (centered on part origin)
        # Parts are centered, so (0, 0) stud is at negative offset
        width = metadata['width']
        length = metadata['length']
        height = metadata['height']
        
        # Calculate local stud position (LDU)
        # X: width direction, Y: height direction (up), Z: length direction
        local_x = (stud_grid_x - (width - 1) / 2.0) * STUD_SPACING
        local_z = (stud_grid_y - (length - 1) / 2.0) * STUD_SPACING
        local_y = -height * PLATE_HEIGHT  # Top surface (negative Y is up in LDraw)
        
        local_pos = np.array([local_x, local_y, local_z])
        
        # Transform to world space
        world_pos = part.world_rotation @ local_pos + part.world_position
        
        stud_positions_world.append(world_pos)
    
    return stud_positions_world


def get_tube_positions_world(part: LDrawPart, metadata: Dict) -> List[np.ndarray]:
    """
    Calculate world-space positions of tube centers on the bottom of a part.
    
    For basic parts, tubes align with studs (same grid positions).
    Returns: List of [x, y, z] positions in world space
    """
    if not metadata or not metadata.get('has_tubes', False):
        return []
    
    # For basic parts, tubes are at the same grid positions as studs, just on the bottom
    tube_positions_world = []
    
    for stud_grid_x, stud_grid_y in metadata['studs']:
        width = metadata['width']
        length = metadata['length']
        
        # Calculate local tube position (bottom surface)
        local_x = (stud_grid_x - (width - 1) / 2.0) * STUD_SPACING
        local_z = (stud_grid_y - (length - 1) / 2.0) * STUD_SPACING
        local_y = 0  # Bottom surface
        
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
            # (part_a is above part_b)
            connected_positions = []
            
            for stud_pos in studs_a:
                for tube_pos in tubes_b:
                    # Check horizontal alignment (X, Z)
                    dx = abs(stud_pos[0] - tube_pos[0])
                    dz = abs(stud_pos[2] - tube_pos[2])
                    
                    # Check vertical alignment (Y)
                    # Stud should be slightly above tube (one plate height)
                    dy = stud_pos[1] - tube_pos[1]
                    expected_dy = 0  # They should be at same height when connected
                    
                    if dx < tolerance and dz < tolerance and abs(dy - expected_dy) < tolerance:
                        connected_positions.append((stud_pos[0], stud_pos[2]))
            
            if connected_positions:
                connection = Connection(part_a, part_b, connected_positions)
                connections.append(connection)
    
    return connections, issues


def validate_connections(parts: List[LDrawPart]) -> Dict:
    """
    Main validation function.
    
    Returns:
        {
            "is_valid": bool,
            "connections": List[Dict],
            "issues": List[Dict],
            "stats": Dict
        }
    """
    # Find connections
    connections, initial_issues = find_connections(parts)
    issues = list(initial_issues)
    
    # Check for floating parts (parts with no connections below, except base layer)
    parts_with_metadata = []
    for part in parts:
        metadata = get_part_metadata(part.part_id)
        if metadata:
            parts_with_metadata.append((part, metadata))
    
    # Find base layer (lowest Y coordinate)
    if parts_with_metadata:
        min_y = min(part.world_position[1] for part, _ in parts_with_metadata)
        base_threshold = min_y + PLATE_HEIGHT  # Parts within 1 plate of bottom are "base"
        
        for part, metadata in parts_with_metadata:
            is_base = part.world_position[1] < base_threshold
            
            if not is_base:
                # Check if this part has any connections below it
                has_connection_below = any(
                    conn.upper_part == part for conn in connections
                )
                
                if not has_connection_below:
                    issues.append(ConnectionIssue(
                        "floating_part",
                        "error",
                        f"Part {part.part_id} is floating (no connections below)",
                        [part],
                        {"position": part.world_position.tolist()}
                    ))
    
    # Check for invalid rotations
    for part, metadata in parts_with_metadata:
        if not check_rotation_valid(part.world_rotation):
            issues.append(ConnectionIssue(
                "invalid_rotation",
                "warning",
                f"Part {part.part_id} has invalid rotation (not 0°/90°/180°/270°)",
                [part],
                {"rotation_matrix": part.world_rotation.tolist()}
            ))
    
    # Check for off-grid positions
    for part, metadata in parts_with_metadata:
        x, y, z = part.world_position
        
        # Check if on grid (multiples of STUD_SPACING for X/Z, PLATE_HEIGHT for Y)
        x_remainder = abs(x) % STUD_SPACING
        z_remainder = abs(z) % STUD_SPACING
        y_remainder = abs(y) % PLATE_HEIGHT
        
        tolerance = 0.5  # LDU
        
        if x_remainder > tolerance and x_remainder < (STUD_SPACING - tolerance):
            issues.append(ConnectionIssue(
                "off_grid",
                "warning",
                f"Part {part.part_id} is off-grid in X direction",
                [part],
                {"position": part.world_position.tolist(), "x_offset": float(x_remainder)}
            ))
        
        if z_remainder > tolerance and z_remainder < (STUD_SPACING - tolerance):
            issues.append(ConnectionIssue(
                "off_grid",
                "warning",
                f"Part {part.part_id} is off-grid in Z direction",
                [part],
                {"position": part.world_position.tolist(), "z_offset": float(z_remainder)}
            ))
        
        if y_remainder > tolerance and y_remainder < (PLATE_HEIGHT - tolerance):
            issues.append(ConnectionIssue(
                "off_grid",
                "warning",
                f"Part {part.part_id} is off-grid in Y direction (height)",
                [part],
                {"position": part.world_position.tolist(), "y_offset": float(y_remainder)}
            ))
    
    # Compile results
    error_count = sum(1 for issue in issues if issue.severity == "error")
    warning_count = sum(1 for issue in issues if issue.severity == "warning")
    
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
            "connections": len(connections),
            "errors": error_count,
            "warnings": warning_count
        }
    }
