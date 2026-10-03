#!/usr/bin/env python3
"""Install the CRS-only node, DoH and UID firewall without touching shared services.

Root-only deployment helper. Credentials are read locally from the existing subscription,
written only to a private config, and never included in output or versioned artifacts.
"""

import argparse
import copy
import ipaddress
import json
import os
import pathlib
import pwd
import re
import shutil
import socket
import subprocess
import urllib.parse

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
CONFIG = pathlib.Path("/etc/crs-security")
STATE = pathlib.Path("/var/lib/crs-egress")


def management_origin(value):
    """Require a credential-free HTTPS origin without echoing rejected input."""
    message = (
        "Use an HTTPS origin with a valid host/port and no credentials, path, query or fragment"
    )
    try:
        if not value or any(character.isspace() or ord(character) < 32 for character in value):
            raise ValueError
        parsed = urllib.parse.urlsplit(value)
        host = parsed.hostname
        port = parsed.port
        if (
            parsed.scheme != "https"
            or not host
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or "?" in value
            or "#" in value
            or parsed.netloc.endswith(":")
            or (port is not None and not 1 <= port <= 65535)
        ):
            raise ValueError
        try:
            address = ipaddress.ip_address(host)
            if "%" in host:
                raise ValueError
            host = f"[{address}]" if address.version == 6 else str(address)
        except ValueError:
            host = host.encode("idna").decode("ascii").lower()
            labels = (host[:-1] if host.endswith(".") else host).split(".")
            if (
                len(host) > 253
                or labels[-1].isdigit()
                or any(
                    not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                    for label in labels
                )
            ):
                raise ValueError
        return f"https://{host}" + (f":{port}" if port is not None and port != 443 else "")
    except (ValueError, UnicodeError):
        raise argparse.ArgumentTypeError(message) from None


def private_path(value):
    """Accept simple absolute paths suitable for a systemd InaccessiblePaths entry."""
    path = pathlib.Path(value)
    if not path.is_absolute() or any(
        character.isspace() or ord(character) < 32 or character in "%\"'\\" for character in value
    ):
        raise argparse.ArgumentTypeError(
            "Use an absolute private path without whitespace or escapes"
        )
    return path


