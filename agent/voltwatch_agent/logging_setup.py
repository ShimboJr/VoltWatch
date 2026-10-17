"""
Logging setup — rotating file handler in %LOCALAPPDATA%\\VoltWatch\\logs.

The token is never logged: a filter strips Authorization headers and the
raw token value from all log records.
"""

import logging
import os
import re
from logging.handlers import RotatingFileHandler
from pathlib import Path


def get_log_dir() -> Path:
    local_app = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
    log_dir = Path(local_app) / "VoltWatch" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir


class _TokenRedactFilter(logging.Filter):
    """Strip bearer tokens and other secrets from log output."""

    _BEARER = re.compile(r"Bearer\s+\S+", re.IGNORECASE)
    _PASSWORD = re.compile(r'"password"\s*:\s*"[^"]*"', re.IGNORECASE)

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = self._BEARER.sub("Bearer [REDACTED]", record.msg)
            record.msg = self._PASSWORD.sub('"password": "[REDACTED]"', record.msg)
        return True


def setup_logging(level: str = "INFO", token: str | None = None) -> logging.Logger:
    """
    Configure the root logger with a rotating file handler and a stream handler.

    Args:
        level:  Log level string (DEBUG, INFO, WARNING, ERROR).
        token:  If provided, a second filter pattern strips the literal token value.

    Returns:
        The configured root logger.
    """
    log_dir = get_log_dir()
    log_file = log_dir / "voltwatch.log"

    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    fmt = logging.Formatter(
        "%(asctime)s %(levelname)-8s %(name)s — %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )

    # Rotating file: 5 MB × 5 files
    fh = RotatingFileHandler(log_file, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8")
    fh.setFormatter(fmt)
    fh.addFilter(_TokenRedactFilter())

    # Console (visible when running from a terminal)
    ch = logging.StreamHandler()
    ch.setFormatter(fmt)
    ch.addFilter(_TokenRedactFilter())

    root.addHandler(fh)
    root.addHandler(ch)

    if token:
        class _LiteralTokenFilter(logging.Filter):
            def filter(self, record: logging.LogRecord) -> bool:
                if isinstance(record.msg, str) and token in record.msg:
                    record.msg = record.msg.replace(token, "[REDACTED]")
                return True

        for handler in root.handlers:
            handler.addFilter(_LiteralTokenFilter())

    return root
