'use strict';

/** 內容穩定雜湊（base36）；只作變更偵測與去重，不作安全用途。 */
export function stableHash(str) {
    let h = 0;
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i++) {
        h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

/** 對使用者可編輯的世界書欄位建立完整 fingerprint。 */
export function entryFingerprint(entry) {
    return stableHash(JSON.stringify({
        content: String(entry?.content ?? ''),
        comment: String(entry?.comment ?? ''),
        key: Array.isArray(entry?.key) ? entry.key.map((value) => String(value)) : [],
    }));
}

/**
 * true 代表不可安全自動覆寫：條目被改過，或來自沒有完整 fingerprint 的舊版本。
 * 舊資料採保守策略，避免把「無法判斷」誤當成「沒有手改」。
 */
export function shouldProtectExistingEntry(entry) {
    const recorded = entry?.extensions?.hmg?.entryHash;
    return typeof recorded !== 'string' || recorded !== entryFingerprint(entry);
}

/** number input 共用正規化：空值/非數字退預設，其餘轉整數並 clamp。 */
export function normalizeIntegerSetting(rawValue, defaultValue, min, max) {
    if (rawValue === '' || rawValue == null) return defaultValue;
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** 將既有設定就地 migration；回傳是否有任何值被修正。 */
export function normalizeIntegerSettings(settings, defaults, bounds) {
    let changed = false;
    for (const [key, { min, max }] of Object.entries(bounds)) {
        const normalized = normalizeIntegerSetting(settings[key], defaults[key], min, max);
        if (!Object.is(settings[key], normalized)) {
            settings[key] = normalized;
            changed = true;
        }
    }
    return changed;
}

/** Horae 新版摘要 id 內含建立時間；舊資料退回覆蓋範圍位置。 */
export function sourceOrderFromSummary(summaryId, maxIdx = -1) {
    const match = String(summaryId ?? '').match(/^(?:as|cs|ms)_(\d{10,})$/i);
    if (match) {
        const timestamp = Number(match[1]);
        if (Number.isSafeInteger(timestamp)) return timestamp;
    }
    return Number.isFinite(Number(maxIdx)) ? Number(maxIdx) : -1;
}

const IMPORTANT_EVENT_LEVELS = new Set(['重要', '关键', '關鍵', 'important', 'critical']);

/** Horae 1.15.x 會把繁體「關鍵」正規化成簡體「关键」；以布林標記優先並兼容多語文字。 */
export function isImportantHoraeEvent(event) {
    if (!event || event.isSummary || event._summaryId || event._carryoverSeed) return false;
    if (event.is_important === true) return true;
    return IMPORTANT_EVENT_LEVELS.has(String(event.level ?? '').trim().toLowerCase());
}

function storyBackground(meta) {
    return {
        storyDate: String(meta?.timestamp?.story_date ?? ''),
        storyTime: String(meta?.timestamp?.story_time ?? ''),
        location: String(meta?.scene?.location ?? ''),
        characters: Array.isArray(meta?.scene?.characters_present)
            ? meta.scene.characters_present.map(String).filter(Boolean)
            : [],
    };
}

function itemBaseName(name) {
    return String(name ?? '')
        .replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '')
        .replace(/[\(（]\d+(?:\.\d+)?[^\)）]*[\)）]$/, '')
        .trim()
        .toLowerCase();
}

/**
 * Horae 的 NPC／好感／物品是每樓增量，不可逐樓直接寫世界書。
 * 這是供無公開 API（測試／舊版）時使用的保守聚合器；瀏覽器內優先傳入 Horae.getLatestState()。
 */
