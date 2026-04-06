#!/usr/bin/env bash
# start-daemon.sh - Finger Daemon 启动脚本
# 包含健康检查、孤儿清理、自动重启

set -euo pipefail

FINGER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$FINGER_DIR/.daemon.pid"
LOG_DIR="$HOME/.finger/logs"
LOG_FILE="$LOG_DIR/daemon-$(date +%Y%m%d-%H%M%S).log"
NODE="$(which node)"

mkdir -p "$LOG_DIR"

# 清理孤儿 kernel bridge 进程
cleanup_orphans() {
  local orphans=$(ps aux | grep finger-kernel-bridge-bin | grep -v grep | awk '{print $2}')
  if [ -n "$orphans" ]; then
    echo "[$(date)] Cleaning up $(echo "$orphans" | wc -l | tr -d ' ') orphan kernel bridge processes"
    for pid in $orphans; do
      # 只杀没有父进程的孤儿（ppid=1 或 ppid 不在）
      local ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tail -1 | tr -d ' ')
      if [ "$ppid" = "1" ] || [ -z "$ppid" ]; then
        kill "$pid" 2>/dev/null && echo "  Killed orphan PID $pid"
      fi
    done
  fi
}

# 健康检查
health_check() {
  local pid="$1"
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  # 检查 HTTP 端口
  if ! lsof -i :9999 -P -p "$pid" 2>/dev/null | grep -q LISTEN; then
    return 1
  fi
  return 0
}

# 停止旧 daemon
stop_daemon() {
  if [ -f "$PID_FILE" ]; then
    local old_pid
    old_pid=$(cat "$PID_FILE")
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      echo "[$(date)] Stopping old daemon (PID $old_pid)..."
      kill "$old_pid" 2>/dev/null
      sleep 3
      # 强制清理
      if kill -0 "$old_pid" 2>/dev/null; then
        kill -9 "$old_pid" 2>/dev/null
      fi
    fi
    rm -f "$PID_FILE"
  fi
}

# 主流程
main() {
  echo "=== Finger Daemon Manager ==="
  echo "Log: $LOG_FILE"

  # 清理孤儿
  cleanup_orphans

  # 停止旧进程
  stop_daemon

  # 启动 daemon
  echo "[$(date)] Starting daemon..."
  cd "$FINGER_DIR"
  nohup "$NODE" dist/server/index.js >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  echo "PID: $pid"

  # 等待启动
  sleep 10

  # 健康检查
  if health_check "$pid"; then
    echo "[$(date)] ✅ Daemon started successfully (PID $pid)"
    echo "[$(date)] HTTP: http://127.0.0.1:9999"
    echo "[$(date)] WebSocket: ws://127.0.0.1:9998"
    echo "[$(date)] Log: $LOG_FILE"
  else
    echo "[$(date)] ❌ Daemon failed to start!"
    echo "[$(date)] Check log: $LOG_FILE"
    tail -30 "$LOG_FILE"
    exit 1
  fi
}

main "$@"
