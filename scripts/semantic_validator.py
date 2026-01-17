"""
Semantic Similarity Validator

Uses AI vision to validate that the LEGO model matches the input image conceptually.
Checks that major components (head, body, limbs, etc.) are present and in correct positions.
"""

import base64
from typing import Dict, List, Optional
import json


def encode_image_base64(image_path: str) -> str:
    """Encode image to base64 for OpenAI API."""
    with open(image_path, 'rb') as f:
        return base64.b64encode(f.read()).decode('utf-8')


def validate_semantic_similarity(
    input_image_path: str,
    render_image_path: str,
    api_key: str,
    model: str = "gpt-4o"
) -> Dict:
    """
    Validate that the rendered LEGO model is semantically similar to the input image.
    
    Checks:
    - Major components present (head, body, limbs, etc.)
    - Correct relative positions
    - Proper proportions
    - Overall structure matches
    
    Args:
        input_image_path: Path to original reference image
        render_image_path: Path to rendered LEGO model
        api_key: OpenAI API key
        model: Vision model to use
    
    Returns:
        {
            "is_valid": bool,
            "similarity_score": float (0-100),
            "components": {
                "expected": [...],
                "found": [...],
                "missing": [...],
                "misplaced": [...]
            },
            "issues": [...],
            "analysis": str
        }
    """
    import requests
    
    # Encode images
    input_b64 = encode_image_base64(input_image_path)
    render_b64 = encode_image_base64(render_image_path)
    
    # Construct prompt
    prompt = """You are validating that a LEGO model matches a reference image conceptually and structurally.

Compare these two images:
1. FIRST IMAGE: The original reference/input image
2. SECOND IMAGE: The rendered LEGO model

Analyze if the LEGO model captures the essence of the reference image. Check:

1. **Major Components**: Are all main parts present? (e.g., head, body, arms, legs, base)
2. **Layout**: Are components in the correct relative positions?
3. **Proportions**: Do size ratios match reasonably well?
4. **Orientation**: Is the model facing the right direction?
5. **Key Features**: Are distinctive elements present? (e.g., weapons, accessories, shapes)

Respond in JSON format:
{
    "is_valid": boolean,
    "similarity_score": number (0-100),
    "components": {
        "expected": ["component1", "component2", ...],
        "found": ["component1", "component2", ...],
        "missing": ["componentX"],
        "misplaced": ["componentY"]
    },
    "proportions": {
        "correct": boolean,
        "issues": ["head too small", ...]
    },
    "orientation": {
        "correct": boolean,
        "issue": "facing wrong direction"
    },
    "overall_match": "excellent|good|fair|poor",
    "issues": [
        {"type": "missing_component", "component": "left arm", "severity": "error"},
        {"type": "wrong_position", "component": "head", "expected": "top", "actual": "middle", "severity": "warning"}
    ],
    "summary": "brief description of how well they match"
}

Be strict but reasonable. Minor color differences are OK. Focus on structure and layout."""

    # Call OpenAI Vision API
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }
    
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{input_b64}",
                            "detail": "high"
                        }
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{render_b64}",
                            "detail": "high"
                        }
                    }
                ]
            }
        ],
        "response_format": {"type": "json_object"},
        "max_tokens": 2000
    }
    
    try:
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=60
        )
        
        if response.status_code != 200:
            return {
                "is_valid": False,
                "error": f"API error {response.status_code}: {response.text}",
                "similarity_score": 0
            }
        
        result = response.json()
        content = result['choices'][0]['message']['content']
        analysis = json.loads(content)
        
        # Add metadata
        analysis["method"] = "vision_ai"
        analysis["model"] = model
        
        return analysis
        
    except Exception as e:
        return {
            "is_valid": False,
            "error": f"Validation failed: {str(e)}",
            "similarity_score": 0
        }


