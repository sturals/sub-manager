document.addEventListener('DOMContentLoaded', async () => {
    const newSubUrl = document.getElementById('new-sub-url');
    const btnAddSub = document.getElementById('btn-add-sub');
    const subsList = document.getElementById('subs-list');
    const btnRun = document.getElementById('btn-run');
    const exportUrl = document.getElementById('export-url');
    const btnCopy = document.getElementById('btn-copy');

    // Status elements
    const statTotal = document.getElementById('stat-total');
    const statActive = document.getElementById('stat-active');
    const statDead = document.getElementById('stat-dead');
    const statUnchecked = document.getElementById('stat-unchecked');
    const statDuplicates = document.getElementById('stat-duplicates');
    const subsCount = document.getElementById('subs-count');

    const progressSection = document.getElementById('progress-section');
    const statusText = document.getElementById('status-text');
    const progressFill = document.getElementById('progress-fill');
    const liveLogs = document.getElementById('live-logs');

    // Nodes section elements
    const nodesTbody = document.getElementById('nodes-tbody');
    const nodesCount = document.getElementById('nodes-count');
    const filterCountry = document.getElementById('filter-country');
    const filterDays = document.getElementById('filter-days');
    const filterSort = document.getElementById('filter-sort');
    const btnApplyFilter = document.getElementById('btn-apply-filter');
    const btnGenUrl = document.getElementById('btn-gen-url');
    const filteredExportUrl = document.getElementById('filtered-export-url');
    const btnCopyFiltered = document.getElementById('btn-copy-filtered');
    const filteredCountInfo = document.getElementById('filtered-count-info');

    // Raw nodes data from /api/nodes
    let allNodes = [];
    let filteredNodes = [];

    // When the dashboard is opened from another device (?token=...), forward
    // the token to every API call
    const ACCESS_TOKEN = new URLSearchParams(location.search).get('token');
    let serverIpData = null;

    function api(url, opts) {
        if (ACCESS_TOKEN) {
            url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(ACCESS_TOKEN);
        }
        return fetch(url, opts);
    }

    // Non-blocking toast instead of alert()
    function toast(message, type = 'info') {
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.textContent = message;
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 400);
        }, 4000);
    }

    // Toggle logic
    const subsHeaderToggle = document.getElementById('subs-header-toggle');
    const subsContentContainer = document.getElementById('subs-content-container');
    const subsToggleIcon = document.getElementById('subs-toggle-icon');

    subsHeaderToggle.addEventListener('click', () => {
        if (subsContentContainer.style.display === 'none') {
            subsContentContainer.style.display = 'block';
            subsToggleIcon.textContent = '▼';
        } else {
            subsContentContainer.style.display = 'none';
            subsToggleIcon.textContent = '►';
        }
    });

    // Load initial data
    try {
        const ipRes = await api('/api/ip');
        serverIpData = await ipRes.json();
        exportUrl.value = `http://${serverIpData.ip}:${serverIpData.port}/sub?token=${serverIpData.token}`;
    } catch(e) {
        exportUrl.value = window.location.origin + '/sub';
    }

    let subscriptions = [];

    function renderSubs() {
        subsList.innerHTML = '';
        subscriptions.forEach((url, index) => {
            const item = document.createElement('div');
            item.className = 'sub-item';

            const text = document.createElement('div');
            text.className = 'sub-item-text';
            text.textContent = `${index + 1}. ${url}`;
            text.title = url;

            const btnDelete = document.createElement('button');
            btnDelete.className = 'btn secondary btn-small';
            btnDelete.textContent = 'Удалить';
            btnDelete.onclick = () => {
                subscriptions.splice(index, 1);
                saveSubs();
            };

            item.appendChild(text);
            item.appendChild(btnDelete);
            subsList.appendChild(item);
        });
        subsCount.textContent = `Всего: ${subscriptions.length}`;
    }

    async function saveSubs() {
        const res = await api('/api/subs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: subscriptions })
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            toast(data.error || 'Не удалось сохранить подписки', 'error');
            await loadSubs();
            return;
        }
        renderSubs();
    }

    btnAddSub.addEventListener('click', () => {
        const url = newSubUrl.value.trim();
        if (!url) return;
        if (!/^https?:\/\//i.test(url)) {
            toast('Подписка должна быть http(s) ссылкой', 'error');
            return;
        }
        if (subscriptions.includes(url)) {
            toast('Эта подписка уже добавлена', 'error');
            return;
        }
        subscriptions.push(url);
        newSubUrl.value = '';
        saveSubs();
    });

    newSubUrl.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') btnAddSub.click();
    });

    async function loadSubs() {
        const res = await api('/api/subs');
        subscriptions = await res.json();
        renderSubs();
    }

    async function loadStats() {
        const res = await api('/api/stats');
        const stats = await res.json();
        statTotal.textContent = stats.total;
        statActive.textContent = stats.active;
        statDead.textContent = stats.dead;
        statUnchecked.textContent = stats.unchecked;
        statDuplicates.textContent = stats.duplicates || 0;
    }

    // -------------------------------------------------------------------------
    // Nodes table logic
    // -------------------------------------------------------------------------

    function uptimeBadge(days) {
        if (days >= 30) return { cls: 'badge-gold', label: `${days} дн` };
        if (days >= 7)  return { cls: 'badge-green', label: `${days} дн` };
        if (days >= 1)  return { cls: 'badge-yellow', label: `${days} дн` };
        return { cls: 'badge-gray', label: '< 1 дня' };
    }

    function formatDate(isoStr) {
        if (!isoStr) return '—';
        const d = new Date(isoStr);
        return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
    }

    function populateCountryFilter(nodes) {
        const countries = [...new Set(nodes.map(n => n.country))].sort();
        // Remember selection
        const selected = new Set([...filterCountry.options]
            .filter(o => o.selected && o.value)
            .map(o => o.value));
        filterCountry.innerHTML = '<option value="">🌐 Все страны</option>';
        for (const c of countries) {
            const opt = document.createElement('option');
            opt.value = c;
            opt.textContent = c;
            if (selected.has(c)) opt.selected = true;
            filterCountry.appendChild(opt);
        }
    }

    function applyFilters() {
        const selectedCountries = [...filterCountry.options]
            .filter(o => o.selected && o.value)
            .map(o => o.value);
        const minDays = parseInt(filterDays.value) || 0;
        const sort = filterSort.value;

        filteredNodes = allNodes.filter(n => {
            if (selectedCountries.length > 0 && !selectedCountries.includes(n.country)) return false;
            if (minDays > 0 && n.uptimeDays < minDays) return false;
            return true;
        });

        filteredNodes.sort((a, b) => {
            if (sort === 'uptime-desc') return b.uptimeDays - a.uptimeDays;
            if (sort === 'uptime-asc')  return a.uptimeDays - b.uptimeDays;
            if (sort === 'country-asc') return a.country.localeCompare(b.country);
            if (sort === 'latency-asc') return a.latency - b.latency;
            return 0;
        });

        renderNodesTable(filteredNodes);
        nodesCount.textContent = `${filteredNodes.length} / ${allNodes.length}`;
    }

    function renderNodesTable(nodes) {
        if (nodes.length === 0) {
            nodesTbody.innerHTML = '<tr><td colspan="5" class="table-empty">Нет узлов, соответствующих фильтру</td></tr>';
            return;
        }
        nodesTbody.innerHTML = '';
        for (const n of nodes) {
            const badge = uptimeBadge(n.uptimeDays);
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="country-cell">${n.country}</span></td>
                <td class="ip-cell">${n.realIp || '—'}</td>
                <td class="latency-cell">${n.latency > 0 ? n.latency + ' мс' : '—'}</td>
                <td class="date-cell">${formatDate(n.activeFrom)}</td>
                <td><span class="uptime-badge ${badge.cls}">${badge.label}</span></td>
            `;
            nodesTbody.appendChild(tr);
        }
    }

    async function loadNodes() {
        try {
            const res = await api('/api/nodes');
            allNodes = await res.json();
            populateCountryFilter(allNodes);
            applyFilters();
        } catch(e) {
            console.error('Не удалось загрузить узлы:', e);
        }
    }

    btnApplyFilter.addEventListener('click', applyFilters);

    // -------------------------------------------------------------------------
    // Filtered subscription URL builder
    // -------------------------------------------------------------------------

    function buildFilteredSubUrl() {
        const selectedCountries = [...filterCountry.options]
            .filter(o => o.selected && o.value)
            .map(o => o.value);
        const minDays = parseInt(filterDays.value) || 0;

        let base;
        if (serverIpData) {
            base = `http://${serverIpData.ip}:${serverIpData.port}/sub?token=${serverIpData.token}`;
        } else {
            base = window.location.origin + '/sub?';
        }

        const params = new URLSearchParams();
        // token already in base for serverIpData case; add for origin case
        if (!serverIpData && ACCESS_TOKEN) params.set('token', ACCESS_TOKEN);
        if (selectedCountries.length > 0) params.set('country', selectedCountries.join(','));
        if (minDays > 0) params.set('minDays', minDays);

        const queryStr = params.toString();
        return base + (queryStr ? (base.includes('?') ? '&' : '?') + queryStr : '');
    }

    btnGenUrl.addEventListener('click', () => {
        const url = buildFilteredSubUrl();
        filteredExportUrl.value = url;

        // Count matching nodes from current filter
        const count = filteredNodes.length;
        const selectedCountries = [...filterCountry.options]
            .filter(o => o.selected && o.value)
            .map(o => o.value);
        const minDays = parseInt(filterDays.value) || 0;

        let desc = `В подписку войдут ${count} узлов`;
        if (selectedCountries.length > 0) desc += ` из ${selectedCountries.join(', ')}`;
        if (minDays > 0) desc += ` с uptime ${minDays}+ дн.`;
        filteredCountInfo.textContent = desc;
        toast('Ссылка сгенерирована!', 'success');
    });

    btnCopyFiltered.addEventListener('click', async () => {
        if (!filteredExportUrl.value) {
            toast('Сначала нажмите «Сгенерировать ссылку»', 'error');
            return;
        }
        try {
            await navigator.clipboard.writeText(filteredExportUrl.value);
        } catch(e) {
            filteredExportUrl.select();
            document.execCommand('copy');
        }
        btnCopyFiltered.textContent = 'Скопировано!';
        setTimeout(() => btnCopyFiltered.textContent = 'Копировать', 2000);
    });

    // -------------------------------------------------------------------------
    // Initial load
    // -------------------------------------------------------------------------
    await loadSubs();
    await loadStats();
    await loadNodes();

    const btnStop = document.getElementById('btn-stop');

    let pollTimer = null;

    btnRun.addEventListener('click', async () => {
        const res = await api('/api/run', { method: 'POST' });
        if (res.ok) {
            progressSection.style.display = 'block';
            btnRun.style.display = 'none';
            btnStop.style.display = 'inline-block';
            if (pollTimer) clearTimeout(pollTimer);
            pollStatus();
        } else {
            const data = await res.json();
            toast('Ошибка: ' + data.error, 'error');
        }
    });

    btnStop.addEventListener('click', async () => {
        btnStop.disabled = true;
        btnStop.textContent = 'Остановка...';
        await api('/api/stop', { method: 'POST' });
        if (pollTimer) clearTimeout(pollTimer);
        pollStatus(); // force immediate poll
    });

    async function pollStatus() {
        try {
            const res = await api('/api/status');
            const status = await res.json();

            if (status.stage === 'fetching') statusText.textContent = 'Скачивание подписок...';
            else if (status.stage === 'filtering') statusText.textContent = 'Фильтрация мертвых узлов...';
            else if (status.stage === 'testing') {
                statusText.textContent = `Проверка узлов (${status.progress}/${status.total})...`;
                const percent = status.total > 0 ? (status.progress / status.total) * 100 : 0;
                progressFill.style.width = percent + '%';
            }

            if (status.logs && status.logs.length > 0) {
                const newText = status.logs.join('\n');
                if (liveLogs.value !== newText) {
                    liveLogs.value = newText;
                    liveLogs.scrollTop = liveLogs.scrollHeight;
                }
            }

            if (!status.isRunning) {
                btnRun.style.display = 'inline-block';
                btnStop.style.display = 'none';
                btnStop.disabled = false;
                btnStop.textContent = 'Остановить';
                // Reload stats and nodes table after run completes
                loadStats();
                loadNodes();

                if (status.stage === 'idle' && status.total > 0) {
                    statusText.textContent = `Проверка узлов (${status.total}/${status.total})...`;
                    progressFill.style.width = '100%';
                }

                if (status.stage === 'cancelled') {
                    statusText.textContent = 'Остановлено пользователем';
                    toast('Процесс остановлен', 'info');
                } else if (status.stage === 'error') {
                    toast('Произошла ошибка при выполнении', 'error');
                } else {
                    toast('Проверка завершена!', 'success');
                }
                return; // Stop polling
            }
        } catch (e) {
            console.error('Ошибка при опросе статуса:', e);
        }

        pollTimer = setTimeout(pollStatus, 1000);
    }

    btnCopy.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(exportUrl.value);
        } catch (e) {
            // clipboard API requires a secure context — fall back to selection
            exportUrl.select();
            document.execCommand('copy');
        }
        btnCopy.textContent = 'Скопировано!';
        setTimeout(() => btnCopy.textContent = 'Копировать', 2000);
    });
});
