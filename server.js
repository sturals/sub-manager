const express = require('express');
const path = require('path');
const os = require('os');
const { loadDb, saveDb, flushSync } = require('./src/database');
const { fetchSubscriptions } = require('./src/subscription');
const { testNodes, abortTesting } = require('./src/tester');
const { overwriteRemarkWithFlag } = require('./src/flag');
const { log, logWarn, logError, getRecentLogs, clearLogs } = require('./src/logger');

const PORT = parseInt(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Dead-node retest policy: exponential backoff, give up after MAX_FAILS
const DEAD_RETEST_BACKOFF_DAYS = [1, 3, 7];
const MAX_FAILS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

class CancelledError extends Error {
    constructor() { super('Остановлено пользователем'); this.cancelled = true; }
}

const app = express();
app.use(express.json());

// --- Security ---------------------------------------------------------------
// 1. Host-header check: blocks DNS-rebinding (a malicious website resolving
//    its domain to 127.0.0.1 and driving this API from the browser).
// 2. /api/* and /sub require the access token unless the request comes from
//    this same machine. The token is auto-generated and stored in the DB.
const HOSTNAME_RE = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[?[0-9a-fA-F:]+\]?)$/;

function isLoopback(addr) {
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

app.use((req, res, next) => {
    if (!HOSTNAME_RE.test(req.hostname || '')) {
        return res.status(403).json({ error: 'Forbidden host' });
    }
    next();
});

app.use(['/api', '/sub'], (req, res, next) => {
    if (isLoopback(req.socket.remoteAddress)) return next();
    const db = loadDb();
    const token = req.query.token || req.get('x-token');
    if (token && token === db.settings.token) return next();
    return res.status(403).json({ error: 'Forbidden: token required (see export URL on the dashboard)' });
});

app.use(express.static(path.join(__dirname, 'public')));
// -----------------------------------------------------------------------------

let currentStatus = { isRunning: false, progress: 0, total: 0, stage: 'idle' };

app.get('/api/subs', (req, res) => {
    const db = loadDb();
    res.json(db.subscriptions || []);
});

app.get('/api/ip', (req, res) => {
    const interfaces = os.networkInterfaces();
    let localIp = 'localhost';
    // return the FIRST non-internal IPv4 (labeled loop — `break` inside the
    // inner loop alone kept overwriting localIp with every next adapter)
    outer:
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIp = iface.address;
                break outer;
            }
        }
    }
    const db = loadDb();
    res.json({ ip: localIp, port: PORT, token: db.settings.token });
});

app.post('/api/subs', (req, res) => {
    const urls = req.body.urls || [];
    if (!Array.isArray(urls) || urls.some(u => typeof u !== 'string' || !/^https?:\/\//i.test(u))) {
        return res.status(400).json({ error: 'Каждая подписка должна быть http(s) URL' });
    }
    const uniqueUrls = [...new Set(urls)];
    if (uniqueUrls.length !== urls.length) {
        return res.status(400).json({ error: 'Список содержит дубликаты адресов' });
    }
    const db = loadDb();
    db.subscriptions = urls;
    saveDb();
    res.json({ success: true });
});

app.get('/api/status', (req, res) => {
    res.json({ ...currentStatus, logs: getRecentLogs() });
});

app.post('/api/stop', (req, res) => {
    if (currentStatus.isRunning) {
        currentStatus.cancelRequested = true;
        log('Получен запрос на остановку проверки...');
        abortTesting();
    }
    res.json({ success: true });
});

// Decides whether a previously dead node deserves a retest
function deadNodeIsDue(record) {
    const fails = record.failCount || 1;
    if (fails >= MAX_FAILS) return false; // tombstone: stop wasting time on it
    if (!record.lastChecked) return true;
    const waitDays = DEAD_RETEST_BACKOFF_DAYS[Math.min(fails - 1, DEAD_RETEST_BACKOFF_DAYS.length - 1)];
    return (Date.now() - Date.parse(record.lastChecked)) >= waitDays * DAY_MS;
}

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
        const fetchedIds = new Set(nodes.map(n => n.id));

        if (currentStatus.cancelRequested) throw new CancelledError();

        // 2. Filter
        currentStatus.stage = 'filtering';
        const nodesToTest = [];
        let skippedDead = 0;
        let retestDead = 0;

        for (const node of nodes) {
            const existing = db.nodes[node.id];
            if (existing) {
                if (existing.status === 'dead') {
                    // dead is no longer forever: retest with backoff (1/3/7 days),
                    // give up only after MAX_FAILS consecutive failures
                    if (deadNodeIsDue(existing)) {
                        retestDead++;
                        nodesToTest.push(node);
                    } else {
                        skippedDead++;
                    }
                    continue;
                }
                // active / duplicate / unchecked from interrupted runs — re-test
                nodesToTest.push(node);
            } else {
                nodesToTest.push(node);
                db.nodes[node.id] = { status: 'unchecked', originalLink: node.originalLink };
            }
        }

        if (currentStatus.cancelRequested) throw new CancelledError();

        // 3. Test
        currentStatus.stage = 'testing';
        currentStatus.total = nodesToTest.length;
        log(`Начинаем проверку. Узлов для проверки: ${nodesToTest.length} (повторная проверка мертвых: ${retestDead}, пропущено мертвых: ${skippedDead}). Всего найдено: ${nodes.length}, дубликатов: ${duplicatesCount}`);

        const seenRealIps = new Set();

        const CHUNK_SIZE = 50; // port limits
        for (let i = 0; i < nodesToTest.length; i += CHUNK_SIZE) {
            if (currentStatus.cancelRequested) break;

            const chunk = nodesToTest.slice(i, i + CHUNK_SIZE);
            log(`Проверка чанка ${i} - ${i + chunk.length}`);
            const { results, completed } = await testNodes(chunk);

            if (!completed) {
                // xray was killed mid-chunk (stop pressed / startup failure):
                // these results are not trustworthy — do NOT mark nodes dead
                log('Чанк не был завершен — результаты отброшены, узлы останутся непроверенными');
                continue;
            }

            for (const result of results) {
                const node = db.nodes[result.id];
                if (!node) continue;
                node.lastChecked = new Date().toISOString();

                if (result.status === 'active' && result.realIp && result.country) {
                    node.failCount = 0;
                    if (seenRealIps.has(result.realIp)) {
                        node.status = 'duplicate'; // same exit IP as another node
                        log(`Дубликат по реальному IP: ${result.realIp}`);
                    } else {
                        seenRealIps.add(result.realIp);
                        // Запоминаем дату первого успешного прохождения
                        if (!node.activeFrom) {
                            node.activeFrom = new Date().toISOString();
                        }
                        node.status = 'active';
                        node.latency = result.latency;
                        node.country = result.country;
                        node.realIp = result.realIp;

                        if (node.originalLink) {
                            node.originalLink = overwriteRemarkWithFlag(node.originalLink, result.country, result.realIp);
                        }
                    }
                } else {
                    node.status = 'dead';
                    node.failCount = (node.failCount || 0) + 1;
                    node.activeFrom = null; // сбрасываем при смерти — uptime считается от последнего «воскрешения»
                }

                currentStatus.progress++;
            }
            saveDb(); // debounced; cheap to call per chunk
        }

        if (currentStatus.cancelRequested) throw new CancelledError();

        // 4. Prune (only after a fully completed run!): records that are no
        // longer present in any subscription are useless — except active ones,
        // which the user may still rely on in the exported list.
        let pruned = 0;
        for (const id of Object.keys(db.nodes)) {
            if (fetchedIds.has(id)) continue;
            const st = db.nodes[id].status;
            if (st === 'dead' || st === 'duplicate' || st === 'unchecked') {
                delete db.nodes[id];
                pruned++;
            }
        }
        if (pruned > 0) {
            log(`Удалено ${pruned} узлов, которых больше нет ни в одной подписке`);
        }
        saveDb();

        currentStatus.stage = 'idle';
        currentStatus.isRunning = false;
        log('Процесс завершен');

    } catch (e) {
        if (e instanceof CancelledError) {
            log('Проверка остановлена пользователем');
            currentStatus.stage = 'cancelled';
        } else {
            logError('Процесс прерван или произошла ошибка', e);
            currentStatus.stage = 'error';
        }
        saveDb();
        currentStatus.isRunning = false;
    }
});

