const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../database.json');

function loadDb() {
    if (!fs.existsSync(dbPath)) {
        return { subscriptions: [], nodes: {} };
    }
    try {
        return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    } catch (e) {
        return { subscriptions: [], nodes: {} };
    }
}

function saveDb(data) {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

module.exports = { loadDb, saveDb };
