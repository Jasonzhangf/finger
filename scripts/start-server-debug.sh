#!/bin/bash
# 调试模式启动

PID_FILE="$HOME/.finger/runtime/server.pid"
LOG_FILE="$HOME/.finger/logs/server.log"

echo "=== 调试模式启动 ==="

# 清理
pids=$(pgrep -f "node.*dist/server/index.js" 2>/dev/null)
if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null
fi
rm -f "$PID_FILE"

# 启动并捕获所有输出
cd /Volumes/extension/code/finger

# 使用 stdbuf 禁用缓冲
node dist/server/index.js 2>&1 | tee "$LOG_FILE" &
NEW_PID=$!
echo $NEW_PID > "$PID_FILE"

echo "PID: $NEW_PID"
echo "监控中... (Ctrl+C 停止)"

# 等待进程退出
wait $NEW_PID
EXIT_CODE=$?
echo ""
echo "=== 进程退出 ==="
echo "退出码: $EXIT_CODE"
echo "时间: $(date)"
