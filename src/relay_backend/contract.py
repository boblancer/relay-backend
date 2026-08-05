from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

REPOSITORY_CONTRACT_PATH = Path(__file__).resolve().parents[2] / "openapi.yaml"
PACKAGED_CONTRACT_PATH = Path(__file__).with_name("openapi.yaml")
CONTRACT_PATH = (
    REPOSITORY_CONTRACT_PATH if REPOSITORY_CONTRACT_PATH.exists() else PACKAGED_CONTRACT_PATH
)
REPOSITORY_AUTOMATION_CONTRACT_PATH = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "automation-service-browserbase"
    / "openapi.yaml"
)
PACKAGED_AUTOMATION_CONTRACT_PATH = Path(__file__).with_name("automation_service_openapi.yaml")
AUTOMATION_CONTRACT_PATH = (
    REPOSITORY_AUTOMATION_CONTRACT_PATH
    if REPOSITORY_AUTOMATION_CONTRACT_PATH.exists()
    else PACKAGED_AUTOMATION_CONTRACT_PATH
)


def _load_contract(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as contract_file:
        contract = yaml.safe_load(contract_file)
    if not isinstance(contract, dict):
        raise RuntimeError("The OpenAPI contract must contain an object.")
    return contract


def load_openapi_contract() -> dict[str, Any]:
    return _load_contract(CONTRACT_PATH)


def load_automation_openapi_contract() -> dict[str, Any]:
    return _load_contract(AUTOMATION_CONTRACT_PATH)
