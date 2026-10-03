import argparse
import importlib.util
import pathlib
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

script = pathlib.Path(__file__).parents[1] / "scripts/crs-security-network.py"
spec = importlib.util.spec_from_file_location("network", script)
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)


class SecurityNetworkTest(unittest.TestCase):
    def test_additional_profile_cannot_overwrite_an_existing_service(self):
        args = types.SimpleNamespace(
            egress_id="network", port=17897, dns_port=17898, expected_ip="203.0.113.10"
        )
        with patch.object(network.os, "geteuid", return_value=0), patch.object(
            network.pathlib, "Path"
        ) as path, patch.object(network, "private_write") as write, patch.object(
            network, "run"
        ) as run:
            path.return_value.exists.return_value = True
            with self.assertRaises(RuntimeError):
                network.install_additional(args)
            write.assert_not_called()
            run.assert_not_called()

    def test_multiple_proxy_uids_are_pinned_to_distinct_ingresses(self):
        profiles = [
            {"uid": 2001, "port": 17894, "ingressIp": "192.0.2.10", "ingressPort": 443},
            {"uid": 2002, "port": 17897, "ingressIp": "198.51.100.20", "ingressPort": 8443},
        ]
        rules = network.egress_rules(2000, profiles)
        self.assertIn("tcp dport { 6379, 17894, 17897 }", rules)
        self.assertIn("meta skuid 2001 ip daddr 192.0.2.10 tcp dport 443", rules)
        self.assertIn("meta skuid 2002 ip daddr 198.51.100.20 tcp dport 8443", rules)
        for uid in [2000, 2001, 2002]:
            self.assertIn(f"meta skuid {uid} counter reject with icmpx", rules)
        self.assertNotIn("dport 53", rules)
        self.assertNotIn("daddr ::", rules)
        for bad in [
            {**profiles[1], "uid": 2001},
            {**profiles[1], "uid": 2000},
            {**profiles[1], "port": 17894},
            {**profiles[1], "ingressIp": "198.51.100.20; accept"},
        ]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                network.egress_rules(2000, [profiles[0], bad])

    def test_each_proxy_resolves_targets_only_through_its_own_node(self):
        node = {"name": "CRS_FIXED", "type": "ss", "server": "192.0.2.10", "port": 443}
        for port, dns in [(17894, 17896), (17897, 17898)]:
            configuration = network.proxy_configuration(node, port, dns)
            self.assertEqual(configuration["mixed-port"], port)
            self.assertEqual(configuration["dns"]["listen"], f"127.0.0.1:{dns}")
            self.assertFalse(configuration["ipv6"])
            self.assertEqual(configuration["rules"], ["MATCH,CRS_FIXED"])
            self.assertEqual(configuration["proxies"], [node])
            self.assertNotIn("fallback", configuration["dns"])
            for key in ["nameserver", "default-nameserver", "proxy-server-nameserver"]:
                self.assertEqual(configuration["dns"][key], ["https://8.8.8.8/dns-query#CRS_FIXED"])

    def test_documentation_addresses_and_domains_are_explicit_origins(self):
        for value, expected in [
            ("https://192.0.2.10", "https://192.0.2.10"),
            ("https://management.example:443/", "https://management.example"),
            ("https://MANAGEMENT.example:8443", "https://management.example:8443"),
            ("https://[2001:db8::1]/", "https://[2001:db8::1]"),
        ]:
            with self.subTest(value=value):
                self.assertEqual(network.management_origin(value), expected)

    def test_rejected_origins_do_not_echo_credentials_or_allow_env_injection(self):
        synthetic_secret = "synthetic-password-only"
        for value in [
            "",
            "http://192.0.2.10",
            f"https://fixture:{synthetic_secret}@management.example",
            "https://management.example/admin-next/login",
            "https://management.example?redirect=fixture",
            "https://management.example#fixture",
            "https://management.example?",
            "https://management.example#",
            "https://management.example\nCRS_ADMIN_HTTPS_ONLY=false",
            "https://management.example:0",
            "https://management.example:65536",
            "https://management.example:",
            "https://[invalid]",
            "https://bad_host.example",
            "https://management.example..",
            "https://192.0.2.999",
        ]:
            with self.subTest(value=value):
                with self.assertRaises(argparse.ArgumentTypeError) as raised:
                    network.management_origin(value)
                self.assertNotIn(synthetic_secret, str(raised.exception))

    def test_invalid_management_origin_prevents_deployment_side_effects(self):
        args = types.SimpleNamespace(management_origin="http://192.0.2.10", private_path=[])
        with patch.object(network.os, "geteuid") as identity, patch.object(
            network, "private_write"
        ) as write, patch.object(network, "run") as run:
            with self.assertRaises(argparse.ArgumentTypeError):
                network.install(args)
            identity.assert_not_called()
            write.assert_not_called()
            run.assert_not_called()

    def test_cli_requires_origin_and_hides_invalid_credential_value(self):
        arguments = [
            sys.executable,
            str(script),
            "--node",
            "fixture",
            "--expected-ip",
            "203.0.113.10",
        ]
        missing = subprocess.run(arguments, capture_output=True, text=True)
        self.assertEqual(missing.returncode, 2)
        self.assertIn("--management-origin", missing.stderr)
        synthetic_secret = "synthetic-password-only"
        rejected = subprocess.run(
            arguments
            + ["--management-origin", f"https://fixture:{synthetic_secret}@management.example"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(rejected.returncode, 2)
        self.assertNotIn(synthetic_secret, rejected.stdout + rejected.stderr)

    def test_private_paths_cannot_inject_systemd_directives(self):
        self.assertEqual(
            network.private_path("/srv/private/operations"), pathlib.Path("/srv/private/operations")
        )
        for value in ["relative/path", "/srv/private\nUser=root", "/srv/%u", '/srv/"fixture"']:
            with self.subTest(value=value):
                with self.assertRaises(argparse.ArgumentTypeError):
                    network.private_path(value)


if __name__ == "__main__":
    unittest.main()
