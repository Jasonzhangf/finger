/**
 * Daemon Command
 */

import { Command } from "commander";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { FINGER_PATHS, ensureFingerLayout } from "../../core/finger-paths.js";

const PID_FILE = FINGER_PATHS.runtime.daemonPid;
const LOG_FILE = FINGER_PATHS.logs.daemonLog;

export function daemonCommand(): Command {
  const cmd = new Command("daemon")
    .description("Daemon lifecycle management");

  cmd
    .command("start")
    .description("Start the daemon")
    .option("-d, --detach", "Run in background", false)
    .action(async (options) => {
      if (isRunning()) {
        console.log("Daemon already running");
        return;
      }

      if (options.detach) {
        startDetached();
      } else {
        const { CoreDaemon } = await import("../../core/daemon.js");
        const daemon = new CoreDaemon();
        await daemon.start();
        process.stdin.resume();
      }
    });

  cmd
    .command("stop")
    .description("Stop the daemon")
    .action(() => {
      if (!isRunning()) {
        console.log("Daemon not running");
        return;
      }
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8"), 10);
      process.kill(pid, "SIGTERM");
      console.log("Daemon stopped");
    });

  cmd
    .command("status")
    .description("Show daemon status")
    .action(() => {
      if (!isRunning()) {
        console.log("Daemon: not running");
        return;
      }
      const pid = fs.readFileSync(PID_FILE, "utf-8");
      console.log("Daemon: running (PID", pid + ")");
    });

  cmd
    .command("logs")
    .description("View daemon logs")
    .option("-f, --follow", "Follow log output", false)
    .option("-n, --lines <n>", "Number of lines", "50")
    .action((options) => {
      if (!fs.existsSync(LOG_FILE)) {
        console.log("No log file");
        return;
      }

      if (options.follow) {
        spawn("tail", ["-f", LOG_FILE], { stdio: "inherit" });
      } else {
        spawn("tail", ["-n", options.lines, LOG_FILE], { stdio: "inherit" });
      }
    });

  cmd
    .command("install")
    .description("Install as system service (systemd/launchd)")
    .action(() => {
      const platform = os.platform();
      if (platform === "darwin") {
        installLaunchd();
      } else if (platform === "linux") {
        installSystemd();
      } else {
        console.log("Unsupported platform:", platform);
      }
    });

  return cmd;
}

function isRunning(): boolean {
  if (!fs.existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8"), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startDetached(): void {
  ensureFingerLayout();
  const logFd = fs.openSync(LOG_FILE, "a");
  
  const scriptPath = path.join(__dirname, "..", "..", "core", "daemon.js");
  const proc = spawn("node", [scriptPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, FINGER_DAEMON: "1" },
  });

  proc.unref();
  fs.writeFileSync(PID_FILE, String(proc.pid));
  console.log("Daemon started with PID", proc.pid);
}

function installLaunchd(): void {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.finger.daemon.plist");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.finger.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>node</string>
        <string>${path.resolve(__dirname, "../../core/daemon.js")}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>
</dict>
</plist>`;

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  console.log("Installed launchd plist:", plistPath);
  console.log("Run: launchctl load", plistPath);
}

function installSystemd(): void {
  console.log("Install systemd service:");
  console.log("  sudo nano /etc/systemd/system/finger-daemon.service");
  console.log("  sudo systemctl daemon-reload");
  console.log("  sudo systemctl enable finger-daemon");
  console.log("  sudo systemctl start finger-daemon");
}