def validate_semantic_similarity_batch(
    pairs: List[tuple],
    api_key: str,
    model: str = "gpt-4o",
    min_similarity: float = 70.0
) -> Dict:
    """
    Validate multiple input/render pairs.
    
    Args:
        pairs: List of (input_image_path, render_image_path) tuples
        api_key: OpenAI API key
        model: Vision model to use
        min_similarity: Minimum similarity score to pass
    
    Returns:
        {
            "results": [...],
            "summary": {
                "total": int,
                "passed": int,
                "failed": int,
                "average_score": float
            }
        }
    """
    results = []
    scores = []
    
    for input_path, render_path in pairs:
        result = validate_semantic_similarity(input_path, render_path, api_key, model)
        
        result["input_image"] = input_path
        result["render_image"] = render_path
        result["passed"] = result.get("similarity_score", 0) >= min_similarity
        
        results.append(result)
        scores.append(result.get("similarity_score", 0))
    
    summary = {
        "total": len(results),
        "passed": sum(1 for r in results if r.get("passed", False)),
        "failed": sum(1 for r in results if not r.get("passed", False)),
        "average_score": sum(scores) / len(scores) if scores else 0
    }
    
    return {
        "results": results,
        "summary": summary
    }


def validate_submodule_semantic(
    render_image_path: str,
    subassembly_info: Dict,
    steps_completed: List[Dict],
    api_key: str,
    model: str = "gpt-4o"
) -> Dict:
    """
    Validate a partial/submodule render against blueprint expectations.
    
    This allows semantic validation WITHOUT requiring a full reference image.
    Instead, it validates that the rendered submodule matches what the blueprint
    says should exist at this stage of the build.
    
    Args:
        render_image_path: Path to rendered image of partial build/submodule
        subassembly_info: Dict with subassembly details:
            {
                "name": "torso",
                "description": "Main body section with attachment points",
                "expected_components": ["chest plate", "shoulder joints"],
                "expected_position": "center",
                "symmetric": false
            }
        steps_completed: List of blueprint steps completed so far:
            [{"step": 1, "title": "Base", "description": "Build the foundation..."}]
        api_key: OpenAI API key
        model: Vision model to use
    
    Returns:
        {
            "is_valid": bool,
            "confidence_score": float (0-100),
            "components": {
                "expected": [...],
                "found": [...],
                "missing": [...],
                "extra": [...]
            },
            "structure": {
                "matches_description": bool,
                "issues": [...]
            },
            "progress_assessment": str,
            "issues": [...],
            "summary": str
        }
    """
    import requests
    
    render_b64 = encode_image_base64(render_image_path)
    
    # Build context from blueprint
    subassembly_name = subassembly_info.get("name", "unknown")
    subassembly_desc = subassembly_info.get("description", "")
    expected_components = subassembly_info.get("expected_components", [])
    expected_position = subassembly_info.get("expected_position", "")
    is_symmetric = subassembly_info.get("symmetric", False)
    
    # Build steps context
    steps_context = ""
    if steps_completed:
        steps_context = "Steps completed so far:\n"
        for step in steps_completed:
            steps_context += f"  Step {step.get('step', '?')}: {step.get('title', '')} - {step.get('description', '')}\n"
    
    components_str = ", ".join(expected_components) if expected_components else "the described components"
    
    prompt = f"""You are validating a PARTIAL LEGO build against its blueprint specification.

This is NOT a complete model - it's a work-in-progress showing the "{subassembly_name}" subassembly.

## Subassembly Specification
- **Name**: {subassembly_name}
- **Description**: {subassembly_desc}
- **Expected Components**: {components_str}
- **Expected Position**: {expected_position if expected_position else "not specified"}
- **Should be Symmetric**: {"Yes" if is_symmetric else "No"}

{steps_context}

## Your Task
Analyze the rendered image and determine if it matches the blueprint expectations for this subassembly.

Check:
1. **Component Presence**: Are the expected components ({components_str}) present or taking shape?
2. **Structure**: Does the build structure match the description "{subassembly_desc}"?
3. **Proportions**: Are the proportions reasonable for this subassembly?
4. **Symmetry**: {"Is it symmetric as required?" if is_symmetric else "N/A"}
5. **Build Quality**: Are bricks properly connected? Any floating pieces?

Important: This is a PARTIAL build. Don't penalize for:
- Missing components that belong to OTHER subassemblies
- Incomplete overall model
- Missing details that come in later steps

Respond in JSON:
{{
    "is_valid": boolean,
    "confidence_score": number (0-100, how confident you are in the assessment),
    "components": {{
        "expected": ["component1", ...],
        "found": ["component1", ...],
        "missing": ["componentX"],
        "extra": ["unexpected_component"]
    }},
    "structure": {{
        "matches_description": boolean,
        "issues": ["issue1", ...]
    }},
    "proportions": {{
        "reasonable": boolean,
        "issues": ["proportion issue", ...]
    }},
    "symmetry": {{
        "checked": boolean,
        "symmetric": boolean,
        "issues": ["asymmetry in X", ...]
    }},
    "build_quality": {{
        "connections_valid": boolean,
        "floating_pieces": boolean,
        "issues": ["quality issue", ...]
    }},
    "progress_assessment": "on_track|ahead|behind|off_track",
    "issues": [
        {{"type": "missing_component", "component": "X", "severity": "error|warning"}},
        ...
    ],
    "summary": "Brief description of how well this subassembly matches expectations"
}}"""

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }
    
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{render_b64}",
                            "detail": "high"
                        }
                    }
                ]
            }
        ],
        "response_format": {"type": "json_object"},
        "max_tokens": 2000
    }
    
    try:
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=60
        )
        
        if response.status_code != 200:
            return {
                "is_valid": False,
                "error": f"API error {response.status_code}: {response.text}",
                "confidence_score": 0
            }
        
        result = response.json()
        content = result['choices'][0]['message']['content']
        analysis = json.loads(content)
        
        # Add metadata
        analysis["method"] = "submodule_semantic"
        analysis["model"] = model
        analysis["subassembly_name"] = subassembly_name
        
        return analysis
        
    except Exception as e:
        return {
            "is_valid": False,
            "error": f"Validation failed: {str(e)}",
            "confidence_score": 0
        }


