#!/usr/bin/env python3
"""Cron-owned Magnus fleet checks.

This runner intentionally uses the public Magnus Control API instead of
importing application internals. It writes one JSON object per run to
MAGNUS_FLEET_CHECK_LOG_DIR so Hermes Agent can inspect recent checks through
the Magnus API.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_LOG_DIR = "/var/log/magnus/fleet-checks"
MAX_RESPONSE_BYTES = 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def validate_base_url(value: str) -> str:
    if value != value.strip():
        raise ValueError("CONTROL_API_URL must not contain surrounding whitespace")
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("CONTROL_API_URL must be an exact https DNS origin without userinfo")
    hostname = parsed.hostname.rstrip(".").lower()
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise ValueError("CONTROL_API_URL must use a DNS hostname, not an IP literal")
    if (
        hostname == "localhost"
        or hostname.endswith(".localhost")
        or hostname.endswith(".local")
        or "." not in hostname
        or len(hostname) > 253
        or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in hostname.split(".")
        )
    ):
        raise ValueError("CONTROL_API_URL must use a non-local DNS hostname")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("CONTROL_API_URL contains an invalid port") from error
    if port is not None and port < 1:
        raise ValueError("CONTROL_API_URL contains an invalid port")
    netloc = hostname if port is None else f"{hostname}:{port}"
    return urllib.parse.urlunsplit(("https", netloc, "", "", ""))


def read_bounded(response: Any, maximum: int = MAX_RESPONSE_BYTES) -> bytes:
    headers = getattr(response, "headers", None)
    declared = headers.get("Content-Length") if headers is not None else None
    if declared is not None:
        try:
            declared_bytes = int(declared)
        except (TypeError, ValueError) as error:
            raise ValueError("Magnus response has an invalid Content-Length") from error
        if declared_bytes < 0 or declared_bytes > maximum:
            raise ValueError(f"Magnus response exceeds {maximum} bytes")
    chunks: list[bytes] = []
    received = 0
    while True:
        chunk = response.read(min(64 * 1024, maximum - received + 1))
        if not chunk:
            break
        chunks.append(chunk)
        received += len(chunk)
        if received > maximum:
            raise ValueError(f"Magnus response exceeds {maximum} bytes")
    return b"".join(chunks)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


class MagnusApi:
    def __init__(self, base_url: str, token: str, ca_path: str | None = None) -> None:
        self.base_url = validate_base_url(base_url)
        self.token = token
        self.context = ssl.create_default_context(cafile=ca_path or None)
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=self.context),
            NoRedirect(),
        )

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})
        url = f"{self.base_url}/api/v1/{path.lstrip('/')}"
        if query:
            url = f"{url}?{query}"
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}"})
        with self.opener.open(request, timeout=30) as response:
            payload = json.loads(read_bounded(response).decode("utf-8"))
        if not payload.get("success", False):
            raise RuntimeError(f"Magnus API returned unsuccessful response for {path}")
        return payload


def check_fleet_status(api: MagnusApi) -> dict[str, Any]:
    stats = api.get("stats/overview").get("data", {})
    nodes_resp = api.get("nodes", {"pageSize": 100}).get("data", [])

    nodes = stats.get("nodes", {})
    offline = int(nodes.get("offline", 0) or 0)
    degraded = int(nodes.get("degraded", 0) or 0)
    total = int(nodes.get("total", len(nodes_resp)) or 0)
    online = int(nodes.get("online", 0) or 0)

    stale_nodes = []
    now = utc_now()
    for node in nodes_resp:
        heartbeat = node.get("lastHeartbeatAt")
        minutes_since = None
        if heartbeat:
            try:
                parsed = datetime.fromisoformat(str(heartbeat).replace("Z", "+00:00"))
                minutes_since = int((now - parsed).total_seconds() // 60)
            except ValueError:
                minutes_since = None
        if node.get("status") != "ONLINE" or (minutes_since is not None and minutes_since >= 5):
            stale_nodes.append({
                "id": node.get("id"),
                "name": node.get("name"),
                "status": node.get("status"),
                "lastHeartbeatAt": heartbeat,
                "minutesSinceHeartbeat": minutes_since,
            })

    status = "critical" if offline > 0 else "warning" if degraded > 0 or stale_nodes else "ok"
    summary = f"Fleet status: {online}/{total} online, {degraded} degraded, {offline} offline."
    if stale_nodes:
        summary += f" {len(stale_nodes)} node(s) need attention."

    return {
        "kind": "fleet-status",
        "status": status,
        "summary": summary,
        "counts": {
            "total": total,
            "online": online,
            "degraded": degraded,
            "offline": offline,
            "attention": len(stale_nodes),
        },
        "data": {
            "stats": stats,
            "attentionNodes": stale_nodes[:25],
        },
    }


def check_anomalies(api: MagnusApi) -> dict[str, Any]:
    summary = api.get("anomalies/summary").get("data", {})
    active = int(summary.get("totalActive", 0) or 0)
    by_severity = summary.get("bySeverity", {}) or {}
    critical = int(by_severity.get("critical", 0) or 0)
    warning = int(by_severity.get("warning", 0) or 0)
    recent = api.get("anomalies", {"resolved": "false", "pageSize": 25}).get("data", {})

    status = "critical" if critical > 0 else "warning" if warning > 0 or active > 0 else "ok"
    summary_text = f"Anomaly scan: {active} active, {critical} critical, {warning} warning."

    return {
        "kind": "anomaly-scan",
        "status": status,
        "summary": summary_text,
        "counts": {
            "active": active,
            "critical": critical,
            "warning": warning,
        },
        "data": {
            "summary": summary,
            "recent": recent.get("anomalies", [])[:25],
        },
    }


def write_log(log_dir: Path, event: dict[str, Any]) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    day = utc_now().strftime("%Y-%m-%d")
    target = log_dir / f"{day}.jsonl"
    with target.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Magnus fleet checks and append JSONL logs.")
    parser.add_argument("--kind", choices=["all", "fleet-status", "anomaly-scan"], default="all")
    parser.add_argument("--env-file", default=os.environ.get("MAGNUS_ENV_FILE", "/opt/magnus-api/.env"))
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--log-dir", default=None)
    args = parser.parse_args()

    env_file = load_env_file(Path(args.env_file))
    env = {**env_file, **os.environ}
    base_url = args.base_url or env.get("CONTROL_API_URL") or "https://localhost:4000"
    fleet_token = env.get("MAGNUS_FLEET_CHECK_TOKEN") or ""
    log_dir = Path(args.log_dir or env.get("MAGNUS_FLEET_CHECK_LOG_DIR") or DEFAULT_LOG_DIR)
    ca_path = env.get("MAGNUS_FLEET_CHECK_CA_PATH") or None

    started = utc_now()
    event: dict[str, Any] = {
        "runId": str(uuid.uuid4()),
        "kind": args.kind,
        "status": "error",
        "startedAt": iso(started),
        "completedAt": iso(started),
        "durationMs": 0,
        "summary": "Fleet check did not complete.",
        "counts": {},
        "data": {},
        "errors": [],
    }

    if len(fleet_token) < 32:
        event["errors"].append("MAGNUS_FLEET_CHECK_TOKEN is required")
    else:
        api = MagnusApi(base_url, fleet_token, ca_path)
        checks = []
        try:
            if args.kind in {"all", "fleet-status"}:
                checks.append(check_fleet_status(api))
            if args.kind in {"all", "anomaly-scan"}:
                checks.append(check_anomalies(api))

            severity_order = {"ok": 0, "warning": 1, "critical": 2, "error": 3}
            worst = max((check["status"] for check in checks), key=lambda s: severity_order.get(str(s), 3), default="ok")
            event.update({
                "status": worst,
                "summary": " ".join(str(check["summary"]) for check in checks),
                "counts": {check["kind"]: check.get("counts", {}) for check in checks},
                "data": {check["kind"]: check.get("data", {}) for check in checks},
            })
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError) as exc:
            event["errors"].append(str(exc))

    completed = utc_now()
    event["completedAt"] = iso(completed)
    event["durationMs"] = int((time.monotonic() - time.monotonic()) * 1000)
    event["durationMs"] = int((completed - started).total_seconds() * 1000)

    try:
        write_log(log_dir, event)
    except OSError as exc:
        print(f"failed to write fleet check log: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(event, indent=2, sort_keys=True))
    return 1 if event["status"] == "error" else 0


if __name__ == "__main__":
    raise SystemExit(main())
