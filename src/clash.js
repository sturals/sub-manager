const YAML = require('yaml');

// Converts Clash YAML subscriptions into regular share links (vless:// etc.)
// so the rest of the pipeline (parser, dedup, export) works unchanged.

function looksLikeClashYaml(text) {
    return /^\s*proxies\s*:/m.test(text);
}

function b64(str) {
    return Buffer.from(str, 'utf8').toString('base64');
}

function clashProxyToLink(p) {
    try {
        if (!p || !p.server || !p.port) return null;
        const name = p.name || '';
        const server = String(p.server);
        const port = parseInt(p.port);
        if (!port) return null;
        const hostPart = server.includes(':') ? `[${server}]` : server;

        switch (p.type) {
            case 'ss': {
                if (!p.cipher || p.password === undefined) return null;
                const userinfo = b64(`${p.cipher}:${p.password}`);
                return `ss://${userinfo}@${hostPart}:${port}#${encodeURIComponent(name)}`;
            }
            case 'trojan': {
                if (p.password === undefined) return null;
                const params = new URLSearchParams();
                if (p.sni) params.set('sni', p.sni);
                if (p['skip-cert-verify']) params.set('allowInsecure', '1');
                if (p.network && p.network !== 'tcp') params.set('type', p.network);
                const ws = p['ws-opts'];
                if (p.network === 'ws' && ws) {
                    if (ws.path) params.set('path', ws.path);
                    if (ws.headers && ws.headers.Host) params.set('host', ws.headers.Host);
                }
                const q = params.toString();
                return `trojan://${encodeURIComponent(String(p.password))}@${hostPart}:${port}${q ? '?' + q : ''}#${encodeURIComponent(name)}`;
            }
            case 'vless': {
                if (!p.uuid) return null;
                const params = new URLSearchParams();
                params.set('encryption', 'none');
                if (p.network && p.network !== 'tcp') params.set('type', p.network);
                if (p.flow) params.set('flow', p.flow);
                const reality = p['reality-opts'];
                if (reality && reality['public-key']) {
                    params.set('security', 'reality');
                    params.set('pbk', reality['public-key']);
                    if (reality['short-id']) params.set('sid', String(reality['short-id']));
                } else if (p.tls) {
                    params.set('security', 'tls');
                    if (p['skip-cert-verify']) params.set('allowInsecure', '1');
                }
                const sni = p.servername || p.sni;
                if (sni) params.set('sni', sni);
                if (p['client-fingerprint']) params.set('fp', p['client-fingerprint']);
                const ws = p['ws-opts'];
                if (p.network === 'ws' && ws) {
                    if (ws.path) params.set('path', ws.path);
                    if (ws.headers && ws.headers.Host) params.set('host', ws.headers.Host);
                }
                const grpc = p['grpc-opts'];
                if (p.network === 'grpc' && grpc && grpc['grpc-service-name']) {
                    params.set('serviceName', grpc['grpc-service-name']);
                }
                return `vless://${p.uuid}@${hostPart}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
            }
            case 'vmess': {
                if (!p.uuid) return null;
                const ws = p['ws-opts'] || {};
                const config = {
                    v: '2',
                    ps: name,
                    add: server,
                    port: String(port),
                    id: p.uuid,
                    aid: String(p.alterId || 0),
                    scy: p.cipher || 'auto',
                    net: p.network || 'tcp',
                    type: 'none',
                    host: (ws.headers && ws.headers.Host) || '',
                    path: ws.path || '',
                    tls: p.tls ? 'tls' : '',
                    sni: p.servername || p.sni || '',
                    fp: p['client-fingerprint'] || ''
                };
                return 'vmess://' + b64(JSON.stringify(config));
            }
            default:
                return null; // hysteria2, tuic, snell etc. — not supported by the tester yet
        }
    } catch (e) {
        return null;
    }
}

// Returns { links, skipped }
function clashToLinks(text) {
    const doc = YAML.parse(text, { logLevel: 'silent' });
    const proxies = doc && Array.isArray(doc.proxies) ? doc.proxies : [];
    const links = [];
    let skipped = 0;
    for (const p of proxies) {
        const link = clashProxyToLink(p);
        if (link) links.push(link);
        else skipped++;
    }
    return { links, skipped };
}

module.exports = { looksLikeClashYaml, clashToLinks };