def validate_final_model_semantic(
    input_image_path: str,
    render_image_path: str,
    blueprint: Dict,
    api_key: str,
    model: str = "gpt-4o"
) -> Dict:
    """
    Comprehensive semantic validation for a COMPLETE model.
    
    This is the full validation that can only run when the entire model is complete.
    It compares the rendered model against BOTH the reference image AND the blueprint.
    
    Args:
        input_image_path: Path to original reference image
        render_image_path: Path to rendered LEGO model
        blueprint: Full blueprint with subassemblies and step_outline
        api_key: OpenAI API key
        model: Vision model to use
    
    Returns:
        Comprehensive validation result including:
        - Reference image comparison
        - Blueprint compliance check
        - All subassemblies validation
        - Overall build quality assessment
    """
    import requests
    
    input_b64 = encode_image_base64(input_image_path)
    render_b64 = encode_image_base64(render_image_path)
    
    # Extract blueprint info
    subassemblies = blueprint.get("subassemblies", [])
    step_outline = blueprint.get("step_outline", [])
    
    subassembly_descriptions = ""
    for sub in subassemblies:
        subassembly_descriptions += f"- {sub.get('name', '?')}: {sub.get('description', '')} (position: {sub.get('expected_position', 'N/A')})\n"
    
    step_summary = f"Total steps: {len(step_outline)}"
    if step_outline:
        step_summary += f"\nFirst step: {step_outline[0].get('title', '?')}"
        step_summary += f"\nLast step: {step_outline[-1].get('title', '?')}"
    
    prompt = f"""You are performing FINAL VALIDATION of a completed LEGO model.

Compare the rendered LEGO model (SECOND IMAGE) against:
1. The original reference image (FIRST IMAGE)
2. The blueprint specification below

## Blueprint Specification

### Subassemblies
{subassembly_descriptions if subassembly_descriptions else "No subassemblies specified"}

### Build Summary
{step_summary}

## Validation Criteria

### 1. Reference Image Match (weight: 40%)
- Does the LEGO model capture the essence of the reference?
- Are key features/characteristics present?
- Is the overall shape/silhouette similar?

### 2. Blueprint Compliance (weight: 30%)
- Are all specified subassemblies present?
- Are subassemblies in their expected positions?
- Does the build follow the step outline?

### 3. Build Quality (weight: 20%)
- Are all parts properly connected?
- No floating or impossible placements?
- Structural integrity looks sound?

### 4. Proportions & Details (weight: 10%)
- Are proportions reasonable?
- Are symmetric parts actually symmetric?
- Are details appropriate for the part count?

Respond in JSON:
{{
    "is_valid": boolean,
    "overall_score": number (0-100),
    "reference_match": {{
        "score": number (0-100),
        "captures_essence": boolean,
        "key_features_present": ["feature1", ...],
        "key_features_missing": ["feature2", ...],
        "shape_similarity": "excellent|good|fair|poor",
        "issues": [...]
    }},
    "blueprint_compliance": {{
        "score": number (0-100),
        "subassemblies_present": ["sub1", ...],
        "subassemblies_missing": ["sub2", ...],
        "position_issues": ["sub X is in wrong position", ...],
        "issues": [...]
    }},
    "build_quality": {{
        "score": number (0-100),
        "connections_valid": boolean,
        "structural_integrity": boolean,
        "floating_pieces": boolean,
        "issues": [...]
    }},
    "proportions": {{
        "score": number (0-100),
        "reasonable": boolean,
        "symmetry_valid": boolean,
        "issues": [...]
    }},
    "overall_match": "excellent|good|fair|poor",
    "issues": [
        {{"type": "...", "component": "...", "severity": "error|warning", "description": "..."}}
    ],
    "summary": "Comprehensive summary of the final validation"
}}"""

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }
    
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{input_b64}",
                            "detail": "high"
                        }
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{render_b64}",
                            "detail": "high"
                        }
                    }
                ]
            }
        ],
        "response_format": {"type": "json_object"},
        "max_tokens": 3000
    }
    
    try:
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=90
        )
        
        if response.status_code != 200:
            return {
                "is_valid": False,
                "error": f"API error {response.status_code}: {response.text}",
                "overall_score": 0
            }
        
        result = response.json()
        content = result['choices'][0]['message']['content']
        analysis = json.loads(content)
        
        # Add metadata
        analysis["method"] = "final_semantic"
        analysis["model"] = model
        
        return analysis
        
    except Exception as e:
        return {
            "is_valid": False,
            "error": f"Validation failed: {str(e)}",
            "overall_score": 0
        }