export function aggregateHoraeState(chat) {
    const state = { items: {}, affection: {}, npcs: {}, relationships: [] };
    const itemKeysByBase = new Map();

    for (const message of Array.isArray(chat) ? chat : []) {
        const meta = message?.horae_meta;
        if (!meta || meta._skipHorae) continue;

        for (const [rawName, update] of Object.entries(meta.items || {})) {
            const base = itemBaseName(rawName);
            if (!base) continue;
            const previousKey = itemKeysByBase.get(base);
            const previous = previousKey ? state.items[previousKey] : null;
            if (previousKey && previousKey !== rawName) delete state.items[previousKey];
            state.items[rawName] = { ...(previous || {}), ...(update || {}) };
            itemKeysByBase.set(base, rawName);
        }
        for (const rawName of meta.deletedItems || []) {
            const base = itemBaseName(rawName);
            const key = itemKeysByBase.get(base);
            if (key) delete state.items[key];
            itemKeysByBase.delete(base);
        }

        for (const [name, update] of Object.entries(meta.npcs || {})) {
            state.npcs[name] = { ...(state.npcs[name] || {}), ...(update || {}) };
        }
        for (const [name, update] of Object.entries(meta.affection || {})) {
            if (update && typeof update === 'object') {
                const value = Number(update.value);
                if (!Number.isFinite(value)) continue;
                state.affection[name] = update.type === 'relative'
                    ? Number(state.affection[name] || 0) + value
                    : value;
            } else {
                const value = Number(update);
                if (Number.isFinite(value)) state.affection[name] = Number(state.affection[name] || 0) + value;
            }
        }
        if (Array.isArray(meta.relationships)) state.relationships = meta.relationships.map((r) => ({ ...r }));
    }
    return state;
}

function makeCandidate(candidate) {
    const result = {
        id: String(candidate.id),
        type: String(candidate.type),
        action: candidate.action === 'delete' ? 'delete' : 'upsert',
        entityKey: String(candidate.entityKey ?? ''),
        summaryText: String(candidate.summaryText ?? '').trim(),
        importance: String(candidate.importance ?? ''),
        covered: Array.isArray(candidate.covered) ? candidate.covered.slice() : [],
        maxIdx: Number.isFinite(candidate.maxIdx) ? candidate.maxIdx : -1,
        sourceOrder: Number.isFinite(candidate.sourceOrder) ? candidate.sourceOrder : -1,
        distanceFromBottom: Number.isFinite(candidate.distanceFromBottom) ? candidate.distanceFromBottom : Infinity,
        background: candidate.background || { storyDate: '', storyTime: '', location: '', characters: [] },
        defaultKeywords: [...new Set((candidate.defaultKeywords || []).map(String).map((s) => s.trim()).filter(Boolean))].slice(0, 8),
    };
    result.sourceHash = stableHash(JSON.stringify({
        type: result.type,
        action: result.action,
        entityKey: result.entityKey,
        summaryText: result.summaryText,
        importance: result.importance,
        background: result.background,
    }));
    return result;
}

function summaryCoveredIndices(summary) {
    if (Array.isArray(summary?.coveredIndices) && summary.coveredIndices.length) {
        return summary.coveredIndices.filter(Number.isInteger);
    }
    if (Array.isArray(summary?.range) && summary.range.length === 2
        && Number.isInteger(summary.range[0]) && Number.isInteger(summary.range[1])) {
        const lo = Math.min(summary.range[0], summary.range[1]);
        const hi = Math.max(summary.range[0], summary.range[1]);
        return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    }
    return [];
}

