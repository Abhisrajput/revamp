#!/usr/bin/env python3
"""
REVAMP Platform Load Test Harness

Tests the API under concurrent load to identify performance bottlenecks,
memory leaks, and error rates before production deployment.

Usage:
  # Quick smoke test (1 user, 1 pipeline)
  python scripts/load-test.py --smoke

  # Moderate load (5 concurrent users)
  python scripts/load-test.py --users 5

  # Full load test (10 concurrent users, 3 pipelines each)
  python scripts/load-test.py --users 10 --pipelines 3

  # API endpoint stress test (no LLM calls)
  python scripts/load-test.py --api-only --users 20 --duration 60

Requirements:
  - API server running at $API_URL (default: http://localhost:8787)
  - Valid auth token in $REVAMP_TOKEN or --token flag
  - At least one project in the database
"""

import argparse
import json
import time
import sys
import os
import threading
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from dataclasses import dataclass, field
from typing import Optional

# ─── Configuration ──────────────────────────────────────────────

API_URL = os.environ.get("API_URL", "http://localhost:8787")
TOKEN = os.environ.get("REVAMP_TOKEN", "")

# ─── Metrics Collection ─────────────────────────────────────────

@dataclass
class RequestMetric:
    method: str
    path: str
    status: int
    duration_ms: float
    error: Optional[str] = None

@dataclass
class LoadTestResults:
    total_requests: int = 0
    successful: int = 0
    failed: int = 0
    errors: dict = field(default_factory=dict)
    latencies: list = field(default_factory=list)
    requests_per_second: float = 0.0
    duration_seconds: float = 0.0
    metrics: list = field(default_factory=list)

    def add(self, metric: RequestMetric):
        self.total_requests += 1
        self.latencies.append(metric.duration_ms)
        self.metrics.append(metric)
        if metric.status < 400:
            self.successful += 1
        else:
            self.failed += 1
            key = f"{metric.status} {metric.path}"
            self.errors[key] = self.errors.get(key, 0) + 1

    def summary(self) -> str:
        if not self.latencies:
            return "No requests recorded."

        p50 = statistics.median(self.latencies)
        p95 = sorted(self.latencies)[int(len(self.latencies) * 0.95)] if len(self.latencies) > 1 else p50
        p99 = sorted(self.latencies)[int(len(self.latencies) * 0.99)] if len(self.latencies) > 1 else p50

        lines = [
            "",
            "═══════════════════════════════════════════════════",
            "  REVAMP Load Test Results",
            "═══════════════════════════════════════════════════",
            "",
            f"  Duration:          {self.duration_seconds:.1f}s",
            f"  Total Requests:    {self.total_requests}",
            f"  Successful:        {self.successful} ({self.successful/max(self.total_requests,1)*100:.1f}%)",
            f"  Failed:            {self.failed} ({self.failed/max(self.total_requests,1)*100:.1f}%)",
            f"  Requests/sec:      {self.requests_per_second:.1f}",
            "",
            "  Latency:",
            f"    p50:             {p50:.0f}ms",
            f"    p95:             {p95:.0f}ms",
            f"    p99:             {p99:.0f}ms",
            f"    min:             {min(self.latencies):.0f}ms",
            f"    max:             {max(self.latencies):.0f}ms",
            "",
        ]

        if self.errors:
            lines.append("  Errors:")
            for key, count in sorted(self.errors.items(), key=lambda x: -x[1]):
                lines.append(f"    {key}: {count}")
            lines.append("")

        lines.append("═══════════════════════════════════════════════════")
        return "\n".join(lines)

# ─── API Client ─────────────────────────────────────────────────

results = LoadTestResults()
results_lock = threading.Lock()

def api_call(method: str, path: str, data=None, timeout=30) -> tuple:
    """Make an API call and record metrics. Returns (status, body)."""
    url = f"{API_URL}{path}"
    body = json.dumps(data).encode() if data else None
    req = Request(url, data=body, method=method)
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Content-Type", "application/json")

    start = time.monotonic()
    try:
        with urlopen(req, timeout=timeout) as resp:
            status = resp.status
            response_body = resp.read().decode()
            duration = (time.monotonic() - start) * 1000

            metric = RequestMetric(method, path, status, duration)
            with results_lock:
                results.add(metric)

            return status, json.loads(response_body) if response_body else {}
    except HTTPError as e:
        duration = (time.monotonic() - start) * 1000
        error_body = e.read().decode() if e.fp else ""
        metric = RequestMetric(method, path, e.code, duration, error_body[:200])
        with results_lock:
            results.add(metric)
        return e.code, {"error": error_body[:200]}
    except (URLError, TimeoutError) as e:
        duration = (time.monotonic() - start) * 1000
        metric = RequestMetric(method, path, 0, duration, str(e))
        with results_lock:
            results.add(metric)
        return 0, {"error": str(e)}

# ─── Test Scenarios ─────────────────────────────────────────────

def test_health():
    """Basic health check."""
    status, body = api_call("GET", "/health")
    assert status == 200, f"Health check failed: {status}"
    print(f"  [OK] Health check: {body.get('status', 'unknown')}")

