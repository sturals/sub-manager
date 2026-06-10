const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, '../app.log');

const recentLogs = [];

function addMemoryLog(line) {
    recentLogs.push(line);
    if (recentLogs.length > 200) {
        recentLogs.shift();
    }
}

function log(message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}`;
    fs.appendFileSync(logPath, line + '\n');
    console.log(line);
    addMemoryLog(line);
}

function logError(message, error) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ERROR: ${message} - ${error.stack || error}`;
    fs.appendFileSync(logPath, line + '\n');
    console.error(line);
    addMemoryLog(line);
}

function getRecentLogs() {
    return recentLogs;
}

function clearLogs() {
    recentLogs.length = 0;
}

module.exports = { log, logError, getRecentLogs, clearLogs };
