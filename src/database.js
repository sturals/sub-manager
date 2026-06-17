const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, '../database.json');

// The DB is kept in memory and persisted with a debounce + atomic rename.
// Previously every saveDb() synchronously rewrote the whole 30+ MB JSON file
// (hundreds of times per run) and every loadDb() re-parsed it from disk.

let db = null;
let saveTimer = null;
let dirty = false;

function loadDb() {
    if (db) return db;
    if (!fs.existsSync(dbPath)) {
        db = { subscriptions: [], nodes: {}, settings: {} };
    } else {
        try {
            db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        } catch (e) {
            // keep the corrupt file around instead of silently nuking user data
            try { fs.copyFileSync(dbPath, dbPath + '.corrupt'); } catch (e2) {}
            db = { subscriptions: [], nodes: {}, settings: {} };
        }
    }
    if (!db.subscriptions) db.subscriptions = [];
    if (!db.nodes) db.nodes = {};
    if (!db.settings) db.settings = {};
    if (!db.settings.token) {
        db.settings.token = crypto.randomBytes(16).toString('hex');
        flushSync();
    }
    return db;
}

function writeAtomic() {
    const tmp = dbPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dbPath);
    dirty = false;
}

// Schedule a save (debounced, at most one disk write per 2s)
function saveDb() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            if (dirty) writeAtomic();
        } catch (e) {
            console.error('Failed to save database:', e.message);
        }
    }, 2000);
}

function flushSync() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
        writeAtomic();
    } catch (e) {
        console.error('Failed to save database:', e.message);
    }
}

// Make sure pending changes hit the disk on shutdown
process.on('exit', () => { if (dirty) flushSync(); });
process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });

module.exports = { loadDb, saveDb, flushSync };