/** 從 Horae raw chat 建立「可畢業候選」；autoSummaries 是可選壓縮層，不再是前置條件。 */
export function extractHoraeCandidates(chat, latestState = null) {
    if (!Array.isArray(chat) || !chat.length) return [];
    const summaryById = new Map();
    const locationMemory = {};
    const deletedNpcs = new Set();
    for (const message of chat) {
        const meta = message?.horae_meta;
        if (!meta) continue;
        for (const summary of meta.autoSummaries || []) {
            const key = String(summary?.id ?? `anon_${stableHash(String(summary?.summaryText ?? ''))}`);
            summaryById.set(key, summary);
        }
        Object.assign(locationMemory, meta.locationMemory || {});
        for (const value of meta._deletedNpcs || []) deletedNpcs.add(String(value?.name ?? value));
    }
    const activeSummaries = [...summaryById.values()]
        .filter((summary) => summary && summary.active !== false && String(summary.summaryText ?? '').trim());
    const activeSummaryIds = new Set(activeSummaries.map((summary) => String(summary.id ?? '')).filter(Boolean));
    const chatLen = chat.length;
    const latestChatTime = chat.reduce((latest, message) => {
        const timestamp = Date.parse(message?.send_date || '');
        return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
    }, -1);
    const stateSourceOrder = latestChatTime >= 0 ? latestChatTime : chatLen;
    const candidates = [];

    for (const summary of activeSummaries) {
        const covered = summaryCoveredIndices(summary);
        const maxIdx = covered.length ? Math.max(...covered) : -1;
        let bg = { storyDate: '', storyTime: '', location: '', characters: [] };
        for (let i = covered.length - 1; i >= 0; i--) {
            if (chat[covered[i]]?.horae_meta) { bg = storyBackground(chat[covered[i]].horae_meta); break; }
        }
        const id = summary.id != null && summary.id !== ''
            ? String(summary.id)
            : `sum_${stableHash(String(summary.summaryText))}`;
        candidates.push(makeCandidate({
            id,
            type: 'summary',
            summaryText: summary.summaryText,
            importance: '摘要',
            covered,
            maxIdx,
            sourceOrder: sourceOrderFromSummary(id, maxIdx),
            distanceFromBottom: maxIdx >= 0 ? Math.max(0, chatLen - 1 - maxIdx) : Infinity,
            background: bg,
            defaultKeywords: [...bg.characters, bg.location],
        }));
    }

    for (let messageIndex = 0; messageIndex < chat.length; messageIndex++) {
        const message = chat[messageIndex];
        const meta = message?.horae_meta;
        if (!meta || meta._skipHorae) continue;
        const events = Array.isArray(meta.events) ? meta.events : (meta.event ? [meta.event] : []);
        for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
            const event = events[eventIndex];
            if (!isImportantHoraeEvent(event)) continue;
            if (event._compressedBy && activeSummaryIds.has(String(event._compressedBy))) continue;
            const summaryText = String(event.summary ?? '').trim();
            if (!summaryText) continue;
            const sendKey = String(message.send_date ?? message.extra?.api ?? messageIndex);
            const id = `evt_${stableHash(`${sendKey}|${eventIndex}`)}`;
            const bg = storyBackground(meta);
            const absolute = Date.parse(message.send_date || '');
            candidates.push(makeCandidate({
                id,
                type: 'event',
                summaryText,
                importance: event.level || '重要',
                covered: [messageIndex],
                maxIdx: messageIndex,
                sourceOrder: Number.isFinite(absolute) ? absolute : messageIndex,
                distanceFromBottom: Math.max(0, chatLen - 1 - messageIndex),
                background: bg,
                defaultKeywords: [...bg.characters, bg.location],
            }));
        }
    }

    const state = latestState && typeof latestState === 'object' ? latestState : aggregateHoraeState(chat);
    Object.assign(locationMemory, state.locationMemory || {});
    for (const [location, info] of Object.entries(locationMemory)) {
        if (!location) continue;
        if (info?._deleted) {
            candidates.push(makeCandidate({
                id: `loc_${stableHash(location)}`, type: 'location', action: 'delete', entityKey: location,
                summaryText: `刪除已移除的永久場景「${location}」。`, importance: '來源已刪除',
                sourceOrder: stateSourceOrder, defaultKeywords: [location],
            }));
            continue;
        }
        if (!info?.desc) continue;
        const updatedAt = Date.parse(info.lastUpdated || info.firstSeen || '');
        candidates.push(makeCandidate({
            id: `loc_${stableHash(location)}`,
            type: 'location',
            entityKey: location,
            summaryText: `地點「${location}」：${info.desc}`,
            importance: '永久場景',
            sourceOrder: Number.isFinite(updatedAt) ? updatedAt : stateSourceOrder,
            background: { storyDate: '', storyTime: '', location, characters: [] },
            defaultKeywords: [location, ...location.split(/[·・>＞/]/)],
        }));
    }

    const characterNames = new Set([...Object.keys(state.npcs || {}), ...Object.keys(state.affection || {})]);
    for (const name of deletedNpcs) {
        if (!name) continue;
        candidates.push(makeCandidate({
            id: `char_${stableHash(name)}`, type: 'character', action: 'delete', entityKey: name,
            summaryText: `刪除已從 Horae 移除的角色資料「${name}」。`, importance: '來源已刪除',
            sourceOrder: stateSourceOrder, defaultKeywords: [name],
        }));
    }
    for (const name of characterNames) {
        if (!name || deletedNpcs.has(name)) continue;
        const npc = state.npcs?.[name] || {};
        const affection = state.affection?.[name];
        const details = [
            npc.appearance ? `外貌：${npc.appearance}` : '',
            npc.personality ? `性格：${npc.personality}` : '',
            npc.relationship ? `與玩家的關係：${npc.relationship}` : '',
            npc.gender ? `性別：${npc.gender}` : '',
            npc.age ? `年齡：${npc.age}` : '',
            npc.race ? `種族：${npc.race}` : '',
            npc.job ? `職業：${npc.job}` : '',
            affection !== undefined ? `好感度：${affection}` : '',
        ].filter(Boolean);
        if (!details.length) continue;
        const aliases = Array.isArray(npc._aliases) ? npc._aliases : [];
        candidates.push(makeCandidate({
            id: `char_${stableHash(name)}`,
            type: 'character',
            entityKey: name,
            summaryText: `角色「${name}」目前的長期資料：${details.join('；')}。`,
            importance: '角色資料',
            sourceOrder: stateSourceOrder,
            defaultKeywords: [name, ...aliases],
        }));
    }

    for (const [name, item] of Object.entries(state.items || {})) {
        const rank = String(item?.importance ?? '');
        if (!['!', '!!', '重要', '关键', '關鍵'].includes(rank)) continue;
        const details = [
            item.description ? `描述：${item.description}` : '',
            item.holder ? `持有者：${item.holder}` : '',
            item.location ? `位置：${item.location}` : '',
        ].filter(Boolean);
        candidates.push(makeCandidate({
            id: `item_${stableHash(itemBaseName(name))}`,
            type: 'item',
            entityKey: name,
            summaryText: `重要物品「${name}」${details.length ? `：${details.join('；')}` : ''}。`,
            importance: rank === '!!' ? '關鍵物品' : '重要物品',
            sourceOrder: stateSourceOrder,
            defaultKeywords: [name, item.holder, item.location],
        }));
    }

    const currentItemBases = new Set(Object.keys(state.items || {}).map(itemBaseName));
    const deletedItemNames = new Set();
    const historicalItemImportance = new Map();
    for (const message of chat) {
        for (const [name, item] of Object.entries(message?.horae_meta?.items || {})) {
            const rank = String(item?.importance ?? '');
            if (['!', '!!', '重要', '关键', '關鍵'].includes(rank)) historicalItemImportance.set(itemBaseName(name), rank);
        }
        for (const name of message?.horae_meta?.deletedItems || []) deletedItemNames.add(String(name));
    }
    for (const name of deletedItemNames) {
        const base = itemBaseName(name);
        if (!base || currentItemBases.has(base) || !historicalItemImportance.has(base)) continue;
        candidates.push(makeCandidate({
            id: `item_${stableHash(base)}`, type: 'item', action: 'delete', entityKey: name,
            summaryText: `刪除已消耗／遺失的重要物品「${name}」。`, importance: '來源已刪除',
            sourceOrder: stateSourceOrder, defaultKeywords: [name],
        }));
    }

    for (const rel of state.relationships || []) {
        if (!rel?.from || !rel?.to || !rel?.type) continue;
        const entityKey = `${rel.from}>${rel.to}`;
        candidates.push(makeCandidate({
            id: `rel_${stableHash(entityKey)}`,
            type: 'relationship',
            entityKey,
            summaryText: `角色關係：${rel.from}與${rel.to}目前為「${rel.type}」${rel.note ? `；${rel.note}` : ''}。`,
            importance: '關係資料',
            sourceOrder: stateSourceOrder,
            defaultKeywords: [rel.from, rel.to, rel.type],
        }));
    }

    const typeOrder = { summary: 0, event: 1, location: 2, character: 3, item: 4, relationship: 5 };
    return candidates.sort((a, b) => {
        const aHistorical = a.maxIdx >= 0;
        const bHistorical = b.maxIdx >= 0;
        if (aHistorical !== bHistorical) return aHistorical ? -1 : 1;
        if (aHistorical && a.maxIdx !== b.maxIdx) return a.maxIdx - b.maxIdx;
        return (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99) || a.id.localeCompare(b.id);
    });
}

