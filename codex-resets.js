/* Public announcement statistics only; never accesses account usage or redeems credits. */
(() => {
    const API = 'https://codex-resets.com/api/v1';
    const DAY = 86400000;

    function summarize(status, events) {
        const { latest_reset: latest, scheduled_reset: scheduled, stats } = status.data || {};
        const times = events.map(event => Date.parse(event.announced_at)).sort((a, b) => a - b);
        if (!latest || !Number.isFinite(Date.parse(latest.announced_at)) || !times.length ||
            times.some(time => !Number.isFinite(time)) || !Number.isInteger(stats?.total) ||
            stats.total !== times.length || !Number.isFinite(stats.avg_interval_days) || stats.avg_interval_days < 0) {
            throw new Error('重置数据不完整');
        }
        const gaps = times.slice(1).map((time, index) => (time - times[index]) / DAY);
        return { latestAt: latest.announced_at, type: latest.reset_type, total: stats.total,
            averageDays: stats.avg_interval_days, longestDays: gaps.length ? Math.max(...gaps) : null,
            scheduled: scheduled ? { at: scheduled.scheduled_for } : null,
            fetchedAt: new Date().toISOString(), sourceAt: status.meta?.generated_at || null };
    }

    function elapsed(timestamp, now = Date.now()) {
        const age = now - Date.parse(timestamp);
        if (!Number.isFinite(age) || age < 0) return '时间待核实';
        if (age < 60000) return '刚刚';
        if (age < 3600000) return `${Math.floor(age / 60000)} 分钟前`;
        if (age < DAY) return `${Math.floor(age / 3600000)} 小时前`;
        return `${Math.floor(age / DAY)} 天前`;
    }

    // Runnable regression check: node codex-resets.js --self-check
    if (typeof document === 'undefined') {
        if (typeof module !== 'undefined') module.exports = { summarize, elapsed };
        if (typeof require !== 'undefined' && require.main === module) {
            const assert = require('node:assert/strict');
            const events = [{ announced_at: '2026-01-01T00:00:00Z' }, { announced_at: '2026-01-04T00:00:00Z' }];
            const status = { data: { latest_reset: events[1], scheduled_reset: null, stats: { total: 2, avg_interval_days: 3 } } };
            assert.equal(summarize(status, events).longestDays, 3);
            assert.equal(summarize(status, events).scheduled, null);
            assert.throws(() => summarize(status, events.slice(1)));
            assert.throws(() => summarize(status, [{ announced_at: 'bad' }, events[1]]));
            assert.equal(elapsed(events[0].announced_at, Date.parse('2026-01-01T12:00:00Z')), '12 小时前');
            assert.equal(elapsed('bad'), '时间待核实');
            console.log('Codex reset self-check passed');
        }
        return;
    }

    const byId = id => document.getElementById(`codex-reset-${id}`);
    const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    let current = null;
    let busy = false;

    function render(data, cached) {
        current = data;
        byId('elapsed').textContent = elapsed(data.latestAt);
        byId('date').textContent = `${dateFormat.format(new Date(data.latestAt))} · 北京时间`;
        byId('date').dateTime = data.latestAt;
        byId('type').textContent = { banked: '备用重置额度', regular: '常规重置' }[data.type] || '重置公告';
        byId('total').textContent = data.total.toLocaleString('zh-CN');
        byId('average').textContent = data.averageDays.toFixed(1);
        byId('longest').textContent = data.longestDays === null ? '—' : data.longestDays.toFixed(1);
        const scheduledTime = Date.parse(data.scheduled?.at);
        byId('next').textContent = !data.scheduled ? '下一次重置：暂无明确公告' :
            Number.isFinite(scheduledTime) && scheduledTime > Date.now() ? `已公告计划：${dateFormat.format(new Date(scheduledTime))}（北京时间），待执行确认` : '已有重置计划，等待执行确认';
        const snapshotAt = data.sourceAt || data.fetchedAt;
        byId('sync').textContent = `${cached ? '离线备用数据' : '来源数据'} · ${dateFormat.format(new Date(snapshotAt))}`;
        byId('sync').className = cached ? 'text-amber-600' : 'text-gray-400';
    }

    async function getJson(url) {
        const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    async function refresh() {
        if (busy) return;
        busy = true;
        byId('refresh').disabled = true;
        byId('sync').textContent = '正在更新…';
        try {
            const status = await getJson(`${API}/status`);
            const events = [];
            let cursor = '';
            const seen = new Set();
            do {
                const page = await getJson(`${API}/resets?limit=100&order=asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
                events.push(...page.data);
                cursor = page.pagination.has_more ? page.pagination.next_cursor : '';
                if (page.pagination.has_more && (!cursor || seen.has(cursor) || seen.size >= 20)) throw new Error('历史分页异常');
                seen.add(cursor);
            } while (cursor);
            render(summarize(status, events), false);
        } catch (error) {
            console.warn('Codex reset refresh:', error);
            try { render(current || await getJson('./data/codex-resets.json'), true); }
            catch { byId('sync').textContent = '暂时无法获取数据，请稍后重试'; byId('next').textContent = '可点击来源链接查看最新公告'; }
        } finally {
            busy = false;
            byId('refresh').disabled = false;
        }
    }

    byId('refresh').addEventListener('click', refresh);
    refresh();
    setInterval(() => {
        if (!document.hidden && current) byId('elapsed').textContent = elapsed(current.latestAt);
    }, 60000);
    setInterval(() => { if (!document.hidden) refresh(); }, 15 * 60000);
})();
