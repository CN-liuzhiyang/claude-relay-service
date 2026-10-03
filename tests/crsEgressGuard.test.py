import importlib.util
import json
import pathlib
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "guard", pathlib.Path(__file__).parents[1] / "scripts/crs-egress-guard.py"
)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class EgressGuardTest(unittest.TestCase):
    def test_two_independent_probes_verify_exact_ip(self):
        with patch.object(
            guard.subprocess,
            "run",
            return_value=types.SimpleNamespace(returncode=0, stdout="192.0.2.1\n"),
        ) as run:
            guard.probe(
                "http://127.0.0.1:17895",
                ["https://probe-a.invalid", "https://probe-b.invalid"],
                "192.0.2.1",
            )
            self.assertEqual(run.call_count, 2)
            self.assertIn("--proxy", run.call_args.args[0])
            self.assertIn("--noproxy", run.call_args.args[0])

    def test_error_malformed_response_and_ip_drift_reject(self):
        for code, response in [(7, ""), (0, "untrusted malformed response"), (0, "192.0.2.2")]:
            with self.subTest(code=code, response=response):
                with patch.object(
                    guard.subprocess,
                    "run",
                    return_value=types.SimpleNamespace(returncode=code, stdout=response),
                ):
                    with self.assertRaises((RuntimeError, ValueError)):
                        guard.probe(
                            "http://127.0.0.1:17895", ["https://probe.invalid"], "192.0.2.1"
                        )

    def test_startup_failure_and_runtime_drift_terminate_proxy(self):
        for checks in [[RuntimeError("fixture fail")], [None, RuntimeError("fixture drift")]]:
            with self.subTest(checks=len(checks)), tempfile.TemporaryDirectory() as directory:
                status = pathlib.Path(directory) / "status.json"
                settings = pathlib.Path(directory) / "guard.json"
                settings.write_text(
                    json.dumps(
                        {
                            "expectedIp": "192.0.2.1",
                            "port": 17895,
                            "proxyUrl": "http://127.0.0.1:17895",
                            "probeUrls": ["https://probe.invalid"],
                            "command": ["synthetic-proxy"],
                            "statusFile": str(status),
                            "intervalSeconds": 0,
                        }
                    )
                )
                child = Mock()
                child.poll.return_value = None
                channel = Mock()
                channel.__enter__ = Mock(return_value=channel)
                channel.__exit__ = Mock(return_value=False)
                channel.connect_ex.return_value = 0
                with patch.object(guard.subprocess, "Popen", return_value=child), patch.object(
                    guard.socket, "socket", return_value=channel
                ), patch.object(guard.signal, "signal"), patch.object(
                    guard.time, "sleep"
                ), patch.object(
                    guard, "notify"
                ) as notify, patch.object(
                    guard, "probe", side_effect=checks
                ):
                    with self.assertRaises(SystemExit):
                        guard.supervise(types.SimpleNamespace(settings=str(settings)))
                    child.terminate.assert_called_once()
                    self.assertFalse(json.loads(status.read_text())["healthy"])
                    self.assertEqual(notify.call_count, len(checks) - 1)


if __name__ == "__main__":
    unittest.main()
