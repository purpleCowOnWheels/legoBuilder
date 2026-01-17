"""
Connection Validator Package

Validates LEGO part connections in LDraw MPD files.
"""

from .mpd_parser import load_and_parse_mpd, LDrawPart
from .connection_detector import validate_connections, Connection, ConnectionIssue
from .part_metadata import get_part_metadata, get_supported_parts, is_basic_part

__all__ = [
    'load_and_parse_mpd',
    'validate_connections',
    'get_part_metadata',
    'get_supported_parts',
    'is_basic_part',
    'LDrawPart',
    'Connection',
    'ConnectionIssue'
]
