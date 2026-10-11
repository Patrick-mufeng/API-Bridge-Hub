"""Model catalog: the console table must show real upstream fields, safely.

/v1/models is the flattened OpenAI shape (id/object/created/owned_by) that
clients need, so it only ever carried four fields and the console could show a
bare list. The upstream web model list actually returns 22 keys per model:
capability flags, context windows, reasoning tiers, credit consumption rates
and discounts. /api/models/detail projects that into a table.

The projection is an explicit allowlist, not a subtraction. The raw configs
also carry ak/sk/base_url/auth_type, which are credential material: today they
happen to be blank for every model, and an allowlist keeps them out even when
they are not.
"""

from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from src import main as main_module

AUTH_HEADERS = {"Authorization": "Bearer smoke-key"}


def _config(**overrides):
    """A config shaped like the upstream web model list entry."""
    config = {
        "name": "glm-5.3",
        "display_name": "GLM-5.3",
        "config_name": "glm-5.3",
        "model_name": "glm-5.3",
        "multimodal": True,
        "is_default": False,
        "is_beta": False,
        "is_new": True,
        "is_preset": True,
        "max_mode": True,
        "provider": "",
        "custom_model_id": None,
        "context_window_tokens": {"dev": 200000, "max": 1000000},
        "reasoning_effort_config": {
            "support_thinking": True,
            "options": ["light", "high", "extra_high"],
            "default_level": "extra_high",
        },
        "features": {
            "consumption_rate": {"enable": True, "data": {"rate": 0.78}},
            "multimodal": {"enable": True},
            "reasoning": {"enable": True},
            "access": {"data": {"identity_list": [0, 5, 1]}},
        },
        "icon": {"light": "https://lf-cdn.trae.com.cn/x/glm.svg", "dark": "https://lf-cdn.trae.com.cn/x/glm-dark.svg"},
        "ak": "SHOULD-NOT-LEAK",
        "sk": "SHOULD-NOT-LEAK",
        "base_url": "https://secret.internal/v1",
        "auth_type": 7,
    }
    config.update(overrides)
    return config


class ModelDetailRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main_module.app)

    def _fetch(self, configs):
        async def fake(**kwargs):
            return configs

        with patch.object(main_module.trae_client, "_fetch_web_model_configs", fake):
            return self.client.get("/api/models/detail", headers=AUTH_HEADERS)

    def test_reports_the_projected_fields(self):
        response = self._fetch({"glm-5.3": _config()})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["success"])
        self.assertEqual(len(body["models"]), 1)
        model = body["models"][0]
        for field in (
            "name", "display_name", "provider", "multimodal", "max_mode",
            "is_default", "is_beta", "is_new", "is_preset",
            "context_dev", "context_max", "consumption_rate",
            "discount_percent", "reasoning_options", "reasoning_default",
            "supports_thinking", "supports_video",
        ):
            with self.subTest(field=field):
                self.assertIn(field, model)

    def test_context_and_capabilities_are_mapped(self):
        model = self._fetch({"glm-5.3": _config()}).json()["models"][0]
        self.assertEqual(model["context_dev"], 200000)
        self.assertEqual(model["context_max"], 1000000)
        self.assertEqual(model["consumption_rate"], 0.78)
        self.assertEqual(model["reasoning_options"], ["light", "high", "extra_high"])
        self.assertEqual(model["reasoning_default"], "extra_high")
        self.assertIs(model["supports_thinking"], True)
        self.assertIs(model["multimodal"], True)
        self.assertIs(model["max_mode"], True)

    def test_credential_fields_never_reach_the_response(self):
        response = self._fetch({"glm-5.3": _config()})
        text = response.text
        for secret in ("SHOULD-NOT-LEAK", "secret.internal", "auth_type"):
            with self.subTest(secret=secret):
                self.assertNotIn(secret, text)
        for field in ("ak", "sk", "base_url"):
            with self.subTest(field=field):
                self.assertNotIn(field, response.json()["models"][0])

    def test_discount_is_summarised_from_whichever_shape_is_present(self):
        member = _config(features={
            "consumption_rate": {"enable": True, "data": {"rate": 0.78}},
            "discount": {
                "enable": True,
                "data": {"original_consumption_rate": 0.78, "consumption_rate": 0.39, "member_discount": 50},
            },
        })
        model = self._fetch({"glm-5.3": member}).json()["models"][0]
        self.assertEqual(model["discount_percent"], 50)
        self.assertEqual(model["consumption_rate"], 0.39)

        off_peak = _config(features={
            "consumption_rate": {"enable": True, "data": {"rate": 0.15}},
            "activity_discount": {
                "enable": True,
                "subKey": "off_peak_member_discount",
                "data": {
                    "current": {"before_consumption_rate": 0.15, "consumption_rate": 0.15, "discount": 100},
                    "member": {"before_consumption_rate": 0.15, "after_consumption_rate": 0.08, "discount": 50},
                },
            },
        })
        model = self._fetch({"deepseek-v4.1-flash": off_peak}).json()["models"][0]
        self.assertEqual(model["discount_percent"], 50)
        self.assertEqual(model["consumption_rate"], 0.15)
        self.assertEqual(model["discount_kind"], "off_peak_member_discount")

    def test_missing_optional_fields_do_not_crash(self):
        sparse = {"name": "bare-model"}
        body = self._fetch({"bare-model": sparse}).json()
        self.assertEqual(body["models"][0]["name"], "bare-model")
        self.assertEqual(body["models"][0]["context_max"], 0)
        self.assertIsNone(body["models"][0]["consumption_rate"])

    def test_reports_an_upstream_failure_instead_of_an_empty_list(self):
        async def boom(**kwargs):
            raise RuntimeError("upstream down")

        with patch.object(main_module.trae_client, "_fetch_web_model_configs", boom):
            response = self.client.get("/api/models/detail", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 502)
        self.assertFalse(response.json()["success"])

    def test_counts_capability_totals(self):
        configs = {
            "a": _config(name="a", max_mode=True, multimodal=True),
            "b": _config(name="b", max_mode=False, multimodal=False),
        }
        body = self._fetch(configs).json()
        self.assertEqual(body["total"], 2)
        self.assertEqual(body["max_mode_count"], 1)
        self.assertEqual(body["multimodal_count"], 1)


if __name__ == "__main__":
    unittest.main()
