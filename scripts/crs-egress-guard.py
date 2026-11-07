#!/usr/bin/env python3
"""Supervise one pinned Mihomo node. A mismatched or unverifiable egress closes all connections.

Probe failures that only mean "could not measure" (timeout, TLS, transport, probe HTTP error)
are retried a few times before closing; an IP mismatch or malformed response closes at once.
No automatic node changes, expected-IP updates or retry into DIRECT. Restart is manual.
Periodic checks cannot eliminate the drift window between probes; see the operations SOP.
"""

import argparse
import ipaddress
import json
import math
import os
import pathlib
import signal
import socket
import subprocess
import time
from urllib.parse import urlsplit


DEFAULT_INTERVAL_SECONDS = 60
DEFAULT_TRANSIENT_RETRIES = 2
DEFAULT_RETRY_DELAY_SECONDS = 5
# The single node has no fallback route, so a probe that could not complete cannot leak traffic
# elsewhere; only a measured mismatch proves the egress changed.
TRANSIENT_REASONS = {
    "probe_timeout",
    "probe_tls_error",
    "probe_transport_error",
    "probe_http_error",
    "probe_process_timeout",
}


class VerificationFailure(RuntimeError):
    """Safe numeric diagnostics only; never retain a URL, response, IP or stderr."""

    def __init__(self, reason, probe_index=None, curl_exit=None, http_status=None):
        super().__init__("CRS egress verification rejected")
        self.details = {"reason": reason}
        for key, value in [
            ("probeIndex", probe_index),
            ("curlExit", curl_exit),
            ("httpStatus", http_status),
        ]:
            if value is not None:
                self.details[key] = value


def probe_one(proxy, url, expected, index):
    try:
        result = subprocess.run(
            [
                "/usr/bin/curl",
                "--silent",
                "--fail",
                "--max-time",
                "8",
                "--noproxy",
                "",
                "--proxy",
                proxy,
                "--write-out",
                "\n%{http_code} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}",
                url,
            ],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=10,
            env={"PATH": "/usr/bin:/bin"},
        )
    except subprocess.TimeoutExpired:
        raise VerificationFailure("probe_process_timeout", index) from None
    except OSError:
        raise VerificationFailure("probe_process_unavailable", index) from None
    body, _, metadata = result.stdout.rpartition("\n")
    fields = metadata.split()
    status = fields[0] if fields else ""
    timings = {}
    if len(fields) == 5:
        try:
            values = [float(value) for value in fields[1:]]
            if all(math.isfinite(value) and 0 <= value <= 60 for value in values):
                timings = dict(
                    zip(
                        ["connectMs", "tlsMs", "firstByteMs", "totalMs"],
                        [round(value * 1000) for value in values],
                    )
                )
        except ValueError:
            pass

    def reject(reason, curl_exit):
        failure = VerificationFailure(reason, index, curl_exit, http_status)
        failure.details.update(timings)
        raise failure

    http_status = int(status) if status.isascii() and status.isdigit() else None
    if http_status is not None and not 100 <= http_status <= 599:
        http_status = None
    if result.returncode:
        if result.returncode == 28:
            reason = "probe_timeout"
        elif result.returncode in [35, 51, 58, 59, 60, 64, 66, 77, 80, 82, 83, 90, 91]:
            reason = "probe_tls_error"
        elif result.returncode == 22:
            reason = "probe_http_error"
        else:
            reason = "probe_transport_error"
        reject(reason, result.returncode)
    if http_status != 200:
        reject("probe_http_error", 0)
    try:
        observed = str(ipaddress.ip_address(body.strip()))
    except ValueError:
        reject("probe_invalid_ip_response", 0)
    if observed != expected:
        reject("egress_ip_mismatch", 0)
    return {"probeIndex": index, "curlExit": 0, "httpStatus": 200, **timings}


def validate_probe_urls(urls, fallback_urls):
    if not isinstance(urls, list) or len(urls) < 2:
        raise ValueError("Two HTTPS probes are required")
    if not isinstance(fallback_urls, list) or len(fallback_urls) > 1:
        raise ValueError("At most one fallback probe is allowed")
    if fallback_urls and len(urls) != 2:
        raise ValueError("Fallback requires two primary probes")
    hosts = set()
    for url in urls + fallback_urls:
        if not isinstance(url, str):
            raise ValueError("Invalid probe URL")
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or parsed.port not in (None, 443)
            or parsed.hostname.lower() in hosts
        ):
            raise ValueError("Distinct HTTPS probe hosts are required")
        hosts.add(parsed.hostname.lower())


