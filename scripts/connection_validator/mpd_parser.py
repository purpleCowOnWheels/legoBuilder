"""
LDraw MPD Parser

Parses LDraw MPD files and extracts part instances with their positions and rotations.
"""

import re
from typing import List, Dict, Tuple
import numpy as np


class LDrawPart:
    """Represents a single part instance in the model."""
    
    def __init__(self, part_id: str, color: int, position: np.ndarray, rotation: np.ndarray):
        self.part_id = part_id
        self.color = color
        self.position = position  # [x, y, z]
        self.rotation = rotation  # 3x3 rotation matrix
        self.world_position = position.copy()
        self.world_rotation = rotation.copy()
    
    def __repr__(self):
        return f"LDrawPart({self.part_id}, pos={self.position}, color={self.color})"


class LDrawSubmodel:
    """Represents a submodel (0 FILE ... 0 NOFILE block)."""
    
    def __init__(self, name: str):
        self.name = name
        self.parts = []  # List of LDrawPart or LDrawSubmodel
        self.submodel_refs = []  # References to other submodels
    
    def add_part(self, part):
        self.parts.append(part)
    
    def add_submodel_ref(self, ref):
        self.submodel_refs.append(ref)


def parse_type1_line(line: str) -> Dict:
    """
    Parse LDraw type 1 line (part/submodel placement).
    
    Format: 1 <color> <x> <y> <z> <a> <b> <c> <d> <e> <f> <g> <h> <i> <part.dat>
    
    Where [a b c d e f g h i] form a 3x3 transformation matrix:
    [ a  b  c ]
    [ d  e  f ]
    [ g  h  i ]
    """
    parts = line.strip().split()
    
    if len(parts) < 15 or parts[0] != '1':
        return None
    
    try:
        color = int(parts[1])
        x, y, z = float(parts[2]), float(parts[3]), float(parts[4])
        
        # Rotation/scale matrix (3x3)
        a, b, c = float(parts[5]), float(parts[6]), float(parts[7])
        d, e, f = float(parts[8]), float(parts[9]), float(parts[10])
        g, h, i = float(parts[11]), float(parts[12]), float(parts[13])
        
        # Part filename (can have spaces, so join remaining parts)
        part_file = ' '.join(parts[14:])
        
        # Extract part ID (remove .dat extension, handle paths)
        part_id = part_file.split('/')[-1].split('\\')[-1].replace('.dat', '').replace('.ldr', '')
        
        position = np.array([x, y, z])
        rotation = np.array([
            [a, b, c],
            [d, e, f],
            [g, h, i]
        ])
        
        return {
            'color': color,
            'position': position,
            'rotation': rotation,
            'part_id': part_id,
            'part_file': part_file
        }
    except (ValueError, IndexError) as e:
        print(f"Warning: Could not parse type 1 line: {line.strip()}")
        return None


def parse_mpd(mpd_content: str) -> Tuple[Dict[str, LDrawSubmodel], str]:
    """
    Parse an MPD file into submodels.
    
    Returns:
        (submodels_dict, main_model_name)
    """
    lines = mpd_content.split('\n')
    submodels = {}
    current_submodel = None
    main_model_name = None
    
    for line in lines:
        line_stripped = line.strip()
        
        # Skip empty lines and comments (except meta commands)
        if not line_stripped or (line_stripped.startswith('0') and not line_stripped.startswith('0 FILE') and not line_stripped.startswith('0 NOFILE')):
            continue
        
        # Start of submodel
        if line_stripped.startswith('0 FILE'):
            name = line_stripped[7:].strip()
            current_submodel = LDrawSubmodel(name)
            submodels[name] = current_submodel
            
            # First submodel is usually the main model
            if main_model_name is None:
                main_model_name = name
        
        # End of submodel
        elif line_stripped.startswith('0 NOFILE'):
            current_submodel = None
        
        # Part/submodel reference (type 1 line)
        elif line_stripped.startswith('1') and current_submodel:
            parsed = parse_type1_line(line_stripped)
            if parsed:
                # Check if it's a submodel reference or a part
                part_ref = LDrawPart(
                    parsed['part_id'],
                    parsed['color'],
                    parsed['position'],
                    parsed['rotation']
                )
                current_submodel.add_part(part_ref)
    
    return submodels, main_model_name


