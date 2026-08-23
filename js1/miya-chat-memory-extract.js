/**
 * 角色记忆自动提炼（与 MiyaChatSummary 分镜/合卷总结并列，互不共用列表与触发配置）
 */
(function (global) {
    'use strict';

    var MEMORY_OUTPUT_CONTRACT =
        '只输出一个 JSON 对象，不要代码块或其它文字。格式：' +
        '{"title":"简短明确的记忆主题","content":"80-200字的角色视角长期记忆","keywords":["具体关键词1","具体关键词2","具体关键词3"]}。' +
        'title 必填，概括这条记忆的具体主题；' +
        'keywords 至少 3 个、最多 12 个，只写未来对话中可能自然出现的具体人物、地点、事件、物品、约定或偏好；' +
        '每个关键词都必须能帮助区分并召回这条具体记忆；不得用当前角色姓名、昵称、用户姓名、双方日常称呼、代词或泛词凑数；' +
        '优先复用原对话中实际出现的事件用词和口语表达，同一事件可以补充少量未来可能自然出现的短语变体，但每个变体必须单独作为数组元素；不要堆叠无关同义词。';

    var DEFAULT_MEMORY_PROMPT =
        '阅读以下对话，从角色视角提取对其重要的记忆：情感转折、约定与承诺、喜好与禁忌、关系变化、关键事件与细节。' +
        '客观区分双方，按时间线整理。' + MEMORY_OUTPUT_CONTRACT;

    var GENERIC_KEYWORDS = {
        '记忆': true,
        '聊天': true,
        '用户': true,
        '角色': true,
        '事情': true,
        '关系': true,
        '对话': true,
        '内容': true
    };

    var generating = {};

    function clampInt(v, lo, hi, fallback) {
        var n = parseInt(v, 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(hi, Math.max(lo, n));
    }

    function newMemoryId() {
        return 'cmem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function getApiConfig() {
        if (typeof global.miyaGetApiConfigCached === 'function') return global.miyaGetApiConfigCached();
        return {};
    }

    function resolveSummaryConfig(cfg) {
        cfg = cfg && typeof cfg === 'object' ? cfg : getApiConfig();
        var summaryBaseUrl = String(cfg.summaryBaseUrl || '').trim();
        var summaryApiKey = String(cfg.summaryApiKey || '').trim();
        var summaryModel = String(cfg.summaryModel || '').trim();
        return {
            baseUrl: summaryBaseUrl || String(cfg.baseUrl || '').trim(),
            apiKey: summaryApiKey || String(cfg.apiKey || '').trim(),
            model: summaryModel || String(cfg.model || '').trim(),
            useDedicated: !!(summaryBaseUrl || summaryApiKey || summaryModel)
        };
    }

    function normalizeBaseUrl(base) {
        var t = String(base || '').trim().replace(/\/+$/, '');
        if (!t) return '';
        try {
            var u = new URL(t);
            var path = (u.pathname || '/').replace(/\/+$/, '');
            var segs = path.split('/').filter(Boolean);
            if (segs.length && segs[segs.length - 1].toLowerCase() === 'v1') return u.origin + path;
            if (!path || path === '/') return u.origin + '/v1';
            return u.origin + path + '/v1';
        } catch (e) {
            return t.toLowerCase().endsWith('/v1') ? t : t + '/v1';
        }
    }

    function extractText(data) {
        if (!data) return '';
        if (data.choices && data.choices[0]) {
            var ch = data.choices[0];
            if (ch.message && ch.message.content != null) return String(ch.message.content).trim();
            if (ch.text != null) return String(ch.text).trim();
        }
        if (data.content != null) return String(data.content).trim();
        return '';
    }

    function normalizeKeywords(value) {
        var list = Array.isArray(value)
            ? value
            : String(value || '').split(/[，,、\n]+/);
        var seen = {};
        return list
            .map(function (item) { return String(item || '').trim(); })
            .filter(function (item) {
                var key = item.toLowerCase();
                if (!key || GENERIC_KEYWORDS[key] || seen[key]) return false;
                seen[key] = true;
                return true;
            })
            .slice(0, 12);
    }

    function addKeywordExclusion(map, value) {
        var key = String(value || '').trim().toLowerCase();
        if (key) map[key] = true;
    }

    function buildKeywordExclusions(contact, profile, settings) {
        var excluded = {};
        Object.keys(GENERIC_KEYWORDS).forEach(function (key) {
            excluded[key] = true;
        });
        addKeywordExclusion(excluded, contact && contact.name);
        addKeywordExclusion(excluded, contact && contact.remarkName);
        addKeywordExclusion(excluded, profile && profile.name);

        var ext = settings && settings.externalMemory && typeof settings.externalMemory === 'object'
            ? settings.externalMemory
            : {};
        var groups = ext.synonyms && typeof ext.synonyms === 'object' && !Array.isArray(ext.synonyms)
            ? ext.synonyms
            : {};
        Object.keys(groups).forEach(function (base) {
            var group = groups[base];
            var terms = Array.isArray(group)
                ? group
                : group && Array.isArray(group.terms)
                    ? group.terms
                    : [];
            var tags = group && Array.isArray(group.tags) ? group.tags : [];
            var generic = !!(group && group.generic === true) || tags.some(function (tag) {
                return String(tag || '').trim().toLowerCase() === 'generic';
            });
            if (!generic) return;
            addKeywordExclusion(excluded, base);
            terms.forEach(function (term) { addKeywordExclusion(excluded, term); });
        });
        return excluded;
    }

    function filterMemoryKeywords(value, exclusions) {
        var excluded = exclusions && typeof exclusions === 'object' ? exclusions : {};
        return normalizeKeywords(value).filter(function (keyword) {
            return !excluded[String(keyword || '').trim().toLowerCase()];
        });
    }

    function parseMemoryResult(text, exclusions) {
        var raw = String(text || '').trim();
        var fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        if (fenced) raw = fenced[1].trim();
        var parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            throw new Error('记忆抽取未返回有效 JSON');
        }
        var content = String((parsed && parsed.content) || '').trim();
        var title = String((parsed && parsed.title) || '').trim();
        var keywords = filterMemoryKeywords(parsed && parsed.keywords, exclusions);
        if (!title) throw new Error('记忆标题为空');
        if (!content) throw new Error('记忆正文为空');
        if (keywords.length < 3) throw new Error('记忆有效关键词少于 3 个（称呼、泛词或 generic 同义词不计入）');
        return { title: title.slice(0, 160), content: content, keywords: keywords };
    }

    function formatTsPrefix(ts) {
        var t = Number(ts);
        if (!Number.isFinite(t) || t <= 0) return '';
        try {
            return '[' + new Date(t).toLocaleString('zh-CN') + '] ';
        } catch (e) {
            return '';
        }
    }

    function messageLine(m, contact, profile) {
        if (!m || m.deleted || m.role === 'system') return '';
        var fmt = global.MiyaChatOnlineFormat;
        var body =
            fmt && typeof fmt.formatMessageForApi === 'function'
                ? fmt.formatMessageForApi(m)
                : String(m.content || '').trim();
        if (!body) return '';
        var who =
            m.role === 'user'
                ? profile && profile.name
                    ? profile.name + ': '
                    : '我: '
                : (contact.name || '对方') + ': ';
        return formatTsPrefix(m.createdAt) + who + body;
    }

    function resolveMemoryPrompt(contact, settings, profile) {
        var custom = String((settings && settings.memoryAutoPrompt) || '').trim();
        var prompt = custom || DEFAULT_MEMORY_PROMPT.replace('从角色视角', '从「' + (((contact && (contact.remarkName || contact.name)) || '角色')) + '」的视角');
        var excludedNames = [
            contact && contact.name,
            contact && contact.remarkName,
            profile && profile.name
        ].map(function (value) { return String(value || '').trim(); }).filter(Boolean);
        if (excludedNames.length) {
            prompt += '\n本次提炼中，以下当前对话参与者的姓名、昵称或称呼不得作为关键词：' + excludedNames.join('、') + '。';
        }
        return custom ? prompt + '\n\n' + MEMORY_OUTPUT_CONTRACT : prompt;
    }

    function lastCharMemoryEnd(settings) {
        var list = settings && Array.isArray(settings.charMemoryList) ? settings.charMemoryList : [];
        if (!list.length) return 0;
        var mx = 0;
        list.forEach(function (row) {
            var e = clampInt(row && row.endIndex, 0, 9999999, 0);
            if (e > mx) mx = e;
        });
        return mx;
    }

    function isOnlineNarrationRow(m) {
        var fmt = global.MiyaChatOnlineFormat;
        return !!(
            fmt &&
            typeof fmt.isCharacterOnlineNarrationMessage === 'function' &&
            fmt.isCharacterOnlineNarrationMessage(m)
        );
    }

    /** 统计上次提炼覆盖终点（1-based endIndex）之后完成的「角色回复轮次」，与引擎 replyBatchId 语义一致 */
    function countAssistantRounds(history, afterOneBasedEndIndex) {
        if (!Array.isArray(history) || !history.length) return 0;
        var start = clampInt(afterOneBasedEndIndex, 0, history.length, 0);
        var seenBatch = {};
        var count = 0;
        var legacyRoundOpen = false;
        for (var i = start; i < history.length; i++) {
            var m = history[i];
            if (!m || m.deleted) continue;
            if (m.role === 'user') {
                legacyRoundOpen = false;
                continue;
            }
            if (m.role === 'system' && !isOnlineNarrationRow(m)) continue;
            if (m.role !== 'assistant' && !isOnlineNarrationRow(m)) continue;
            var batch = String(m.replyBatchId || '').trim();
            if (batch) {
                if (!seenBatch[batch]) {
                    seenBatch[batch] = true;
                    count++;
                }
                legacyRoundOpen = false;
            } else if (!legacyRoundOpen) {
                count++;
                legacyRoundOpen = true;
            }
        }
        return count;
    }

    function adjustCharMemoryIndicesAfterPurge(list, delStart, delEnd) {
        if (!Array.isArray(list) || !list.length) return list || [];
        var ds = clampInt(delStart, 1, 9999999, 1);
        var de = clampInt(delEnd, ds, 9999999, ds);
        var n = de - ds + 1;
        return list.map(function (row) {
            if (!row || typeof row !== 'object') return row;
            var s = clampInt(row.startIndex, 0, 9999999, 0);
            var e = clampInt(row.endIndex, 0, 9999999, 0);
            if (!s || !e) return row;
            if (e < ds) return row;
            if (s > de) {
                return Object.assign({}, row, {
                    startIndex: Math.max(1, s - n),
                    endIndex: Math.max(1, e - n)
                });
            }
            return Object.assign({}, row, { sourceRangeMissing: true });
        });
    }

    function isLegacyFixedMemory(row) {
        return !!(row && !Array.isArray(row.keywords));
    }

    function isFixedMemory(row) {
        return !!(row && (row.fixedInject === true || isLegacyFixedMemory(row)));
    }

    function selectCharMemories(chatSettings, queryText, debug) {
        var list = chatSettings && Array.isArray(chatSettings.charMemoryList) ? chatSettings.charMemoryList : [];
        var query = String(queryText || '').toLowerCase();
        var fixed = [];
        var recalled = [];
        if (debug && typeof debug === 'object') {
            debug.queryText = String(queryText || '');
            debug.memoryInterop = !(chatSettings && chatSettings.memoryInterop === false);
            debug.candidateCount = list.length;
            debug.fixedCount = 0;
            debug.recalledCount = 0;
            debug.matches = [];
        }
        if (chatSettings && chatSettings.memoryInterop === false) return [];
        if (!list.length) return [];
        list.forEach(function (row) {
            if (!row || !String(row.content || '').trim()) return;
            if (isFixedMemory(row)) {
                fixed.push(row);
                return;
            }
            var hits = normalizeKeywords(row.keywords).filter(function (keyword) {
                return query && query.indexOf(keyword.toLowerCase()) >= 0;
            });
            if (!hits.length) return;
            recalled.push({ row: row, hitCount: hits.length, hits: hits });
        });
        fixed.sort(function (a, b) {
            return (Number(a.startIndex) || Number(a.createdAt) || 0) -
                (Number(b.startIndex) || Number(b.createdAt) || 0);
        });
        recalled.sort(function (a, b) {
            if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
            return (Number(b.row.updatedAt || b.row.createdAt) || 0) -
                (Number(a.row.updatedAt || a.row.createdAt) || 0);
        });
        var selectedRecalled = recalled.slice(0, 5);
        if (debug && typeof debug === 'object') {
            debug.fixedCount = fixed.length;
            debug.recalledCount = selectedRecalled.length;
            debug.matches = selectedRecalled.map(function (item) {
                return { id: String(item.row.id || ''), keywords: item.hits.slice() };
            });
        }
        return fixed.concat(selectedRecalled.map(function (item) { return item.row; }));
    }

    function buildCharMemoryContextBlock(chatSettings, queryText, debug) {
        var selected = selectCharMemories(chatSettings, queryText, debug);
        if (!selected.length) return '';
        var lines = selected
            .slice()
            .map(function (row, i) {
                var body = String((row && row.content) || '').trim();
                if (!body) return '';
                var rangeLabel = row && row.source === 'manual'
                    ? ''
                    : ' · 消息' +
                        String(row.startIndex || '?') +
                        '-' +
                        String(row.endIndex || '?');
                return (
                    '【角色记忆' +
                    String(i + 1) +
                    rangeLabel +
                    '】\n' +
                    body
                );
            })
            .filter(Boolean);
        if (!lines.length) return '';
        return (
            '【长期记忆·角色重要记忆】\n' +
            '以下为从对话中提炼的、对该角色重要的记忆片段，请结合近期上下文使用，勿与分镜总结重复堆砌。\n\n' +
            lines.join('\n\n')
        );
    }

    function maybeAutoMemoryExtract(chatId) {
        var store = global.miyaChatStore;
        if (!store) return;
        var settings = store.getChatSettings(chatId);
        var trigger = clampInt(settings.memoryAutoRoundTrigger, 0, 500, 0);
        if (trigger <= 0) return;
        var history = store.getMessages(chatId);
        if (!history.length) return;
        var last = lastCharMemoryEnd(settings);
        if (last > history.length) last = 0;
        var rounds = countAssistantRounds(history, last);
        if (rounds < trigger) return;
        performMemoryExtract(chatId, { silent: true });
    }

    function performMemoryExtract(chatId, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var silent = !!opts.silent;
        var cid = String(chatId || '').trim();
        if (!cid) return Promise.resolve(false);
        if (generating[cid]) return Promise.resolve(false);

        var store = global.miyaChatStore;
        if (!store) return Promise.resolve(false);
        var chat = store.findChat(cid);
        if (!chat) return Promise.resolve(false);
        var contact = store.findContact(chat.contactId);
        if (!contact) return Promise.resolve(false);
        var profiles = store.getProfiles();
        var profile =
            profiles.find(function (p) {
                return p.id === chat.profileId;
            }) || store.getActiveProfile();
        var settings = store.getChatSettings(cid);
        var history = store.getMessages(cid);
        if (!history.length) return Promise.resolve(false);

        var start = 1;
        var end = history.length;
        if (silent) {
            var last = lastCharMemoryEnd(settings);
            if (last > history.length) last = 0;
            start = last + 1;
            if (start > history.length) return Promise.resolve(false);
        } else {
            start = clampInt(opts.start, 1, history.length, 1);
            end = clampInt(opts.end, 1, history.length, history.length);
            start = Math.max(1, Math.min(start, history.length));
            end = Math.max(start, Math.min(end, history.length));
        }
        if (start > end) return Promise.resolve(false);

        var sourceRows = history.slice(start - 1, end);
        if (opts.requireCompleteRange) {
            if (sourceRows.length !== end - start + 1 || sourceRows.some(function (m) { return !m || m.deleted; })) {
                if (!silent && global.miyaDialog && global.miyaDialog.alert) {
                    global.miyaDialog.alert({
                        title: '无法重新提取',
                        message: '对应的原始聊天记录不完整，旧记忆已保留。'
                    });
                }
                return Promise.resolve(false);
            }
        }
        var excerpt = sourceRows
            .map(function (m) {
                return messageLine(m, contact, profile);
            })
            .filter(Boolean)
            .join('\n');
        if (!excerpt) return Promise.resolve(false);

        var sc = resolveSummaryConfig(getApiConfig());
        var base = normalizeBaseUrl(sc.baseUrl);
        if (!base || !sc.apiKey || !sc.model) {
            if (!silent && global.miyaDialog && global.miyaDialog.alert) {
                global.miyaDialog.alert({
                    title: '未配置 API',
                    message: sc.useDedicated
                        ? '总结 API 需填写地址、密钥和模型；也可清空总结 API 后使用聊天 API。'
                        : '请在主屏设置中填写聊天 API 地址、密钥和模型。'
                });
            }
            return Promise.resolve(false);
        }

        var promptText = resolveMemoryPrompt(contact, settings, profile) + '\n\n' + excerpt;
        generating[cid] = true;
        var memoryMessages = [{ role: 'user', content: promptText }];
        var eng = global.miyaChatEngine;
        if (eng && typeof eng.prependUniversalWorldbookMessage === 'function') {
            memoryMessages = eng.prependUniversalWorldbookMessage(memoryMessages);
        }
        return fetch(base + '/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + sc.apiKey
            },
            body: JSON.stringify({
                model: sc.model,
                temperature: 0.45,
                messages: memoryMessages
            })
        })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                var text = extractText(data);
                if (!text) throw new Error('empty_memory');
                var result = parseMemoryResult(text, buildKeywordExclusions(contact, profile, settings));
                var replaceId = String(opts.replaceMemoryId || '').trim();
                var confirmation = true;
                if (replaceId && opts.confirmReplace) {
                    var confirmMessage = result.title + '\n\n' + result.content + '\n\n关键词：' + result.keywords.join('、');
                    confirmation = global.miyaDialog && typeof global.miyaDialog.confirm === 'function'
                        ? global.miyaDialog.confirm({
                              title: '确认替换这条记忆？',
                              message: confirmMessage,
                              confirmText: '替换',
                              cancelText: '保留旧记忆'
                          })
                        : Promise.resolve(global.confirm('确认替换这条记忆？\n\n' + confirmMessage));
                }
                return Promise.resolve(confirmation).then(function (confirmed) {
                    if (!confirmed) return false;
                    var list = Array.isArray(settings.charMemoryList) ? settings.charMemoryList.slice() : [];
                    if (replaceId) {
                        var found = false;
                        list = list.map(function (row) {
                            if (!row || row.id !== replaceId) return row;
                            found = true;
                            return Object.assign({}, row, {
                                title: result.title,
                                content: result.content,
                                keywords: result.keywords,
                                fixedInject: isFixedMemory(row),
                                updatedAt: Date.now()
                            });
                        });
                        if (!found) throw new Error('memory_not_found');
                    } else {
                        list.push({
                            id: newMemoryId(),
                            title: result.title,
                            date: new Date().toLocaleString('zh-CN'),
                            startIndex: start,
                            endIndex: end,
                            content: result.content,
                            keywords: result.keywords,
                            fixedInject: false,
                            source: 'auto',
                            createdAt: Date.now()
                        });
                    }
                    return store.saveChatSettings(cid, { charMemoryList: list }).then(function () {
                        var ext = global.MiyaExternalMemory;
                        if (!replaceId && ext && typeof ext.writeExtractedMemory === 'function') {
                            ext.writeExtractedMemory(cid, result).catch(function (err) {
                                if (global.console && typeof global.console.warn === 'function') {
                                    global.console.warn('[MiyaExternalMemory] write_memory failed:', err && err.message ? err.message : err);
                                }
                            });
                        }
                        return true;
                    });
                });
            })
            .then(function (saved) {
                if (!saved) return false;
                if (
                    global.miyaMemoryApp &&
                    typeof global.miyaMemoryApp.onCharMemoryUpdated === 'function'
                ) {
                    global.miyaMemoryApp.onCharMemoryUpdated(cid);
                }
                if (!silent && typeof opts.onDone === 'function') opts.onDone();
                return true;
            })
            .catch(function (e) {
                if (!silent && global.miyaDialog && global.miyaDialog.alert) {
                    global.miyaDialog.alert({
                        title: '记忆提炼失败',
                        message: (e && e.message) || String(e)
                    });
                }
                return false;
            })
            .finally(function () {
                delete generating[cid];
            });
    }

    global.MiyaChatMemoryExtract = {
        DEFAULT_MEMORY_PROMPT: DEFAULT_MEMORY_PROMPT,
        maybeAutoMemoryExtract: maybeAutoMemoryExtract,
        performMemoryExtract: performMemoryExtract,
        lastCharMemoryEnd: lastCharMemoryEnd,
        countAssistantRounds: countAssistantRounds,
        adjustCharMemoryIndicesAfterPurge: adjustCharMemoryIndicesAfterPurge,
        normalizeKeywords: normalizeKeywords,
        parseMemoryResult: parseMemoryResult,
        isFixedMemory: isFixedMemory,
        selectCharMemories: selectCharMemories,
        buildCharMemoryContextBlock: buildCharMemoryContextBlock,
        isGenerating: function (chatId) {
            return !!generating[String(chatId || '')];
        }
    };
})(window);
