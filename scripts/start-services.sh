#!/bin/bash

# Finger 项目服务启动脚本
# 自动启动所有必要的服务：iFlow CLI (SDK 自动管理)、Finger Daemon

set -e

echo "========================================"
echo "Finger Services Startup Script"
echo "========================================"

# 检查 Node.js 版本
if ! command -v node &> /dev/null
then
    echo "Node.js not found. Please install Node.js (>=20.0.0)."
    exit 1
fi

NODE_VERSION=$(node -v)
REQUIRED_NODE_VERSION="v20.0.0"
if [[ "$(printf '%s\n' "$REQUIRED_NODE_VERSION" "$NODE_VERSION" | sort -V | head -n 1)" != "$REQUIRED_NODE_VERSION" ]]; then
    echo "Node.js version is $NODE_VERSION, but $REQUIRED_NODE_VERSION or higher is required."
    exit 1
fi

# 检查 npm
if ! command -v npm &> /dev/null
then
    echo "npm not found."
    exit 1
fi

# 检查 iFlow CLI
if ! command -v iflow &> /dev/null
then
    echo "iFlow CLI not found. Please install it first:"
    echo "  Mac/Linux: bash -c \"\$(curl -fsSL https://cloud.iflow.cn/iflow-cli/install.sh)\""
    echo "  Windows: npm install -g @iflow-ai/iflow-cli@latest"
    exit 1
fi

echo "[Check] Node.js: $(node -v)"
echo "[Check] iFlow CLI: $(iflow --version)"

# 创建必要的目录
mkdir -p .finger
mkdir -p output/deepseek-research

# ========================================
# 1. 启动 iFlow 服务
# ========================================
echo ""
echo "========================================"
echo "[1/2] iFlow Service"
echo "========================================"
echo "Note: iFlow process is auto-managed by SDK"
echo "      No manual startup required."
echo "      SDK will start iflow when tests connect."

# ========================================
# 2. 启动 Finger Daemon
# ========================================
echo ""
echo "========================================"
echo "[2/2] Finger Daemon"
echo "========================================"

PID_FILE=".finger/daemon.pid"
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p $OLD_PID > /dev/null 2>&1; then
        echo "Stopping existing Finger Daemon (PID: $OLD_PID)..."
        kill $OLD_PID 2>/dev/null || true
        sleep 2
    fi
    rm -f "$PID_FILE"
fi

echo "Building project..."
npm run build

echo "Starting Finger Server..."
nohup node dist/server/index.js > /tmp/finger-daemon.log 2>&1 &
FINGER_PID=$!
echo "$FINGER_PID" > "$PID_FILE"
echo "Finger Daemon started (PID: $FINGER_PID)"
echo "Log: /tmp/finger-daemon.log"

# 等待服务启动
echo "Waiting for server to start..."
for i in {1..10}; do
    if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
        echo "Server is ready!"
        break
    fi
    if [ $i -eq 10 ]; then
        echo "Warning: Server may not have started correctly."
        echo "Check: /tmp/finger-daemon.log"
        exit 1
    fi
    sleep 1
done

# 健康检查
echo ""
echo "Running health check..."
bash scripts/health-check.sh

# ========================================
# Summary
# ========================================
echo ""
echo "========================================"
echo "Services Ready"
echo "========================================"
echo "Finger HTTP:  http://localhost:8080"
echo "Finger WS:    ws://localhost:8081"
echo "iFlow:        Auto-managed by SDK"
echo ""
echo "Ready for E2E tests!"
