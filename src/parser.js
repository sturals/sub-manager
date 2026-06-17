function parseProxyLink(link) {
    if (link.startsWith('vless://')) {
        return parseVless(link);
    } else if (link.startsWith('vmess://')) {
        return parseVmess(link);
    } else if (link.startsWith('ss://')) {
        return parseSs(link);
    } else if (link.startsWith('trojan://')) {
        return parseTrojan(link);
    }
    return null;
}

// Decodes standard AND url-safe base64, with or without padding
function decodeBase64(str) {
    const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
}

// Splits "host:port" / "[ipv6]:port" into parts
function splitHostPort(str) {
    if (str.startsWith('[')) {
        const end = str.indexOf(']');
        if (end === -1) return null;
        const port = parseInt(str.substring(end + 2));
        if (!port) return null;
        return { host: str.substring(1, end), port };
    }
    const idx = str.lastIndexOf(':');
    if (idx === -1) return null;
    const port = parseInt(str.substring(idx + 1));
    if (!port) return null;
    return { host: str.substring(0, idx), port };
}

function parseVless(link) {
    try {
        const url = new URL(link);
        const id = decodeURIComponent(url.username);
        const address = url.hostname.replace(/^\[|\]$/g, '');
        const port = parseInt(url.port);
        const remark = decodeURIComponent(url.hash.substring(1));
        const params = Object.fromEntries(url.searchParams);

        if (!address || !port || !id) return null;

        return {
            protocol: 'vless',
            remark,
            link,
            outbound: {
                protocol: "vless",
                settings: {
                    vnext: [{
                        address: address,
                        port: port,
                        users: [{
                            id: id,
                            encryption: params.encryption || "none",
                            flow: params.flow || ""
                        }]
                    }]
                },
                streamSettings: buildStreamSettings(params)
            }
        };
    } catch (e) {
        return null;
    }
}

function parseVmess(link) {
    try {
        const jsonStr = decodeBase64(link.substring(8));
        const config = JSON.parse(jsonStr);

        const params = {
            type: config.net,
            security: config.tls,
            sni: config.sni,
            path: config.path,
            host: config.host,
            fp: config.fp,
            alpn: config.alpn
        };

        const address = config.add;
        const port = parseInt(config.port);
        if (!address || !port || !config.id) return null;

        return {
            protocol: 'vmess',
            remark: config.ps,
            link,
            outbound: {
                protocol: "vmess",
                settings: {
                    vnext: [{
                        address: address,
                        port: port,
                        users: [{
                            id: config.id,
                            alterId: parseInt(config.aid) || 0,
                            security: config.scy || "auto"
                        }]
                    }]
                },
                streamSettings: buildStreamSettings(params)
            }
        };
    } catch (e) {
        return null;
    }
}

// Supports both SIP002 (ss://base64(method:pass)@host:port#remark,
// ss://method:pass@host:port#remark) and the legacy full-base64 form
// (ss://base64(method:pass@host:port)#remark).
function parseSs(link) {
    try {
        // 1. Cut off remark and query manually — never feed dummy hosts to URL()
        let body = link.substring(5); // after 'ss://'
        let remark = '';
        const hashIdx = body.indexOf('#');
        if (hashIdx !== -1) {
            remark = decodeURIComponent(body.substring(hashIdx + 1));
            body = body.substring(0, hashIdx);
        }
        const queryIdx = body.indexOf('?');
        if (queryIdx !== -1) {
            body = body.substring(0, queryIdx); // plugin params are not supported by xray socks test
        }
        body = body.replace(/\/+$/, '');

        // 2. Legacy form: the whole body is base64(method:pass@host:port)
        if (!body.includes('@')) {
            body = decodeBase64(body);
            if (!body.includes('@')) return null;
        }

        // 3. Split at the LAST @ — passwords may contain @
        const atIdx = body.lastIndexOf('@');
        let userinfo = body.substring(0, atIdx);
        const hostPort = splitHostPort(body.substring(atIdx + 1));
        if (!hostPort) return null;

        // 4. userinfo is either plain "method:pass" (possibly percent-encoded)
        //    or base64("method:pass")
        if (!userinfo.includes(':')) {
            userinfo = decodeBase64(userinfo);
        } else {
            try { userinfo = decodeURIComponent(userinfo); } catch (e) {}
        }
        const colonIdx = userinfo.indexOf(':');
        if (colonIdx === -1) return null;
        const method = userinfo.substring(0, colonIdx);
        const password = userinfo.substring(colonIdx + 1);
        if (!method || !password) return null;

        return {
            protocol: 'shadowsocks',
            remark,
            link,
            outbound: {
                protocol: "shadowsocks",
                settings: {
                    servers: [{
                        address: hostPort.host,
                        port: hostPort.port,
                        method: method,
                        password: password
                    }]
                }
            }
        };

    } catch(e) {
        return null;
    }
}

function parseTrojan(link) {
    try {
        const url = new URL(link);
        const password = decodeURIComponent(url.username);
        const address = url.hostname.replace(/^\[|\]$/g, '');
        const port = parseInt(url.port);
        const remark = decodeURIComponent(url.hash.substring(1));
        const params = Object.fromEntries(url.searchParams);

        if (!address || !port || !password) return null;

        // trojan is TLS by default
        if (!params.security) params.security = 'tls';

        return {
            protocol: 'trojan',
            remark,
            link,
            outbound: {
                protocol: "trojan",
                settings: {
                    servers: [{
                        address: address,
                        port: port,
                        password: password
                    }]
                },
                streamSettings: buildStreamSettings(params)
            }
        };
    } catch (e) {
        return null;
    }
}

function buildStreamSettings(params) {
    const streamSettings = {
        network: params.type || "tcp",
        security: params.security || "none"
    };

    if (streamSettings.security === "tls" || streamSettings.security === "reality") {
        const sec = {
            serverName: params.sni || "",
            fingerprint: params.fp || "",
            show: false
        };
        if (streamSettings.security === "tls") {
            if (params.allowInsecure === '1' || params.allowInsecure === 'true' || params.insecure === '1') {
                sec.allowInsecure = true;
            }
            if (params.alpn) {
                sec.alpn = String(params.alpn).split(',').map(s => s.trim()).filter(Boolean);
            }
        }
        if (streamSettings.security === "reality") {
            sec.publicKey = params.pbk || "";
            sec.shortId = params.sid || "";
            sec.spiderX = params.spx || "";
        }
        streamSettings[streamSettings.security + "Settings"] = sec;
    }

    if (streamSettings.network === "ws") {
        streamSettings.wsSettings = {
            path: params.path || "/",
            headers: params.host ? { Host: params.host } : {}
        };
    } else if (streamSettings.network === "grpc") {
        streamSettings.grpcSettings = {
            serviceName: params.serviceName || "",
            multiMode: params.mode === "multi"
        };
    } else if (streamSettings.network === "httpupgrade") {
        streamSettings.httpupgradeSettings = {
            path: params.path || "/",
            host: params.host || ""
        };
    }

    return streamSettings;
}

module.exports = { parseProxyLink, decodeBase64 };