def quick_component_check(
    input_image_path: str,
    render_image_path: str,
    api_key: str,
    expected_components: Optional[List[str]] = None
) -> Dict:
    """
    Quick check for specific components without full analysis.
    
    Args:
        input_image_path: Path to original reference image
        render_image_path: Path to rendered LEGO model
        api_key: OpenAI API key
        expected_components: List of components to check for (e.g., ["head", "arms", "base"])
    
    Returns:
        {
            "found_components": [...],
            "missing_components": [...],
            "issues": [...]
        }
    """
    import requests
    
    render_b64 = encode_image_base64(render_image_path)
    
    components_str = ", ".join(expected_components) if expected_components else "all major components"
    
    prompt = f"""Look at this LEGO model and identify which of these components are present: {components_str}

List each component that you can clearly see in the image.

Respond in JSON:
{{
    "found": ["component1", "component2", ...],
    "unclear": ["component3"]
}}"""

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }
    
    payload = {
        "model": "gpt-4o-mini",  # Use faster model for quick check
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{render_b64}",
                            "detail": "low"
                        }
                    }
                ]
            }
        ],
        "response_format": {"type": "json_object"},
        "max_tokens": 500
    }
    
    try:
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=30
        )
        
        if response.status_code != 200:
            return {"error": f"API error {response.status_code}"}
        
        result = response.json()
        content = json.loads(result['choices'][0]['message']['content'])
        
        if expected_components:
            found = set(content.get("found", []))
            expected = set(expected_components)
            missing = expected - found
            
            return {
                "found_components": list(found),
                "missing_components": list(missing),
                "issues": [
                    {"type": "missing_component", "component": comp}
                    for comp in missing
                ]
            }
        
        return content
        
    except Exception as e:
        return {"error": str(e)}


