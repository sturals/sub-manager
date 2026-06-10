const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const { loadDb, saveDb } = require('./src/database');
const { fetchSubscriptions } = require('./src/subscription');
const { testNodes } = require('./src/tester');
const { log, logError, getRecentLogs, clearLogs } = require('./src/logger');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

let currentStatus = { isRunning: false, progress: 0, total: 0, stage: 'idle' };

app.get('/api/subs', (req, res) => {
    const db = loadDb();
    res.json(db.subscriptions || []);
});

const os = require('os');
app.get('/api/ip', (req, res) => {
    const interfaces = os.networkInterfaces();
    let localIp = 'localhost';
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                // Return the first non-internal IPv4 address found
                localIp = iface.address;
                break;
            }
        }
    }
    res.json({ ip: localIp, port: 3000 });
});

app.post('/api/subs', (req, res) => {
    const db = loadDb();
    db.subscriptions = req.body.urls || [];
    saveDb(db);
    res.json({ success: true });
});

app.get('/api/status', (req, res) => {
    res.json({ ...currentStatus, logs: getRecentLogs() });
});

app.post('/api/stop', (req, res) => {
    if (currentStatus.isRunning) {
        currentStatus.cancelRequested = true;
        log('Получен запрос на остановку проверки...');
        const { abortTesting } = require('./src/tester');
        abortTesting();
    }
    res.json({ success: true });
});

app.post('/api/run', async (req, res) => {
    if (currentStatus.isRunning) {
        return res.status(400).json({ error: 'Already running' });
    }
    
    clearLogs();
    currentStatus = { isRunning: true, progress: 0, total: 0, stage: 'fetching', cancelRequested: false };
    res.json({ success: true });
    
    try {
        const db = loadDb();
        
        // 1. Fetch
        const { uniqueNodes, duplicatesCount } = await fetchSubscriptions(db.subscriptions);
        db.lastDuplicatesCount = duplicatesCount;
        const nodes = uniqueNodes;
        
        if (currentStatus.cancelRequested) throw new Error('Остановлено пользователем');

        // 2. Filter
        currentStatus.stage = 'filtering';
        const nodesToTest = [];
        
        for (const node of nodes) {
            const existing = db.nodes[node.id];
            if (existing) {
                // If dead in the past, skip checking
                if (existing.status === 'dead') {
                    continue; 
                }
                // If active in the past, we re-test to see if it's still active
                nodesToTest.push(node);
            } else {
                // New node
                nodesToTest.push(node);
                db.nodes[node.id] = { status: 'unchecked', originalLink: node.originalLink };
            }
        }
        
        if (currentStatus.cancelRequested) throw new Error('Остановлено пользователем');

        // 3. Test
        currentStatus.stage = 'testing';
        currentStatus.total = nodesToTest.length;
        log(`Начинаем проверку. Узлов для проверки: ${nodesToTest.length}. (Всего найдено: ${nodes.length}, дубликатов: ${duplicatesCount})`);
        
        const { overwriteRemarkWithFlag } = require('./src/flag');
        const { parseProxyLink } = require('./src/parser');
        
        const seenRealIps = new Set();
        
        // chunk testing because of port limits (if many nodes)
        const CHUNK_SIZE = 50; 
        for (let i = 0; i < nodesToTest.length; i += CHUNK_SIZE) {
            if (currentStatus.cancelRequested) {
                log('Проверка остановлена пользователем');
                break;
            }
            const chunk = nodesToTest.slice(i, i + CHUNK_SIZE);
            log(`Проверка чанка ${i} - ${i + chunk.length}`);
            const results = await testNodes(chunk);
            
            for (const result of results) {
                const node = db.nodes[result.id];
                node.lastChecked = new Date().toISOString();
                
                if (result.status === 'active' && result.realIp && result.country) {
                    if (seenRealIps.has(result.realIp)) {
                        node.status = 'duplicate'; // Mark as duplicate IP
                        log(`Дубликат по реальному IP: ${result.realIp}`);
                    } else {
                        seenRealIps.add(result.realIp);
                        node.status = 'active';
                        
                        if (node.originalLink) {
                            node.originalLink = overwriteRemarkWithFlag(node.originalLink, result.country, result.realIp);
                        }
                    }
                } else {
                    node.status = result.status;
                }
                
                currentStatus.progress++;
            }
            saveDb(db); // save periodically
        }
        
        // Cleanup: mark any remaining 'unchecked' nodes as dead (orphans from interrupted runs)
        let cleanedUp = 0;
        for (const k in db.nodes) {
            if (db.nodes[k].status === 'unchecked') {
                db.nodes[k].status = 'dead';
                cleanedUp++;
            }
        }
        if (cleanedUp > 0) {
            log(`Очищено ${cleanedUp} устаревших узлов из прошлых запусков`);
            saveDb(db);
        }
        
        currentStatus.stage = 'idle';
        currentStatus.isRunning = false;
        log('Процесс завершен');
        
    } catch (e) {
        logError('Процесс прерван или произошла ошибка', e);
        currentStatus.stage = 'error';
        currentStatus.isRunning = false;
    }
});

app.get('/api/stats', (req, res) => {
    const db = loadDb();
    let total = 0;
    let active = 0;
    let dead = 0;
    let unchecked = 0;
    let duplicateIp = 0;
    for(const k in db.nodes) {
        total++;
        if(db.nodes[k].status === 'active') active++;
        else if(db.nodes[k].status === 'dead') dead++;
        else if(db.nodes[k].status === 'duplicate') duplicateIp++;
        else unchecked++;
    }
    res.json({ total, active, dead, unchecked, duplicates: (db.lastDuplicatesCount || 0) + duplicateIp });
});

app.get('/sub', (req, res) => {
    const db = loadDb();
    let activeLinks = [];
    for (const k in db.nodes) {
        if (db.nodes[k].status === 'active') {
            activeLinks.push(db.nodes[k].originalLink);
        }
    }
    const b64 = Buffer.from(activeLinks.join('\n')).toString('base64');
    res.send(b64);
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    log(`Server running on http://localhost:${PORT}`);
});
