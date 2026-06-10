function parseProxyLink(link) {
    if (link.startsWith('vless://')) {
        return parseVless(link);
    } else if (link.startsWith('vmess://')) {
        return parseVmess(link);
    } else if (link.startsWith('ss://')) {
        return parseSs(link);
    }
    return null;
}

function parseVless(link) {
    try {
        const url = new URL(link);
        const id = url.username;
        const address = url.hostname;
        const port = parseInt(url.port);
        const remark = decodeURIComponent(url.hash.substring(1));
        const params = Object.fromEntries(url.searchParams);

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
        const b64 = link.substring(8);
        const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
        const config = JSON.parse(jsonStr);
        
        const params = {
            type: config.net,
            security: config.tls,
            sni: config.sni,
            path: config.path,
            host: config.host,
            fp: config.fp
        };

        return {
            protocol: 'vmess',
            remark: config.ps,
            link,
            outbound: {
                protocol: "vmess",
                settings: {
                    vnext: [{
                        address: config.add,
                        port: parseInt(config.port),
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

function parseSs(link) {
    try {
        let urlStr = link;
        if (!link.includes('@')) {
            let match = link.match(/^ss:\/\/([a-zA-Z0-9+/=]+)(#.*)?$/);
            if (match) {
                const b64 = match[1];
                const decoded = Buffer.from(b64, 'base64').toString('utf8');
                urlStr = 'ss://' + decoded + '@127.0.0.1:80' + (match[2] || ''); 
                // just a dummy, the real format might differ if the whole thing is base64
            }
        }
        
        const url = new URL(urlStr);
        let method = url.username;
        let password = url.password;
        
        // Handle SIP002 base64 username
        if (!password && method) {
             const decoded = Buffer.from(method, 'base64').toString('utf8');
             if (decoded.includes(':')) {
                 const parts = decoded.split(':');
                 method = parts[0];
                 password = parts.slice(1).join(':');
             }
        }
        
        return {
            protocol: 'shadowsocks',
            remark: decodeURIComponent(url.hash.substring(1)),
            link,
            outbound: {
                protocol: "shadowsocks",
                settings: {
                    servers: [{
                        address: url.hostname,
                        port: parseInt(url.port),
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

function buildStreamSettings(params) {
    const streamSettings = {
        network: params.type || "tcp",
        security: params.security || "none"
    };

    if (streamSettings.security === "tls" || streamSettings.security === "reality") {
        streamSettings[streamSettings.security + "Settings"] = {
            serverName: params.sni || "",
            fingerprint: params.fp || "",
            show: false
        };
        if (streamSettings.security === "reality") {
            streamSettings.realitySettings.publicKey = params.pbk || "";
            streamSettings.realitySettings.shortId = params.sid || "";
            streamSettings.realitySettings.spiderX = params.spx || "";
        }
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
    }

    return streamSettings;
}

module.exports = { parseProxyLink };
