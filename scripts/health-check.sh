#!/bin/bash
# Finger 服务健康检查脚本

set -e

echo "========================================"
echo "Finger Services Health Check"
echo "========================================"

# 检查 HTTP 服务
echo -n "HTTP Service (9999): "
if curl -sf http://localhost:9999/health > /dev/null 2>&1; then
    echo "✅ OK"
    curl -s http://localhost:9999/health
else
    echo "❌ DOWN"
    exit 1
fi

# 检查 WebSocket 端口
echo -n "WebSocket Port (9998): "
if lsof -ti :9998 > /dev/null 2>&1; then
    echo "✅ Bound"
else
    echo "❌ Not bound"
    exit 1
fi

# 检查 HTTP 端口
echo -n "HTTP Port (9999): "
if lsof -ti :9999 > /dev/null 2>&1; then
    echo "✅ Bound"
else
    echo "❌ Not bound"
    exit 1
fi

# 检查 API 端点
echo -n "API /api/v1/modules: "
if curl -sf http://localhost:9999/api/v1/modules > /dev/null 2>&1; then
    echo "✅ OK"
else
    echo "❌ DOWN"
fi

echo -n "API /api/v1/workflows: "
if curl -sf http://localhost:9999/api/v1/workflows > /dev/null 2>&1; then
    echo "✅ OK"
else
    echo "❌ DOWN"
fi

echo ""
echo "========================================"
echo "All checks passed!"
echo "========================================"