def apply_transform(position: np.ndarray, rotation: np.ndarray, 
                    parent_position: np.ndarray, parent_rotation: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """
    Apply parent transform to child position and rotation.
    
    Returns: (new_position, new_rotation)
    """
    # Transform position: parent_rotation * position + parent_position
    new_position = parent_rotation @ position + parent_position
    
    # Transform rotation: parent_rotation * rotation
    new_rotation = parent_rotation @ rotation
    
    return new_position, new_rotation


def flatten_submodels(submodels: Dict[str, LDrawSubmodel], main_model_name: str) -> List[LDrawPart]:
    """
    Flatten submodel hierarchy into a flat list of parts with world-space transforms.
    
    Returns: List of LDrawPart with world_position and world_rotation set
    """
    all_parts = []
    
    def process_submodel(submodel_name: str, parent_position: np.ndarray, parent_rotation: np.ndarray):
        # Check if it's a submodel in our dictionary
        if submodel_name not in submodels and submodel_name.upper() not in submodels:
            # Try with .ldr extension
            if f"{submodel_name}.ldr" in submodels:
                submodel_name = f"{submodel_name}.ldr"
            elif f"{submodel_name.upper()}.ldr" in submodels:
                submodel_name = f"{submodel_name.upper()}.ldr"
            else:
                # It's a primitive part, not a submodel
                return
        
        submodel = submodels.get(submodel_name) or submodels.get(submodel_name.upper())
        if not submodel:
            return
        
        for part in submodel.parts:
            # Apply parent transform
            world_pos, world_rot = apply_transform(
                part.position, part.rotation,
                parent_position, parent_rotation
            )
            
            # Check if this part is itself a submodel reference
            part_key = part.part_id
            if part_key not in submodels:
                # Try variants
                if part_key.upper() in submodels:
                    part_key = part_key.upper()
                elif f"{part_key}.ldr" in submodels:
                    part_key = f"{part_key}.ldr"
                elif f"{part_key.upper()}.ldr" in submodels:
                    part_key = f"{part_key.upper()}.ldr"
            
            if part_key in submodels:
                # Recursively process submodel
                process_submodel(part_key, world_pos, world_rot)
            else:
                # It's a primitive part
                part_copy = LDrawPart(part.part_id, part.color, part.position.copy(), part.rotation.copy())
                part_copy.world_position = world_pos
                part_copy.world_rotation = world_rot
                all_parts.append(part_copy)
    
    # Start with identity transform at main model
    identity_pos = np.array([0.0, 0.0, 0.0])
    identity_rot = np.eye(3)
    
    process_submodel(main_model_name, identity_pos, identity_rot)
    
    return all_parts


def load_and_parse_mpd(file_path: str) -> List[LDrawPart]:
    """
    Load an MPD file and return a flat list of parts with world-space transforms.
    """
    with open(file_path, 'r', encoding='utf-8') as f:
        mpd_content = f.read()
    
    submodels, main_model_name = parse_mpd(mpd_content)
    
    if not main_model_name:
        raise ValueError("No main model found in MPD file")
    
    parts = flatten_submodels(submodels, main_model_name)
    
    return parts


if __name__ == "__main__":
    # Test the parser
    import sys
    if len(sys.argv) > 1:
        parts = load_and_parse_mpd(sys.argv[1])
        print(f"Loaded {len(parts)} parts")
        for i, part in enumerate(parts[:10]):
            print(f"  {i+1}. {part.part_id} at {part.world_position}")