if __name__ == "__main__":
    import sys
    import os
    
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("Error: OPENAI_API_KEY environment variable not set")
        sys.exit(1)
    
    # Parse command line arguments
    if len(sys.argv) < 2:
        print("Usage:")
        print("  Full comparison:     python semantic_validator.py full <input_image> <render_image>")
        print("  Submodule check:     python semantic_validator.py submodule <render_image> <subassembly_json> [steps_json]")
        print("  Final validation:    python semantic_validator.py final <input_image> <render_image> <blueprint_json>")
        print("  Legacy (full):       python semantic_validator.py <input_image> <render_image>")
        sys.exit(1)
    
    mode = sys.argv[1]
    
    # Legacy mode (backward compatibility)
    if mode not in ["full", "submodule", "final"] and len(sys.argv) >= 3:
        input_img = sys.argv[1]
        render_img = sys.argv[2]
        print("Validating semantic similarity (legacy mode)...")
        result = validate_semantic_similarity(input_img, render_img, api_key)
        print(json.dumps(result, indent=2))
        sys.exit(0)
    
    if mode == "full":
        if len(sys.argv) < 4:
            print("Usage: python semantic_validator.py full <input_image> <render_image>")
            sys.exit(1)
        input_img = sys.argv[2]
        render_img = sys.argv[3]
        print("Validating semantic similarity...")
        result = validate_semantic_similarity(input_img, render_img, api_key)
        print(json.dumps(result, indent=2))
    
    elif mode == "submodule":
        if len(sys.argv) < 4:
            print("Usage: python semantic_validator.py submodule <render_image> <subassembly_json> [steps_json]")
            sys.exit(1)
        render_img = sys.argv[2]
        subassembly_json = sys.argv[3]
        steps_json = sys.argv[4] if len(sys.argv) > 4 else "[]"
        
        try:
            subassembly_info = json.loads(subassembly_json)
            steps_completed = json.loads(steps_json)
        except json.JSONDecodeError as e:
            print(f"Error parsing JSON: {e}")
            sys.exit(1)
        
        print(f"Validating submodule: {subassembly_info.get('name', 'unknown')}...")
        result = validate_submodule_semantic(render_img, subassembly_info, steps_completed, api_key)
        print(json.dumps(result, indent=2))
    
    elif mode == "final":
        if len(sys.argv) < 5:
            print("Usage: python semantic_validator.py final <input_image> <render_image> <blueprint_json>")
            sys.exit(1)
        input_img = sys.argv[2]
        render_img = sys.argv[3]
        blueprint_json = sys.argv[4]
        
        try:
            blueprint = json.loads(blueprint_json)
        except json.JSONDecodeError as e:
            print(f"Error parsing blueprint JSON: {e}")
            sys.exit(1)
        
        print("Validating final model...")
        result = validate_final_model_semantic(input_img, render_img, blueprint, api_key)
        print(json.dumps(result, indent=2))
    
    else:
        print(f"Unknown mode: {mode}")
        sys.exit(1)
