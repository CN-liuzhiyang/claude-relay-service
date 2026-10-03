#!/usr/bin/env python3
"""Supervise one pinned Mihomo node. A failed/mismatched IP probe closes all connections.

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


def probe(proxy, urls, expected):
    for url in urls:
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
                url,
            ],
            capture_output=True,
            text=True,
            timeout=10,
            env={"PATH": "/usr/bin:/bin"},
        )
        if result.returncode or str(ipaddress.ip_address(result.stdout.strip())) != expected:
            raise RuntimeError("Egress verification failed (response omitted)")


def notify(message):
    endpoint = os.getenv("NOTIFY_SOCKET")
    if endpoint:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
            channel.connect("\0" + endpoint[1:] if endpoint.startswith("@") else endpoint)
            channel.sendall(message.encode())


def supervise(args):
    settings = json.loads(pathlib.Path(args.settings).read_text())
    expected = str(ipaddress.ip_address(settings["expectedIp"]))
    status = pathlib.Path(settings["statusFile"])
    child = subprocess.Popen(
        settings["command"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
    )

    def stop(_signal, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        # Child can listen during validation; production CRS starts only after READY.
        for _attempt in range(30):
            if child.poll() is not None:
                raise RuntimeError("Dedicated proxy exited during startup")
            with socket.socket() as connection:
                connection.settimeout(0.2)
                if connection.connect_ex(("127.0.0.1", settings["port"])) == 0:
                    break
            time.sleep(0.2)
        probe(settings["proxyUrl"], settings["probeUrls"], expected)
        notify("READY=1\nSTATUS=Expected egress verified")
        while child.poll() is None:
            status.write_text(json.dumps({"healthy": True, "checkedAt": time.time()}))
            time.sleep(settings.get("intervalSeconds", 20))
            probe(settings["proxyUrl"], settings["probeUrls"], expected)
        raise RuntimeError("Dedicated proxy exited")
    except (Exception, SystemExit) as error:
        # Fixed messages only: child config, probe output and URL errors never reach logs.
        print("CRS egress guard closed the proxy; verify node/IP before manual restart", flush=True)
        if isinstance(error, SystemExit):
            return
        raise SystemExit(1) from None
    finally:
        try:
            status.write_text(json.dumps({"healthy": False, "checkedAt": time.time()}))
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
