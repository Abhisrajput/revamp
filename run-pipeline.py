#!/usr/bin/env python3
"""Run all 8 pipeline stages sequentially with auto-approval."""

import urllib.request
import urllib.error
import json
import time
import sys

API = "http://localhost:8787"
PIPELINE = "0f86b9f2-d9c8-4f69-b1cc-bde6865b08fb"
MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

STAGES = ["SCAN", "DECODE", "BLUEPRINT", "SPEC_LOCK", "ARCHITECT", "FORGE", "SHADOW_RUN", "EVOLVE"]
NAMES = [
    "Setup & Configuration", "Intent Extraction", "Business Capability Mining",
    "Behavior Lock-in", "Modernization Approach", "Co-Create",
    "Parallel Run & Cutover", "Continuous Modernization",
]


TOKEN = ""

def api_call(method, path, data=None, timeout=300):
    url = f"{API}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.read().decode()
    except Exception as ex:
        return str(ex)


# Login
login_resp = api_call("POST", "/auth/login", {"email": "demo@revamp.ai", "password": "demo1234"})
TOKEN = json.loads(login_resp)["token"]

print("=" * 60)
print("  REVAMP 8-STAGE PIPELINE — FULL RUN")
print(f"  Pipeline: {PIPELINE[:8]}")
print(f"  Model: {MODEL}")
print("=" * 60)
print()

total_start = time.time()

for i, stage in enumerate(STAGES):
    print(f"▸ Stage {i+1}/8: {NAMES[i]} ({stage})")
    print(f"  Executing...", end="", flush=True)

    start = time.time()
    result = api_call("POST", f"/pipeline/{PIPELINE}/stage/{stage}",
                      {"model": MODEL, "evaluator_model": MODEL})
    duration = time.time() - start

    # Parse output length from SSE events
    output_len = 0
    validation_passed = None
    validation_score = None
    for line in result.split("\n"):
        if line.startswith("data:"):
            try:
                d = json.loads(line[5:].strip())
                if "outputLength" in d:
                    output_len = d["outputLength"]
                    v = d.get("validation")
                    if v:
                        validation_passed = v.get("passed")
                        validation_score = v.get("score", 0)
            except:
                pass

    if output_len > 0:
        val_str = ""
        if validation_passed is not None:
            val_str = f", validation: {'PASS' if validation_passed else 'FAIL'} ({validation_score}%)"
        print(f"\r  ✅ Complete — {output_len:,} chars, {duration:.1f}s{val_str}")
    else:
        # Check if there's an error
        error_msg = ""
        if "error" in result.lower():
            for line in result.split("\n"):
                if "error" in line.lower():
                    error_msg = line[:100]
                    break
        if error_msg:
            print(f"\r  ⚠ Completed with issues — {duration:.1f}s ({error_msg})")
        else:
            print(f"\r  ✅ Complete — {duration:.1f}s (output not captured from SSE)")

    # Auto-approve
    print(f"  Approving...", end="", flush=True)
    approve = api_call("POST", f"/pipeline/{PIPELINE}/approve/{stage}",
                       {"comment": f"Auto-approved stage {i+1}/8"})
    try:
        ar = json.loads(approve)
        print(f"\r  ✓ {ar.get('message', 'Approved')}")
    except:
        print(f"\r  ✓ Approved ({approve[:60]})")

    print()
    time.sleep(1)

total_duration = time.time() - total_start

print("=" * 60)
print("  PIPELINE COMPLETE")
print(f"  Total time: {total_duration:.0f}s ({total_duration/60:.1f} min)")
print("=" * 60)
print()

# Final status
status_raw = api_call("GET", f"/pipeline/{PIPELINE}/status")
try:
    d = json.loads(status_raw)
    sp = d.get("stage_progress", {})
    for s in STAGES:
        st = sp.get(s, {}).get("status", "?")
        icon = "✅" if st == "approved" else "❌" if st == "failed" else "⏳"
        print(f"  {icon} {s:12s} → {st}")
    print(f"\n  Pipeline status: {d.get('status')}")
except:
    print(status_raw[:300])
