from __future__ import annotations

import io
import unittest
from unittest.mock import patch

import magnus_fleet_check as fleet_check


class ResponseFixture(io.BytesIO):
    def __init__(self, payload: bytes, content_length: str | None = None) -> None:
        super().__init__(payload)
        self.headers = {} if content_length is None else {"Content-Length": content_length}


class FleetCheckTransportTests(unittest.TestCase):
    def test_base_url_is_an_exact_public_https_dns_origin(self) -> None:
        self.assertEqual(
            fleet_check.validate_base_url("https://Magnus.Example:4000/"),
            "https://magnus.example:4000",
        )
        for invalid in (
            "http://magnus.example:4000",
            "https://user@magnus.example:4000",
            "https://magnus.example:4000/api",
            "https://magnus.example:4000?token=bad",
            "https://magnus.example:4000#fragment",
            "https://127.0.0.1:4000",
            "https://[::1]:4000",
            "https://localhost:4000",
            "https://magnus.local:4000",
            "https://magnus:4000",
            "https://bad_label.example:4000",
            "https://magnus.example:not-a-port",
            "https://magnus.example:0",
            " https://magnus.example:4000",
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    fleet_check.validate_base_url(invalid)

    def test_bounded_reader_rejects_declared_and_streamed_oversize_bodies(self) -> None:
        with self.assertRaisesRegex(ValueError, "exceeds 8 bytes"):
            fleet_check.read_bounded(ResponseFixture(b"small", "9"), 8)
        with self.assertRaisesRegex(ValueError, "exceeds 8 bytes"):
            fleet_check.read_bounded(ResponseFixture(b"123456789"), 8)
        with self.assertRaisesRegex(ValueError, "invalid Content-Length"):
            fleet_check.read_bounded(ResponseFixture(b"small", "invalid"), 8)
        self.assertEqual(fleet_check.read_bounded(ResponseFixture(b"12345678"), 8), b"12345678")

    def test_client_uses_bounded_reader_and_does_not_follow_redirects(self) -> None:
        client = fleet_check.MagnusApi(
            "https://magnus.example:4000",
            "dedicated-fleet-check-token-with-32-plus-characters",
        )
        response = ResponseFixture(b"x" * (fleet_check.MAX_RESPONSE_BYTES + 1))
        with patch.object(client.opener, "open", return_value=response):
            with self.assertRaisesRegex(ValueError, "exceeds"):
                client.get("stats/overview")

        handler = fleet_check.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, "Found", {}, "https://evil.example"))


if __name__ == "__main__":
    unittest.main()
