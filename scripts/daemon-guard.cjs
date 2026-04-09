#!/usr/bin/env node
/**
 * Finger Daemon Guard - 双进程守护机制
 *
 * Lifecycle: guard → spawns daemon (detached) → daemon dies → guard restarts
 * Guard writes GUARD_PID_FILE. On startup, if an old guard PID exists, we kill
 * the old daemon tree (daemon + heartbeat-writer + kernel-bridge) to prevent orphans.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { matchesManagedFingerProcess } = require('./daemon-process-matchers.cjs');
const net = require('net');

const FINGER_ROOT = path.resolve(__dirname, '..');
function resolveFingerHome() {
    const override = process.env.FINGER_HOME;
    if (typeof override === 'string' && override.trim().length > 0) return override.trim();
    return path.join(os.homedir(), '.finger');
}
const FINGER_HOME = resolveFingerHome();
const RUNTIME_DIR = path.join(FINGER_HOME, 'runtime');
const PID_FILE = path.join(RUNTIME_DIR, 'server.pid');
const GUARD_PID_FILE = path.join(RUNTIME_DIR, 'guard.pid');
const LEGACY_PID_FILES = [
    path.join(RUNTIME_DIR, 'daemon.pid'),
    path.join(FINGER_HOME, 'daemon.pid'),
    path.join(FINGER_HOME, 'finger-daemon.pid'),
];
const HEARTBEAT_FILE = path.join(RUNTIME_DIR, 'daemon.heartbeat');
const HEARTBEAT_PATTERN = /daemon\.heartbeat/;
const USER_LOG_DIR = path.join(FINGER_HOME, 'logs');
const USER_DAEMON_LOG = path.join(USER_LOG_DIR, 'daemon.log');
const DAEMON_LOG_MAX_MB = Number.parseInt(process.env.FINGER_DAEMON_LOG_MAX_MB || '20', 10);
const DAEMON_LOG_ARCHIVE_LIMIT = Number.parseInt(process.env.FINGER_DAEMON_LOG_ARCHIVE_LIMIT || '8', 10);
const DAEMON_LOG_KEEP_MB_AFTER_COMPACT = Number.parseInt(process.env.FINGER_DAEMON_LOG_KEEP_MB_AFTER_COMPACT || '5', 10);
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 30000;
const RESTART_DELAY_MS = 2000;
const MAX_RESTARTS = Number.parseInt(process.env.FINGER_DAEMON_MAX_RESTARTS || '0', 10); // <=0 means unlimited
const ORPHAN_MAIL_PATTERN = /(\/\.finger\/scripts\/email_poll\.sh|email envelope list --account)/;

class DaemonGuard {
    constructor() {
        this.mainPid = null;
        this.guardPid = process.pid;
        this.restartCount = 0;
        this.isShuttingDown = false;
        this.heartbeatTimer = null;
        console.log(`[DaemonGuard] Guard process started (PID: ${this.guardPid})`);
    }

    async start() {
        this.cleanupLegacyPidFiles();
        // Kill any leftover daemon tree from a previous guard that died unexpectedly
        this.cleanupOrphanTree();
        await this.spawnMainDaemon();
        this.startHeartbeatMonitor();
        this.startMainProcessCheck();
        this.setupExitHandlers();
    }

    async spawnMainDaemon() {
        console.log('[DaemonGuard] Starting main daemon...');
        await this.waitForPorts([9998, 9999]);
        fs.mkdirSync(USER_LOG_DIR, { recursive: true });
        this.ensureDaemonLogWithinBudget();

        // Set NODE_PATH to include global openclaw package so that
        // external plugins (e.g. openclaw-weixin) can resolve "openclaw/plugin-sdk"
        const env = { ...process.env };
        env.NODE_PATH = [env.NODE_PATH, '/opt/homebrew/lib/node_modules']
            .filter(Boolean).join(path.delimiter);

        const mainProcess = spawn('node', [path.join(FINGER_ROOT, 'dist', 'server', 'index.js')], {
            stdio: ['ignore', fs.openSync(USER_DAEMON_LOG, 'a'), fs.openSync(USER_DAEMON_LOG, 'a')],
            detached: true,
            env,
        });

        this.mainPid = mainProcess.pid;
        this.mainProcess = mainProcess;
        fs.writeFileSync(PID_FILE, String(this.mainPid));
        console.log(`[DaemonGuard] Main daemon started (PID: ${this.mainPid})`);

        mainProcess.on('exit', (code, signal) => {
            console.log(`[DaemonGuard] Main daemon exited (code: ${code}, signal: ${signal})`);
            if (!this.isShuttingDown) {
                this.handleMainProcessCrash();
            }
        });

        mainProcess.on('error', (err) => {
            console.error('[DaemonGuard] Main daemon error:', err);
            if (!this.isShuttingDown) {
                this.handleMainProcessCrash();
            }
        });
    }

    startHeartbeatMonitor() {
        console.log('[DaemonGuard] Starting heartbeat monitor...');
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.heartbeatTimer = setInterval(() => {
            try {
                fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({
                    timestamp: Date.now(),
                    pid: this.mainPid,
                    guardPid: this.guardPid
                }));
                this.ensureDaemonLogWithinBudget();
            } catch (_) {}
        }, HEARTBEAT_INTERVAL_MS);
        console.log('[DaemonGuard] Heartbeat monitor started');
    }

    formatArchiveTimestamp(now = new Date()) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    }

    listDaemonArchiveLogs() {
        try {
            const entries = fs.readdirSync(USER_LOG_DIR);
            return entries
                .filter((name) => /^daemon-.*\.log$/.test(name))
                .map((name) => path.join(USER_LOG_DIR, name))
                .map((filePath) => {
                    try {
                        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
                    } catch (_) {
                        return null;
                    }
                })
                .filter(Boolean)
                .sort((a, b) => b.mtimeMs - a.mtimeMs);
        } catch (_) {
            return [];
        }
    }

    pruneDaemonArchiveLogs() {
        const maxArchives = Number.isFinite(DAEMON_LOG_ARCHIVE_LIMIT) && DAEMON_LOG_ARCHIVE_LIMIT >= 0
            ? DAEMON_LOG_ARCHIVE_LIMIT
            : 8;
        const archives = this.listDaemonArchiveLogs();
        if (archives.length <= maxArchives) return;
        const stale = archives.slice(maxArchives);
        for (const item of stale) {
            try {
                fs.unlinkSync(item.filePath);
            } catch (_) {}
        }
    }

    ensureDaemonLogWithinBudget() {
        const maxBytes = Math.max(1, DAEMON_LOG_MAX_MB) * 1024 * 1024;
        const keepBytes = Math.max(1, DAEMON_LOG_KEEP_MB_AFTER_COMPACT) * 1024 * 1024;
        try {
            if (!fs.existsSync(USER_DAEMON_LOG)) return;
            const stat = fs.statSync(USER_DAEMON_LOG);
            if (!stat.isFile() || stat.size <= maxBytes) return;

            const archivePath = path.join(USER_LOG_DIR, `daemon-${this.formatArchiveTimestamp()}.log`);
            try {
                fs.copyFileSync(USER_DAEMON_LOG, archivePath);
            } catch (_) {}

            let tail = Buffer.alloc(0);
            const bytesToRead = Math.min(stat.size, keepBytes);
            if (bytesToRead > 0) {
                const fd = fs.openSync(USER_DAEMON_LOG, 'r');
                try {
                    tail = Buffer.alloc(bytesToRead);
                    const start = Math.max(0, stat.size - bytesToRead);
                    fs.readSync(fd, tail, 0, bytesToRead, start);
                } finally {
                    fs.closeSync(fd);
                }
            }
            fs.writeFileSync(USER_DAEMON_LOG, tail);
            this.pruneDaemonArchiveLogs();
            console.warn(`[DaemonGuard] daemon.log compacted: ${Math.round(stat.size / 1024 / 1024)}MB -> ${Math.round(tail.length / 1024 / 1024)}MB`);
        } catch (error) {
            console.warn('[DaemonGuard] ensureDaemonLogWithinBudget failed:', error.message);
        }
    }

    startMainProcessCheck() {
        console.log('[DaemonGuard] Starting main process health check...');
        this.checkTimer = setInterval(() => {
            try {
                const result = process.kill(this.mainPid, 0);
                if (result === false) {
                    console.log(`[DaemonGuard] Main process is dead (PID: ${this.mainPid})`);
                    this.handleMainProcessCrash();
                    return;
                }

                if (fs.existsSync(HEARTBEAT_FILE)) {
                    const stats = fs.statSync(HEARTBEAT_FILE);
                    const now = new Date();
                    const fileAge = now.getTime() - stats.mtime.getTime();
                    if (fileAge > HEARTBEAT_TIMEOUT_MS) {
                        console.warn(`[DaemonGuard] Heartbeat timeout (${fileAge}ms > ${HEARTBEAT_TIMEOUT_MS}ms)`);
                        this.handleMainProcessCrash();
                    }
                } else {
                    console.warn('[DaemonGuard] Heartbeat file missing');
                }
            } catch (error) {
                console.error('[DaemonGuard] Health check error:', error);
                this.handleMainProcessCrash();
            }
        }, HEARTBEAT_INTERVAL_MS);
        console.log('[DaemonGuard] Main process health check started');
    }

    handleMainProcessCrash() {
        console.error('[DaemonGuard] Main process crashed!');
        this.cleanupMainProcess();

        const allowUnlimited = !Number.isFinite(MAX_RESTARTS) || MAX_RESTARTS <= 0;
        if (allowUnlimited || this.restartCount < MAX_RESTARTS) {
            this.restartCount += 1;
            const delay = Math.min(30000, RESTART_DELAY_MS * Math.max(1, this.restartCount));
            const maxText = allowUnlimited ? '∞' : String(MAX_RESTARTS);
            console.log(`[DaemonGuard] Restarting daemon (attempt ${this.restartCount}/${maxText}, delay=${delay}ms)...`);
            setTimeout(() => {
                this.spawnMainDaemon().catch((err) => {
                    console.error('[DaemonGuard] Failed to restart daemon:', err);
                });
            }, delay);
        } else {
            console.error(`[DaemonGuard] Max restarts reached (${MAX_RESTARTS}), exiting guard...`);
            this.shutdown();
        }
    }

    async waitForPorts(ports) {
        while (true) {
            const checks = await Promise.all(ports.map((port) => this.isPortAvailable(port)));
            if (checks.every(Boolean)) {
                return;
            }
            console.warn('[DaemonGuard] Port still in use, waiting for release...');
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    isPortAvailable(port) {
        return new Promise((resolve) => {
            const tester = net.createServer();
            tester.once('error', () => resolve(false));
            tester.once('listening', () => {
                tester.close(() => resolve(true));
            });
            tester.listen(port, '0.0.0.0');
        });
    }

    cleanupMainProcess() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        // Kill kernel-bridge if it was spawned alongside our daemon
        this.cleanupKernelBridge();

        if (this.mainPid) {
            this.killProcessTree(this.mainPid, 'main process');
        }
    }

    snapshotProcesses() {
        const rows = [];
        try {
            const psOutput = execSync('ps -eo pid,ppid,command', { encoding: 'utf8' });
            for (const line of psOutput.split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 3) continue;
                const pid = parseInt(parts[0], 10);
                const ppid = parseInt(parts[1], 10);
                if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
                rows.push({ pid, ppid, cmd: parts.slice(2).join(' ') });
            }
        } catch (_) {}
        return rows;
    }

    buildChildrenMap(rows) {
        const map = new Map();
        for (const row of rows) {
            if (!map.has(row.ppid)) map.set(row.ppid, []);
            map.get(row.ppid).push(row.pid);
        }
        return map;
    }

    collectDescendants(rootPid, childrenMap) {
        const out = [];
        const stack = [...(childrenMap.get(rootPid) || [])];
        const seen = new Set();
        while (stack.length > 0) {
            const pid = stack.pop();
            if (!pid || seen.has(pid)) continue;
            seen.add(pid);
            out.push(pid);
            const children = childrenMap.get(pid);
            if (children && children.length > 0) {
                for (const child of children) stack.push(child);
            }
        }
        return out;
    }

    /**
     * Kill orphan processes left behind by a previous guard that exited uncleanly.
     * Scans the process table for:
     *   1. node dist/server/index.js  (old daemon)
     *   2. node scripts/daemon-guard.cjs (old guard – kill it only if we are the new guard)
     *   3. node -e ... daemon.heartbeat (orphan heartbeat writers, ppid=1)
     *   4. finger-kernel-bridge-bin (orphan kernel bridges)
     */
    cleanupOldProcesses() {
        const rows = this.snapshotProcesses();
        const cmdByPid = new Map(rows.map((row) => [row.pid, row.cmd]));

        // 1. Read previous PID files
        if (fs.existsSync(PID_FILE)) {
            try {
                const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
                if (oldPid && !isNaN(oldPid)) {
                    const cmdline = cmdByPid.get(oldPid);
                    if (matchesManagedFingerProcess(cmdline, FINGER_ROOT, 'dist/server/index.js')) {
                        this.killProcessTree(oldPid, 'old daemon');
                    } else {
                        console.warn(`[DaemonGuard] Dirty server.pid, pid=${oldPid}, skip unrelated process`);
                    }
                }
            } catch (e) {}
        }

        // 2. Kill old guard if its PID file exists (we are replacing it)
        if (fs.existsSync(GUARD_PID_FILE)) {
            try {
                const oldGuardPid = parseInt(fs.readFileSync(GUARD_PID_FILE, 'utf8').trim());
                if (oldGuardPid && !isNaN(oldGuardPid) && oldGuardPid !== process.pid) {
                    const cmdline = cmdByPid.get(oldGuardPid);
                    if (matchesManagedFingerProcess(cmdline, FINGER_ROOT, 'scripts/daemon-guard.cjs')) {
                        this.killProcessTree(oldGuardPid, 'old guard');
                    } else {
                        console.warn(`[DaemonGuard] Dirty guard.pid, pid=${oldGuardPid}, skip unrelated process`);
                    }
                }
            } catch (e) {}
        }
    }

    /**
     * Aggressive cleanup: kill ALL orphan daemon/heartbeat/kernel-bridge processes
     * that belong to this finger installation, regardless of PID files.
     * Called once at guard startup.
     */
    cleanupOrphanTree() {
        this.cleanupOldProcesses();

        // Kill orphan heartbeat writers (ppid=1 means their parent is dead)
        try {
            const rows = this.snapshotProcesses();
            for (const row of rows) {
                const { pid, ppid, cmd } = row;
                // Orphan heartbeat writers: parent dead, and they reference our heartbeat path
                if (ppid === 1 && HEARTBEAT_PATTERN.test(cmd)) {
                    this.killProcessTree(pid, 'orphan heartbeat writer');
                }
                // Orphan daemons: dist/server/index.js with ppid=1
                if (ppid === 1 && matchesManagedFingerProcess(cmd, FINGER_ROOT, 'dist/server/index.js')) {
                    this.killProcessTree(pid, 'orphan daemon');
                }
                // Orphan guards: daemon-guard.cjs with ppid=1 (except current guard)
                if (
                    ppid === 1 &&
                    matchesManagedFingerProcess(cmd, FINGER_ROOT, 'scripts/daemon-guard.cjs') &&
                    pid !== process.pid
                ) {
                    this.killProcessTree(pid, 'orphan guard');
                }
                // Orphan kernel bridges: ppid=1
                if (ppid === 1 && cmd.includes('finger-kernel-bridge-bin')) {
                    this.killProcessTree(pid, 'orphan kernel-bridge');
                }
                // Orphan mail polling shell/processes from previous daemon turns
                if (ppid === 1 && ORPHAN_MAIL_PATTERN.test(cmd)) {
                    this.killProcessTree(pid, 'orphan mail-poll');
                }
            }
        } catch (e) {
            console.warn('[DaemonGuard] orphan scan failed:', e.message);
        }
    }

    killProcessTree(pid, label) {
        const rows = this.snapshotProcesses();
        const childrenMap = this.buildChildrenMap(rows);
        const descendants = this.collectDescendants(pid, childrenMap);
        const ordered = [...descendants.reverse(), pid];
        const sent = [];

        for (const currentPid of ordered) {
            try {
                process.kill(currentPid, 'SIGTERM');
                sent.push(currentPid);
            } catch (_) {}
        }
        if (sent.length > 0) {
            console.log(`[DaemonGuard] Sent SIGTERM to ${label} tree`, { rootPid: pid, count: sent.length });
        } else {
            console.log(`[DaemonGuard] ${label} (PID: ${pid}) already terminated`);
        }

        setTimeout(() => {
            for (const currentPid of sent) {
                try { process.kill(currentPid, 'SIGKILL'); } catch (_) {}
            }
        }, 3000);
    }

    cleanupKernelBridge() {
        try {
            const psOutput = execSync('ps -eo pid,ppid,command', { encoding: 'utf8' });
            for (const line of psOutput.split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 3) continue;
                const pid = parseInt(parts[0]);
                const ppid = parseInt(parts[1]);
                const cmd = parts.slice(2).join(' ');
                if (ppid === this.mainPid && cmd.includes('finger-kernel-bridge-bin')) {
                    console.log(`[DaemonGuard] Killing kernel-bridge (PID: ${pid})`);
                    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
                }
            }
        } catch (e) {}
    }

    setupExitHandlers() {
        const signalHandler = () => {
            this.isShuttingDown = true;
            console.log('[DaemonGuard] Shutting down...');
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }
            this.cleanupMainProcess();
            this.cleanupGuardFiles();
            process.exit(0);
        };

        process.on('SIGINT', signalHandler);
        process.on('SIGTERM', signalHandler);
        process.on('exit', () => {
            this.isShuttingDown = true;
            this.cleanupMainProcess();
            this.cleanupGuardFiles();
        });
    }

    cleanupGuardFiles() {
        try {
            if (fs.existsSync(PID_FILE)) {
                fs.unlinkSync(PID_FILE);
            }
            if (fs.existsSync(GUARD_PID_FILE)) {
                fs.unlinkSync(GUARD_PID_FILE);
            }
            this.cleanupLegacyPidFiles();
            if (fs.existsSync(HEARTBEAT_FILE)) {
                fs.unlinkSync(HEARTBEAT_FILE);
            }
            console.log('[DaemonGuard] Guard files cleaned up');
        } catch (e) {
            console.error('[DaemonGuard] Error cleaning up guard files:', e);
        }
    }

    cleanupLegacyPidFiles() {
        for (const file of LEGACY_PID_FILES) {
            try {
                if (fs.existsSync(file)) fs.unlinkSync(file);
            } catch (_) {}
        }
    }

    shutdown() {
        console.log('[DaemonGuard] Initiating shutdown...');
        this.isShuttingDown = true;
        this.cleanupMainProcess();
        this.cleanupGuardFiles();
        process.exit(0);
    }
}

if (require.main === module) {
    const guard = new DaemonGuard();
    guard.start();
    fs.writeFileSync(GUARD_PID_FILE, String(process.pid));
}