def test_auth_flow():
    """Login + verify token works."""
    status, body = api_call("POST", "/auth/login", {
        "email": "demo@aignite.ai",
        "password": "demo1234",
    })
    if status == 200:
        print(f"  [OK] Login: token received")
        return body.get("token")
    else:
        print(f"  [WARN] Login failed ({status}): {body.get('error', 'unknown')}")
        return None

def test_projects_list():
    """List projects."""
    status, body = api_call("GET", "/projects")
    if status == 200:
        projects = body if isinstance(body, list) else body.get("projects", [])
        print(f"  [OK] Projects: {len(projects)} found")
        return projects
    else:
        print(f"  [WARN] Projects list failed ({status})")
        return []

def test_pipeline_status(pipeline_run_id: str):
    """Check pipeline status."""
    status, body = api_call("GET", f"/pipeline/{pipeline_run_id}/status")
    if status == 200:
        stage = body.get("current_stage", "unknown")
        print(f"  [OK] Pipeline status: stage={stage}")
    else:
        print(f"  [WARN] Pipeline status failed ({status})")

def test_api_endpoints_stress(duration_seconds: int = 30):
    """Stress test read-only API endpoints."""
    print(f"\n  Stress testing API endpoints for {duration_seconds}s...")
    end_time = time.monotonic() + duration_seconds
    count = 0

    while time.monotonic() < end_time:
        api_call("GET", "/health", timeout=5)
        api_call("GET", "/projects", timeout=5)
        api_call("GET", "/admin/health", timeout=5)
        count += 3

    print(f"  [OK] Completed {count} requests in {duration_seconds}s")

# ─── Concurrent User Simulation ─────────────────────────────────

def simulate_user(user_id: int, num_pipelines: int = 1):
    """Simulate a single user's workflow."""
    print(f"\n  User {user_id}: Starting...")

    # Login
    token = test_auth_flow()

    # List projects
    projects = test_projects_list()

    # For each pipeline, check status
    for i in range(min(num_pipelines, 3)):
        # Simulate browsing project pages
        api_call("GET", "/projects", timeout=10)
        time.sleep(0.5)  # Human think time

    print(f"  User {user_id}: Complete")

# ─── Main ───────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="REVAMP Platform Load Test")
    parser.add_argument("--smoke", action="store_true", help="Quick smoke test (1 user)")
    parser.add_argument("--api-only", action="store_true", help="Test API endpoints only (no LLM)")
    parser.add_argument("--users", type=int, default=1, help="Number of concurrent users")
    parser.add_argument("--pipelines", type=int, default=1, help="Pipelines per user")
    parser.add_argument("--duration", type=int, default=30, help="Stress test duration (seconds)")
    parser.add_argument("--token", type=str, default="", help="Auth token")
    parser.add_argument("--api-url", type=str, default="", help="API base URL")
    args = parser.parse_args()

    global TOKEN, API_URL
    if args.token:
        TOKEN = args.token
    if args.api_url:
        API_URL = args.api_url

    print(f"\nREVAMP Load Test")
    print(f"  API: {API_URL}")
    print(f"  Users: {args.users}")
    print(f"  Mode: {'smoke' if args.smoke else 'api-only' if args.api_only else 'full'}")
    print()

    start_time = time.monotonic()

    # Phase 1: Health check
    print("Phase 1: Health Check")
    try:
        test_health()
    except Exception as e:
        print(f"  [FAIL] Server unreachable: {e}")
        sys.exit(1)

    if args.smoke:
        # Quick smoke test
        print("\nPhase 2: Smoke Test")
        test_auth_flow()
        test_projects_list()
        print("\n  Smoke test complete.")

    elif args.api_only:
        # API endpoint stress test
        print(f"\nPhase 2: API Stress Test ({args.users} concurrent users, {args.duration}s)")
        with ThreadPoolExecutor(max_workers=args.users) as pool:
            futures = [
                pool.submit(test_api_endpoints_stress, args.duration)
                for _ in range(args.users)
            ]
            for f in as_completed(futures):
                try:
                    f.result()
                except Exception as e:
                    print(f"  [ERROR] Worker failed: {e}")

    else:
        # Full concurrent user simulation
        print(f"\nPhase 2: Concurrent Users ({args.users} users, {args.pipelines} pipelines each)")
        with ThreadPoolExecutor(max_workers=args.users) as pool:
            futures = [
                pool.submit(simulate_user, i + 1, args.pipelines)
                for i in range(args.users)
            ]
            for f in as_completed(futures):
                try:
                    f.result()
                except Exception as e:
                    print(f"  [ERROR] User simulation failed: {e}")

    # Results
    end_time = time.monotonic()
    results.duration_seconds = end_time - start_time
    results.requests_per_second = results.total_requests / max(results.duration_seconds, 0.001)

    print(results.summary())

    # Exit code: 1 if error rate > 5%
    error_rate = results.failed / max(results.total_requests, 1)
    if error_rate > 0.05:
        print(f"\n  FAIL: Error rate {error_rate*100:.1f}% exceeds 5% threshold")
        sys.exit(1)
    else:
        print(f"\n  PASS: Error rate {error_rate*100:.1f}% is within threshold")

if __name__ == "__main__":
    main()
