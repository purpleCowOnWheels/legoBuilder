"""
LEGO Connection Validator - Part Metadata Database

Defines connection points (studs, tubes) for basic LEGO parts.
LDU (LDraw Units): 1 stud = 20 LDU spacing, 1 plate height = 8 LDU
"""

# Standard dimensions in LDU
STUD_SPACING = 20  # Distance between stud centers
PLATE_HEIGHT = 8   # Height of one plate
BRICK_HEIGHT = 24  # Height of one brick (3 plates)
STUD_HEIGHT = 4    # Height of stud above surface

# Connection point metadata for basic parts
BASIC_PARTS_METADATA = {
    # 2x4 Brick
    "3001": {
        "name": "Brick 2x4",
        "width": 2,  # studs
        "length": 4,  # studs
        "height": 3,  # plates
        "studs": [
            (0, 0), (0, 1), (0, 2), (0, 3),
            (1, 0), (1, 1), (1, 2), (1, 3)
        ],
        "has_tubes": True
    },
    
    # 2x2 Brick
    "3003": {
        "name": "Brick 2x2",
        "width": 2,
        "length": 2,
        "height": 3,
        "studs": [
            (0, 0), (0, 1),
            (1, 0), (1, 1)
        ],
        "has_tubes": True
    },
    
    # 1x2 Brick
    "3004": {
        "name": "Brick 1x2",
        "width": 1,
        "length": 2,
        "height": 3,
        "studs": [(0, 0), (0, 1)],
        "has_tubes": True
    },
    
    # 1x4 Brick
    "3010": {
        "name": "Brick 1x4",
        "width": 1,
        "length": 4,
        "height": 3,
        "studs": [(0, 0), (0, 1), (0, 2), (0, 3)],
        "has_tubes": True
    },
    
    # 1x1 Brick
    "3005": {
        "name": "Brick 1x1",
        "width": 1,
        "length": 1,
        "height": 3,
        "studs": [(0, 0)],
        "has_tubes": False  # Too small for tube
    },
    
    # 2x3 Brick
    "3002": {
        "name": "Brick 2x3",
        "width": 2,
        "length": 3,
        "height": 3,
        "studs": [
            (0, 0), (0, 1), (0, 2),
            (1, 0), (1, 1), (1, 2)
        ],
        "has_tubes": True
    },
    
    # 1x3 Brick
    "3622": {
        "name": "Brick 1x3",
        "width": 1,
        "length": 3,
        "height": 3,
        "studs": [(0, 0), (0, 1), (0, 2)],
        "has_tubes": True
    },
    
    # 1x6 Brick
    "3009": {
        "name": "Brick 1x6",
        "width": 1,
        "length": 6,
        "height": 3,
        "studs": [(0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (0, 5)],
        "has_tubes": True
    },
    
    # 2x6 Brick
    "2456": {
        "name": "Brick 2x6",
        "width": 2,
        "length": 6,
        "height": 3,
        "studs": [
            (0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (0, 5),
            (1, 0), (1, 1), (1, 2), (1, 3), (1, 4), (1, 5)
        ],
        "has_tubes": True
    },
    
    # 2x8 Brick
    "3007": {
        "name": "Brick 2x8",
        "width": 2,
        "length": 8,
        "height": 3,
        "studs": [
            (0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (0, 5), (0, 6), (0, 7),
            (1, 0), (1, 1), (1, 2), (1, 3), (1, 4), (1, 5), (1, 6), (1, 7)
        ],
        "has_tubes": True
    },
    
    # PLATES (height = 1 plate = 8 LDU)
    
    # 2x4 Plate
    "3020": {
        "name": "Plate 2x4",
        "width": 2,
        "length": 4,
        "height": 1,
        "studs": [
            (0, 0), (0, 1), (0, 2), (0, 3),
            (1, 0), (1, 1), (1, 2), (1, 3)
        ],
        "has_tubes": True
    },
    
    # 2x2 Plate
    "3022": {
        "name": "Plate 2x2",
        "width": 2,
        "length": 2,
        "height": 1,
        "studs": [
            (0, 0), (0, 1),
            (1, 0), (1, 1)
        ],
        "has_tubes": True
    },
    
    # 1x2 Plate
    "3023": {
        "name": "Plate 1x2",
        "width": 1,
        "length": 2,
        "height": 1,
        "studs": [(0, 0), (0, 1)],
        "has_tubes": True
    },
    
    # 1x4 Plate
    "3710": {
        "name": "Plate 1x4",
        "width": 1,
        "length": 4,
        "height": 1,
        "studs": [(0, 0), (0, 1), (0, 2), (0, 3)],
        "has_tubes": True
    },
    
    # 1x1 Plate
    "3024": {
        "name": "Plate 1x1",
        "width": 1,
        "length": 1,
        "height": 1,
        "studs": [(0, 0)],
        "has_tubes": False
    },
    
    # 2x3 Plate
    "3021": {
        "name": "Plate 2x3",
        "width": 2,
        "length": 3,
        "height": 1,
        "studs": [
            (0, 0), (0, 1), (0, 2),
            (1, 0), (1, 1), (1, 2)
        ],
        "has_tubes": True
    },
    
    # 1x3 Plate
    "3623": {
        "name": "Plate 1x3",
        "width": 1,
        "length": 3,
        "height": 1,
        "studs": [(0, 0), (0, 1), (0, 2)],
        "has_tubes": True
    },
    
    # 1x6 Plate
    "3666": {
        "name": "Plate 1x6",
        "width": 1,
        "length": 6,
        "height": 1,
        "studs": [(0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (0, 5)],
        "has_tubes": True
    },
    
    # 2x6 Plate
    "3795": {
        "name": "Plate 2x6",
        "width": 2,
        "length": 6,
        "height": 1,
        "studs": [
            (0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (0, 5),
            (1, 0), (1, 1), (1, 2), (1, 3), (1, 4), (1, 5)
        ],
        "has_tubes": True
    },
    
    # 2x8 Plate
    "3034": {
        "name": "Plate 2x8",
        "width": 2,
        "length": 8,
        "height": 1,
        "studs": [
            (0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (0, 5), (0, 6), (0, 7),
            (1, 0), (1, 1), (1, 2), (1, 3), (1, 4), (1, 5), (1, 6), (1, 7)
        ],
        "has_tubes": True
    },
    
    # THIN PLATES
    
    # 1x2 Plate (jumper/modified)
    "3794": {
        "name": "Plate 1x2 Modified with 1 Stud",
        "width": 1,
        "length": 2,
        "height": 1,
        "studs": [(0, 0)],  # Only center stud
        "has_tubes": True
    },
    
    # 2x2 Tile (no studs)
    "3068": {
        "name": "Tile 2x2",
        "width": 2,
        "length": 2,
        "height": 1,
        "studs": [],  # Smooth tile
        "has_tubes": True
    },
    
    # 1x2 Tile (no studs)
    "3069": {
        "name": "Tile 1x2",
        "width": 1,
        "length": 2,
        "height": 1,
        "studs": [],  # Smooth tile
        "has_tubes": True
    },
    
    # More common parts
    
    # 1x8 Brick
    "3008": {
        "name": "Brick 1x8",
        "width": 1,
        "length": 8,
        "height": 3,
        "studs": [(0, i) for i in range(8)],
        "has_tubes": True
    },
    
    # 1x8 Plate
    "3460": {
        "name": "Plate 1x8",
        "width": 1,
        "length": 8,
        "height": 1,
        "studs": [(0, i) for i in range(8)],
        "has_tubes": True
    },
    
    # 4x4 Plate
    "3031": {
        "name": "Plate 4x4",
        "width": 4,
        "length": 4,
        "height": 1,
        "studs": [(i, j) for i in range(4) for j in range(4)],
        "has_tubes": True
    },
    
    # 1x1 Round Brick
    "3062": {
        "name": "Brick 1x1 Round",
        "width": 1,
        "length": 1,
        "height": 3,
        "studs": [(0, 0)],
        "has_tubes": False,
        "round": True
    },
    
    # 1x1 Round Plate
    "4073": {
        "name": "Plate 1x1 Round",
        "width": 1,
        "length": 1,
        "height": 1,
        "studs": [(0, 0)],
        "has_tubes": False,
        "round": True
    },
    
    # Slope 2x2
    "3039": {
        "name": "Slope Brick 45 2x2",
        "width": 2,
        "length": 2,
        "height": 3,
        "studs": [(0, 0), (1, 0)],  # Only front studs (back is sloped)
        "has_tubes": True,
        "slope": True
    },
    
    # Slope 2x3
    "3298": {
        "name": "Slope Brick 33 2x3",
        "width": 2,
        "length": 3,
        "height": 3,
        "studs": [(0, 0), (1, 0)],  # Only front studs
        "has_tubes": True,
        "slope": True
    },
    
    # 1x2 Slope
    "3040": {
        "name": "Slope Brick 45 1x2",
        "width": 1,
        "length": 2,
        "height": 3,
        "studs": [(0, 0)],  # Only front stud
        "has_tubes": True,
        "slope": True
    },
}


def get_part_metadata(part_id: str) -> dict:
    """Get metadata for a part, or None if not in database."""
    return BASIC_PARTS_METADATA.get(part_id)


def get_supported_parts() -> list:
    """Get list of all supported part IDs."""
    return list(BASIC_PARTS_METADATA.keys())


def is_basic_part(part_id: str) -> bool:
    """Check if part is in the basic parts database."""
    return part_id in BASIC_PARTS_METADATA
