#!/bin/bash
# Build and globally install myfinger CLI

set -euo pipefail

current_build_version() {
  node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); process.stdout.write(String(pkg.fingerBuildVersion || pkg.version || 'unknown'));"
}

echo "=== Building myfinger (raw backend build, skip prebuild line-limit gate) ==="
npm run build:backend:raw
chmod +x dist/cli/index.js

BUILD_VERSION=$(current_build_version)
echo "=== Build version: ${BUILD_VERSION} ==="

echo "=== Copying autostart agents ==="
mkdir -p ~/.finger/autostart
cp dist/agents/router-chat/router-chat-agent.js ~/.finger/autostart/ 2>/dev/null || echo "Warning: router-chat-agent.js not found"

 echo "=== Installing globally as 'myfinger' ==="
 # IMPORTANT:
 # Use tarball install instead of `npm install -g .` to avoid creating a global
 # symlink to the current workspace (which can break cron/background jobs when
 # the workspace path is not accessible).
 PKG_TGZ=$(npm pack --silent)
 npm install -g "$PKG_TGZ"
 rm -f "$PKG_TGZ"
 
 echo "=== Building Rust binaries for global installation ==="
 GLOBAL_INSTALL_DIR=$(npm root -g)/fingerdaemon
 if [ -d "$GLOBAL_INSTALL_DIR/rust" ]; then
   echo "Global install dir: $GLOBAL_INSTALL_DIR"
   cargo build --release --manifest-path "$GLOBAL_INSTALL_DIR/rust/Cargo.toml"
   echo "Rust binaries built successfully"
 else
   echo "Warning: Global install rust directory not found at $GLOBAL_INSTALL_DIR/rust"
 fi
 
 echo "=== Restarting daemon ==="
 npm run daemon:restart

echo "=== Verifying daemon health ==="
curl --fail --silent http://127.0.0.1:9999/health >/dev/null

echo "=== Installation complete ==="
echo "Usage:"
echo "  myfinger daemon start    # Start daemon"
echo "  myfinger chat            # Start chat mode"
echo "  myfinger --help          # Show all commands"
