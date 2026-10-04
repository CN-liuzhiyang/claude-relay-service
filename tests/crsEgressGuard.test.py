import importlib.util
import contextlib
import io
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
    def test_failure_categories_and_probe_index_never_include_response_or_url(self):
        secret = "synthetic-private-response-only"
        cases = [
            (28, "\n000", "probe_timeout"),
            (60, "\n000", "probe_tls_error"),
            (22, f"{secret}\n429", "probe_http_error"),
            (7, "\n000", "probe_transport_error"),
            (0, f"{secret}\n200", "probe_invalid_ip_response"),
            (0, "192.0.2.2\n200", "egress_ip_mismatch"),
        ]
        for code, body, reason in cases:
            with self.subTest(reason=reason), patch.object(
                guard.subprocess,
                "run",
                side_effect=[
                    types.SimpleNamespace(returncode=0, stdout="192.0.2.1\n200"),
                    types.SimpleNamespace(returncode=code, stdout=body),
                ],
            ):
                with self.assertRaises(guard.VerificationFailure) as raised:
                    guard.probe(
                        "http://127.0.0.1:17895",
                        ["https://probe-a.invalid", f"https://{secret}.invalid"],
                        "192.0.2.1",
                    )
                failure = raised.exception
                self.assertEqual(failure.details["reason"], reason)
                self.assertEqual(failure.details["probeIndex"], 1)
                self.assertEqual(failure.details["curlExit"], code)
                self.assertNotIn(secret, json.dumps(failure.details) + str(failure))
                self.assertNotIn("192.0.2.2", json.dumps(failure.details))

    def test_subprocess_timeout_and_spawn_failure_are_safe(self):
        for error, reason in [
            (
                guard.subprocess.TimeoutExpired(
                    "synthetic-secret-command", 10, output="synthetic-secret-output"
                ),
                "probe_process_timeout",
            ),
            (FileNotFoundError("synthetic-secret-path"), "probe_process_unavailable"),
        ]:
            with self.subTest(reason=reason), patch.object(
                guard.subprocess, "run", side_effect=error
            ):
                with self.assertRaises(guard.VerificationFailure) as raised:
                    guard.probe("http://127.0.0.1:17895", ["https://probe.invalid"], "192.0.2.1")
                self.assertEqual(raised.exception.details, {"reason": reason, "probeIndex": 0})
                self.assertNotIn("synthetic-secret", str(raised.exception))

    def test_empty_probes_never_approve_an_exit(self):
        with patch.object(guard.subprocess, "run") as run:
            with self.assertRaises(guard.VerificationFailure):
                guard.probe("http://127.0.0.1:17895", [], "192.0.2.1")
            run.assert_not_called()

    def test_two_independent_probes_verify_exact_ip(self):
        with patch.object(
            guard.subprocess,
            "run",
            return_value=types.SimpleNamespace(returncode=0, stdout="192.0.2.1\n200"),
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
        for code, response in [
            (7, "\n000"),
            (0, "untrusted malformed response\n200"),
            (0, "192.0.2.2\n200"),
        ]:
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
        for checks in [
            [guard.VerificationFailure("probe_transport_error", 0, 7)],
            [None, guard.VerificationFailure("egress_ip_mismatch", 1, 0, 200)],
        ]:
            with self.subTest(checks=len(checks)), tempfile.TemporaryDirectory() as directory:
                status = pathlib.Path(directory) / "status.json"
                settings = pathlib.Path(directory) / "guard.json"
                settings.write_text(
                    json.dumps(
                        {
                            "expectedIp": "192.0.2.1",
                            "port": 17895,
                            "proxyUrl": "http://127.0.0.1:17895",
                            "probeUrls": ["https://probe-a.invalid", "https://probe-b.invalid"],
                            "command": ["synthetic-proxy"],
                            "statusFile": str(status),
                            "intervalSeconds": 0,
                            "transientRetries": 0,
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
                    state = json.loads(status.read_text())
                    self.assertFalse(state["healthy"])
                    self.assertEqual(state["reason"], checks[-1].details["reason"])
                    self.assertEqual(state["probeIndex"], checks[-1].details["probeIndex"])
                    self.assertEqual(notify.call_count, len(checks) - 1)

    def test_invalid_configuration_has_no_child_and_no_private_error_output(self):
        for probes in [
            [],
            ["https://probe.invalid"],
            ["http://probe-a.invalid", "https://probe-b.invalid"],
        ]:
            with self.subTest(probes=len(probes)), tempfile.TemporaryDirectory() as directory:
                settings = pathlib.Path(directory) / "guard.json"
                settings.write_text(
                    json.dumps(
                        {
                            "expectedIp": "192.0.2.1",
                            "statusFile": str(pathlib.Path(directory) / "status.json"),
                            "probeUrls": probes,
                            "command": ["synthetic-secret-command"],
                        }
                    )
                )
                captured = io.StringIO()
                with patch.object(guard.subprocess, "Popen") as child, contextlib.redirect_stdout(
                    captured
                ):
                    with self.assertRaises(SystemExit):
                        guard.supervise(types.SimpleNamespace(settings=str(settings)))
                child.assert_not_called()
                self.assertEqual(
                    json.loads(captured.getvalue())["reason"], "guard_configuration_invalid"
                )
                self.assertNotIn("synthetic-secret", captured.getvalue())

    def test_child_spawn_failure_persists_only_a_safe_category(self):
        with tempfile.TemporaryDirectory() as directory:
            status = pathlib.Path(directory) / "status.json"
            settings = pathlib.Path(directory) / "guard.json"
            settings.write_text(
                json.dumps(
                    {
                        "expectedIp": "192.0.2.1",
                        "statusFile": str(status),
                        "probeUrls": ["https://probe-a.invalid", "https://probe-b.invalid"],
                        "command": ["synthetic-secret-command"],
                    }
                )
            )
            captured = io.StringIO()
            with patch.object(
                guard.subprocess, "Popen", side_effect=FileNotFoundError("synthetic-secret-error")
            ), contextlib.redirect_stdout(captured):
                with self.assertRaises(SystemExit):
                    guard.supervise(types.SimpleNamespace(settings=str(settings)))
            self.assertEqual(json.loads(status.read_text())["reason"], "proxy_start_failed")
            self.assertNotIn("synthetic-secret", captured.getvalue())

    def test_failed_status_write_blocks_ready_and_closes_child_without_error_text(self):
        with tempfile.TemporaryDirectory() as directory:
            status = pathlib.Path(directory) / "status.json"
            settings = pathlib.Path(directory) / "guard.json"
            settings.write_text(
                json.dumps(
                    {
                        "expectedIp": "192.0.2.1",
                        "port": 17895,
                        "proxyUrl": "http://127.0.0.1:17895",
                        "probeUrls": ["https://probe-a.invalid", "https://probe-b.invalid"],
                        "command": ["synthetic-proxy"],
                        "statusFile": str(status),
                    }
                )
            )
            child = Mock()
            child.poll.return_value = None
            channel = Mock()
            channel.__enter__ = Mock(return_value=channel)
            channel.__exit__ = Mock(return_value=False)
            channel.connect_ex.return_value = 0
            captured = io.StringIO()
            with patch.object(guard.subprocess, "Popen", return_value=child), patch.object(
                guard.socket, "socket", return_value=channel
            ), patch.object(guard.signal, "signal"), patch.object(guard, "probe"), patch.object(
                guard, "notify"
            ) as notify, patch.object(
                guard.pathlib.Path,
                "write_text",
                side_effect=PermissionError(13, "synthetic-secret-message"),
            ), contextlib.redirect_stdout(
                captured
            ):
                with self.assertRaises(SystemExit):
                    guard.supervise(types.SimpleNamespace(settings=str(settings)))
            notify.assert_not_called()
            child.terminate.assert_called_once()
            self.assertEqual(json.loads(captured.getvalue())["reason"], "state_io_error")
            self.assertNotIn("synthetic-secret", captured.getvalue())

    def _verify_settings(self, retries=2):
        return {
            "proxyUrl": "http://127.0.0.1:17895",
            "probeUrls": ["https://probe-a.invalid", "https://probe-b.invalid"],
            "transientRetries": retries,
            "retryDelaySeconds": 5,
        }

    def test_transient_failures_retry_then_pass_without_closing(self):
        failures = [
            guard.VerificationFailure("probe_tls_error", 0, 35),
            guard.VerificationFailure("probe_timeout", 1, 28),
        ]
        captured = io.StringIO()
        with patch.object(guard, "probe", side_effect=failures + [None]) as probe, patch.object(
            guard.time, "sleep"
        ) as sleep, contextlib.redirect_stdout(captured):
            guard.verify(self._verify_settings(), "192.0.2.1")
        self.assertEqual(probe.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 5])
        events = [json.loads(line) for line in captured.getvalue().splitlines()]
        self.assertEqual([event["event"] for event in events], ["crs_egress_probe_retry"] * 2)
        self.assertEqual([event["attempts"] for event in events], [1, 2])
        self.assertEqual(events[0]["reason"], "probe_tls_error")

    def test_transient_failures_close_after_retries_are_exhausted(self):
        failure = lambda: guard.VerificationFailure("probe_transport_error", 0, 7)
        with patch.object(
            guard, "probe", side_effect=[failure(), failure(), failure()]
        ) as probe, patch.object(guard.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(guard.VerificationFailure) as raised:
                guard.verify(self._verify_settings(), "192.0.2.1")
        self.assertEqual(probe.call_count, 3)
        self.assertEqual(raised.exception.details["reason"], "probe_transport_error")
        self.assertEqual(raised.exception.details["attempts"], 3)

    def test_mismatch_and_malformed_response_close_without_retry(self):
        for reason in ["egress_ip_mismatch", "probe_invalid_ip_response"]:
            with self.subTest(reason=reason), patch.object(
                guard, "probe", side_effect=[guard.VerificationFailure(reason, 0, 0, 200)]
            ) as probe, patch.object(guard.time, "sleep") as sleep:
                with self.assertRaises(guard.VerificationFailure) as raised:
                    guard.verify(self._verify_settings(), "192.0.2.1")
                probe.assert_called_once()
                sleep.assert_not_called()
                self.assertEqual(raised.exception.details["attempts"], 1)

    def test_mismatch_during_retry_window_still_closes_immediately(self):
        with patch.object(
            guard,
            "probe",
            side_effect=[
                guard.VerificationFailure("probe_tls_error", 0, 35),
                guard.VerificationFailure("egress_ip_mismatch", 1, 0, 200),
            ],
        ) as probe, patch.object(guard.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(guard.VerificationFailure) as raised:
                guard.verify(self._verify_settings(), "192.0.2.1")
        self.assertEqual(probe.call_count, 2)
        self.assertEqual(raised.exception.details["reason"], "egress_ip_mismatch")

    def test_running_guard_survives_a_transient_blip_and_uses_default_interval(self):
        with tempfile.TemporaryDirectory() as directory:
            status = pathlib.Path(directory) / "status.json"
            settings = pathlib.Path(directory) / "guard.json"
            settings.write_text(
                json.dumps(
                    {
                        "expectedIp": "192.0.2.1",
                        "port": 17895,
                        "proxyUrl": "http://127.0.0.1:17895",
                        "probeUrls": ["https://probe-a.invalid", "https://probe-b.invalid"],
                        "command": ["synthetic-proxy"],
                        "statusFile": str(status),
                    }
                )
            )
            child = Mock()
            child.poll.return_value = None
            channel = Mock()
            channel.__enter__ = Mock(return_value=channel)
            channel.__exit__ = Mock(return_value=False)
            channel.connect_ex.return_value = 0
            checks = [
                None,  # startup
                guard.VerificationFailure("probe_tls_error", 0, 35),
                None,  # retry succeeds, proxy stays up
                guard.VerificationFailure("egress_ip_mismatch", 0, 0, 200),
            ]
            with patch.object(guard.subprocess, "Popen", return_value=child), patch.object(
                guard.socket, "socket", return_value=channel
            ), patch.object(guard.signal, "signal"), patch.object(
                guard.time, "sleep"
            ) as sleep, patch.object(
                guard, "notify"
            ), patch.object(
                guard, "probe", side_effect=checks
            ), contextlib.redirect_stdout(
                io.StringIO()
            ):
                with self.assertRaises(SystemExit):
                    guard.supervise(types.SimpleNamespace(settings=str(settings)))
            child.terminate.assert_called_once()
            state = json.loads(status.read_text())
            self.assertEqual(state["reason"], "egress_ip_mismatch")
            self.assertEqual(state["attempts"], 1)
            self.assertIn(60, [call.args[0] for call in sleep.call_args_list])

    def test_out_of_range_timing_is_rejected_before_start(self):
        for key, value in [("intervalSeconds", -1), ("transientRetries", 9), ("retryDelaySeconds", "5")]:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                settings = pathlib.Path(directory) / "guard.json"
                settings.write_text(
                    json.dumps(
                        {
                            "expectedIp": "192.0.2.1",
                            "statusFile": str(pathlib.Path(directory) / "status.json"),
                            "probeUrls": ["https://probe-a.invalid", "https://probe-b.invalid"],
                            "command": ["synthetic-proxy"],
                            key: value,
                        }
                    )
                )
                with patch.object(guard.subprocess, "Popen") as child, contextlib.redirect_stdout(
                    io.StringIO()
                ):
                    with self.assertRaises(SystemExit):
                        guard.supervise(types.SimpleNamespace(settings=str(settings)))
                child.assert_not_called()


if __name__ == "__main__":
    unittest.main()
