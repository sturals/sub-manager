// Plain-assert tests, zero dependencies. Run: npm test (or: node tests/parser.test.js)
const assert = require('assert');
const { parseProxyLink, decodeBase64 } = require('../src/parser');
const { looksLikeClashYaml, clashToLinks } = require('../src/clash');

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok - ${name}`);
    } catch (e) {
        console.error(`  FAIL - ${name}`);
        console.error(e.message);
        process.exitCode = 1;
    }
}

const b64 = s => Buffer.from(s, 'utf8').toString('base64');

console.log('parser.js');

test('vless: basic ws+tls link', () => {
    const link = 'vless://11111111-2222-3333-4444-555555555555@example.com:443?type=ws&security=tls&sni=cdn.example.com&path=%2Fws&host=cdn.example.com#My%20Node';
    const r = parseProxyLink(link);
    assert.ok(r);
    assert.strictEqual(r.protocol, 'vless');
    assert.strictEqual(r.remark, 'My Node');
    const vnext = r.outbound.settings.vnext[0];
    assert.strictEqual(vnext.address, 'example.com');
    assert.strictEqual(vnext.port, 443);
    assert.strictEqual(vnext.users[0].id, '11111111-2222-3333-4444-555555555555');
    assert.strictEqual(r.outbound.streamSettings.network, 'ws');
    assert.strictEqual(r.outbound.streamSettings.tlsSettings.serverName, 'cdn.example.com');
    assert.strictEqual(r.outbound.streamSettings.wsSettings.path, '/ws');
});

test('vless: reality params land in realitySettings', () => {
    const link = 'vless://uuid-here@1.2.3.4:8443?security=reality&pbk=PUBKEY&sid=abcd&fp=chrome&sni=apple.com#r';
    const r = parseProxyLink(link);
    const rs = r.outbound.streamSettings.realitySettings;
    assert.strictEqual(rs.publicKey, 'PUBKEY');
    assert.strictEqual(rs.shortId, 'abcd');
    assert.strictEqual(rs.serverName, 'apple.com');
});

test('vmess: base64 json', () => {
    const cfg = { v: '2', ps: 'vm node', add: '5.6.7.8', port: '8080', id: 'uuid-x', aid: '0', net: 'ws', path: '/x', host: 'h.com', tls: 'tls' };
    const r = parseProxyLink('vmess://' + b64(JSON.stringify(cfg)));
    assert.ok(r);
    assert.strictEqual(r.remark, 'vm node');
    const vnext = r.outbound.settings.vnext[0];
    assert.strictEqual(vnext.address, '5.6.7.8');
    assert.strictEqual(vnext.port, 8080);
    assert.strictEqual(r.outbound.streamSettings.security, 'tls');
});

test('ss: SIP002 with base64 userinfo', () => {
    const link = `ss://${b64('aes-256-gcm:secretpass')}@9.9.9.9:8388#sip002`;
    const r = parseProxyLink(link);
    assert.ok(r);
    const srv = r.outbound.settings.servers[0];
    assert.strictEqual(srv.address, '9.9.9.9');
    assert.strictEqual(srv.port, 8388);
    assert.strictEqual(srv.method, 'aes-256-gcm');
    assert.strictEqual(srv.password, 'secretpass');
});

test('ss: LEGACY full-base64 keeps the real host (regression: was 127.0.0.1:80)', () => {
    const link = `ss://${b64('chacha20-ietf-poly1305:pw123@77.88.99.11:443')}#legacy`;
    const r = parseProxyLink(link);
    assert.ok(r);
    const srv = r.outbound.settings.servers[0];
    assert.strictEqual(srv.address, '77.88.99.11');   // NOT the old dummy 127.0.0.1
    assert.strictEqual(srv.port, 443);                 // NOT the old dummy 80
    assert.strictEqual(srv.method, 'chacha20-ietf-poly1305');
    assert.strictEqual(srv.password, 'pw123');
    assert.strictEqual(r.remark, 'legacy');
});

test('ss: password containing @ (split at last @)', () => {
    const link = `ss://${b64('aes-128-gcm:p@ss@w0rd@8.8.4.4:9000')}#at`;
    const r = parseProxyLink(link);
    const srv = r.outbound.settings.servers[0];
    assert.strictEqual(srv.address, '8.8.4.4');
    assert.strictEqual(srv.port, 9000);
    assert.strictEqual(srv.password, 'p@ss@w0rd');
});

