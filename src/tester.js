const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { logWarn } = require('./logger');

const xrayBinary = process.platform === 'win32' ? 'xray.exe' : 'xray';
const xrayPath = path.join(__dirname, '../xray', xrayBinary);
const configPath = path.join(__dirname, '../xray/config.json');

let currentBasePort = 40000;
const TEST_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const TEST_TIMEOUT = 5000;

let activeXrayProcess = null;
let aborted = false;

function tryConnect(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host: '127.0.0.1' }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('error', () => { socket.destroy(); resolve(false); });
        socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
}

// Polls the first inbound port instead of a blind fixed sleep:
// on slow machines / large configs 2s was not enough and whole
// chunks were falsely marked dead.
async function waitForXrayReady(port, processRef, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (aborted || processRef.exitCode !== null) return false;
        if (await tryConnect(port)) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

// ---------------------------------------------------------------------------
// Config pre-validation: runs `xray run -test -c config.json` synchronously.
// Returns true if Xray accepts the config, false otherwise.
// ---------------------------------------------------------------------------
function validateConfig(configObj) {
    fs.writeFileSync(configPath, JSON.stringify(configObj, null, 2));
    const res = spawnSync(xrayPath, ['run', '-test', '-c', configPath], { timeout: 15000 });
    return res.status === 0;
}

// ---------------------------------------------------------------------------
// Build Xray config object for a set of nodes starting at basePort.
// ---------------------------------------------------------------------------
function buildConfig(nodes, basePort) {
    const inbounds = [];
    const outbounds = [];
    const routingRules = [];

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const port = basePort + i;
        const tag = `out-${i}`;

        inbounds.push({
            port: port,
            listen: "127.0.0.1",
            protocol: "socks",
            tag: `in-${i}`,
            settings: { auth: "noauth", udp: true }
        });

        const outbound = JSON.parse(JSON.stringify(node.parsed.outbound));
        outbound.tag = tag;
        outbounds.push(outbound);

        routingRules.push({
            type: "field",
            inboundTag: [`in-${i}`],
            outboundTag: tag
        });
    }

    return {
        log: { loglevel: "warning" },
        inbounds,
        outbounds,
        routing: { rules: routingRules }
    };
}

// ---------------------------------------------------------------------------
// Binary search for bad nodes in a list. Returns an array of node IDs that
// cause Xray config validation to fail.
// ---------------------------------------------------------------------------
function findBadNodeIds(nodes, basePort) {
    if (nodes.length === 0) return [];

    // Single node — if it fails, it's bad
    if (nodes.length === 1) {
        const cfg = buildConfig(nodes, basePort);
        if (!validateConfig(cfg)) {
            return [nodes[0].id];
        }
        return [];
    }

    // First check if this whole set is valid
    const cfg = buildConfig(nodes, basePort);
    if (validateConfig(cfg)) {
        return []; // All good
    }

    // Split in half, recurse
    const mid = Math.ceil(nodes.length / 2);
    const left = nodes.slice(0, mid);
    const right = nodes.slice(mid);

    const badLeft = findBadNodeIds(left, basePort);
    const badRight = findBadNodeIds(right, basePort);

    return [...badLeft, ...badRight];
}

async function testNode(node, port) {
    const agent = new SocksProxyAgent(`socks5://127.0.0.1:${port}`);
    let hardTimer = null;
    try {
        const start = Date.now();
        const axiosPromise = axios.get(TEST_URL, {
            httpAgent: agent,
            httpsAgent: agent,
            timeout: TEST_TIMEOUT
        });

        // Hard timeout fallback just in case axios hangs
        const timeoutPromise = new Promise((_, reject) => {
            hardTimer = setTimeout(() => reject(new Error('Hard timeout')), TEST_TIMEOUT + 500);
        });

        const response = await Promise.race([axiosPromise, timeoutPromise]);

        const latency = Date.now() - start;
        if (response.status === 200 && response.data) {
            const text = response.data;
            const ipMatch = text.match(/ip=([^\n]+)/);
            const locMatch = text.match(/loc=([^\n]+)/);
            if (ipMatch && locMatch) {
                return {
                    id: node.id,
                    status: 'active',
                    latency,
                    realIp: ipMatch[1].trim(),
                    country: locMatch[1].trim()
                };
            }
        }
        return { id: node.id, status: 'dead', latency: -1 };
    } catch (error) {
        return { id: node.id, status: 'dead', latency: -1 };
    } finally {
        if (hardTimer) clearTimeout(hardTimer); // don't leak 50 timers per chunk
    }
}

// Returns { results, completed }. When the run was aborted mid-chunk the
// in-flight results are NOT trustworthy (xray was killed under them), so
// completed=false tells the caller to discard them instead of marking
// untested nodes as dead.
async function testNodes(nodes) {
    if (nodes.length === 0) return { results: [], completed: true };

    aborted = false;

    const chunkBasePort = currentBasePort;
    currentBasePort += 50;
    if (currentBasePort > 50000) currentBasePort = 40000;

    // 1. Build config & pre-validate
    let validNodes = nodes;
    let config = buildConfig(validNodes, chunkBasePort);

    if (!validateConfig(config)) {
        // Config is bad — find the problematic nodes via binary search
        const badIds = findBadNodeIds(validNodes, chunkBasePort);

        if (badIds.length > 0) {
            const badSet = new Set(badIds);
            logWarn(`Найдено ${badIds.length} нод с невалидным конфигом — пропущены (IDs: ${badIds.slice(0, 5).join(', ')}${badIds.length > 5 ? '...' : ''})`);
            validNodes = validNodes.filter(n => !badSet.has(n.id));

            if (validNodes.length === 0) {
                return { results: [], completed: true };
            }

            // Rebuild config with clean nodes
            config = buildConfig(validNodes, chunkBasePort);

            // Final sanity check
            if (!validateConfig(config)) {
                logWarn('Конфиг всё ещё невалиден после удаления плохих нод — чанк пропущен');
                return { results: [], completed: false };
            }
        } else {
            logWarn('validateConfig вернул false, но бинарный поиск не нашёл виновника — чанк пропущен');
            return { results: [], completed: false };
        }
    }

    // 2. Write the validated config and start Xray
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const xrayProcess = spawn(xrayPath, ['run', '-c', configPath]);
    activeXrayProcess = xrayProcess;

    let xrayErrorLog = '';
    xrayProcess.stdout.on('data', (data) => {
        xrayErrorLog += data.toString();
    });
    xrayProcess.stderr.on('data', (data) => {
        xrayErrorLog += data.toString();
    });

    const ready = await waitForXrayReady(chunkBasePort, xrayProcess);
    if (!ready) {
        await new Promise(r => setTimeout(r, 100));
        if (activeXrayProcess) {
            try { activeXrayProcess.kill(); } catch(e) {}
            activeXrayProcess = null;
        }
        if (!aborted) {
            logWarn(`Xray не поднялся за 10 секунд — чанк пропущен (узлы не помечаются мертвыми)`);
        }
        return { results: [], completed: false };
    }

    // 3. Test all valid nodes of the chunk in parallel
    const results = await Promise.all(validNodes.map((node, i) => testNode(node, chunkBasePort + i)));

    const completed = !aborted;

    // 4. Cleanup
    if (activeXrayProcess) {
        try { activeXrayProcess.kill(); } catch(e) {}
        activeXrayProcess = null;
    }

    return { results, completed };
}

function abortTesting() {
    aborted = true;
    if (activeXrayProcess) {
        try { activeXrayProcess.kill(); } catch(e) {}
        activeXrayProcess = null;
    }
}

module.exports = { testNodes, abortTesting };
