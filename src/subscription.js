const axios = require('axios');
const { parseProxyLink, decodeBase64 } = require('./parser');
const { looksLikeClashYaml, clashToLinks } = require('./clash');
const crypto = require('crypto');
const { log, logError, logWarn } = require('./logger');

function extractLinks(text) {
    // 1. Clash YAML subscription
    if (looksLikeClashYaml(text)) {
        const { links, skipped } = clashToLinks(text);
        if (skipped > 0) {
            logWarn(`Clash YAML: пропущено ${skipped} прокси неподдерживаемых типов`);
        }
        return links;
    }
    // 2. base64-encoded list of links
    if (!text.includes('://')) {
        try {
            text = decodeBase64(text.replace(/\s+/g, ''));
        } catch(e) {}
    }
    // 3. plain list of links
    return text.split('\n').map(l => l.trim()).filter(l => l);
}

async function fetchSubscriptions(urls) {
    let allLinks = [];
    for (const url of urls) {
        try {
            log(`Скачивание подписки: ${url}`);
            const response = await axios.get(url, { timeout: 15000, responseType: 'text', transformResponse: [d => d] });
            const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            const links = extractLinks(text);
            if (links.length === 0) {
                logWarn(`Подписка не дала ни одной ссылки (неподдерживаемый формат?): ${url}`);
            } else {
                log(`Найдено ${links.length} строк в подписке`);
            }
            allLinks = allLinks.concat(links);
        } catch (e) {
            logError(`Ошибка скачивания ${url}`, e.message);
        }
    }

    log(`Начат парсинг ${allLinks.length} строк...`);
    const parsedNodes = [];
    let unparsed = 0;
    for (const link of allLinks) {
        const parsed = parseProxyLink(link);
        if (parsed) {
            const idSource = JSON.stringify(parsed.outbound);
            const id = crypto.createHash('md5').update(idSource).digest('hex');
            parsedNodes.push({ id, parsed, originalLink: link });
        } else if (link.includes('://')) {
            unparsed++;
        }
    }
    if (unparsed > 0) {
        logWarn(`Не удалось распарсить ${unparsed} ссылок (неподдерживаемые протоколы или мусор)`);
    }

    let duplicatesCount = 0;
    const uniqueNodes = [];
    const seen = new Set();
    for(const node of parsedNodes) {
        if(!seen.has(node.id)) {
            seen.add(node.id);
            uniqueNodes.push(node);
        } else {
            duplicatesCount++;
        }
    }

    log(`Парсинг завершен. Уникальных узлов: ${uniqueNodes.length}, дубликатов: ${duplicatesCount}.`);

    return { uniqueNodes, duplicatesCount };
}

module.exports = { fetchSubscriptions };
