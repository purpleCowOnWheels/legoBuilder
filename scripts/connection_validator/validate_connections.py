#!/usr/bin/env python3
"""
Connection Validator CLI

Validates LEGO connections in LDraw MPD files.
Supports auto-fix mode to automatically correct floating parts.
"""

import sys
import json
import argparse
import re
from mpd_parser import load_and_parse_mpd, parse_type1_line
from connection_detector import validate_connections, find_nearest_potential_connection
from part_metadata import get_part_metadata


def parse_mpd_with_line_tracking(file_path: str):
    """
    Parse MPD file and track which line each part came from.
    Returns: (parts_list, line_mapping, original_content)
    
    line_mapping: dict mapping part index to (line_number, original_line)
    """
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    lines = content.split('\n')
    parts = load_and_parse_mpd(file_path)
    
    # Build line mapping by matching parts to type 1 lines
    line_mapping = {}
    part_idx = 0
    
    for line_num, line in enumerate(lines):
        line_stripped = line.strip()
        if line_stripped.startswith('1 '):
            parsed = parse_type1_line(line_stripped)
            if parsed and part_idx < len(parts):
                line_mapping[part_idx] = (line_num, line)
                part_idx += 1
    
    return parts, line_mapping, content


def apply_fix_to_line(original_line: str, dx: float, dy: float, dz: float) -> str:
    """
    Apply position fix to a type 1 LDraw line.
    Returns the corrected line.
    """
    parts = original_line.strip().split()
    if len(parts) < 15 or parts[0] != '1':
        return original_line
    
    try:
        # Parse current position
        x, y, z = float(parts[2]), float(parts[3]), float(parts[4])
        
        # Apply fix (subtract the gap to move part to correct position)
        new_x = x - dx
        new_y = y - dy
        new_z = z - dz
        
        # Rebuild line with new position
        parts[2] = f"{new_x:.0f}" if new_x == int(new_x) else f"{new_x}"
        parts[3] = f"{new_y:.0f}" if new_y == int(new_y) else f"{new_y}"
        parts[4] = f"{new_z:.0f}" if new_z == int(new_z) else f"{new_z}"
        
        return ' '.join(parts)
    except (ValueError, IndexError):
        return original_line


def auto_fix_connections(file_path: str, max_iterations: int = 50) -> dict:
    """
    Automatically fix floating parts by adjusting their positions.
    
    Iteratively:
    1. Validate connections
    2. Apply fixes to floating parts
    3. Re-validate
    4. Repeat until stable or max iterations
    
    Returns:
    {
        "is_valid": bool,
        "auto_corrected": bool,
        "iterations": int,
        "fixes_applied": int,
        "fixes_summary": [str],
        "corrected_content": str,  # The fixed LDraw code
        "original_errors": int,
        "final_errors": int,
        "stats": {...},
        "remaining_issues": [...]
    }
    """
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original_content = content
    total_fixes = 0
    fixes_summary = []
    iteration = 0
    prev_error_count = float('inf')
    stall_count = 0
    
    while iteration < max_iterations:
        iteration += 1
        
        # Write current content to temp file for validation
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        
        # Parse and validate
        parts = load_and_parse_mpd(file_path)
        result = validate_connections(parts)
        
        error_count = result['stats']['errors']
        
        # Check if we're done
        if error_count == 0:
            break
        
        # Check if we're stalled (not making progress)
        if error_count >= prev_error_count:
            stall_count += 1
            if stall_count >= 2:
                # Stuck, can't fix automatically
                break
        else:
            stall_count = 0
        
        prev_error_count = error_count
        
        # Build parts with metadata for fix calculation
        parts_with_meta = []
        for part in parts:
            meta = get_part_metadata(part.part_id)
            if meta:
                parts_with_meta.append((part, meta))
        
        # Find all floating parts and their fixes
        fixes_this_round = []
        lines = content.split('\n')
        
        for issue in result['issues']:
            if issue['type'] != 'floating_part' or issue['severity'] != 'error':
                continue
            
            details = issue.get('details', {})
            gap = details.get('gap')
            if not gap:
                continue
            
            # Find the line for this part by matching position
            pos = details.get('position', [])
            if len(pos) != 3:
                continue
            
            target_x, target_y, target_z = pos
            
            # Find the type 1 line with this position
            for line_num, line in enumerate(lines):
                line_stripped = line.strip()
                if not line_stripped.startswith('1 '):
                    continue
                
                parsed = parse_type1_line(line_stripped)
                if not parsed:
                    continue
                
                px, py, pz = parsed['position']
                if abs(px - target_x) < 0.1 and abs(py - target_y) < 0.1 and abs(pz - target_z) < 0.1:
                    # Found the line, apply fix
                    dx, dy, dz = gap['dx'], gap['dy'], gap['dz']
                    fixed_line = apply_fix_to_line(line, dx, dy, dz)
                    
                    if fixed_line != line:
                        fixes_this_round.append((line_num, line, fixed_line, parsed['part_id'], dx, dy, dz))
                    break
        
        if not fixes_this_round:
            # No fixes possible this round
            break
        
        # Apply all fixes
        for line_num, old_line, new_line, part_id, dx, dy, dz in fixes_this_round:
            lines[line_num] = new_line
            total_fixes += 1
            
            # Build summary
            fix_desc = []
            if abs(dy) > 0.1:
                fix_desc.append(f"Y {-dy:+.0f}")
            if abs(dx) > 0.1:
                fix_desc.append(f"X {-dx:+.0f}")
            if abs(dz) > 0.1:
                fix_desc.append(f"Z {-dz:+.0f}")
            
            if fix_desc:
                fixes_summary.append(f"{part_id}: {', '.join(fix_desc)}")
        
        content = '\n'.join(lines)
    
    # Final validation
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    parts = load_and_parse_mpd(file_path)
    final_result = validate_connections(parts)
    
    # Count original errors
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(original_content)
    orig_parts = load_and_parse_mpd(file_path)
    orig_result = validate_connections(orig_parts)
    original_errors = orig_result['stats']['errors']
    
    # Write final corrected content back
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    return {
        "is_valid": final_result['is_valid'],
        "auto_corrected": total_fixes > 0,
        "iterations": iteration,
        "fixes_applied": total_fixes,
        "fixes_summary": fixes_summary[:20],  # Limit to 20 for brevity
        "corrected_content": content,
        "original_errors": original_errors,
        "final_errors": final_result['stats']['errors'],
        "stats": final_result['stats'],
        "remaining_issues": [i for i in final_result['issues'] if i['severity'] == 'error'][:5]
    }


