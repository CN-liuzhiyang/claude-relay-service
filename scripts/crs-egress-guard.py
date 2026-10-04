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
import os
import pathlib
import signal
import socket
import subprocess
import time


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
    """Safe diagnostic fields only; never retain a URL, response, expected IP or stderr."""

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


def probe(proxy, urls, expected):
    if not urls:
        raise VerificationFailure("probe_configuration_invalid")
    for index, url in enumerate(urls):
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
                    "\n%{http_code}",
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
        body, _, status = result.stdout.rpartition("\n")
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
            raise VerificationFailure(reason, index, result.returncode, http_status)
        if http_status != 200:
            raise VerificationFailure("probe_http_error", index, 0, http_status)
        try:
            observed = str(ipaddress.ip_address(body.strip()))
        except ValueError:
            raise VerificationFailure("probe_invalid_ip_response", index, 0, http_status) from None
        if observed != expected:
            raise VerificationFailure("egress_ip_mismatch", index, 0, http_status)


def verify(settings, expected):
    retries = settings.get("transientRetries", DEFAULT_TRANSIENT_RETRIES)
    for attempt in range(1, retries + 2):
        try:
            probe(settings["proxyUrl"], settings["probeUrls"], expected)
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
        if not isinstance(settings["probeUrls"], list) or len(settings["probeUrls"]) < 2:
            raise ValueError("Two HTTPS probes are required")
        if not all(
            isinstance(url, str) and url.startswith("https://") for url in settings["probeUrls"]
        ):
            raise ValueError("HTTPS probes are required")
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
        # Fixed categories and integers only. Raw child/probe exception details stay private.
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
