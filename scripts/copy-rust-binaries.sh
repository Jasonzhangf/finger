#!/bin/bash
set -e
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT_DIR/dist/bin"
mkdir -p "$BIN_DIR"

if [ -f "$ROOT_DIR/rust/target/release/finger-kernel-bridge-bin" ]; then
  cp "$ROOT_DIR/rust/target/release/finger-kernel-bridge-bin" "$BIN_DIR/"
  echo "Copied finger-kernel-bridge-bin (release)"
else
  echo "WARNING: finger-kernel-bridge-bin not found in rust/target/release/"
fi

if [ -f "$ROOT_DIR/rust/target/release/ledger-cli" ]; then
  cp "$ROOT_DIR/rust/target/release/ledger-cli" "$BIN_DIR/"
  echo "Copied ledger-cli (release)"
fi
