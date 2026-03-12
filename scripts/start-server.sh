#!/bin/bash
# Finger 服务器单实例启动脚本
# 功能：杀掉旧实例，启动新实例，确保单实例运行

PID_FILE="$HOME/.finger/runtime/server.pid"
LOG_FILE="$HOME/.finger/logs/server.log"
SERVER_SCRIPT="/Volumes/extension/code/finger/dist/server/index.js"

echo "=== Finger 服务器单实例启动 ==="

# 1. 检查并杀掉旧实例
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p $OLD_PID > /dev/null 2>&1; then
        echo "杀掉旧实例: PID=$OLD_PID"
        kill -9 $OLD_PID 2>/dev/null
        sleep 1
    fi
    rm -f "$PID_FILE"
fi

# 2. 确保端口空闲（仅针对 9999/9998）
for port in 9999 9998; do
    pid_on_port=$(lsof -t -i :$port 2>/dev/null)
    if [ -n "$pid_on_port" ]; then
        echo "端口 $port 被占用，尝试释放: PID=$pid_on_port"
        for pid in $pid_on_port; do
            if ps -p "$pid" > /dev/null 2>&1; then
                kill -9 "$pid" 2>/dev/null
            fi
        done
        sleep 1
    fi
done

# 4. 启动新实例
echo "启动服务器..."
mkdir -p "$(dirname "$PID_FILE")"
mkdir -p "$(dirname "$LOG_FILE")"

nohup node "$SERVER_SCRIPT" > "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo $NEW_PID > "$PID_FILE"
echo "服务器已启动: PID=$NEW_PID"

# 5. 等待并验证
sleep 3
if ps -p $NEW_PID > /dev/null 2>&1; then
    echo "服务器运行中"
    lsof -i :9999 -P | grep LISTEN && echo "HTTP 端口: OK"
    lsof -i :9998 -P | grep LISTEN && echo "WebSocket 端口: OK"
else
    echo "服务器启动失败，查看日志:"
    tail -20 "$LOG_FILE"
    exit 1
fi
