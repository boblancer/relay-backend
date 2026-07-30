from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

CONTRACT_PATH = Path(__file__).resolve().parents[2] / "openapi.yaml"


def load_openapi_contract() -> dict[str, Any]:
    with CONTRACT_PATH.open(encoding="utf-8") as contract_file:
        contract = yaml.safe_load(contract_file)
    if not isinstance(contract, dict):
        raise RuntimeError("The OpenAPI contract must contain an object.")
    return contract
