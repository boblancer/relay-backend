from __future__ import annotations

from pathlib import Path
from typing import Protocol


class BlobStorage(Protocol):
    def save(self, namespace_id: int, record_id: str, filename: str, data: bytes) -> str: ...
    def read(self, namespace_id: int, record_id: str, filename: str) -> bytes: ...
    def delete(self, namespace_id: int, record_id: str, filename: str) -> None: ...


class LocalBlobStorage:
    def __init__(self, root: Path) -> None:
        self.root = root

    def save(self, namespace_id: int, record_id: str, filename: str, data: bytes) -> str:
        directory = self.root / str(namespace_id) / record_id
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / filename
        path.write_bytes(data)
        return f"{namespace_id}/{record_id}/{filename}"

    def read(self, namespace_id: int, record_id: str, filename: str) -> bytes:
        path = self.root / str(namespace_id) / record_id / filename
        if not path.is_file():
            raise FileNotFoundError(f"Blob not found: {namespace_id}/{record_id}/{filename}")
        return path.read_bytes()

    def delete(self, namespace_id: int, record_id: str, filename: str) -> None:
        path = self.root / str(namespace_id) / record_id / filename
        if path.is_file():
            path.unlink()
