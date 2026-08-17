/**
 * 线上单聊外置 Isolation Memory 接入。
 */
(function (global) {
    'use strict';

    var REQUEST_TIMEOUT_MS = 6500;
    var MAX_CONTEXT_CHARS = 12000;
    var preparedByChat = {};
    var debugByChat = {};
    var lastWriteByChat = {};

    function configFromSettings(settings) {
        var raw = settings && settings.externalMemory && typeof settings.externalMemory === 'object'
            ? settings.externalMemory
            : {};
        return {
            enabled: !!raw.enabled,
            endpoint: String(raw.endpoint || '').trim().replace(/\/+$/, ''),
            memoryKey: String(raw.memoryKey || '').trim(),
            synonymsToken: String(raw.synonymsToken || '').trim(),
            mcpToken: String(raw.mcpToken || '').trim(),
            synonyms: raw.synonyms && typeof raw.synonyms === 'object' && !Array.isArray(raw.synonyms)
                ? raw.synonyms
                : {},
            synonymsVersion: String(raw.synonymsVersion || '').trim(),
            synonymsUpdatedAt: Math.max(0, Number(raw.synonymsUpdatedAt) || 0)
        };
    }

    function isReady(cfg) {
        return !!(cfg.enabled && cfg.endpoint && cfg.memoryKey && cfg.mcpToken);
    }

    function fetchWithTimeout(url, options) {
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = setTimeout(function () {
            if (controller) controller.abort();
        }, REQUEST_TIMEOUT_MS);
        var opts = Object.assign({}, options || {});
        if (controller) opts.signal = controller.signal;
        return fetch(url, opts).finally(function () {
            clearTimeout(timer);
        });
    }

    function parseJsonResponse(response) {
        if (!response || !response.ok) {
            throw new Error('HTTP ' + (response ? response.status : 0));
        }
        return response.json().catch(function () {
            throw new Error('invalid_json');
        });
    }

    function callMcp(cfg, name, args) {
        return fetchWithTimeout(cfg.endpoint + '/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + cfg.mcpToken
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'miya_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
                method: 'tools/call',
                params: { name: name, arguments: args || {} }
            })
        }).then(parseJsonResponse).then(function (rpc) {
            if (!rpc || typeof rpc !== 'object' || rpc.error) {
                throw new Error(rpc && rpc.error && rpc.error.message ? rpc.error.message : 'invalid_jsonrpc');
            }
            var result = rpc.result;
            if (!result || result.isError) {
                var errText =
                    result && Array.isArray(result.content) && result.content[0]
                        ? String(result.content[0].text || '')
                        : 'mcp_tool_error';
                throw new Error(errText || 'mcp_tool_error');
            }
            var text =
                Array.isArray(result.content) && result.content[0] && result.content[0].type === 'text'
                    ? String(result.content[0].text || '')
                    : '';
            if (!text) throw new Error('invalid_mcp_result');
            try {
                return JSON.parse(text);
            } catch (e) {
                throw new Error('invalid_mcp_result');
            }
        });
    }

    function normalizeSynonymGroups(groups) {
        var out = {};
        if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return out;
        Object.keys(groups).forEach(function (rawBase) {
            var base = String(rawBase || '').trim();
            if (!base) return;
            var group = groups[rawBase];
            var terms = Array.isArray(group)
                ? group
                : group && Array.isArray(group.terms)
                    ? group.terms
                    : [];
            var tags = group && Array.isArray(group.tags) ? group.tags : [];
            var seen = {};
            out[base] = {
                terms: terms.map(function (term) { return String(term || '').trim(); }).filter(function (term) {
                    var key = term.toLowerCase();
                    if (!key || seen[key]) return false;
                    seen[key] = true;
                    return true;
                }),
                generic: !!(group && group.generic === true) || tags.some(function (tag) {
                    return String(tag || '').trim().toLowerCase() === 'generic';
                })
            };
        });
        return out;
    }

    function refreshSynonyms(chatId, overrideConfig) {
        var store = global.miyaChatStore;
        if (!store || !chatId) return Promise.reject(new Error('store_missing'));
        var cfg = overrideConfig
            ? configFromSettings({ externalMemory: overrideConfig })
            : configFromSettings(store.getChatSettings(chatId));
        if (!cfg.endpoint || !cfg.synonymsToken) {
            return Promise.reject(new Error('同义词端点或凭据未配置'));
        }
        return fetchWithTimeout(cfg.endpoint + '/api/synonyms', {
            method: 'GET',
            headers: { Authorization: 'Bearer ' + cfg.synonymsToken }
        }).then(parseJsonResponse).then(function (data) {
            if (!data || data.ok !== true || !data.groups || typeof data.groups !== 'object') {
                throw new Error('invalid_synonyms_response');
            }
            var saved = configFromSettings(store.getChatSettings(chatId));
            var next = Object.assign({}, saved, cfg, {
                synonyms: normalizeSynonymGroups(data.groups),
                synonymsVersion: String(data.version || '').trim(),
                synonymsUpdatedAt: Date.now()
            });
            return store.saveChatSettings(chatId, { externalMemory: next }).then(function () {
                return next;
            });
        });
    }

    function ensureSynonyms(chatId, cfg) {
        if (Object.keys(cfg.synonyms || {}).length || !cfg.synonymsToken) return Promise.resolve(cfg);
        return refreshSynonyms(chatId).catch(function (err) {
            if (global.console && typeof global.console.warn === 'function') {
                global.console.warn('[MiyaExternalMemory] synonyms refresh failed:', err && err.message ? err.message : err);
            }
            return cfg;
        });
    }

    function includesTerm(text, term) {
        var needle = String(term || '').trim().toLowerCase();
        return !!(needle && text.indexOf(needle) >= 0);
    }

    function concreteHits(settings, cfg, queryText) {
        var text = String(queryText || '').trim().toLowerCase();
        if (!text) return [];
        var hits = [];
        function addHit(term) {
            var value = String(term || '').trim();
            if (value && hits.indexOf(value) < 0) hits.push(value);
        }
        var memories = settings && Array.isArray(settings.charMemoryList) ? settings.charMemoryList : [];
        for (var i = 0; i < memories.length; i++) {
            var keywords = memories[i] && Array.isArray(memories[i].keywords) ? memories[i].keywords : [];
            for (var k = 0; k < keywords.length; k++) {
                if (includesTerm(text, keywords[k])) addHit(keywords[k]);
            }
        }
        var groups = normalizeSynonymGroups(cfg.synonyms);
        Object.keys(groups).forEach(function (base) {
            var group = groups[base];
            if (group.generic) return;
            if (includesTerm(text, base)) addHit(base);
            group.terms.forEach(function (term) {
                if (includesTerm(text, term)) addHit(term);
            });
        });
        return hits.slice(0, 12);
    }

    function cleanSearchResult(raw) {
        var blocks = [];
        if (!raw || typeof raw !== 'object') return [];
        if (raw.mode === 'keyword' && Array.isArray(raw.results)) {
            blocks = raw.results;
        } else if (raw.mode === 'exact_title' && raw.private && typeof raw.private === 'object') {
            blocks = Object.keys(raw.private).map(function (id) { return raw.private[id]; });
        }
        var total = 0;
        var chunks = [];
        blocks.slice(0, 5).forEach(function (block) {
            if (!block) return;
            if (raw.mode === 'keyword' && block.scope !== 'private') return;
            var title = String(block.title || '').trim();
            var entries = Array.isArray(block.entries) ? block.entries : [];
            var contents = entries.filter(function (entry) {
                return entry && entry.status === 'active' && String(entry.content || '').trim();
            }).slice(0, 3).map(function (entry) {
                return String(entry.content || '').trim();
            });
            if (!title || !contents.length) return;
            var chunk = '【' + title + '】\n' + contents.join('\n');
            var remaining = MAX_CONTEXT_CHARS - total;
            if (remaining <= 0) return;
            if (chunk.length > remaining) chunk = chunk.slice(0, remaining);
            total += chunk.length;
            chunks.push(chunk);
        });
        return chunks;
    }

    function summarizeSearchResult(raw) {
        var blocks = [];
        if (raw && raw.mode === 'keyword' && Array.isArray(raw.results)) {
            blocks = raw.results;
        } else if (raw && raw.mode === 'exact_title' && raw.private && typeof raw.private === 'object') {
            blocks = Object.keys(raw.private).map(function (id) { return raw.private[id]; });
        }
        return {
            mode: raw && raw.mode ? String(raw.mode) : '',
            returned: raw && raw.returned != null ? Number(raw.returned) : blocks.length,
            blocks: blocks.slice(0, 5).map(function (block) {
                var entries = block && Array.isArray(block.entries) ? block.entries : [];
                return {
                    scope: block && block.scope ? String(block.scope) : '',
                    hasTitle: !!String(block && block.title || '').trim(),
                    entries: entries.length,
                    activeContentEntries: entries.filter(function (entry) {
                        return entry && entry.status === 'active' && !!String(entry.content || '').trim();
                    }).length
                };
            })
        };
    }

    function buildQueryText(chatId) {
        var store = global.miyaChatStore;
        var rows = store && store.getMessages ? store.getMessages(chatId) : [];
        var parts = [];
        for (var i = rows.length - 1; i >= 0; i--) {
            var row = rows[i];
            if (!row || row.deleted) continue;
            if (row.role !== 'user') {
                if (parts.length) break;
                continue;
            }
            var engine = global.miyaChatEngine;
            var text = engine && typeof engine.messageContentText === 'function'
                ? engine.messageContentText(row).trim()
                : String(row.content || '').trim();
            if (text) parts.unshift(text);
        }
        return parts.join('\n\n').trim();
    }

    function prepareForChat(chatId) {
        delete preparedByChat[chatId];
        debugByChat[chatId] = { enabled: false, status: 'not_configured' };
        var store = global.miyaChatStore;
        if (!store || !chatId) return Promise.resolve();
        var settings = store.getChatSettings(chatId);
        var cfg = configFromSettings(settings);
        if (!isReady(cfg)) return Promise.resolve();
        debugByChat[chatId] = {
            enabled: true,
            status: 'checking',
            synonymsGroups: Object.keys(cfg.synonyms || {}).length,
            query: '',
            lastWrite: lastWriteByChat[chatId] ? Object.assign({}, lastWriteByChat[chatId]) : null
        };
        return ensureSynonyms(chatId, cfg).then(function (freshCfg) {
            settings = store.getChatSettings(chatId);
            var query = buildQueryText(chatId);
            debugByChat[chatId].synonymsGroups = Object.keys(freshCfg.synonyms || {}).length;
            debugByChat[chatId].query = query.slice(0, 240);
            var hits = concreteHits(settings, freshCfg, query);
            debugByChat[chatId].concreteHits = hits;
            if (!hits.length) {
                debugByChat[chatId].status = 'no_concrete_hit';
                return;
            }
            var seenSearchTerms = {};
            var searchQuery = hits.filter(function (term) {
                var key = String(term || '').trim().toLowerCase();
                if (!key || seenSearchTerms[key]) return false;
                seenSearchTerms[key] = true;
                return true;
            }).join(' ');
            debugByChat[chatId].searchQuery = searchQuery;
            debugByChat[chatId].status = 'searching';
            return callMcp(freshCfg, 'search_memory', {
                key: freshCfg.memoryKey,
                query: searchQuery,
                include_superseded: false
            }).then(function (raw) {
                debugByChat[chatId].workerResult = summarizeSearchResult(raw);
                var chunks = cleanSearchResult(raw);
                debugByChat[chatId].status = chunks.length ? 'injected' : 'empty_result';
                debugByChat[chatId].blocks = chunks.length;
                if (chunks.length) {
                    preparedByChat[chatId] = [{
                        role: 'system',
                        content: '【外置长期记忆】\n' + chunks.join('\n\n')
                    }];
                }
            });
        }).catch(function (err) {
            debugByChat[chatId].status = 'search_failed';
            debugByChat[chatId].error = err && err.message ? String(err.message).slice(0, 160) : 'unknown';
            if (global.console && typeof global.console.warn === 'function') {
                global.console.warn('[MiyaExternalMemory] search_memory failed:', err && err.message ? err.message : err);
            }
        });
    }

    function writeExtractedMemory(chatId, result) {
        var store = global.miyaChatStore;
        if (!store || !chatId) return Promise.reject(new Error('store_missing'));
        var cfg = configFromSettings(store.getChatSettings(chatId));
        if (!isReady(cfg)) return Promise.resolve(false);
        lastWriteByChat[chatId] = { status: 'writing', updatedAt: Date.now() };
        return callMcp(cfg, 'write_memory', {
            key: cfg.memoryKey,
            title: String(result && result.title || '').trim(),
            content: String(result && result.content || '').trim(),
            keywords: Array.isArray(result && result.keywords) ? result.keywords.slice() : []
        }).then(function () {
            lastWriteByChat[chatId] = { status: 'success', updatedAt: Date.now() };
            return true;
        }).catch(function (err) {
            lastWriteByChat[chatId] = {
                status: 'failed',
                error: err && err.message ? String(err.message).slice(0, 160) : 'unknown',
                updatedAt: Date.now()
            };
            throw err;
        });
    }

    function registerProvider() {
        var engine = global.miyaChatEngine;
        if (!engine || typeof engine.registerPostHistoryMemoryProvider !== 'function') return false;
        engine.registerPostHistoryMemoryProvider('external-memory', function (context) {
            var chatId = context && context.chatId;
            if (context && chatId && debugByChat[chatId]) {
                context.memoryRecallDebug = context.memoryRecallDebug || {};
                context.memoryRecallDebug.externalMemory = Object.assign({}, debugByChat[chatId]);
            }
            var messages = chatId && preparedByChat[chatId] ? preparedByChat[chatId] : [];
            if (chatId) delete preparedByChat[chatId];
            return messages;
        });
        return true;
    }

    global.MiyaExternalMemory = {
        configFromSettings: configFromSettings,
        refreshSynonyms: refreshSynonyms,
        prepareForChat: prepareForChat,
        writeExtractedMemory: writeExtractedMemory,
        normalizeSynonymGroups: normalizeSynonymGroups
    };

    if (!registerProvider()) {
        global.addEventListener('DOMContentLoaded', registerProvider, { once: true });
    }
})(window);
