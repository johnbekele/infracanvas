#!/usr/bin/env bash
set -Eeuo pipefail
__self_host_line=0
trap 'status=$?; if [ "$status" -ne 0 ]; then echo "$SELF_HOST_DOC:$__self_host_line: verify block failed with exit code $status" >&2; fi; exit $status' EXIT

__self_host_line=5
printf '\n==> %s:%s\n' "$SELF_HOST_DOC" "$__self_host_line"
exit 7

