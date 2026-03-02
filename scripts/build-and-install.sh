#!/bin/bash
# Build and globally install myfinger CLI

set -e

echo "=== Building myfinger ==="
npm run build
chmod +x dist/cli/index.js

echo "=== Copying autostart agents ==="
mkdir -p ~/.finger/autostart
cp dist/agents/router-chat/router-chat-agent.js ~/.finger/autostart/ 2>/dev/null || echo "Warning: router-chat-agent.js not found"

echo "=== Installing globally as 'myfinger' ==="
npm install -g .

echo "=== Installation complete ==="
echo "Usage:"
echo "  myfinger daemon start    # Start daemon"
echo "  myfinger chat            # Start chat mode"
echo "  myfinger --help          # Show all commands"
