#!/usr/bin/env python3
"""
Hold an advisory lock on guard.lock, then run daemon-guard.
This is a flock-compatible fallback for platforms without `flock` binary.
"""
import fcntl
import os
import signal
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 4:
        return 2

    lock_file = sys.argv[1]
    node_path = sys.argv[2]
    guard_script = sys.argv[3]

    os.makedirs(os.path.dirname(lock_file), exist_ok=True)
    lock_fd = os.open(lock_file, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 73

    child = subprocess.Popen([node_path, guard_script], close_fds=True)

    def _forward(sig, _frame):
        try:
            child.send_signal(sig)
        except Exception:
            pass

    signal.signal(signal.SIGTERM, _forward)
    signal.signal(signal.SIGINT, _forward)

    try:
        return child.wait()
    finally:
        try:
            os.close(lock_fd)
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())

