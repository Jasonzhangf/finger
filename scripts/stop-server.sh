#!/bin/bash
# Finger 服务器停止脚本

PID_FILE="$HOME/.finger/runtime/server.pid"

echo "=== 停止 Finger 服务器 ==="

# 1. 从 PID 文件停止
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p $PID > /dev/null 2>&1; then
        echo "停止进程: PID=$PID"
        kill -TERM $PID 2>/dev/null
        sleep 2
        # 如果还在，强制杀死
        if ps -p $PID > /dev/null 2>&1; then
            kill -9 $PID 2>/dev/null
        fi
    fi
    rm -f "$PID_FILE"
fi

# 2. 清理端口
for port in 9999 9998; do
    pid_on_port=$(lsof -t -i :$port 2>/dev/null)
    if [ -n "$pid_on_port" ]; then
        kill -9 $pid_on_port 2>/dev/null
    fi
done

echo "服务器已停止"
