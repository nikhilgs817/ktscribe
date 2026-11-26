"""Keeps the cloud API key off disk in plain text.

On Windows the key is encrypted with DPAPI (CryptProtectData), so only the same
Windows user on the same PC can read it back. Elsewhere it is stored base64-encoded,
which is not encryption; that path is for development only.
"""
import base64
import ctypes
import os
import sys


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(data: bytes, protect: bool) -> bytes:
    crypt32 = ctypes.windll.crypt32  # type: ignore[attr-defined]
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    buf = ctypes.create_string_buffer(data, len(data))
    src = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    out = _Blob()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    if not fn(ctypes.byref(src), None, None, None, None, 0x1, ctypes.byref(out)):
        raise OSError("Windows could not encrypt or decrypt the API key")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


def protect(plain: str) -> str:
    if not plain:
        return ""
    raw = plain.encode("utf-8")
    if sys.platform == "win32":
        return "dpapi:" + base64.b64encode(_dpapi(raw, True)).decode()
    return "b64:" + base64.b64encode(raw).decode()


def unprotect(stored: str) -> str:
    if not stored:
        return ""
    try:
        kind, _, data = stored.partition(":")
        raw = base64.b64decode(data)
        if kind == "dpapi":
            return _dpapi(raw, False).decode("utf-8")
        if kind == "b64":
            return raw.decode("utf-8")
    except Exception:
        return ""
    return ""


def env_key(provider: str) -> str:
    return os.environ.get({"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}.get(provider, ""), "")
