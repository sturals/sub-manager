function getFlagEmoji(countryCode) {
    if (!countryCode) return '';
    return countryCode.toUpperCase().replace(/./g, char => String.fromCodePoint(char.charCodeAt(0) + 127397));
}

function overwriteRemarkWithFlag(link, countryCode, realIp) {
    try {
        if (!countryCode) return link;
        const flag = getFlagEmoji(countryCode);
        const newRemark = `${flag} ${countryCode} - ${realIp}`;
        
        if (link.startsWith('vless://') || link.startsWith('ss://')) {
            const hashIndex = link.lastIndexOf('#');
            if (hashIndex !== -1) {
                const base = link.substring(0, hashIndex);
                return base + '#' + encodeURIComponent(newRemark);
            } else {
                return link + '#' + encodeURIComponent(newRemark);
            }
        } else if (link.startsWith('vmess://')) {
            const b64 = link.substring(8);
            const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
            const config = JSON.parse(jsonStr);
            config.ps = newRemark;
            return 'vmess://' + Buffer.from(JSON.stringify(config)).toString('base64');
        }

        return link;

    } catch (e) {
        return link;
    }
}

module.exports = { overwriteRemarkWithFlag };