def main():
    parser = argparse.ArgumentParser(description='Validate LEGO connections in MPD files')
    parser.add_argument('mpd_file', help='Path to MPD file')
    parser.add_argument('--json', action='store_true', help='Output JSON format')
    parser.add_argument('--verbose', action='store_true', help='Verbose output')
    parser.add_argument('--auto-fix', action='store_true', help='Automatically fix floating parts')
    parser.add_argument('--max-iterations', type=int, default=50, help='Max auto-fix iterations')
    
    args = parser.parse_args()
    
    try:
        if args.auto_fix:
            # Auto-fix mode
            result = auto_fix_connections(args.mpd_file, args.max_iterations)
            
            if args.json:
                print(json.dumps(result, indent=2))
            else:
                print(f"=== Auto-Fix Results ===\n")
                print(f"Original errors: {result['original_errors']}")
                print(f"Final errors: {result['final_errors']}")
                print(f"Fixes applied: {result['fixes_applied']}")
                print(f"Iterations: {result['iterations']}")
                print(f"Valid: {'✓ YES' if result['is_valid'] else '✗ NO'}")
                
                if result['fixes_summary']:
                    print(f"\nFixes applied:")
                    for fix in result['fixes_summary'][:10]:
                        print(f"  - {fix}")
                    if len(result['fixes_summary']) > 10:
                        print(f"  ... and {len(result['fixes_summary']) - 10} more")
                
                if result['remaining_issues']:
                    print(f"\nRemaining issues (need manual fix):")
                    for issue in result['remaining_issues']:
                        print(f"  - {issue['message']}")
            
            sys.exit(0 if result['is_valid'] else 1)
        
        else:
            # Standard validation mode
            if args.verbose:
                print(f"Loading {args.mpd_file}...", file=sys.stderr)
            
            parts = load_and_parse_mpd(args.mpd_file)
            
            if args.verbose:
                print(f"Loaded {len(parts)} parts", file=sys.stderr)
            
            result = validate_connections(parts)
            
            if args.json:
                print(json.dumps(result, indent=2))
            else:
                print(f"=== Connection Validation Results ===\n")
                print(f"Total parts: {result['stats']['total_parts']}")
                print(f"Supported parts: {result['stats']['supported_parts']}")
                if result['stats'].get('unsupported_parts', 0) > 0:
                    print(f"Unsupported parts: {result['stats']['unsupported_parts']}")
                print(f"Connections found: {result['stats']['connections']}")
                print(f"Errors: {result['stats']['errors']}")
                print(f"Warnings: {result['stats']['warnings']}")
                print(f"\nValid: {'✓ YES' if result['is_valid'] else '✗ NO'}")
                
                if 'summary' in result:
                    print(f"\n=== Summary ===\n")
                    print(result['summary'])
                
                if args.verbose and result['issues']:
                    print(f"\n=== Detailed Issues ===\n")
                    for issue in result['issues']:
                        icon = "✗" if issue['severity'] == 'error' else "⚠"
                        print(f"  {icon} [{issue['severity']}] {issue['type']}: {issue['message']}")
                
                if result['connections'] and args.verbose:
                    print(f"\n=== Connections ===\n")
                    for conn in result['connections'][:10]:
                        print(f"  {conn['upper_part']} -> {conn['lower_part']} ({conn['strength']} studs)")
                    if len(result['connections']) > 10:
                        print(f"  ... and {len(result['connections']) - 10} more")
            
            sys.exit(0 if result['is_valid'] else 1)
    
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        if args.verbose:
            import traceback
            traceback.print_exc()
        sys.exit(2)


if __name__ == "__main__":
    main()
