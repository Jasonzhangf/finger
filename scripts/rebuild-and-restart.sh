#!/usr/bin/env bash
set -euo pipefail

npm run build:backend
npm --prefix ui run build
myfinger daemon restart
