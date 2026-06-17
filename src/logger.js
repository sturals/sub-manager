const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, '../app.log');
const MAX_LOG_SIZE = 1024 * 1024; // 1 MB

// Simple rotation on startup: app.log -> app.log.1
try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_SIZE) {
        fs.renameSync(logPath, logPath + '.1');
    }
} catch (e) { /* non-fatal */ }

const recentLogs = [];

function addMemoryLog(line) {
    recentLogs.push(line);
    if (recentLogs.length > 200) {
        recentLogs.shift();
    }
}

function writeLine(line, isError) {
    try {
        fs.appendFileSync(logPath, line + '\n');
    } catch (e) { /* non-fatal */ }
    (isError ? console.error : console.log)(line);
    addMemoryLog(line);
}

function log(message) {
    writeLine(`[${new Date().toISOString()}] ${message}`, false);
}

function logWarn(message) {
    writeLine(`[${new Date().toISOString()}] WARN: ${message}`, false);
}

function logError(message, error) {
    const details = error ? ` - ${error.stack || error}` : '';
    writeLine(`[${new Date().toISOString()}] ERROR: ${message}${details}`, true);
}

function getRecentLogs() {
    return recentLogs;
}

function clearLogs() {
    recentLogs.length = 0;
}

module.exports = { log, logWarn, logError, getRecentLogs, clearLogs };
