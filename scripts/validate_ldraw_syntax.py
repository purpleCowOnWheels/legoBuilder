#!/usr/bin/env python3
"""
Fast LDraw syntax validation.
Exits with code 0 if valid, non-zero if invalid.
Prints validation errors to stdout in JSON format.
"""

import sys
import json
from pathlib import Path
from typing import Dict, List, Any

def validate_ldraw_file(file_path: str) -> Dict[str, Any]:
    """
    Validate an LDraw file syntax.
    
    Returns:
        Dict with 'valid' boolean and 'errors' list
    """
    
    errors = []
    
    # Check file exists
    path = Path(file_path)
    if not path.exists():
        return {
            "valid": False,
            "errors": [f"File not found: {file_path}"]
        }
    
    # Try to parse the file
    try:
        # Read file content
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Check for common syntax issues before parsing
        lines = content.split('\n')
        for i, line in enumerate(lines, 1):
            line = line.strip()
            if not line or line.startswith('0 //'):
                continue
            
            tokens = line.split()
            if not tokens:
                continue
                
            line_type = tokens[0]
            
            # Check line type 1 (subfile reference) has correct number of tokens
            if line_type == '1':
                if len(tokens) < 15:
                    errors.append(f"Line {i}: Type 1 line has {len(tokens)} tokens, expected at least 15")
                    continue
                
                # Check numeric fields can be parsed
                try:
                    color = int(tokens[1])
                    x, y, z = float(tokens[2]), float(tokens[3]), float(tokens[4])
                    a, b, c = float(tokens[5]), float(tokens[6]), float(tokens[7])
                    d, e, f = float(tokens[8]), float(tokens[9]), float(tokens[10])
                    g, h, i_val = float(tokens[11]), float(tokens[12]), float(tokens[13])
                    
                    # Check for NaN or Infinity
                    coords = [x, y, z, a, b, c, d, e, f, g, h, i_val]
                    for val in coords:
                        if not (-1e10 < val < 1e10):
                            errors.append(f"Line {i}: Extreme value detected: {val}")
                        if val != val:  # NaN check
                            errors.append(f"Line {i}: NaN value detected")
                            
                except (ValueError, IndexError) as e:
                    errors.append(f"Line {i}: Invalid numeric values - {str(e)}")
                    
            # Check line types 2,3,4 (lines, triangles, quads)
            elif line_type in ['2', '3', '4']:
                expected_tokens = {'2': 8, '3': 11, '4': 14}[line_type]
                if len(tokens) < expected_tokens:
                    errors.append(f"Line {i}: Type {line_type} line has {len(tokens)} tokens, expected {expected_tokens}")
                    
            elif line_type == '5':
                if len(tokens) < 14:
                    errors.append(f"Line {i}: Type 5 line has {len(tokens)} tokens, expected at least 14")
        
        # Try parsing with pyldraw3
        # Note: pyldraw3 might not have a simple parse-only function exposed,
        # but we can try creating a minimal reader/parser
        # If pyldraw3 doesn't provide direct parsing, we rely on our manual checks above
        
    except UnicodeDecodeError as e:
        errors.append(f"File encoding error: {str(e)}")
    except Exception as e:
        errors.append(f"Parse error: {str(e)}")
    
    return {
        "valid": len(errors) == 0,
        "errors": errors
    }

def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "valid": False,
            "errors": ["Usage: validate_ldraw_syntax.py <file.mpd>"]
        }))
        sys.exit(1)
    
    file_path = sys.argv[1]
    result = validate_ldraw_file(file_path)
    
    # Print result as JSON
    print(json.dumps(result, indent=2))
    
    # Exit with appropriate code
    sys.exit(0 if result["valid"] else 1)

if __name__ == "__main__":
    main()