// ---------------------------------------------------------------------------
// GET /api/nodes — список активных узлов с uptime-метаданными для дашборда
// ---------------------------------------------------------------------------
app.get('/api/nodes', (req, res) => {
    const db = loadDb();
    const now = Date.now();
    const nodes = [];
    for (const [id, node] of Object.entries(db.nodes)) {
        if (node.status !== 'active') continue;
        const activeFromMs = node.activeFrom ? Date.parse(node.activeFrom) : null;
        const uptimeDays = activeFromMs ? Math.floor((now - activeFromMs) / DAY_MS) : 0;
        nodes.push({
            id,
            country: node.country || '??',
            realIp: node.realIp || '',
            latency: node.latency || 0,
            activeFrom: node.activeFrom || null,
            uptimeDays,
        });
    }
    res.json(nodes);
});

app.get('/api/stats', (req, res) => {
    const db = loadDb();
    let total = 0;
    let active = 0;
    let dead = 0;
    let unchecked = 0;
    let duplicateIp = 0;
    for (const k in db.nodes) {
        total++;
        if (db.nodes[k].status === 'active') active++;
        else if (db.nodes[k].status === 'dead') dead++;
        else if (db.nodes[k].status === 'duplicate') duplicateIp++;
        else unchecked++;
    }
    res.json({ total, active, dead, unchecked, duplicates: (db.lastDuplicatesCount || 0) + duplicateIp });
});

app.get('/sub', (req, res) => {
    const db = loadDb();
    const now = Date.now();

    // Optional filters: ?country=NL,DE&minDays=7
    const countriesFilter = req.query.country
        ? req.query.country.toUpperCase().split(',').map(c => c.trim()).filter(Boolean)
        : null;
    const minDays = req.query.minDays ? parseInt(req.query.minDays) || 0 : 0;

    const activeLinks = [];
    for (const node of Object.values(db.nodes)) {
        if (node.status !== 'active') continue;
        if (countriesFilter && !countriesFilter.includes((node.country || '').toUpperCase())) continue;
        if (minDays > 0) {
            const activeFromMs = node.activeFrom ? Date.parse(node.activeFrom) : 0;
            const uptimeDays = Math.floor((now - activeFromMs) / DAY_MS);
            if (uptimeDays < minDays) continue;
        }
        activeLinks.push(node.originalLink);
    }
    const b64 = Buffer.from(activeLinks.join('\n')).toString('base64');
    res.type('text/plain').send(b64);
});

app.listen(PORT, HOST, () => {
    loadDb(); // ensures the access token exists before first request
    log(`Server running on http://localhost:${PORT} (host: ${HOST})`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
        log('Доступ с других устройств — только с токеном (см. URL экспорта на дашборде)');
    }
});
