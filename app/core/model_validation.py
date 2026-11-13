"""Utilities for rejecting missing, truncated, and Git LFS pointer model files."""

from __future__ import annotations

from pathlib import Path
from typing import Mapping


_LFS_POINTER_PREFIX = b"version https://git-lfs.github.com/spec/v1"


def is_valid_model_file(path: Path, minimum_size: int = 1) -> bool:
    """Return False for missing, undersized, unreadable, or Git LFS pointer files."""
    try:
        if not path.is_file() or path.stat().st_size < minimum_size:
            return False
        with path.open("rb") as model_file:
            header = model_file.read(256).lstrip()
        return not header.startswith(_LFS_POINTER_PREFIX)
    except OSError:
        return False


def has_valid_model_files(directory: Path, minimum_sizes: Mapping[str, int]) -> bool:
    """Check every required model file and its minimum plausible size."""
    return directory.is_dir() and all(
        is_valid_model_file(directory / name, min_size)
        for name, min_size in minimum_sizes.items()
    )