def probe(proxy, urls, expected, fallback_urls=None):
    # Existing two-probe profiles retain their original all-probes-required behavior.
    fallback_urls = fallback_urls or []
    if not urls:
        raise VerificationFailure("probe_configuration_invalid")
    verified = []
    failures = []
    for index, url in enumerate(urls):
        try:
            probe_one(proxy, url, expected, index)
            verified.append(index)
        except VerificationFailure as failure:
            if failure.details["reason"] not in TRANSIENT_REASONS:
                raise
            print(json.dumps({"event": "crs_egress_probe_failed", **failure.details}), flush=True)
            if not fallback_urls:
                raise
            failures.append(failure)
    if not failures:
        return
    # Never carry successful observations between retry attempts.
    for index, url in enumerate(fallback_urls, start=len(urls)):
        try:
            probe_one(proxy, url, expected, index)
            verified.append(index)
        except VerificationFailure as failure:
            if failure.details["reason"] not in TRANSIENT_REASONS:
                raise
            print(json.dumps({"event": "crs_egress_probe_failed", **failure.details}), flush=True)
            failures.append(failure)
    if len(verified) < 2:
        raise failures[-1]
    print(
        json.dumps({
            "event": "crs_egress_fallback_verified",
            "verifiedProbeIndices": verified,
            "failedProbeIndices": [f.details["probeIndex"] for f in failures],
        }),
        flush=True,
    )


def verify(settings, expected):
    retries = settings.get("transientRetries", DEFAULT_TRANSIENT_RETRIES)
    for attempt in range(1, retries + 2):
        try:
            probe(
                settings["proxyUrl"], settings["probeUrls"], expected,
                settings.get("fallbackProbeUrls"),
            )
            return
        except VerificationFailure as failure:
            failure.details["attempts"] = attempt
            if failure.details["reason"] not in TRANSIENT_REASONS or attempt > retries:
                raise
            print(json.dumps({"event": "crs_egress_probe_retry", **failure.details}), flush=True)
            time.sleep(settings.get("retryDelaySeconds", DEFAULT_RETRY_DELAY_SECONDS))


def notify(message):
    endpoint = os.getenv("NOTIFY_SOCKET")
    if endpoint:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
            channel.connect("\0" + endpoint[1:] if endpoint.startswith("@") else endpoint)
            channel.sendall(message.encode())


def supervise(args):
    try:
        settings = json.loads(pathlib.Path(args.settings).read_text())
        expected = str(ipaddress.ip_address(settings["expectedIp"]))
        status = pathlib.Path(settings["statusFile"])
        validate_probe_urls(settings["probeUrls"], settings.get("fallbackProbeUrls", []))
        for key, low, high in [
            ("intervalSeconds", 0, 600),
            ("transientRetries", 0, 5),
            ("retryDelaySeconds", 0, 30),
        ]:
            value = settings.get(key, low)
            if type(value) is not int or not low <= value <= high:
                raise ValueError("Guard timing out of range")
    except (OSError, ValueError, KeyError, TypeError):
        print(
            json.dumps({"event": "crs_egress_closed", "reason": "guard_configuration_invalid"}),
            flush=True,
        )
        raise SystemExit(1) from None
    try:
        child = subprocess.Popen(
            settings["command"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
        )
    except (OSError, ValueError, KeyError, TypeError):
        failure = {"reason": "proxy_start_failed"}
        print(json.dumps({"event": "crs_egress_closed", **failure}), flush=True)
        try:
            status.write_text(json.dumps({"healthy": False, "checkedAt": time.time(), **failure}))
        except OSError:
            pass
        raise SystemExit(1) from None

    def stop(_signal, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    failure = {"reason": "controlled_stop"}
    try:
        # Child can listen during validation; production CRS starts only after READY.
        for _attempt in range(30):
            if child.poll() is not None:
                failure = {"reason": "proxy_process_exit", "childExitCode": child.returncode}
                raise RuntimeError("Dedicated proxy exited during startup")
            with socket.socket() as connection:
                connection.settimeout(0.2)
                if connection.connect_ex(("127.0.0.1", settings["port"])) == 0:
                    break
            time.sleep(0.2)
        else:
            failure = {"reason": "proxy_startup_timeout"}
            raise RuntimeError("Dedicated proxy did not listen during startup")
        verify(settings, expected)
        status.write_text(json.dumps({"healthy": True, "checkedAt": time.time()}))
        notify("READY=1\nSTATUS=Expected egress verified")
        while child.poll() is None:
            time.sleep(settings.get("intervalSeconds", DEFAULT_INTERVAL_SECONDS))
            verify(settings, expected)
            status.write_text(json.dumps({"healthy": True, "checkedAt": time.time()}))
        failure = {"reason": "proxy_process_exit", "childExitCode": child.returncode}
        raise RuntimeError("Dedicated proxy exited")
    except (Exception, SystemExit) as error:
        if isinstance(error, VerificationFailure):
            failure = error.details
        elif isinstance(error, OSError):
            failure = {"reason": "state_io_error", "errno": error.errno}
        elif not isinstance(error, SystemExit) and failure["reason"] == "controlled_stop":
            failure = {"reason": "guard_internal_error"}
        # Fixed categories and numeric fields only. Raw child/probe exception details stay private.
        print(json.dumps({"event": "crs_egress_closed", **failure}), flush=True)
        if isinstance(error, SystemExit):
            return
        raise SystemExit(1) from None
    finally:
        try:
            status.write_text(json.dumps({"healthy": False, "checkedAt": time.time(), **failure}))
        except OSError:
            pass  # Disk/permission failures must never prevent closing the proxy.
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--settings", required=True)
    supervise(parser.parse_args())
