const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');

const xrayPath = path.join(__dirname, '../xray/xray.exe');
const configPath = path.join(__dirname, '../xray/config.json');

let activeXrayProcess = null;

async function testNodes(nodes) {
    if (nodes.length === 0) return [];

    // 1. Generate Xray Config
    const inbounds = [];
    const outbounds = [];
    const routingRules = [];

    let currentPort = 10000;

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const port = currentPort++;
        const tag = `out-${i}`;

        // Inbound for this node
        inbounds.push({
            port: port,
            listen: "127.0.0.1",
            protocol: "socks",
            tag: `in-${i}`,
            settings: { auth: "noauth", udp: true }
        });

        // Outbound
        const outbound = JSON.parse(JSON.stringify(node.parsed.outbound));
        outbound.tag = tag;
        outbounds.push(outbound);

        // Route
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
    
    // Wait for Xray to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 3. Test each proxy
    const results = [];
    const promises = nodes.map(async (node, i) => {
        const port = 10000 + i;
        const agent = new SocksProxyAgent(`socks5://127.0.0.1:${port}`);
        try {
            const start = Date.now();
            const axiosPromise = axios.get('https://www.cloudflare.com/cdn-cgi/trace', {
                httpAgent: agent,
                httpsAgent: agent,
                timeout: 5000
            });
            
            // Hard timeout fallback just in case axios hangs
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Hard timeout')), 5500);
            });
            
            const response = await Promise.race([axiosPromise, timeoutPromise]);
            
            const latency = Date.now() - start;
            if (response.status === 200 && response.data) {
                const text = response.data;
                const ipMatch = text.match(/ip=([^\n]+)/);
                const locMatch = text.match(/loc=([^\n]+)/);
                if (ipMatch && locMatch) {
                    results.push({ 
                        id: node.id, 
                        status: 'active', 
                        latency, 
                        realIp: ipMatch[1].trim(), 
                        country: locMatch[1].trim() 
                    });
                } else {
                    results.push({ id: node.id, status: 'dead', latency: -1 });
                }
            } else {
                results.push({ id: node.id, status: 'dead', latency: -1 });
            }
        } catch (error) {
            results.push({ id: node.id, status: 'dead', latency: -1 });
        }
    });

    await Promise.all(promises);

    // 4. Cleanup
    if (activeXrayProcess) {
        try { activeXrayProcess.kill(); } catch(e) {}
        activeXrayProcess = null;
    }
    
    return results;
}

function abortTesting() {
    if (activeXrayProcess) {
        try { activeXrayProcess.kill(); } catch(e) {}
        activeXrayProcess = null;
    }
}

module.exports = { testNodes, abortTesting };
