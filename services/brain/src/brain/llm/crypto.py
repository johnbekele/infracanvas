"""AES-256-GCM decryption matching apps/api/src/lib/encryption.ts."""

from __future__ import annotations

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_IV_LENGTH = 12
_AUTH_TAG_LENGTH = 16


def decrypt(payload: str, key: bytes) -> str | None:
    """Read `iv:authTag:ciphertext`, all hex, AES-256-GCM, as written by
    `apps/api/src/lib/encryption.ts`.

    Returns None when the payload is malformed, when the IV or tag is the wrong
    length, or when the tag does not authenticate. A caller cannot act on the
    difference between those cases and an exception per variant only invites a
    bare `except`.
    """
    parts = payload.split(":")
    if len(parts) != 3:
        return None

    iv_hex, auth_tag_hex, ciphertext_hex = parts
    try:
        iv = bytes.fromhex(iv_hex)
        auth_tag = bytes.fromhex(auth_tag_hex)
        ciphertext = bytes.fromhex(ciphertext_hex)
    except ValueError:
        return None

    if len(iv) != _IV_LENGTH or len(auth_tag) != _AUTH_TAG_LENGTH:
        return None

    try:
        plaintext = AESGCM(key).decrypt(iv, ciphertext + auth_tag, None)
    except Exception:
        return None

    return plaintext.decode("utf-8")
