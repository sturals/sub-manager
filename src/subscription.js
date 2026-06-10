const axios = require('axios');
const { parseProxyLink } = require('./parser');
const crypto = require('crypto');
const { log, logError } = require('./logger');

async function fetchSubscriptions(urls) {
    let allLinks = [];
    for (const url of urls) {
        try {
            log(`Скачивание подписки: ${url}`);
            const response = await axios.get(url, { timeout: 10000 });
            let text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            if (!text.includes('://')) {
                try {
                    text = Buffer.from(text, 'base64').toString('utf8');
                } catch(e) {}
            }
            const links = text.split('\n').map(l => l.trim()).filter(l => l);
            log(`Найдено ${links.length} строк в подписке`);
            allLinks = allLinks.concat(links);
        } catch (e) {
            logError(`Ошибка скачивания ${url}`, e.message);
        }
    }
    
    log(`Начат парсинг ${allLinks.length} строк...`);
    const parsedNodes = [];
    for (const link of allLinks) {
        const parsed = parseProxyLink(link);
        if (parsed) {
            const idSource = JSON.stringify(parsed.outbound);
            const id = crypto.createHash('md5').update(idSource).digest('hex');
            parsedNodes.push({ id, parsed, originalLink: link });
        }
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
