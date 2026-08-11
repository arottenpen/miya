(function (global) {
    'use strict';

    var WEATHER_CACHE = { geocode: {}, weather: {} };

    function clamp(n, lo, hi) {
        return Math.min(hi, Math.max(lo, n));
    }

    function pickTs(v, fallback) {
        var n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
        n = Number(fallback);
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    function localTz() {
        try {
            return (
                (Intl && Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions().timeZone) ||
                'Asia/Shanghai'
            );
        } catch (e) {
            return 'Asia/Shanghai';
        }
    }

    function formatFullDateTimeForTz(ts, tz) {
        var t = pickTs(ts, Date.now());
        try {
            return new Intl.DateTimeFormat('zh-CN', {
                timeZone: tz || localTz(),
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                weekday: 'short',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }).format(new Date(t));
        } catch (e) {
            return new Date(t).toLocaleString('zh-CN', { hour12: false });
        }
    }

    function formatClockForTz(ts, tz) {
        var t = pickTs(ts, Date.now());
        try {
            return new Intl.DateTimeFormat('zh-CN', {
                timeZone: tz || localTz(),
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }).format(new Date(t));
        } catch (e) {
            return new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
        }
    }

    function formatDateWeekForTz(ts, tz) {
        var t = pickTs(ts, Date.now());
        try {
            return new Intl.DateTimeFormat('zh-CN', {
                timeZone: tz || localTz(),
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                weekday: 'short'
            }).format(new Date(t));
        } catch (e) {
            return new Date(t).toLocaleDateString('zh-CN');
        }
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    /** 旧版 Miya API 时间标记；新协议改用完整本地时间方括号前缀，旧格式仍须能剥离。 */
    var RE_MIYA_WHO = '(?:用户|角色|[ua])';
    var RE_MIYA_API_TS_PREFIX = new RegExp(
        '^⧗' +
            RE_MIYA_WHO +
            '·(?:\\d+m·)?(?:昨·|\\d+天·|\\d{1,2}-\\d{1,2}·|\\d{1,2}\\/\\d{1,2}·)?(?:周[一二三四五六日天]·)?\\d{1,2}:\\d{2}(?:@[^›·]+)?›\\s*'
    );
    var RE_MIYA_API_TS_GLOBAL = new RegExp(
        '⧗' +
            RE_MIYA_WHO +
            '·(?:\\d+m·)?(?:昨·|\\d+天·|\\d{1,2}-\\d{1,2}·|\\d{1,2}\\/\\d{1,2}·)?(?:周[一二三四五六日天]·)?\\d{1,2}:\\d{2}(?:@[^›·\\s]+)?›\\s*',
        'g'
    );
    /** 模型漏写 › 或仅在行尾残留 ⧗ 时的宽松匹配 */
    var RE_MIYA_API_TS_LOOSE = /⧗(?:用户|角色|[ua])?·?[^\s›\n]*›?\s*/g;
    var RE_TRAILING_ORPHAN_MARK = /(?:\s*⧗(?:用户|角色|[ua])?[^›\n]*)?\s*›\s*$/;
    var RE_LEGACY_API_TS_PREFIX =
        /^\[(?:D-?\d+\s+)?\d{2}\/\d{2}\/\d{2}\s+\d{1,2}:\d{2}(?:\s+[UA](?:@[^\]]+)?)?\]\s*/i;
    var RE_LEGACY_API_TS_GLOBAL =
        /\[(?:D-?\d+\s+)?\d{2}\/\d{2}\/\d{2}\s+\d{1,2}:\d{2}(?:\s+[UA](?:@[^\]]+)?)?\]\s*/gi;
    function formatHmForTz(ts, tz) {
        var p = wallClockPartsInTz(ts, tz);
        if (!p || !Number.isFinite(p.hour) || !Number.isFinite(p.minute)) {
            var d = new Date(pickTs(ts, Date.now()));
            return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        }
        return pad2(p.hour) + ':' + pad2(p.minute);
    }

    /** 角色时区下的「周四」等短周几 */
    function formatWeekdayZhForTz(ts, tz) {
        var t = pickTs(ts, Date.now());
        try {
            var parts = new Intl.DateTimeFormat('zh-CN', {
                timeZone: tz || localTz(),
                weekday: 'short'
            }).formatToParts(new Date(t));
            var wd = '';
            parts.forEach(function (p) {
                if (p && p.type === 'weekday') wd = String(p.value || '');
            });
            if (wd) {
                wd = wd.replace(/^星期/, '周');
                if (wd.indexOf('周') === 0) return wd;
                return '周' + wd;
            }
        } catch (eWd) {}
        var d = new Date(t);
        return '周' + '日一二三四五六'.charAt(d.getDay());
    }

    function wallClockPartsInTz(ts, tz) {
        var t = pickTs(ts, Date.now());
        try {
            var out = {};
            new Intl.DateTimeFormat('en-US', {
                timeZone: tz || localTz(),
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric',
                hour12: false
            })
                .formatToParts(new Date(t))
                .forEach(function (p) {
                    if (!p || p.type === 'literal') return;
                    out[p.type] = Number(p.value);
                });
            return out;
        } catch (e) {
            var d = new Date(t);
            return {
                year: d.getFullYear(),
                month: d.getMonth() + 1,
                day: d.getDate(),
                hour: d.getHours(),
                minute: d.getMinutes(),
                second: d.getSeconds()
            };
        }
    }

    /** 将角色时区下的 YYYY-MM-DD HH:mm 转为 UTC 毫秒时间戳 */
    function wallClockToMs(year, month, day, hour, minute, tz) {
        year = Number(year);
        month = Number(month);
        day = Number(day);
        hour = Number(hour);
        minute = Number(minute);
        if (
            !Number.isFinite(year) ||
            !Number.isFinite(month) ||
            !Number.isFinite(day) ||
            !Number.isFinite(hour) ||
            !Number.isFinite(minute)
        ) {
            return 0;
        }
        tz = String(tz || '').trim() || localTz();
        var target = [year, month, day, hour, minute];
        function cmpParts(p) {
            if (!p) return -1;
            return (
                p.year - target[0] ||
                p.month - target[1] ||
                p.day - target[2] ||
                p.hour - target[3] ||
                p.minute - target[4]
            );
        }
        var lo = Date.UTC(year, month - 1, day, hour - 14, minute) - 172800000;
        var hi = Date.UTC(year, month - 1, day, hour + 14, minute) + 172800000;
        while (lo < hi - 1) {
            var mid = Math.floor((lo + hi) / 2);
            if (cmpParts(wallClockPartsInTz(mid, tz)) < 0) lo = mid;
            else hi = mid;
        }
        var hit = cmpParts(wallClockPartsInTz(lo, tz)) === 0 ? lo : cmpParts(wallClockPartsInTz(hi, tz)) === 0 ? hi : 0;
        return hit;
    }

    function formatMonthDayForTz(ts, tz) {
        var t = pickTs(ts, Date.now());
        try {
            var parts = new Intl.DateTimeFormat('zh-CN', {
                timeZone: tz || localTz(),
                month: '2-digit',
                day: '2-digit'
            }).formatToParts(new Date(t));
            var mm = '',
                dd = '';
            parts.forEach(function (p) {
                if (!p) return;
                if (p.type === 'month') mm = p.value;
                else if (p.type === 'day') dd = p.value;
            });
            if (mm && dd) return mm + '-' + dd;
        } catch (e2) {}
        var d = new Date(t);
        return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    /** API 时间戳用的绝对月日，如 7/12（不补零，不用「今/昨」） */
    function formatMonthDaySlashForTz(ts, tz) {
        var t = Number(ts);
        if (!Number.isFinite(t) || t <= 0) return '';
        var p = wallClockPartsInTz(t, tz);
        if (!p || !p.month || !p.day) return '';
        return String(p.month) + '/' + String(p.day);
    }

    function stripOneTimelinePrefix(text) {
        var out = String(text || '').trim();
        var guard = 0;
        while (guard++ < 8) {
            var next = out
                .replace(RE_MIYA_API_TS_PREFIX, '')
                .replace(RE_LEGACY_API_TS_PREFIX, '');
            if (next === out) break;
            out = next.trim();
        }
        return out;
    }

    /** 仅供旧协议解析兼容：移除正文中任意位置的旧 API 时间标记。 */
    function stripAllApiTimelineMarkers(text) {
        var out = String(text || '');
        if (!out) return '';
        var prev;
        var guard = 0;
        do {
            prev = out;
            out = out
                .replace(RE_MIYA_API_TS_GLOBAL, '')
                .replace(RE_MIYA_API_TS_LOOSE, '')
                .replace(RE_LEGACY_API_TS_GLOBAL, '');
            guard += 1;
        } while (prev !== out && guard < 16);
        out = out.replace(RE_TRAILING_ORPHAN_MARK, '');
        out = out.replace(/\s*⧗\s*$/g, '');
        out = out.replace(/\s*›\s*/g, ' ');
        return out.replace(/\s{2,}/g, ' ').trim();
    }

    /** 引用摘抄中误带的每轮 system 注入标记（模型偶发复制进 引用- 行） */
    function stripQuotePromptLeakage(text) {
        var s = String(text || '').trim();
        if (!s) return '';
        s = s
            .replace(/【场景锁定·单聊】\s*(?:当前请求仅适用于本单聊线程[^】]*[。．.]?)?/g, '')
            .replace(/【本轮输出格式·强制复核[^】]*】/g, '')
            .trim();
        return s;
    }

    /** 展示兼容仅处理 assistant 开头协议；user/system 正文不按文本形状清洗。 */
    function stripTimelinePrefixForDisplay(text, message) {
        var s = String(text || '').trim();
        if (!s) return '';
        if (!message || message.role !== 'assistant') return s;
        var expected = buildMiyaApiTimelinePrefix(message.createdAt);
        var guard = 0;
        while (s && guard++ < 8) {
            var next = s.replace(RE_MIYA_API_TS_PREFIX, '').trim();
            if (expected && next === s && s.slice(0, expected.length) === expected) {
                next = s.slice(expected.length).trim();
            }
            if (next === s) break;
            s = next;
        }
        return s;
    }

    /** 角色模型输出仅清理整行开头连续旧 ⧗ 协议；正文内旧标记始终作为正文保留。 */
    function splitCollapsedTimelineSegments(text) {
        var raw = String(text || '').trim();
        if (!raw) return [];
        var out = raw;
        var guard = 0;
        while (out && guard++ < 8) {
            var next = out.replace(RE_MIYA_API_TS_PREFIX, '').trim();
            if (next === out) break;
            out = next;
        }
        return [out || raw];
    }

    /** 角色回复入库前：仅清洗开头、且可由角色消息自身上下文确认的时间协议。 */
    function sanitizeRoleMessageFields(fields) {
        if (!fields || typeof fields !== 'object') return fields;
        var fmt = global.MiyaChatOnlineFormat;
        var stripStars =
            fmt && typeof fmt.stripOrphanMarkdownEmphasis === 'function'
                ? fmt.stripOrphanMarkdownEmphasis
                : null;
        var out = Object.assign({}, fields);
        if (out.content != null) out.content = stripTimelinePrefixForDisplay(String(out.content), out);
        if (stripStars && out.role === 'assistant' && out.content != null) {
            out.content = stripStars(out.content);
        }
        if (out.voiceText != null) out.voiceText = stripTimelinePrefixForDisplay(String(out.voiceText), out);
        if (stripStars && out.role === 'assistant' && out.voiceText != null) {
            out.voiceText = stripStars(out.voiceText);
        }
        if (out.callLine != null) out.callLine = stripTimelinePrefixForDisplay(String(out.callLine), out);
        if (stripStars && out.role === 'assistant' && out.callLine != null) {
            out.callLine = stripStars(out.callLine);
        }
        if (out.stickerName != null) out.stickerName = stripTimelinePrefixForDisplay(String(out.stickerName), out);
        if (out.quoteRef && typeof out.quoteRef === 'object' && out.quoteRef.text != null) {
            out.quoteRef = Object.assign({}, out.quoteRef, {
                text: stripQuotePromptLeakage(String(out.quoteRef.text))
            });
        }
        if (out.locationCard && typeof out.locationCard === 'object') {
            out.locationCard = Object.assign({}, out.locationCard);
            if (out.locationCard.name != null) {
                out.locationCard.name = stripTimelinePrefixForDisplay(String(out.locationCard.name), out);
            }
            if (out.locationCard.address != null) {
                out.locationCard.address = stripTimelinePrefixForDisplay(String(out.locationCard.address), out);
            }
        }
        if (out.redPacket && typeof out.redPacket === 'object' && out.redPacket.note != null) {
            out.redPacket = Object.assign({}, out.redPacket, {
                note: stripTimelinePrefixForDisplay(String(out.redPacket.note), out)
            });
        }
        if (out.takeoutOrder && typeof out.takeoutOrder === 'object') {
            out.takeoutOrder = Object.assign({}, out.takeoutOrder);
            if (out.takeoutOrder.shop != null) {
                out.takeoutOrder.shop = stripTimelinePrefixForDisplay(String(out.takeoutOrder.shop), out);
            }
            if (out.takeoutOrder.items != null) {
                out.takeoutOrder.items = stripTimelinePrefixForDisplay(String(out.takeoutOrder.items), out);
            }
            if (out.takeoutOrder.note != null) {
                out.takeoutOrder.note = stripTimelinePrefixForDisplay(String(out.takeoutOrder.note), out);
            }
        }
        if (out.giftParcel && typeof out.giftParcel === 'object') {
            out.giftParcel = Object.assign({}, out.giftParcel);
            if (out.giftParcel.note != null) {
                out.giftParcel.note = stripTimelinePrefixForDisplay(String(out.giftParcel.note), out);
            }
            if (Array.isArray(out.giftParcel.items)) {
                out.giftParcel.items = out.giftParcel.items.map(function (it) {
                    if (!it || typeof it !== 'object') return it;
                    return Object.assign({}, it, {
                        name: it.name != null ? stripTimelinePrefixForDisplay(String(it.name), out) : it.name,
                        shop: it.shop != null ? stripTimelinePrefixForDisplay(String(it.shop), out) : it.shop
                    });
                });
            }
        }
        return out;
    }

    function formatTimelineDateTime(ts, tz) {
        var t = Number(ts);
        if (!Number.isFinite(t) || t <= 0) return '';
        try {
            var fmt = new Intl.DateTimeFormat('zh-CN', {
                timeZone: tz || localTz(),
                year: '2-digit',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
            var parts = fmt.formatToParts ? fmt.formatToParts(new Date(t)) : null;
            if (parts && parts.length) {
                var yy = '',
                    mm = '',
                    dd = '',
                    hh = '',
                    mi = '';
                parts.forEach(function (p) {
                    if (!p) return;
                    if (p.type === 'year') yy = p.value;
                    else if (p.type === 'month') mm = p.value;
                    else if (p.type === 'day') dd = p.value;
                    else if (p.type === 'hour') hh = p.value;
                    else if (p.type === 'minute') mi = p.value;
                });
                if (yy && mm && dd && hh && mi) return yy + '/' + mm + '/' + dd + ' ' + hh + ':' + mi;
            }
        } catch (e) {}
        var d = new Date(t);
        return (
            String(d.getFullYear()).slice(-2) +
            '/' +
            pad2(d.getMonth() + 1) +
            '/' +
            pad2(d.getDate()) +
            ' ' +
            pad2(d.getHours()) +
            ':' +
            pad2(d.getMinutes())
        );
    }

    function calcTimelineDayDelta(ts, nowTs, tz) {
        var t = Number(ts);
        var now = Number(nowTs);
        if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(now) || now <= 0) return null;
        var tp = wallClockPartsInTz(t, tz);
        var np = wallClockPartsInTz(now, tz);
        if (!tp || !np || !tp.year || !np.year) return null;
        var tMid = Date.UTC(tp.year, tp.month - 1, tp.day, 12, 0, 0);
        var nMid = Date.UTC(np.year, np.month - 1, np.day, 12, 0, 0);
        return Math.round((nMid - tMid) / 86400000);
    }

    /** 末尾连续用户消息区间（待回复）；用于纠正「刚发」误判 */
    function trailingUserBurstMeta(history) {
        if (!Array.isArray(history) || !history.length) {
            return { count: 0, firstTs: 0, lastTs: 0 };
        }
        var lastTs = 0;
        var firstTs = 0;
        var count = 0;
        var i;
        for (i = history.length - 1; i >= 0; i--) {
            var row = history[i];
            if (!row || row.deleted) continue;
            if (row.role !== 'user') break;
            var t = Number(row.createdAt);
            if (!Number.isFinite(t) || t <= 0) continue;
            if (!lastTs) lastTs = t;
            firstTs = t;
            count += 1;
        }
        return { count: count, firstTs: firstTs, lastTs: lastTs };
    }

    function shortTzTag(tz) {
        var s = String(tz || '').trim();
        if (!s) return '';
        var i = s.lastIndexOf('/');
        return (i >= 0 ? s.slice(i + 1) : s).replace(/_/g, '');
    }

    function isValidMessageTimestamp(value) {
        var ts = Number(value);
        return Number.isFinite(ts) && ts > 0;
    }

    function formatLocalMessageDateTime(ts) {
        if (!isValidMessageTimestamp(ts)) return '';
        var d = new Date(Number(ts));
        if (Number.isNaN(d.getTime())) return '';
        return (
            d.getFullYear() +
            '/' +
            pad2(d.getMonth() + 1) +
            '/' +
            pad2(d.getDate()) +
            '-星期' +
            '日一二三四五六'.charAt(d.getDay()) +
            '-' +
            pad2(d.getHours()) +
            ':' +
            pad2(d.getMinutes()) +
            ':' +
            pad2(d.getSeconds())
        );
    }

    function buildMiyaApiTimelinePrefix(ts) {
        var formatted = formatLocalMessageDateTime(ts);
        return formatted ? '[' + formatted + ']' : '';
    }

    function resolveMessageFormatter(formatter) {
        return formatter || global.MiyaChatOnlineFormat || null;
    }

    function isRealChatMessage(m, formatter) {
        var st = global.miyaChatStore;
        if (st && typeof st.isRealTimelineMessage === 'function') {
            return st.isRealTimelineMessage(m);
        }
        if (!m || m.deleted || (m.role !== 'user' && m.role !== 'assistant')) return false;
        var fmt = resolveMessageFormatter(formatter);
        if (fmt && typeof fmt.shouldOmitMessage === 'function' && fmt.shouldOmitMessage(m)) return false;
        var body =
            fmt && typeof fmt.formatMessageForApi === 'function'
                ? fmt.formatMessageForApi(m)
                : String(m.content || '').trim();
        return !!String(body || '').trim();
    }

    function buildConversationGapReminder(messageOrGap) {
        var rawGap =
            messageOrGap && messageOrGap.conversationGap && typeof messageOrGap.conversationGap === 'object'
                ? messageOrGap.conversationGap
                : messageOrGap;
        var st = global.miyaChatStore;
        var gap =
            st && typeof st.normalizeConversationGap === 'function'
                ? st.normalizeConversationGap(rawGap)
                : rawGap && rawGap.crossed === true && Number.isFinite(Number(rawGap.elapsedMs)) && Number(rawGap.elapsedMs) > 30 * 60 * 1000
                  ? { crossed: true, elapsedMs: Math.floor(Number(rawGap.elapsedMs)) }
                  : null;
        if (!gap || gap.crossed !== true) return '';
        var duration = formatPreciseDurationZh(gap.elapsedMs);
        return duration ? '【对话间隔提醒】距离上次对话经过了 ' + duration + '。' : '';
    }

    function formatRoughDurationZh(ms) {
        return formatPreciseDurationZh(ms, true);
    }

    /** @param {boolean} rough 为 true 时用「约」字柔和表述 */
    function formatPreciseDurationZh(ms, rough) {
        var x = Math.max(0, Number(ms) || 0);
        if (!Number.isFinite(x)) return '';
        var min = Math.round(x / 60000);
        if (min < 1) return '不到1分钟';
        if (min < 60) return min + (rough ? '分钟左右' : '分钟');
        var hr = Math.floor(min / 60);
        var rm = min % 60;
        if (hr < 24) {
            if (!rm) return hr + (rough ? '小时左右' : '小时');
            return hr + '小时' + rm + '分钟';
        }
        var day = Math.floor(hr / 24);
        if (day < 30) return day + (rough ? '天左右' : '天');
        return Math.floor(day / 30) + (rough ? '个月左右' : '个月');
    }

    function historyWithoutTrailingUserBurst(history) {
        if (!Array.isArray(history) || !history.length) return [];
        var end = history.length;
        while (end > 0) {
            var row = history[end - 1];
            if (!row || row.deleted) {
                end -= 1;
                continue;
            }
            if (row.role === 'user') {
                end -= 1;
                continue;
            }
            break;
        }
        return history.slice(0, end);
    }

    function countTrailingUserMessages(history) {
        if (!Array.isArray(history)) return 0;
        var n = 0;
        for (var i = history.length - 1; i >= 0; i--) {
            var row = history[i];
            if (!row || row.deleted) continue;
            if (row.role !== 'user') break;
            n += 1;
        }
        return n;
    }

    /** 间隔锚点：排除本轮尚未回复的用户消息，避免把「刚发出去」当成上次互动 */
    function gapAnchorTs(history) {
        return historyLastTs(historyWithoutTrailingUserBurst(history));
    }

    function historyLastTs(history, roleFilter) {
        if (!Array.isArray(history) || !history.length) return 0;
        for (var i = history.length - 1; i >= 0; i--) {
            var row = history[i];
            if (!row || row.deleted) continue;
            if (roleFilter === 'user' && row.role !== 'user') continue;
            if (roleFilter === 'assistant' && row.role !== 'assistant') continue;
            var t = Number(row.createdAt);
            if (Number.isFinite(t) && t > 0) return t;
        }
        return 0;
    }

    function normalizeTimeAwareness(raw) {
        var tz = localTz();
        var d = {
            enabled: false,
            mode: 'real',
            real: { userTz: tz, roleTz: tz, strength: 'strong' }
        };
        if (!raw || typeof raw !== 'object') return d;
        var out = {
            enabled: !!raw.enabled,
            mode: String(raw.mode || 'real') === 'virtual' ? 'virtual' : 'real',
            real: Object.assign({}, d.real, raw.real || {})
        };
        out.real.userTz = String(out.real.userTz || '').trim() || tz;
        out.real.roleTz = String(out.real.roleTz || '').trim() || tz;
        out.real.strength = out.real.strength === 'normal' ? 'normal' : 'strong';
        return out;
    }

    function normalizeWeatherAwareness(raw) {
        var d = {
            enabled: false,
            placeUser: '',
            placeRole: '',
            realLocUser: '',
            realLocRole: '',
            weatherTextUser: '',
            weatherTextRole: '',
            weatherTempUser: null,
            weatherTempRole: null,
            mappedLatUser: null,
            mappedLonUser: null,
            mappedLatRole: null,
            mappedLonRole: null,
            lastFetchAt: 0
        };
        if (!raw || typeof raw !== 'object') return d;
        var out = Object.assign({}, d, raw);
        out.placeUser = String(out.placeUser || out.virtualLocUser || '').trim();
        out.placeRole = String(out.placeRole || out.virtualLocRole || '').trim();
        out.realLocUser = String(out.realLocUser || '').trim();
        out.realLocRole = String(out.realLocRole || '').trim();
        out.enabled = !!out.enabled;
        if (Number(out.settingsUiVersion) !== 2) {
            function swapField(a, b) {
                var t = out[a];
                out[a] = out[b];
                out[b] = t;
            }
            swapField('placeUser', 'placeRole');
            swapField('realLocUser', 'realLocRole');
            swapField('weatherTextUser', 'weatherTextRole');
            swapField('mappedLatUser', 'mappedLatRole');
            swapField('mappedLonUser', 'mappedLonRole');
            var tU = out.weatherTempUser;
            out.weatherTempUser = out.weatherTempRole;
            out.weatherTempRole = tU;
            out.settingsUiVersion = 2;
        }
        return out;
    }

    function isTimeStrong(chatSettings) {
        var ta = chatSettings && chatSettings.timeAwareness;
        return !!(ta && ta.enabled && ta.mode === 'real' && ta.real && ta.real.strength === 'strong');
    }

    function isTimeStampEnabled(chatSettings) {
        var ta = chatSettings && chatSettings.timeAwareness;
        return !!(ta && ta.enabled && ta.mode === 'real');
    }

    function buildTimeAwarenessRules(chatSettings, history, profile) {
        var ta = normalizeTimeAwareness(chatSettings && chatSettings.timeAwareness);
        if (!ta.enabled) {
            return [
                '【时间运转（关闭）】',
                '- 你无法获知当前现实时间；除非用户明确给出时间，勿自行推断几点/刚刚等。'
            ].join('\n');
        }
        var nowTs = Date.now();
        var userLast = historyLastTs(history, 'user');
        var asstLast = historyLastTs(history, 'assistant');
        var lines = ['【时间运转】'];
        lines.push('- 浏览器本地当前时间: ' + formatLocalMessageDateTime(nowTs));
        if (userLast) {
            lines.push('- 用户最新发言: ' + formatLocalMessageDateTime(userLast));
        }
        if (asstLast) {
            lines.push('- 你方最新发言: ' + formatLocalMessageDateTime(asstLast));
        }
        if (ta.real.strength === 'strong') {
            var trailing = trailingUserBurstMeta(history);
            if (trailing.count > 0 && trailing.firstTs) {
                lines.push(
                        '- 末尾 ' +
                        trailing.count +
                        ' 条用户消息待回复；最早 ' +
                        formatLocalMessageDateTime(trailing.firstTs) +
                        '，按真实发送时刻理解，勿默认成刚刚。'
                );
            }
        }
        lines.push(
            '- 每条真实聊天消息前缀形如 [2026/08/11-星期二-22:58:05]，即该条固定的浏览器本地发送时刻。'
        );
        lines.push('- 禁止在正文输出方括号时间前缀、⧗、› 或任何时间戳标记。');
        lines.push('- 默认正文不要报时或重复强调经过了多久。');
        return lines.join('\n');
    }

    function buildPerTurnTimeAwarenessBlock(chatSettings, history) {
        var ta = normalizeTimeAwareness(chatSettings && chatSettings.timeAwareness);
        if (!ta.enabled) return '';
        var nowTs = Date.now();
        return ['【本轮时间】', '- 浏览器本地当前时间: ' + formatLocalMessageDateTime(nowTs), '- 正文默认不必提时间。'].join('\n');
    }

    function buildPlaceAwarenessRules(chatSettings, contact, profile) {
        var wa = normalizeWeatherAwareness(chatSettings && chatSettings.weatherAwareness);
        if (!wa.placeUser && !wa.placeRole) return '';
        var userName = String((profile && profile.name) || '用户').trim() || '用户';
        var roleName = String((contact && contact.name) || '角色').trim() || '角色';
        var lines = [
            '以下地点即双方真实日常生活所在地（非临时场景或纯虚构布景）；对话、活动、见闻与出行均须以此为准。'
        ];
        if (wa.placeUser) lines.push(userName + '日常所在地：' + wa.placeUser + '。');
        if (wa.placeRole) lines.push('你（' + roleName + '）日常所在地：' + wa.placeRole + '。');
        if (wa.realLocUser && wa.realLocUser !== wa.placeUser) {
            lines.push(userName + '所在地「' + wa.placeUser + '」的气候参照现实「' + wa.realLocUser + '」。');
        } else if (wa.realLocUser && wa.placeUser) {
            lines.push(userName + '所在地气候参照：' + wa.realLocUser + '。');
        }
        if (wa.realLocRole && wa.realLocRole !== wa.placeRole) {
            lines.push('你所在地「' + wa.placeRole + '」的气候参照现实「' + wa.realLocRole + '」。');
        } else if (wa.realLocRole && wa.placeRole) {
            lines.push('你所在地气候参照：' + wa.realLocRole + '。');
        }
        return lines.join('\n');
    }

    function formatWeatherSideForPrompt(wa, side) {
        var norm = normalizeWeatherAwareness(wa);
        var text = side === 'user' ? norm.weatherTextUser : norm.weatherTextRole;
        var temp = side === 'user' ? norm.weatherTempUser : norm.weatherTempRole;
        text = String(text || '').trim();
        var parts = [];
        if (text) parts.push(text);
        if (Number.isFinite(temp)) {
            var tempStr = Number(temp).toFixed(1) + '°C';
            if (!text || text.indexOf('°C') < 0) parts.push('当前' + tempStr);
        }
        return parts.length ? parts.join('，') : '暂无数据';
    }

    function weatherSideNeedsData(wa, side) {
        wa = normalizeWeatherAwareness(wa);
        if (!wa.enabled) return false;
        var loc = side === 'user' ? wa.realLocUser : wa.realLocRole;
        if (!loc) return false;
        var text = side === 'user' ? wa.weatherTextUser : wa.weatherTextRole;
        var temp = side === 'user' ? wa.weatherTempUser : wa.weatherTempRole;
        if (!String(text || '').trim()) return true;
        return !Number.isFinite(temp);
    }

    function weatherDataIncomplete(wa) {
        return weatherSideNeedsData(wa, 'user') || weatherSideNeedsData(wa, 'role');
    }

    function buildWeatherAwarenessRules(chatSettings) {
        var wa = normalizeWeatherAwareness(chatSettings && chatSettings.weatherAwareness);
        if (!wa.enabled) return '';
        var userName = '用户';
        var weatherRole = formatWeatherSideForPrompt(wa, 'role');
        var weatherUser = formatWeatherSideForPrompt(wa, 'user');
        return [
            '【天气运转】',
            '以下天气对应各自日常所在地的当前实况。',
            '你所在地点此刻天气：' + weatherRole + '。',
            userName + '所在地点此刻天气：' + weatherUser + '。',
            '若提及天气须与以上信息一致，勿擅自改写。',
            '禁止每轮主动提起天气或反复描写阴晴冷暖；仅当剧情自然需要时顺带一句，勿把天气当固定开场。'
        ].join('\n');
    }

    function memberDisplayLabel(store, contact, groupChatId) {
        var gg = global.MiyaChatGroup;
        if (gg && typeof gg.memberDisplayName === 'function') {
            return gg.memberDisplayName(store, contact, groupChatId);
        }
        return String((contact && (contact.remarkName || contact.name)) || '成员').trim() || '成员';
    }

    function collectMemberPrivateWeather(store, members, profileId) {
        var rows = [];
        if (!store || !members || !members.length) return rows;
        members.forEach(function (contact) {
            if (!contact || !contact.id) return;
            var priv =
                typeof store.findChatByContact === 'function'
                    ? store.findChatByContact(contact.id, profileId)
                    : null;
            if (!priv) return;
            var settings =
                typeof store.getChatSettings === 'function' ? store.getChatSettings(priv.id) : null;
            var wa = normalizeWeatherAwareness(settings && settings.weatherAwareness);
            if (!wa.enabled) return;
            rows.push({ contact: contact, wa: wa });
        });
        return rows;
    }

    function buildGroupPlaceAwarenessRules(store, members, profileId, profile, groupChatId) {
        var rows = collectMemberPrivateWeather(store, members, profileId);
        if (!rows.length) return '';
        var userName = String((profile && profile.name) || '用户').trim() || '用户';
        var userPlace = '';
        var userReal = '';
        var memberLines = [];
        rows.forEach(function (row) {
            var wa = row.wa;
            var name = memberDisplayLabel(store, row.contact, groupChatId);
            if (!userPlace && wa.placeUser) userPlace = wa.placeUser;
            if (!userReal && wa.realLocUser) userReal = wa.realLocUser;
            var parts = [];
            if (wa.placeRole) parts.push('日常所在地：' + wa.placeRole);
            if (wa.realLocRole && wa.realLocRole !== wa.placeRole) {
                parts.push('气候参照现实「' + wa.realLocRole + '」');
            } else if (wa.realLocRole) {
                parts.push('气候参照：' + wa.realLocRole);
            }
            if (parts.length) memberLines.push('- ' + name + '：' + parts.join('；'));
        });
        var lines = [
            '以下地点来自各成员单聊配置，须与单聊设定一致；对话、活动与出行均以此为准。'
        ];
        if (userPlace) {
            lines.push(userName + '日常所在地：' + userPlace + '。');
            if (userReal && userReal !== userPlace) {
                lines.push(userName + '所在地气候参照现实「' + userReal + '」。');
            }
        }
        if (memberLines.length) {
            lines.push('各成员：');
            lines = lines.concat(memberLines);
        }
        return lines.join('\n');
    }

    function buildGroupWeatherAwarenessRules(store, members, profileId, profile, groupChatId) {
        var rows = collectMemberPrivateWeather(store, members, profileId);
        if (!rows.length) return '';
        var userName = String((profile && profile.name) || '用户').trim() || '用户';
        var userWeather = '';
        var memberLines = [];
        rows.forEach(function (row) {
            var wa = row.wa;
            var name = memberDisplayLabel(store, row.contact, groupChatId);
            if (!userWeather) {
                var uw = formatWeatherSideForPrompt(wa, 'user');
                if (uw && uw !== '暂无数据') userWeather = uw;
            }
            var roleWeather = formatWeatherSideForPrompt(wa, 'role');
            if (roleWeather && roleWeather !== '暂无数据') {
                memberLines.push('- ' + name + '所在地点此刻天气：' + roleWeather + '。');
            }
        });
        var lines = [
            '【天气运转·群聊】',
            '以下天气来自各成员单聊中已配置的地点映射，须与单聊设定一致。',
            userWeather ? userName + '所在地点此刻天气：' + userWeather + '。' : ''
        ].filter(Boolean);
        if (memberLines.length) {
            lines.push('各成员：');
            lines = lines.concat(memberLines);
        }
        lines.push(
            '若提及天气须与以上信息一致，勿擅自改写。',
            '禁止每轮主动提起天气或反复描写阴晴冷暖；仅当剧情自然需要时顺带一句，勿把天气当固定开场。'
        );
        return lines.join('\n');
    }

    function refreshGroupMembersWeatherIfStale(store, chatRow) {
        if (!store || !chatRow || chatRow.type !== 'group') return Promise.resolve();
        var members =
            global.MiyaChatGroup && typeof global.MiyaChatGroup.getMembers === 'function'
                ? global.MiyaChatGroup.getMembers(store, chatRow)
                : [];
        if (!members.length) return Promise.resolve();
        var profileId = chatRow.profileId;
        var chain = Promise.resolve();
        members.forEach(function (contact) {
            chain = chain.then(function () {
                var priv =
                    typeof store.findChatByContact === 'function'
                        ? store.findChatByContact(contact.id, profileId)
                        : null;
                if (!priv) return;
                var settings =
                    typeof store.getChatSettings === 'function' ? store.getChatSettings(priv.id) : null;
                var wa = normalizeWeatherAwareness(settings && settings.weatherAwareness);
                if (!wa.enabled) return;
                var stale =
                    needsWeatherDailyRefresh(wa) ||
                    weatherNeedsInitialFetch(wa) ||
                    weatherDataIncomplete(wa);
                if (!stale) return;
                return refreshWeatherIfStale(Object.assign({}, settings, { weatherAwareness: wa }), {
                    force: true
                }).then(function (refreshed) {
                    if (refreshed && refreshed.weatherAwareness && store.saveChatSettings) {
                        return store.saveChatSettings(priv.id, {
                            weatherAwareness: refreshed.weatherAwareness
                        });
                    }
                });
            });
        });
        return chain.catch(function () {});
    }

    function stampMessageForApi(text, m, chatSettings, nowTs, prevTs) {
        var body = String(text || '').trim();
        if (!body || !isRealChatMessage(m)) return body;
        var prefix = buildMiyaApiTimelinePrefix(m && m.createdAt);
        if (!prefix) return body;
        if (m && m._apiTimelineStamped === true && body.slice(0, prefix.length) === prefix) {
            body = body.slice(prefix.length).trim();
        }
        return prefix + ' ' + body;
    }

    function sleep(ms) {
        return new Promise(function (r) {
            setTimeout(r, ms);
        });
    }

    function fetchJsonRetry(url, parser, opts) {
        opts = opts || {};
        var attempts = clamp(Number(opts.attempts) || 2, 1, 5);
        var timeoutMs = clamp(Number(opts.timeoutMs) || 5000, 1500, 12000);
        if (typeof fetch !== 'function') return Promise.resolve(null);
        var attempt = 0;
        function run() {
            attempt += 1;
            var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            var timer = ctl
                ? setTimeout(function () {
                      try {
                          ctl.abort();
                      } catch (e) {}
                  }, timeoutMs)
                : null;
            return fetch(url, { signal: ctl ? ctl.signal : undefined })
                .then(function (res) {
                    if (!res || !res.ok) return null;
                    return res.json();
                })
                .then(parser)
                .catch(function () {
                    return null;
                })
                .finally(function () {
                    if (timer) clearTimeout(timer);
                })
                .then(function (parsed) {
                    if (parsed || attempt >= attempts) return parsed;
                    return sleep(280 * attempt).then(run);
                });
        }
        return run();
    }

    function weatherCodeToText(code) {
        var c = Number(code);
        if (!Number.isFinite(c)) return '';
        if (c === 0) return '晴';
        if (c === 1 || c === 2) return '多云';
        if (c === 3) return '阴';
        if (c >= 51 && c <= 67) return '雨';
        if (c >= 71 && c <= 77) return '雪';
        if (c >= 95) return '雷暴';
        return '天气变化';
    }

    function formatWeatherObj(weather) {
        if (!weather) return '';
        var parts = [];
        if (weather.weatherText) parts.push(weather.weatherText);
        if (Number.isFinite(weather.tempNow)) parts.push('当前' + weather.tempNow.toFixed(1) + '°C');
        if (Number.isFinite(weather.tempMin) && Number.isFinite(weather.tempMax)) {
            parts.push('今日' + weather.tempMin.toFixed(1) + '°C~' + weather.tempMax.toFixed(1) + '°C');
        }
        return parts.length ? parts.join('，') : '';
    }

    function formatWeatherSideDisplay(wa, side) {
        var text = formatWeatherSideForPrompt(wa, side);
        return text === '暂无数据' ? '—' : text;
    }

    function geocodePlace(query) {
        var q = String(query || '').trim();
        if (!q) return Promise.resolve(null);
        var key = q.toLowerCase();
        var hit = WEATHER_CACHE.geocode[key];
        if (hit && hit.value && Date.now() - hit.ts < 86400000) return Promise.resolve(hit.value);

        function parseGeocode(data) {
            var rows = data && Array.isArray(data.results) ? data.results : [];
            if (!rows.length) return null;
            var i;
            for (i = 0; i < rows.length; i++) {
                var best = rows[i];
                var lat = Number(best.latitude);
                var lon = Number(best.longitude);
                if (Number.isFinite(lat) && Number.isFinite(lon)) {
                    return { lat: lat, lon: lon };
                }
            }
            return null;
        }

        function tryUrl(url) {
            return fetchJsonRetry(
                url,
                function (data) {
                    return parseGeocode(data);
                },
                { attempts: 3, timeoutMs: 8000 }
            );
        }

        var urlBase =
            'https://geocoding-api.open-meteo.com/v1/search?count=5&language=zh&format=json&name=' +
            encodeURIComponent(q);
        return tryUrl(urlBase).then(function (pos) {
            if (pos) {
                WEATHER_CACHE.geocode[key] = { ts: Date.now(), value: pos };
                return pos;
            }
            return tryUrl(urlBase + '&countryCode=CN').then(function (posCn) {
                if (posCn) WEATHER_CACHE.geocode[key] = { ts: Date.now(), value: posCn };
                return posCn;
            });
        });
    }

    function fetchWeather(lat, lon) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return Promise.resolve(null);
        var key = lat.toFixed(3) + ',' + lon.toFixed(3);
        var hit = WEATHER_CACHE.weather[key];
        if (hit && hit.value && Date.now() - hit.ts < 300000) return Promise.resolve(hit.value);
        var url =
            'https://api.open-meteo.com/v1/forecast?latitude=' +
            encodeURIComponent(String(lat)) +
            '&longitude=' +
            encodeURIComponent(String(lon)) +
            '&current=temperature_2m,weather_code&daily=temperature_2m_min,temperature_2m_max&timezone=auto';
        return fetchJsonRetry(url, function (data) {
            if (!data) return null;
            var cur = data.current || {};
            var daily = data.daily || {};
            var tempNow = Number(cur.temperature_2m);
            var tempMin = Array.isArray(daily.temperature_2m_min) ? Number(daily.temperature_2m_min[0]) : NaN;
            var tempMax = Array.isArray(daily.temperature_2m_max) ? Number(daily.temperature_2m_max[0]) : NaN;
            return {
                tempNow: Number.isFinite(tempNow) ? tempNow : null,
                tempMin: Number.isFinite(tempMin) ? tempMin : null,
                tempMax: Number.isFinite(tempMax) ? tempMax : null,
                weatherText: weatherCodeToText(cur.weather_code)
            };
        }, { attempts: 3, timeoutMs: 8000 }).then(function (w) {
            if (w) WEATHER_CACHE.weather[key] = { ts: Date.now(), value: w };
            return w;
        });
    }

    function startOfLocalDay(ts) {
        var d = new Date(ts || Date.now());
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    function weatherLocFingerprint(wa) {
        wa = normalizeWeatherAwareness(wa);
        return [wa.placeUser, wa.placeRole, wa.realLocUser, wa.realLocRole].join('\x1e');
    }

    function weatherNeedsInitialFetch(wa) {
        wa = normalizeWeatherAwareness(wa);
        if (!wa.enabled) return false;
        if (!wa.realLocUser && !wa.realLocRole) {
            if (wa.placeUser) wa.realLocUser = wa.placeUser;
            if (wa.placeRole) wa.realLocRole = wa.placeRole;
        }
        if (!wa.realLocUser && !wa.realLocRole) return false;
        var last = Number(wa.lastFetchAt) || 0;
        if (!last) return true;
        return weatherDataIncomplete(wa);
    }

    function shouldRefreshWeatherOnSave(prevWa, nextWa) {
        nextWa = normalizeWeatherAwareness(nextWa);
        if (!nextWa.enabled) return false;
        if (!nextWa.realLocUser && !nextWa.realLocRole) {
            if (nextWa.placeUser) nextWa.realLocUser = nextWa.placeUser;
            if (nextWa.placeRole) nextWa.realLocRole = nextWa.placeRole;
        }
        if (!nextWa.realLocUser && !nextWa.realLocRole) return false;
        prevWa = normalizeWeatherAwareness(prevWa);
        if (weatherLocFingerprint(prevWa) !== weatherLocFingerprint(nextWa)) return true;
        if (weatherNeedsInitialFetch(nextWa)) return true;
        return needsWeatherDailyRefresh(nextWa);
    }

    function needsWeatherDailyRefresh(wa) {
        wa = normalizeWeatherAwareness(wa);
        if (!wa.enabled) return false;
        var last = Number(wa.lastFetchAt) || 0;
        return last < startOfLocalDay(Date.now());
    }

    function refreshWeatherIfStale(settings, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        if (!settings) return Promise.resolve(settings);
        var wa = normalizeWeatherAwareness(settings.weatherAwareness);
        if (!wa.enabled) return Promise.resolve(settings);
        if (!opts.force && !opts.forceLocChange) {
            if (!needsWeatherDailyRefresh(wa) && !weatherNeedsInitialFetch(wa) && !weatherDataIncomplete(wa)) {
                return Promise.resolve(settings);
            }
        }
        return refreshWeatherForSettings(settings);
    }

    function refreshWeatherForSettings(settings) {
        var wa = normalizeWeatherAwareness(settings && settings.weatherAwareness);
        if (!wa.enabled) return Promise.resolve(settings);
        if (!wa.realLocUser && wa.placeUser) wa.realLocUser = wa.placeUser;
        if (!wa.realLocRole && wa.placeRole) wa.realLocRole = wa.placeRole;
        var jobs = [];
        function bindSide(realLoc, side) {
            if (!realLoc) return;
            var latKey = side === 'user' ? 'mappedLatUser' : 'mappedLatRole';
            var lonKey = side === 'user' ? 'mappedLonUser' : 'mappedLonRole';
            jobs.push(
                geocodePlace(realLoc).then(function (pos) {
                    if (
                        !pos &&
                        Number.isFinite(Number(wa[latKey])) &&
                        Number.isFinite(Number(wa[lonKey]))
                    ) {
                        pos = { lat: Number(wa[latKey]), lon: Number(wa[lonKey]) };
                    }
                    if (!pos) return;
                    wa[latKey] = pos.lat;
                    wa[lonKey] = pos.lon;
                    return fetchWeather(pos.lat, pos.lon).then(function (w) {
                        if (!w) return;
                        var text = formatWeatherObj(w);
                        if (side === 'user') {
                            wa.weatherTextUser = text;
                            wa.weatherTempUser = w.tempNow;
                        } else {
                            wa.weatherTextRole = text;
                            wa.weatherTempRole = w.tempNow;
                        }
                    });
                })
            );
        }
        bindSide(wa.realLocUser, 'user');
        bindSide(wa.realLocRole, 'role');
        return Promise.all(jobs).then(function () {
            if (jobs.length) wa.lastFetchAt = Date.now();
            settings.weatherAwareness = wa;
            return settings;
        });
    }

    function buildRelationshipLine(chatSettings, contact) {
        var rel = String(
            (chatSettings && chatSettings.relationship) || (contact && contact.relationship) || ''
        ).trim();
        return rel ? '你们当前的关系是：' + rel : '';
    }

    function buildChronicleRelationshipBlock(contact) {
        var rs = global.miyaContactsRelationshipStore;
        if (!rs || typeof rs.buildPromptBlockForCharacterId !== 'function' || !contact) return '';
        var roleId = String(contact.characterId || contact.chronicleId || contact.id || '').trim();
        if (!roleId) return '';
        return String(rs.buildPromptBlockForCharacterId(roleId) || '').trim();
    }

    function buildSummaryContextBlock(chatSettings) {
        var list = chatSettings && Array.isArray(chatSettings.summaryList) ? chatSettings.summaryList : [];
        var megaList = chatSettings && Array.isArray(chatSettings.megaSummaryList) ? chatSettings.megaSummaryList : [];
        if (!list.length && !megaList.length) return '';
        var sumMod = global.MiyaChatSummary;
        var covered =
            sumMod && typeof sumMod.summaryIdsCoveredByMega === 'function'
                ? sumMod.summaryIdsCoveredByMega(megaList)
                : {};
        var items = [];
        megaList.forEach(function (row, mi) {
            var body = String((row && row.content) || '').trim();
            if (!body) return;
            items.push({
                order: Number(row && row.startIndex) || 0,
                text:
                    '【合卷' +
                    String(mi + 1) +
                    ' · 消息' +
                    String(row.startIndex || '?') +
                    '-' +
                    String(row.endIndex || '?') +
                    '】\n' +
                    body
            });
        });
        list.forEach(function (row, i) {
            if (
                sumMod &&
                typeof sumMod.isSummaryShotCovered === 'function'
            ) {
                if (sumMod.isSummaryShotCovered(row, megaList, covered)) return;
            } else {
                var sid = row && row.id ? String(row.id) : '';
                if (sid && covered[sid]) return;
            }
            var body = String((row && row.content) || '').trim();
            if (!body) return;
            items.push({
                order: Number(row && row.startIndex) || 0,
                text:
                    '【分镜' +
                    String(i + 1) +
                    ' · 消息' +
                    String(row.startIndex || '?') +
                    '-' +
                    String(row.endIndex || '?') +
                    '】\n' +
                    body
            });
        });
        items.sort(function (a, b) {
            return (a.order || 0) - (b.order || 0);
        });
        var lines = items.map(function (it) { return it.text; }).filter(Boolean);
        if (!lines.length) return '';
        return (
            '【长期记忆·对话总结】\n' +
            '以下为已沉淀的对话记忆（含合卷与未被合并的分镜），每轮请求均须阅读；与下方「上下文对话」衔接，勿与近期原文重复叙述。\n\n' +
            lines.join('\n\n')
        );
    }

    global.MiyaChatAwareness = {
        localTz: localTz,
        normalizeTimeAwareness: normalizeTimeAwareness,
        normalizeWeatherAwareness: normalizeWeatherAwareness,
        isTimeStrong: isTimeStrong,
        isTimeStampEnabled: isTimeStampEnabled,
        buildTimeAwarenessRules: buildTimeAwarenessRules,
        buildPlaceAwarenessRules: buildPlaceAwarenessRules,
        buildWeatherAwarenessRules: buildWeatherAwarenessRules,
        buildGroupPlaceAwarenessRules: buildGroupPlaceAwarenessRules,
        buildGroupWeatherAwarenessRules: buildGroupWeatherAwarenessRules,
        refreshGroupMembersWeatherIfStale: refreshGroupMembersWeatherIfStale,
        buildRelationshipLine: buildRelationshipLine,
        buildChronicleRelationshipBlock: buildChronicleRelationshipBlock,
        buildSummaryContextBlock: buildSummaryContextBlock,
        isValidMessageTimestamp: isValidMessageTimestamp,
        formatLocalMessageDateTime: formatLocalMessageDateTime,
        isRealChatMessage: isRealChatMessage,
        buildConversationGapReminder: buildConversationGapReminder,
        buildMiyaApiTimelinePrefix: buildMiyaApiTimelinePrefix,
        stripTimelinePrefixForDisplay: stripTimelinePrefixForDisplay,
        stripQuotePromptLeakage: stripQuotePromptLeakage,
        stripAllApiTimelineMarkers: stripAllApiTimelineMarkers,
        stripOneTimelinePrefix: stripOneTimelinePrefix,
        splitCollapsedTimelineSegments: splitCollapsedTimelineSegments,
        sanitizeRoleMessageFields: sanitizeRoleMessageFields,
        stampMessageForApi: stampMessageForApi,
        refreshWeatherForSettings: refreshWeatherForSettings,
        refreshWeatherIfStale: refreshWeatherIfStale,
        needsWeatherDailyRefresh: needsWeatherDailyRefresh,
        shouldRefreshWeatherOnSave: shouldRefreshWeatherOnSave,
        weatherNeedsInitialFetch: weatherNeedsInitialFetch,
        weatherDataIncomplete: weatherDataIncomplete,
        weatherSideNeedsData: weatherSideNeedsData,
        weatherLocFingerprint: weatherLocFingerprint,
        formatWeatherSideDisplay: formatWeatherSideDisplay,
        historyLastTs: historyLastTs,
        gapAnchorTs: gapAnchorTs,
        formatFullDateTimeForTz: formatFullDateTimeForTz,
        wallClockToMs: wallClockToMs,
        wallClockPartsInTz: wallClockPartsInTz,
        formatRoughDurationZh: formatRoughDurationZh,
        formatPreciseDurationZh: formatPreciseDurationZh,
        buildPerTurnTimeAwarenessBlock: buildPerTurnTimeAwarenessBlock
    };
})(window);
