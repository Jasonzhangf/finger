#!/usr/bin/env node
/**
 * Finger Daemon Guard - 双进程守护机制
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const FINGER_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(FINGER_ROOT, '.finger', 'runtime');
const PID_FILE = path.join(RUNTIME_DIR, 'server.pid');
const GUARD_PID_FILE = path.join(RUNTIME_DIR, 'guard.pid');
const HEARTBEAT_FILE = path.join(RUNTIME_DIR, 'daemon.heartbeat');
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 30000;
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 2000;

class DaemonGuard {
    constructor() {
        this.mainPid = null;
        this.guardPid = process.pid;
        this.restartCount = 0;
        this.isShuttingDown = false;
        console.log(`[DaemonGuard] Guard process started (PID: ${this.guardPid})`);
    }

    async start() {
        await this.spawnMainDaemon();
        this.startHeartbeatMonitor();
        this.startMainProcessCheck();
        this.setupExitHandlers();
    }

    async spawnMainDaemon() {
        console.log('[DaemonGuard] Starting main daemon...');
        await this.waitForPorts([9998, 9999]);
        this.cleanupOldProcesses();

        const mainProcess = spawn('node', [path.join(FINGER_ROOT, 'dist', 'server', 'index.js')], {
            stdio: ['ignore', 'pipe', 'ignore'],
            detached: true,
        });

        this.mainPid = mainProcess.pid;
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

        if (this.restartCount < MAX_RESTARTS) {
            this.restartCount++;
            console.log(`[DaemonGuard] Restarting daemon (attempt ${this.restartCount}/${MAX_RESTARTS})...`);
            setTimeout(() => {
                this.spawnMainDaemon().catch((err) => {
                    console.error('[DaemonGuard] Failed to restart daemon:', err);
                });
            }, RESTART_DELAY_MS);
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

    cleanupOldProcesses() {
        if (fs.existsSync(PID_FILE)) {
            try {
                const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
                if (oldPid && !isNaN(oldPid)) {
                    try {
                        process.kill(oldPid, 0);
                        console.log(`[DaemonGuard] Killed old daemon process (PID: ${oldPid})`);
                    } catch (e) {
                        // Process not exists
                    }
                }
            } catch (e) {
                // File read error
            }
        }

        if (fs.existsSync(HEARTBEAT_FILE)) {
            try {
                fs.unlinkSync(HEARTBEAT_FILE);
            } catch (e) {
                // Ignore error
            }
        }
    }

    setupExitHandlers() {
        const exitHandler = () => {
            this.isShuttingDown = true;
            console.log('[DaemonGuard] Shutting down...');
            this.cleanupMainProcess();
            this.cleanupGuardFiles();
            process.exit(0);
        };

        process.on('SIGINT', exitHandler);
        process.on('SIGTERM', exitHandler);
        process.on('exit', exitHandler);
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
