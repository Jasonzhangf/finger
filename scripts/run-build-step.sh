#!/bin/bash

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "[build-step] usage: run-build-step.sh <command...>" >&2
  exit 1
fi

if [ "${FINGER_BUILD_BUMP_DONE:-0}" != "1" ]; then
  node scripts/bump-build-version.mjs
  export FINGER_BUILD_BUMP_DONE=1
fi

"$@"
