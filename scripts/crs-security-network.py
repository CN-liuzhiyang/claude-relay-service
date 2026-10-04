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


def proxy_configuration(node, port, dns_port):
    """One node, remote DoH and no fallback; ports are deployment parameters."""
    return {
        "mixed-port": port,
        "bind-address": "127.0.0.1",
        "allow-lan": False,
        "mode": "rule",
        "log-level": "silent",
        "ipv6": False,
        "profile": {"store-selected": False, "store-fake-ip": False},
        "dns": {
            "enable": True,
            "listen": f"127.0.0.1:{dns_port}",
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


def egress_rules(app_uid, profiles, direct_ports=()):
    """Restrict each proxy UID to its own numeric ingress; app may use registered ports.

    direct_ports are extra loopback ports the app may reach without a proxy, e.g. a local
    tunnel serving an account upstream. They are validated by direct_loopback_ports().
    """
    if int(app_uid) <= 0 or not profiles:
        raise ValueError("At least one dedicated egress is required")
    ports = []
    identifiers = set()
    rules = []
    for profile in profiles:
        uid = int(profile["uid"])
        port = int(profile["port"])
        ingress_port = int(profile["ingressPort"])
        ingress = str(ipaddress.IPv4Address(profile["ingressIp"]))
        if uid <= 0 or uid == int(app_uid) or uid in identifiers or port in ports:
            raise ValueError("Egress UIDs and ports must be distinct")
        if port == 6379 or not 1 <= port <= 65535 or not 1 <= ingress_port <= 65535:
            raise ValueError("Invalid egress port")
        identifiers.add(uid)
        ports.append(port)
        rules.extend(
            [
                f"    meta skuid {uid} ip daddr {ingress} tcp dport {ingress_port} counter accept",
                f"    meta skuid {uid} ip daddr 127.0.0.1 tcp dport {port} counter accept",
                f"    meta skuid {uid} ip daddr 127.0.0.1 ct direction reply counter accept",
                f"    meta skuid {uid} counter reject with icmpx type admin-prohibited",
            ]
        )
    direct = [int(port) for port in direct_ports]
    if any(port == 6379 or port in ports or not 1024 <= port <= 65535 for port in direct):
        raise ValueError("Direct loopback ports must not reuse Redis or egress ports")
    allowed_ports = ", ".join(str(port) for port in [6379, *ports, *dict.fromkeys(direct)])
    return (
        "destroy table inet crs_security\n"
        "table inet crs_security {\n"
        "  chain output {\n"
        "    type filter hook output priority -20; policy accept;\n"
        f"    meta skuid {int(app_uid)} ct direction reply counter accept\n"
        f"    meta skuid {int(app_uid)} ip daddr 127.0.0.1 tcp dport {{ {allowed_ports} }} counter accept\n"
        f"    meta skuid {int(app_uid)} counter reject with icmpx type admin-prohibited\n"
        + "\n".join(rules)
        + "\n  }\n}\n"
    )


PROXY_PROCESS_NAMES = {"mihomo", "clash", "clash-meta", "sing-box", "xray", "v2ray", "gost"}
SHARED_PORT_KEYS = ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"]
DIRECT_PORTS_KEY = "CRS_DIRECT_LOOPBACK_PORTS="


def direct_loopback_ports(value):
    """Parse a comma separated list of unprivileged ports; empty clears the list."""
    ports = []
    for item in (value or "").split(","):
        item = item.strip()
        if not item:
            continue
        if not re.fullmatch(r"\d{1,5}", item) or not 1024 <= int(item) <= 65535:
            raise ValueError("Direct loopback ports must be integers in 1024-65535")
        ports.append(int(item))
    return sorted(dict.fromkeys(ports))


def registered_profiles():
    """Primary egress plus every registered additional egress, as used by egress_rules()."""
    primary = json.loads((STATE / "guard.json").read_text())
    primary["uid"] = pwd.getpwnam("crs-proxy").pw_uid
    registry = CONFIG / "egress-profiles"
    return [primary, *[json.loads(path.read_text()) for path in sorted(registry.glob("*.json"))]]


def _port_of(address):
    try:
        return int(str(address).rsplit(":", 1)[-1])
    except ValueError:
        return None


def reserved_local_ports(profiles, shared_config):
    """Ports a direct upstream must never use: Redis, CRS egress/DNS and shared proxy ports.

    Only port fields are read from the YAML files; node credentials are never output.
    """
    reserved = {6379, *(int(profile["port"]) for profile in profiles)}
    for state in [STATE, *sorted(pathlib.Path("/var/lib").glob("crs-egress-*"))]:
        configuration = state / "config.yaml"
        if configuration.exists():
            dns = (yaml.safe_load(configuration.read_text()) or {}).get("dns") or {}
            reserved.add(_port_of(dns.get("listen", "")))
    shared_path = pathlib.Path(shared_config)
    if shared_path.exists():
        shared = yaml.safe_load(shared_path.read_text()) or {}
        reserved.update(shared.get(key) for key in SHARED_PORT_KEYS)
        reserved.add(_port_of(shared.get("external-controller", "")))
        reserved.update(item.get("port") for item in shared.get("listeners") or [])
    return {int(port) for port in reserved if isinstance(port, int) or str(port).isdigit()}


def proxy_listener_ports():
    """Loopback/any ports currently served by a known proxy binary (catches ad-hoc proxies)."""
    output = subprocess.run(["ss", "-ltnpH"], check=True, capture_output=True, text=True).stdout
    ports = set()
    for line in output.splitlines():
        fields = line.split()
        names = set(re.findall(r'\("([^"]+)"', line))
        if len(fields) >= 4 and names & PROXY_PROCESS_NAMES:
            port = _port_of(fields[3])
            if port:
                ports.add(port)
    return ports


def sync_direct_loopback(args):
    """Set the app's direct loopback port list and mirror it into the CRS-only firewall."""
    if os.geteuid():
        raise RuntimeError("Run as root")
    ports = direct_loopback_ports(args.direct_loopback_ports)
    profiles = registered_profiles()
    conflicts = set(ports) & (
        reserved_local_ports(profiles, args.subscription_config) | proxy_listener_ports()
    )
    if conflicts:
        raise ValueError("Direct loopback ports must not be proxy, DNS or Redis ports")
    environment = CONFIG / "application.env"
    lines = environment.read_text().splitlines()
    if "CRS_PROXY_REQUIRED=true" not in lines:
        raise RuntimeError("Direct loopback sync expects the required proxy policy")
    lines = [line for line in lines if not line.startswith(DIRECT_PORTS_KEY)]
    lines.append(DIRECT_PORTS_KEY + ",".join(str(port) for port in ports))
    rules = egress_rules(pwd.getpwnam("crs").pw_uid, profiles, ports)
    candidate = CONFIG / "egress.candidate.nft"
    private_write(candidate, rules)
    run("nft", "-c", "-f", str(candidate))
    candidate.replace(CONFIG / "egress.nft")
    run("nft", "-f", str(CONFIG / "egress.nft"))
    private_write(environment, "\n".join(lines) + "\n")
    print(
        f"Direct loopback ports synced ({len(ports)}); restart claude-relay to load the list"
    )


def install_additional(args):
    """Add a CRS profile from the shared subscription without editing existing proxy configs."""
    if os.geteuid():
        raise RuntimeError("Run as root")
    identifier = args.egress_id
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", identifier):
        raise ValueError("Use a lowercase egress identifier")
    if (
        not args.port
        or not args.dns_port
        or not 1024 <= args.port <= 65535
        or not 1024 <= args.dns_port <= 65535
        or args.port == args.dns_port
    ):
        raise ValueError("Specify distinct unprivileged proxy and DNS ports")
    expected = str(ipaddress.IPv4Address(args.expected_ip))
    service = f"crs-egress-{identifier}"
    user = f"crs-proxy-{identifier}"
    state = pathlib.Path(f"/var/lib/crs-egress-{identifier}")
    unit_path = pathlib.Path(f"/etc/systemd/system/{service}.service")
    registry = CONFIG / "egress-profiles"
    if unit_path.exists() or state.exists() or (registry / f"{identifier}.json").exists():
        raise RuntimeError("Egress profile already exists; use the private maintenance procedure")
    try:
        pwd.getpwnam(user)
    except KeyError:
        pass
    else:
        raise RuntimeError("Egress UID already exists; use the private maintenance procedure")
    environment = CONFIG / "application.env"
    lines = environment.read_text().splitlines()
    key = "CRS_PROXY_ALLOWED_ENDPOINTS="
    indexes = [index for index, line in enumerate(lines) if line.startswith(key)]
    if len(indexes) != 1 or not lines[indexes[0]][len(key) :]:
        raise RuntimeError("The existing required endpoint allowlist must be configured")
    index = indexes[0]
    primary, *existing = registered_profiles()
    configured = [line[len(DIRECT_PORTS_KEY) :] for line in lines if line.startswith(DIRECT_PORTS_KEY)]
    direct = direct_loopback_ports(",".join(configured))
    if args.port in [6379, *direct] or args.port in [p["port"] for p in [primary, *existing]]:
        raise ValueError("Proxy port conflicts with Redis or a registered egress")
    for port in [args.port, args.dns_port]:
        for kind in [socket.SOCK_STREAM, socket.SOCK_DGRAM]:
            with socket.socket(socket.AF_INET, kind) as channel:
                channel.bind(("127.0.0.1", port))
    source = yaml.safe_load(pathlib.Path(args.subscription_config).read_text())
    node = copy.deepcopy(next(p for p in source["proxies"] if p["name"] == args.node))
    if node["type"] != "ss":
        raise ValueError("This installer supports Shadowsocks nodes only")
    ingress = socket.getaddrinfo(node["server"], node["port"], socket.AF_INET, socket.SOCK_STREAM)[
        0
    ][4][0]
    node.update(name="CRS_FIXED", server=ingress, udp=False)
    run("useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", user)
    proxy_user = pwd.getpwnam(user)
    app = pwd.getpwnam("crs")
    state.mkdir(mode=0o700)
    os.chown(state, proxy_user.pw_uid, proxy_user.pw_gid)
    private_write(
        state / "config.yaml",
        yaml.safe_dump(proxy_configuration(node, args.port, args.dns_port)),
        proxy_user.pw_uid,
        proxy_user.pw_gid,
    )
    run("/usr/local/bin/mihomo", "-t", "-d", str(state), "-f", str(state / "config.yaml"))
    metadata = {
        "uid": proxy_user.pw_uid,
        "port": args.port,
        "ingressIp": ingress,
        "ingressPort": int(node["port"]),
    }
    rules = egress_rules(app.pw_uid, [primary, *existing, metadata], direct)
    candidate = CONFIG / "egress.candidate.nft"
    private_write(candidate, rules)
    run("nft", "-c", "-f", str(candidate))
    settings = {
        **metadata,
        "proxyUrl": f"http://127.0.0.1:{args.port}",
        "expectedIp": expected,
        "intervalSeconds": 60,
        "probeUrls": ["https://api.ipify.org", "https://checkip.amazonaws.com"],
        "statusFile": str(state / "status.json"),
        "command": ["/usr/local/bin/mihomo", "-d", str(state), "-f", str(state / "config.yaml")],
    }
    private_write(state / "guard.json", json.dumps(settings), proxy_user.pw_uid, proxy_user.pw_gid)
    private_write(
        unit_path,
        f"""[Unit]
Description=CRS dedicated egress with fail-closed IP verification
Requires=crs-egress-network.service
After=crs-egress-network.service

[Service]
Type=notify
NotifyAccess=main
User={user}
Group={user}
ExecStart=/usr/bin/python3 /usr/local/libexec/crs-egress-guard.py --settings {state}/guard.json
Restart=no
TimeoutStartSec=40
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
PrivateTmp=yes
PrivateDevices=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths={state}
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
    registry.mkdir(mode=0o700, exist_ok=True)
    private_write(registry / f"{identifier}.json", json.dumps(metadata))
    candidate.replace(CONFIG / "egress.nft")
    run("nft", "-f", str(CONFIG / "egress.nft"))
    # Extend only the endpoint allowlist. Existing account proxies, admin origin and
    # maintenance proxy stay unchanged; CRS restart remains an explicit deployment step.
    endpoints = lines[index][len(key) :].split(",")
    endpoints.extend([f"socks5://127.0.0.1:{args.port}", f"http://127.0.0.1:{args.port}"])
    lines[index] = key + ",".join(dict.fromkeys(endpoints))
    private_write(environment, "\n".join(lines) + "\n")
    run("systemctl", "daemon-reload")
    run("systemctl", "enable", service + ".service")
    run("systemctl", "start", service + ".service")
    print("Additional CRS egress verified; restart CRS after code and policy checks")


def install(args):
    origin = management_origin(args.management_origin)
    protected_paths = [private_path(str(path)) for path in args.private_path]
    if os.geteuid():
        raise RuntimeError("Run as root")
    if any((CONFIG / "egress-profiles").glob("*.json")):
        raise RuntimeError(
            "Registered additional egresses exist; use the private maintenance procedure"
        )
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
    configuration = proxy_configuration(node, 17894, 17896)
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
        "intervalSeconds": 60,
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
    parser.add_argument("--node")
    parser.add_argument("--expected-ip")
    parser.add_argument("--management-origin", type=management_origin)
    parser.add_argument("--private-path", type=private_path, action="append", default=[])
    parser.add_argument("--egress-id")
    parser.add_argument("--port", type=int)
    parser.add_argument("--dns-port", type=int)
    parser.add_argument("--subscription-config", default="/etc/mihomo/config.yaml")
    parser.add_argument(
        "--direct-loopback-ports",
        metavar="PORTS",
        help="only sync the comma separated loopback ports accounts may reach without a proxy",
    )
    arguments = parser.parse_args()
    if arguments.direct_loopback_ports is None:
        missing = [
            flag
            for flag, value in [
                ("--node", arguments.node),
                ("--expected-ip", arguments.expected_ip),
                ("--management-origin", arguments.management_origin),
            ]
            if not value
        ]
        if missing:
            parser.error("the following arguments are required: " + ", ".join(missing))
    try:
        if arguments.direct_loopback_ports is not None:
            sync_direct_loopback(arguments)
        elif arguments.egress_id:
            install_additional(arguments)
        else:
            install(arguments)
    except Exception:
        raise SystemExit(
            "CRS deployment failed; inspect private configuration and rollback records"
        ) from None
