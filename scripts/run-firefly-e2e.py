#!/usr/bin/env python3
"""
End-to-end pipeline run: Firefly III modernization via Bedrock SSO.

Creates a new project, starts a pipeline run, and executes all 8 stages
with auto-approval using AWS Bedrock (tavant-bedrock SSO profile).

Prerequisites:
  1. aws sso login --profile tavant-bedrock
  2. Restart Go orchestrator after SSO login (it caches credentials)
  3. API server running at localhost:8787
  4. Go orchestrator running at localhost:8080

Usage:
  python3 scripts/run-firefly-e2e.py
"""

import urllib.request
import urllib.error
import json
import time
import sys
import subprocess
import os

# ─── Configuration ──────────────────────────────────────────────

API = "http://localhost:8787"
REPO_URL = "https://github.com/firefly-iii/firefly-iii.git"
REPO_BRANCH = "main"
PROJECT_NAME = "Firefly III Modernization"

# Bedrock models (us-east-2 via tavant-bedrock SSO)
# Strategy: Sonnet for fast subtask extraction, Opus for deep composition
EXECUTOR_MODEL = "us.anthropic.claude-sonnet-4-6"
COMPOSER_MODEL = "us.anthropic.claude-opus-4-6-v1"     # Opus for quality composition
EVALUATOR_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

# Auth
LOGIN_EMAIL = "architect@revamp.ai"
LOGIN_PASSWORD = "demo1234"

TOKEN = ""

STAGES = ["SCAN", "DECODE", "BLUEPRINT", "SPEC_LOCK", "ARCHITECT", "FORGE", "SHADOW_RUN", "EVOLVE"]
STAGE_NAMES = [
    "Setup & Configuration", "Intent Extraction", "Business Capability Map",
    "Behavior Lock-in", "Modernization Approach", "Co-Create",
    "Parallel Run & Cutover", "Continuous Modernization",
]

# ─── Helpers ────────────────────────────────────────────────────

def api_call(method, path, data=None, timeout=600, stream=False):
    """Make an API call. Returns (status_code, response_text).
    For SSE endpoints (stream=True), uses curl subprocess for reliable streaming."""
    url = f"{API}{path}"

    if stream:
        # Use curl for SSE — Python's urllib doesn't handle streaming well
        cmd = [
            "curl", "-s", "-N", "-m", str(timeout),
            "-X", method, url,
            "-H", "Content-Type: application/json",
        ]
        if TOKEN:
            cmd += ["-H", f"Authorization: Bearer {TOKEN}"]
        if data:
            cmd += ["-d", json.dumps(data)]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
            return 200, result.stdout
        except subprocess.TimeoutExpired:
            return 0, "Timeout"
        except Exception as ex:
            return 0, str(ex)

    # Non-streaming — use urllib
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        return e.code, body
    except Exception as ex:
        return 0, str(ex)


def api_json(method, path, data=None, timeout=60):
    """Make an API call and parse JSON response."""
    status, body = api_call(method, path, data, timeout)
    try:
        return status, json.loads(body)
    except:
        return status, {"raw": body[:500]}