def run(*command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("Deployment command failed; output withheld: " + command[0])
    return result.stdout.strip()


def private_write(path, content, uid=0, gid=0, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    os.chmod(path, mode)
    os.chown(path, uid, gid)


def install(args):
    origin = management_origin(args.management_origin)
    protected_paths = [private_path(str(path)) for path in args.private_path]
    if os.geteuid():
        raise RuntimeError("Run as root")
    owner_home = pathlib.Path(pwd.getpwuid(ROOT.stat().st_uid).pw_dir)
    protected_paths.extend(
        owner_home / name for name in [".claude", ".codex", ".agents", ".server-docs"]
    )
    protected_paths.extend(
        [
            pathlib.Path("/run/dbus/system_bus_socket"),
            pathlib.Path("/run/systemd/resolve/io.systemd.Resolve"),
        ]
    )
    inaccessible_paths = " ".join("-" + str(private_path(str(path))) for path in protected_paths)
    expected = str(ipaddress.IPv4Address(args.expected_ip))
    for name in ["crs", "crs-proxy"]:
        try:
            pwd.getpwnam(name)
        except KeyError:
            run("useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", name)
    app = pwd.getpwnam("crs")
    proxy_user = pwd.getpwnam("crs-proxy")
    CONFIG.mkdir(mode=0o700, exist_ok=True)
    STATE.mkdir(mode=0o700, exist_ok=True)
    os.chown(STATE, proxy_user.pw_uid, proxy_user.pw_gid)
    source = yaml.safe_load(pathlib.Path("/etc/mihomo/config.yaml").read_text())
    node = copy.deepcopy(next(p for p in source["proxies"] if p["name"] == args.node))
    original_server = node["server"]
    # Only node ingress is resolved on the host at install time, then pinned numerically.
    ingress = socket.getaddrinfo(original_server, node["port"], socket.AF_INET, socket.SOCK_STREAM)[
        0
    ][4][0]
    node.update(name="CRS_FIXED", server=ingress, udp=False)
    if node["type"] != "ss":
        raise RuntimeError("This installer supports the current Shadowsocks subscription only")
    configuration = {
        "mixed-port": 17894,
        "bind-address": "127.0.0.1",
        "allow-lan": False,
        "mode": "rule",
        "log-level": "silent",
        "ipv6": False,
        "profile": {"store-selected": False, "store-fake-ip": False},
        "dns": {
            "enable": True,
            "listen": "127.0.0.1:17896",
            "ipv6": False,
            "enhanced-mode": "redir-host",
            "use-hosts": False,
            "use-system-hosts": False,
            "default-nameserver": ["https://8.8.8.8/dns-query#CRS_FIXED"],
            "nameserver": ["https://8.8.8.8/dns-query#CRS_FIXED"],
            "proxy-server-nameserver": ["https://8.8.8.8/dns-query#CRS_FIXED"],
        },
        "proxies": [node],
        "rules": ["MATCH,CRS_FIXED"],
    }
    private_write(
        STATE / "config.yaml",
        yaml.safe_dump(configuration, allow_unicode=True),
        proxy_user.pw_uid,
        proxy_user.pw_gid,
    )
    run("/usr/local/bin/mihomo", "-t", "-d", str(STATE), "-f", str(STATE / "config.yaml"))
    settings = {
        "port": 17894,
        "proxyUrl": "http://127.0.0.1:17894",
        "expectedIp": expected,
        "nodeName": args.node,
        "ingressIp": ingress,
        "ingressPort": node["port"],
        "ingressDomain": original_server,
        "intervalSeconds": 20,
        "probeUrls": ["https://api.ipify.org", "https://checkip.amazonaws.com"],
        "statusFile": str(STATE / "status.json"),
        "command": ["/usr/local/bin/mihomo", "-d", str(STATE), "-f", str(STATE / "config.yaml")],
    }
    private_write(
        STATE / "guard.json", json.dumps(settings, indent=2), proxy_user.pw_uid, proxy_user.pw_gid
    )
    rules = f"""destroy table inet crs_security
table inet crs_security {{
  chain output {{
    type filter hook output priority -20; policy accept;
    meta skuid {app.pw_uid} ct direction reply counter accept
    meta skuid {app.pw_uid} ip daddr 127.0.0.1 tcp dport {{ 6379, 17894 }} counter accept
    meta skuid {app.pw_uid} counter reject with icmpx type admin-prohibited
    meta skuid {proxy_user.pw_uid} ip daddr {ingress} tcp dport {node['port']} counter accept
    meta skuid {proxy_user.pw_uid} ip daddr 127.0.0.1 tcp dport 17894 counter accept
    meta skuid {proxy_user.pw_uid} ip daddr 127.0.0.1 ct direction reply counter accept
    meta skuid {proxy_user.pw_uid} counter reject with icmpx type admin-prohibited
  }}
}}
"""
    private_write(CONFIG / "egress.nft", rules)
    run("nft", "-c", "-f", str(CONFIG / "egress.nft"))
    private_write(
        pathlib.Path("/etc/systemd/system/crs-egress-network.service"),
        """[Unit]
Description=CRS-only UID egress firewall
Before=crs-egress.service claude-relay.service
After=network.target ufw.service

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/crs-security/egress.nft
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
""",
        mode=0o644,
    )
    shutil.copyfile(ROOT / "scripts/crs-egress-guard.py", "/usr/local/libexec/crs-egress-guard.py")
    os.chmod("/usr/local/libexec/crs-egress-guard.py", 0o755)
    private_write(
        pathlib.Path("/etc/systemd/system/crs-egress.service"),
        """[Unit]
Description=CRS fixed-node proxy with fail-closed egress IP verification
Requires=crs-egress-network.service
After=crs-egress-network.service

[Service]
Type=notify
NotifyAccess=main
User=crs-proxy
Group=crs-proxy
ExecStart=/usr/bin/python3 /usr/local/libexec/crs-egress-guard.py --settings /var/lib/crs-egress/guard.json
Restart=no
TimeoutStartSec=40
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
PrivateTmp=yes
PrivateDevices=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/crs-egress
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictAddressFamilies=AF_INET AF_UNIX
MemoryMax=128M
TasksMax=32

[Install]
WantedBy=multi-user.target
""",
        mode=0o644,
    )
    # Application sandbox: keep the checkout owned by root, grant read/traverse only.
    for parent in ROOT.parents:
        if parent != pathlib.Path("/"):
            run("setfacl", "-m", "u:crs:--x", str(parent))
    for directory, children, files in os.walk(ROOT):
        children[:] = [name for name in children if name not in [".git", "logs", "data"]]
        run("setfacl", "-m", "u:crs:rX", directory)
        for name in files:
            if name != ".env":
                run("setfacl", "-m", "u:crs:r", str(pathlib.Path(directory) / name))
    os.chmod(ROOT / ".env", 0o600)
    for directory in [ROOT / "data", ROOT / "logs"]:
        for path in [directory, *directory.rglob("*")]:
            if not path.is_symlink():
                os.chown(path, app.pw_uid, app.pw_gid)
                os.chmod(path, 0o700 if path.is_dir() else 0o600)
    private_write(
        CONFIG / "application.env",
        """CRS_PROXY_REQUIRED=true
CRS_PROXY_ALLOWED_ENDPOINTS=socks5://127.0.0.1:17894,http://127.0.0.1:17894
CRS_MAINTENANCE_PROXY='{"type":"socks5","host":"127.0.0.1","port":17894}'
REDIS_HOST=127.0.0.1
HTTP_PROXY=http://127.0.0.1:17894
HTTPS_PROXY=http://127.0.0.1:17894
ALL_PROXY=socks5h://127.0.0.1:17894
NO_PROXY=127.0.0.1,localhost
CRS_ADMIN_HTTPS_ONLY=true
CRS_PUBLIC_HTTPS_URL=""" + origin + "\n",
    )
    private_write(
        pathlib.Path("/etc/systemd/system/claude-relay.service.d/security.conf"),
        f"""[Unit]
Requires=crs-egress-network.service
BindsTo=crs-egress.service
After=crs-egress-network.service crs-egress.service

[Service]
User=crs
Group=crs
EnvironmentFile=/etc/crs-security/application.env
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ReadWritePaths={ROOT}/logs {ROOT}/data
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=yes
InaccessiblePaths={inaccessible_paths}
""",
        mode=0o644,
    )
    run("systemctl", "daemon-reload")
    run("systemctl", "enable", "crs-egress-network.service", "crs-egress.service")
    run("systemctl", "start", "crs-egress-network.service")
    print("CRS-specific firewall and service configs installed; shared configs untouched")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", required=True)
    parser.add_argument("--expected-ip", required=True)
    parser.add_argument("--management-origin", type=management_origin, required=True)
    parser.add_argument("--private-path", type=private_path, action="append", default=[])
    install(parser.parse_args())