test('ss: url-safe base64 without padding (regression: regex rejected - and _)', () => {
    const raw = 'aes-256-gcm:k+/k?x@3.3.3.3:1234';
    const urlSafe = b64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r = parseProxyLink('ss://' + urlSafe + '#urlsafe');
    assert.ok(r, 'url-safe base64 must be accepted');
    assert.strictEqual(r.outbound.settings.servers[0].address, '3.3.3.3');
});

test('trojan: defaults to tls, supports allowInsecure', () => {
    const r = parseProxyLink('trojan://mypass@t.example.org:443?sni=t.example.org&allowInsecure=1#tj');
    assert.ok(r);
    assert.strictEqual(r.outbound.protocol, 'trojan');
    assert.strictEqual(r.outbound.settings.servers[0].password, 'mypass');
    assert.strictEqual(r.outbound.streamSettings.security, 'tls');
    assert.strictEqual(r.outbound.streamSettings.tlsSettings.allowInsecure, true);
});

test('garbage links return null, not throw', () => {
    assert.strictEqual(parseProxyLink('ss://!!!notbase64!!!'), null);
    assert.strictEqual(parseProxyLink('vmess://%%%'), null);
    assert.strictEqual(parseProxyLink('hysteria2://x@y:1'), null);
    assert.strictEqual(parseProxyLink('random text'), null);
});

test('decodeBase64 handles url-safe alphabet and missing padding', () => {
    assert.strictEqual(decodeBase64(b64('a?b/c+d').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), 'a?b/c+d');
});

console.log('clash.js');

const CLASH_YAML = `
proxies:
  - { name: "ss-node", type: ss, server: 1.1.1.1, port: 8388, cipher: aes-256-gcm, password: pw }
  - { name: "vless-node", type: vless, server: 2.2.2.2, port: 443, uuid: 11111111-2222-3333-4444-555555555555, network: ws, tls: true, servername: sni.com, ws-opts: { path: /ws, headers: { Host: sni.com } } }
  - { name: "trojan-node", type: trojan, server: 3.3.3.3, port: 443, password: tpw, sni: x.com, skip-cert-verify: true }
  - { name: "vmess-node", type: vmess, server: 4.4.4.4, port: 80, uuid: 99999999-2222-3333-4444-555555555555, alterId: 0, cipher: auto, network: ws }
  - { name: "unsupported", type: hysteria2, server: 5.5.5.5, port: 443, password: x }
`;

test('looksLikeClashYaml detects proxies key', () => {
    assert.ok(looksLikeClashYaml(CLASH_YAML));
    assert.ok(!looksLikeClashYaml('vless://x@y:1\nss://abc'));
});

test('clashToLinks converts supported types and counts skipped', () => {
    const { links, skipped } = clashToLinks(CLASH_YAML);
    assert.strictEqual(links.length, 4);
    assert.strictEqual(skipped, 1);
    // every produced link must round-trip through our own parser
    for (const link of links) {
        const parsed = parseProxyLink(link);
        assert.ok(parsed, 'parser must understand generated link: ' + link);
    }
});

test('clash ss entry round-trips with correct host/creds', () => {
    const { links } = clashToLinks(CLASH_YAML);
    const ss = parseProxyLink(links[0]);
    const srv = ss.outbound.settings.servers[0];
    assert.strictEqual(srv.address, '1.1.1.1');
    assert.strictEqual(srv.port, 8388);
    assert.strictEqual(srv.method, 'aes-256-gcm');
    assert.strictEqual(srv.password, 'pw');
});

test('clash vless reality entry', () => {
    const yaml = `
proxies:
  - { name: "r", type: vless, server: 6.6.6.6, port: 8443, uuid: aaaa1111-2222-3333-4444-555555555555, flow: xtls-rprx-vision, reality-opts: { public-key: PBK, short-id: "07" }, servername: apple.com, client-fingerprint: chrome }
`;
    const { links } = clashToLinks(yaml);
    assert.strictEqual(links.length, 1);
    const r = parseProxyLink(links[0]);
    const rs = r.outbound.streamSettings.realitySettings;
    assert.strictEqual(r.outbound.streamSettings.security, 'reality');
    assert.strictEqual(rs.publicKey, 'PBK');
    assert.strictEqual(rs.shortId, '07');
    assert.strictEqual(r.outbound.settings.vnext[0].users[0].flow, 'xtls-rprx-vision');
});

console.log(process.exitCode ? '\nSOME TESTS FAILED' : `\nAll ${passed} tests passed`);
