const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { logWarn } = require('./logger');

const xrayBinary = process.platform === 'win32' ? 'xray.exe' : 'xray';
const xrayPath = path.join(__dirname, '../xray', xrayBinary);
const configPath = path.join(__dirname, '../xray/config.json');

const BASE_PORT = 40000;
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

    // 1. Generate Xray Config
    const inbounds = [];
    const outbounds = [];
    const routingRules = [];

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const port = BASE_PORT + i;
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

    const xrayConfig = {
        log: { loglevel: "warning" },
        inbounds: inbounds,
        outbounds: outbounds,
        routing: { rules: routingRules }
    };

    fs.writeFileSync(configPath, JSON.stringify(xrayConfig, null, 2));

    // 2. Start Xray Process
    const xrayProcess = spawn(xrayPath, ['run', '-c', configPath]);
    activeXrayProcess = xrayProcess;

    const ready = await waitForXrayReady(BASE_PORT, xrayProcess);
    if (!ready) {
        if (activeXrayProcess) {
            try { activeXrayProcess.kill(); } catch(e) {}
            activeXrayProcess = null;
        }
        if (!aborted) logWarn('Xray не поднялся за 10 секунд — чанк пропущен (узлы не помечаются мертвыми)');
        return { results: [], completed: false };
    }

    // 3. Test all nodes of the chunk in parallel
    const results = await Promise.all(nodes.map((node, i) => testNode(node, BASE_PORT + i)));

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