def check_sso():
    """Verify AWS SSO session is active."""
    try:
        result = subprocess.run(
            ["aws", "sts", "get-caller-identity", "--profile", "tavant-bedrock"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            identity = json.loads(result.stdout)
            print(f"  AWS Identity: {identity.get('Arn', '?')}")
            return True
        else:
            print(f"  ❌ SSO expired: {result.stderr.strip()[:100]}")
            return False
    except Exception as e:
        print(f"  ❌ AWS CLI error: {e}")
        return False


def check_services():
    """Verify all services are running."""
    services = [
        ("API", f"{API}/health"),
        ("Go Orchestrator", "http://localhost:8080/health"),
    ]
    for name, url in services:
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=5) as resp:
                print(f"  ✓ {name}: healthy")
        except Exception as e:
            print(f"  ❌ {name}: {e}")
            return False
    return True


def parse_sse_result(sse_text):
    """Parse SSE event stream to extract final result."""
    output_len = 0
    validation_passed = None
    validation_score = None
    error_msg = None
    last_phase = None

    for line in sse_text.split("\n"):
        if not line.startswith("data:"):
            continue
        try:
            d = json.loads(line[5:].strip())
            event_type = d.get("type", "")

            if event_type == "phase":
                last_phase = d.get("phase", "")

            if event_type in ("completed", "stage_completed"):
                output_len = d.get("outputLength", d.get("docLength", 0))
                if "validation" in d:
                    v = d["validation"]
                    validation_passed = v.get("passed")
                    validation_score = v.get("score", v.get("confidenceScore", 0))

            if event_type == "error" or event_type == "failed":
                error_msg = d.get("message", d.get("error", "Unknown error"))

        except:
            pass

    return {
        "output_len": output_len,
        "validation_passed": validation_passed,
        "validation_score": validation_score,
        "error": error_msg,
        "last_phase": last_phase,
    }


# ─── Main ───────────────────────────────────────────────────────

def main():
    global TOKEN

    print("=" * 65)
    print("  REVAMP E2E: Firefly III → Modern Tech Stack")
    print("=" * 65)
    print()

    # Step 0: Preflight checks
    print("▸ Preflight Checks")

    print("  Checking AWS SSO...")
    if not check_sso():
        print("\n  Run: aws sso login --profile tavant-bedrock")
        print("  Then restart the Go orchestrator and re-run this script.")
        sys.exit(1)

    print("  Checking services...")
    if not check_services():
        print("\n  Start all services: pnpm dev:api && Go orchestrator")
        sys.exit(1)

    print("  ✓ All preflight checks passed\n")

    # Step 1: Login
    print("▸ Authenticating...")
    status, resp = api_json("POST", "/auth/login", {
        "email": LOGIN_EMAIL,
        "password": LOGIN_PASSWORD,
    })
    if status != 200 or "token" not in resp:
        # Try signup
        status, resp = api_json("POST", "/auth/signup", {
            "email": LOGIN_EMAIL,
            "password": LOGIN_PASSWORD,
            "first_name": "Admin",
            "last_name": "User",
        })
    TOKEN = resp.get("token", "")
    if not TOKEN:
        print(f"  ❌ Auth failed: {resp}")
        sys.exit(1)
    print(f"  ✓ Logged in as {resp.get('user', {}).get('email', LOGIN_EMAIL)}\n")

    # Step 2: Find existing project or create new one
    print("▸ Finding or creating project...")
    status, projects = api_json("GET", "/projects")
    project_id = None
    if status == 200 and isinstance(projects, list):
        for p in projects:
            if p.get("repository_url") == REPO_URL or p.get("source_url") == REPO_URL:
                project_id = p.get("id")
                print(f"  ✓ Found existing project: {project_id[:8]}... — {p.get('name')}")
                break

    if not project_id:
        status, proj = api_json("POST", "/projects", {
            "name": PROJECT_NAME,
            "description": "Modernize Firefly III personal finance manager from Laravel/PHP to modern cloud-native stack",
            "repository_url": REPO_URL,
            "repository_branch": REPO_BRANCH,
            "source_type": "git",
            "source_url": REPO_URL,
            "visibility": "private",
            "target_stack": "Java/Spring Boot",
            "target_cloud": "aws",
        })
        if status not in (200, 201):
            print(f"  ❌ Project creation failed ({status}): {proj}")
            sys.exit(1)
        project_id = proj.get("id", "")
        print(f"  ✓ Created project: {project_id[:8]}... — {PROJECT_NAME}")
    print()

    # Step 3: Start pipeline
    print("▸ Starting pipeline run...")
    status, run = api_json("POST", "/pipeline/start", {"project_id": project_id})
    if status not in (200, 201):
        print(f"  ❌ Pipeline start failed ({status}): {run}")
        sys.exit(1)

    pipeline_run_id = run.get("pipeline_run_id", "")
    print(f"  ✓ Pipeline run: {pipeline_run_id[:8]}...\n")

    # Step 4: Execute all 8 stages
    print("=" * 65)
    print(f"  Model: {EXECUTOR_MODEL}")
    print(f"  Repo:  {REPO_URL}")
    print("=" * 65)
    print()

    total_start = time.time()
    results = []

    # Determine max_tokens based on codebase size (detected after SCAN)
    # Small: <10K lines, Medium: 10K-100K, Large: 100K+
    codebase_tier = "large"  # Default to large for safety — adjusted after SCAN
    stage_max_tokens = {
        "small":  {"SCAN": 16384, "DECODE": 32768, "BLUEPRINT": 16384, "SPEC_LOCK": 32768, "ARCHITECT": 16384, "FORGE": 65536, "SHADOW_RUN": 32768, "EVOLVE": 16384},
        "medium": {"SCAN": 32768, "DECODE": 65536, "BLUEPRINT": 32768, "SPEC_LOCK": 65536, "ARCHITECT": 32768, "FORGE": 65536, "SHADOW_RUN": 65536, "EVOLVE": 32768},
        "large":  {"SCAN": 65536, "DECODE": 65536, "BLUEPRINT": 65536, "SPEC_LOCK": 65536, "ARCHITECT": 65536, "FORGE": 65536, "SHADOW_RUN": 65536, "EVOLVE": 65536},
    }

    for i, stage in enumerate(STAGES):
        print(f"▸ Stage {i+1}/8: {STAGE_NAMES[i]} ({stage})")
        print(f"  Executing...", end="", flush=True)

        start = time.time()
        max_tokens = stage_max_tokens[codebase_tier].get(stage, 32768)
        status, sse_text = api_call(
            "POST",
            f"/pipeline/{pipeline_run_id}/stage/{stage}",
            {
                "model": EXECUTOR_MODEL,
                "composer_model": COMPOSER_MODEL,
                "evaluator_model": EVALUATOR_MODEL,
                "max_tokens": max_tokens,
            },
            timeout=1800,  # 30 min max per stage
            stream=True,   # SSE endpoint — must read stream fully
        )
        duration = time.time() - start
        result = parse_sse_result(sse_text)
        result["duration"] = duration
        result["stage"] = stage
        results.append(result)

        if result["error"]:
            print(f"\r  ❌ Failed — {duration:.0f}s: {result['error'][:80]}")
        elif result["output_len"] > 0:
            val_str = ""
            if result["validation_passed"] is not None:
                icon = "✓" if result["validation_passed"] else "⚠"
                val_str = f", validation: {icon} ({result['validation_score']}%)"
            print(f"\r  ✅ Complete — {result['output_len']:,} chars, {duration:.0f}s{val_str}")
        else:
            print(f"\r  ✅ Complete — {duration:.0f}s")

        # After SCAN, detect codebase size from the SSE events
        if stage == "SCAN" and sse_text:
            for line in sse_text.split("\n"):
                if "Scanned" in line and "files" in line:
                    try:
                        # Extract line count from "Scanned X files, Y lines"
                        import re
                        m = re.search(r'([\d,]+)\s*lines', line)
                        if m:
                            total_lines = int(m.group(1).replace(",", ""))
                            if total_lines < 10000:
                                codebase_tier = "small"
                            elif total_lines < 100000:
                                codebase_tier = "medium"
                            else:
                                codebase_tier = "large"
                            print(f"\n  Codebase tier: {codebase_tier} ({total_lines:,} lines) → max_tokens scaled accordingly")
                    except:
                        pass
                    break

        # Auto-approve
        print(f"  Approving...", end="", flush=True)
        status, approve_resp = api_json(
            "POST",
            f"/pipeline/{pipeline_run_id}/approve/{stage}",
            {"comment": f"Auto-approved stage {i+1}/8 ({STAGE_NAMES[i]})", "force": True},
        )
        if status == 200:
            print(f"\r  ✓ Approved")
        else:
            print(f"\r  ⚠ Approval: {approve_resp.get('error', approve_resp)}")

        print()
        time.sleep(2)  # Brief pause between stages

    # Step 5: Summary
    total_duration = time.time() - total_start

    print("=" * 65)
    print("  PIPELINE COMPLETE")
    print(f"  Total time: {total_duration:.0f}s ({total_duration/60:.1f} min)")
    print("=" * 65)
    print()

    # Final status from API
    status, final = api_json("GET", f"/pipeline/{pipeline_run_id}/status")
    if status == 200:
        sp = final.get("stage_progress", {})
        for s in STAGES:
            st = sp.get(s, {}).get("status", "?")
            icon = "✅" if st in ("approved", "completed") else "❌" if st == "failed" else "⏳"
            r = next((r for r in results if r["stage"] == s), {})
            dur = r.get("duration", 0)
            print(f"  {icon} {s:12s} → {st:20s} ({dur:.0f}s)")
        print(f"\n  Pipeline status: {final.get('status')}")
    print()

    # Print the URL to view in browser
    print(f"  View in browser:")
    print(f"  http://localhost:3001/projects/{project_id}/pipeline")
    print()

    # Exit with error if any stage failed
    failed = [r for r in results if r.get("error")]
    if failed:
        print(f"  ⚠ {len(failed)} stage(s) failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
