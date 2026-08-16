"""Unit tests for AES-256-GCM decryption matching the TypeScript API."""

from __future__ import annotations

from brain.llm.crypto import decrypt

# Produced by apps/api/src/lib/encryption.ts (same algorithm: AES-256-GCM,
# iv:authTag:ciphertext hex) under ENCRYPTION_KEY of 64 hex 'a's.
_TS_KEY = bytes.fromhex("a" * 64)
_TS_PLAINTEXT = "sk-test-key-from-typescript"
_TS_PAYLOAD = (
    "11cd53995ed05e3b1c9e5ff6:87f837325af681ae042a5634ec75bdbd:"
    "d97e1bc9d2dbb228168ce30b650a04b4b37b8fddbbc0359b857a45"
)


def test_decrypt_reads_a_payload_written_by_the_typescript_api() -> None:
    assert decrypt(_TS_PAYLOAD, _TS_KEY) == _TS_PLAINTEXT


def test_decrypt_returns_none_for_a_tampered_ciphertext() -> None:
    iv, tag, ciphertext = _TS_PAYLOAD.split(":")
    # Flip the last nibble of the ciphertext so the auth tag no longer verifies.
    tampered_ct = ciphertext[:-1] + ("0" if ciphertext[-1] != "0" else "1")
    tampered = f"{iv}:{tag}:{tampered_ct}"

    assert decrypt(tampered, _TS_KEY) is None
