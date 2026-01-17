#!/usr/bin/env python3
"""
Connection Validator CLI

Validates LEGO connections in LDraw MPD files.
"""

import sys
import json
import argparse
from mpd_parser import load_and_parse_mpd
from connection_detector import validate_connections


def main():
    parser = argparse.ArgumentParser(description='Validate LEGO connections in MPD files')
    parser.add_argument('mpd_file', help='Path to MPD file')
    parser.add_argument('--json', action='store_true', help='Output JSON format')
    parser.add_argument('--verbose', action='store_true', help='Verbose output')
    
    args = parser.parse_args()
    
    try:
        # Load and parse MPD
        if args.verbose:
            print(f"Loading {args.mpd_file}...", file=sys.stderr)
        
        parts = load_and_parse_mpd(args.mpd_file)
        
        if args.verbose:
            print(f"Loaded {len(parts)} parts", file=sys.stderr)
        
        # Validate connections
        result = validate_connections(parts)
        
        if args.json:
            # Output JSON
            print(json.dumps(result, indent=2))
        else:
            # Human-readable output
            print(f"=== Connection Validation Results ===\n")
            print(f"Total parts: {result['stats']['total_parts']}")
            print(f"Supported parts: {result['stats']['supported_parts']}")
            print(f"Connections found: {result['stats']['connections']}")
            print(f"Errors: {result['stats']['errors']}")
            print(f"Warnings: {result['stats']['warnings']}")
            print(f"\nValid: {'✓ YES' if result['is_valid'] else '✗ NO'}")
            
            if result['issues']:
                print(f"\n=== Issues ===\n")
                for issue in result['issues']:
                    icon = "✗" if issue['severity'] == 'error' else "⚠"
                    print(f"  {icon} [{issue['severity']}] {issue['type']}: {issue['message']}")
            
            if result['connections'] and args.verbose:
                print(f"\n=== Connections ===\n")
                for conn in result['connections'][:10]:
                    print(f"  {conn['upper_part']} -> {conn['lower_part']} ({conn['strength']} studs)")
                if len(result['connections']) > 10:
                    print(f"  ... and {len(result['connections']) - 10} more")
        
        # Exit code: 0 if valid, 1 if errors
        sys.exit(0 if result['is_valid'] else 1)
    
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        if args.verbose:
            import traceback
            traceback.print_exc()
        sys.exit(2)


if __name__ == "__main__":
    main()