export function countHoraeCandidateTypes(candidates) {
    const counts = {};
    for (const candidate of candidates || []) counts[candidate.type] = (counts[candidate.type] || 0) + 1;
    return counts;
}

/** 在 Sub API 前判斷候選相對於世界書的狀態，確保未變來源不再花錢。 */
export function classifyCandidateAgainstEntries(entries, candidate) {
    const existing = Object.values(entries || {}).find((entry) =>
        entry?.extensions?.hmg?.summaryId === candidate?.id || entry?.hmg_summary_id === candidate?.id) || null;
    if (!existing) return { status: candidate?.action === 'delete' ? 'absent-delete' : 'new', existing: null };
    if (candidate?.action === 'delete') {
        return { status: shouldProtectExistingEntry(existing) ? 'protected' : 'delete', existing };
    }
    if (existing.extensions?.hmg?.sourceHash === candidate?.sourceHash) return { status: 'unchanged', existing };
    return { status: shouldProtectExistingEntry(existing) ? 'protected' : 'update', existing };
}

/**
 * 全域重整本擴充管理的藍燈：無有效關鍵字者永遠常駐；其餘只保留最新 N 條。
 * 只改 constant/ignoreBudget，不碰 fingerprint 涵蓋的 content/comment/key。
 */
export function rebalanceHmgConstants(entries, constantCount) {
    const keyed = [];
    let changed = 0;

    for (const entry of Object.values(entries || {})) {
        if (!entry) continue;
        const marker = entry.extensions?.hmg;
        const summaryId = marker?.summaryId ?? entry.hmg_summary_id;
        if (summaryId == null || summaryId === '') continue;
        if (String(summaryId).startsWith('__hmg_debug__')) continue;

        const hasKeywords = Array.isArray(entry.key)
            && entry.key.some((value) => String(value).trim().length > 0);
        if (!hasKeywords) {
            if (entry.constant !== true) { entry.constant = true; changed++; }
            // 沒關鍵字仍需 constant 才會生效，但不可無上限繞過世界書預算。
            if (entry.ignoreBudget !== false) { entry.ignoreBudget = false; changed++; }
            continue;
        }

        const storedOrder = Number(marker?.sourceOrder);
        const sourceOrder = Number.isFinite(storedOrder)
            ? storedOrder
            : sourceOrderFromSummary(summaryId, -1);
        const uid = Number.isFinite(Number(entry.uid)) ? Number(entry.uid) : -1;
        keyed.push({ entry, sourceOrder, uid });
    }

    keyed.sort((a, b) => b.sourceOrder - a.sourceOrder || b.uid - a.uid);
    const limit = Math.max(0, Math.trunc(Number(constantCount) || 0));
    keyed.forEach(({ entry }, index) => {
        const shouldBeConstant = index < limit;
        if (entry.constant !== shouldBeConstant) { entry.constant = shouldBeConstant; changed++; }
        if (entry.ignoreBudget !== shouldBeConstant) { entry.ignoreBudget = shouldBeConstant; changed++; }
    });

    return changed;
}
