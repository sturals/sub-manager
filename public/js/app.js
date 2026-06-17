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

    // When the dashboard is opened from another device (?token=...), forward
    // the token to every API call
    const ACCESS_TOKEN = new URLSearchParams(location.search).get('token');
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
        const ipData = await ipRes.json();
        exportUrl.value = `http://${ipData.ip}:${ipData.port}/sub?token=${ipData.token}`;
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

    await loadSubs();
    await loadStats();

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
                loadStats();

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
