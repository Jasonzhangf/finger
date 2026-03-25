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
const { spawn, execSync } = require('child_process');
const net = require('net');

const FINGER_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(FINGER_ROOT, '.finger', 'runtime');
const PID_FILE = path.join(RUNTIME_DIR, 'server.pid');
const GUARD_PID_FILE = path.join(RUNTIME_DIR, 'guard.pid');
const HEARTBEAT_FILE = path.join(RUNTIME_DIR, 'daemon.heartbeat');
const HEARTBEAT_PATTERN = /daemon\.heartbeat/;
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 30000;
const RESTART_DELAY_MS = 2000;
const MAX_RESTARTS = Number.parseInt(process.env.FINGER_DAEMON_MAX_RESTARTS || '0', 10); // <=0 means unlimited

class DaemonGuard {
    constructor() {
        this.mainPid = null;
        this.guardPid = process.pid;
        this.restartCount = 0;
        this.isShuttingDown = false;
        this.heartbeatWriterPid = null;
        console.log(`[DaemonGuard] Guard process started (PID: ${this.guardPid})`);
    }

    async start() {
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

        // Set NODE_PATH to include global openclaw package so that
        // external plugins (e.g. openclaw-weixin) can resolve "openclaw/plugin-sdk"
        const env = { ...process.env };
        env.NODE_PATH = [env.NODE_PATH, '/opt/homebrew/lib/node_modules']
            .filter(Boolean).join(path.delimiter);

        const mainProcess = spawn('node', [path.join(FINGER_ROOT, 'dist', 'server', 'index.js')], {
            stdio: ['ignore', fs.openSync(path.join(require('os').homedir(), '.finger', 'logs', 'daemon.log'), 'a'), fs.openSync(path.join(require('os').homedir(), '.finger', 'logs', 'daemon.log'), 'a')],
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
        const heartbeatWriter = spawn('node', ['-e', `
            const fs = require('fs');
            const heartbeatFile = '${HEARTBEAT_FILE}';
            setInterval(() => {
                fs.writeFileSync(heartbeatFile, JSON.stringify({
                    timestamp: Date.now(),
                    pid: ${this.mainPid},
                    guardPid: ${this.guardPid}
                }));
            }, ${HEARTBEAT_INTERVAL_MS});
        `], {
            stdio: ['ignore', 'pipe', 'ignore'],
            detached: true,
        });
        this.heartbeatWriterPid = heartbeatWriter.pid;
        console.log('[DaemonGuard] Heartbeat monitor started');
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
        // Kill heartbeat writer if we spawned one
        if (this.heartbeatWriterPid) {
            try { process.kill(this.heartbeatWriterPid, 'SIGTERM'); } catch (_) {}
            this.heartbeatWriterPid = null;
        }
        // Kill kernel-bridge if it was spawned alongside our daemon
        this.cleanupKernelBridge();

        if (this.mainPid) {
            try {
                process.kill(this.mainPid, 'SIGTERM');
                console.log(`[DaemonGuard] Sent SIGTERM to main process (PID: ${this.mainPid})`);
                setTimeout(() => {
                    try {
                        process.kill(this.mainPid, 'SIGKILL');
                        console.log(`[DaemonGuard] Sent SIGKILL to main process (PID: ${this.mainPid})`);
                    } catch (e) {
                        // Process already terminated
                    }
                }, 5000);
            } catch (e) {
                console.log(`[DaemonGuard] Main process already terminated`);
            }
        }
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
        // 1. Read previous PID files
        if (fs.existsSync(PID_FILE)) {
            try {
                const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
                if (oldPid && !isNaN(oldPid)) {
                    this.killProcessTree(oldPid, 'old daemon');
                }
            } catch (e) {}
        }

        // 2. Kill old guard if its PID file exists (we are replacing it)
        if (fs.existsSync(GUARD_PID_FILE)) {
            try {
                const oldGuardPid = parseInt(fs.readFileSync(GUARD_PID_FILE, 'utf8').trim());
                if (oldGuardPid && !isNaN(oldGuardPid) && oldGuardPid !== process.pid) {
                    this.killProcessTree(oldGuardPid, 'old guard');
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
            const psOutput = execSync('ps -eo pid,ppid,command', { encoding: 'utf8' });
            for (const line of psOutput.split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 3) continue;
                const pid = parseInt(parts[0]);
                const ppid = parseInt(parts[1]);
                const cmd = parts.slice(2).join(' ');
                // Orphan heartbeat writers: parent dead, and they reference our heartbeat path
                if (ppid === 1 && HEARTBEAT_PATTERN.test(cmd)) {
                    console.log(`[DaemonGuard] Killing orphan heartbeat writer (PID: ${pid})`);
                    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
                }
                // Orphan daemons: dist/server/index.js with ppid=1
                if (ppid === 1 && cmd.includes('dist/server/index.js') && cmd.includes(FINGER_ROOT)) {
                    console.log(`[DaemonGuard] Killing orphan daemon (PID: ${pid})`);
                    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
                }
                // Orphan kernel bridges: ppid=1
                if (ppid === 1 && cmd.includes('finger-kernel-bridge-bin')) {
                    console.log(`[DaemonGuard] Killing orphan kernel-bridge (PID: ${pid})`);
                    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
                }
            }
        } catch (e) {
            console.warn('[DaemonGuard] orphan scan failed:', e.message);
        }
    }

    killProcessTree(pid, label) {
        try {
            process.kill(pid, 'SIGTERM');
            console.log(`[DaemonGuard] Sent SIGTERM to ${label} (PID: ${pid})`);
            // Give it 3s to exit, then SIGKILL
            setTimeout(() => {
                try { process.kill(pid, 'SIGKILL'); } catch (_) {}
            }, 3000);
        } catch (e) {
            console.log(`[DaemonGuard] ${label} (PID: ${pid}) already terminated`);
        }
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
            if (this.heartbeatWriterPid) {
                try { process.kill(this.heartbeatWriterPid, 'SIGTERM'); } catch (_) {}
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
            if (fs.existsSync(HEARTBEAT_FILE)) {
                fs.unlinkSync(HEARTBEAT_FILE);
            }
            console.log('[DaemonGuard] Guard files cleaned up');
        } catch (e) {
            console.error('[DaemonGuard] Error cleaning up guard files:', e);
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
