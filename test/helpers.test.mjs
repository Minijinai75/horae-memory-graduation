import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const helpersPath = fs.existsSync(path.join(testDir, '..', 'horae-memory-graduation', 'helpers.js'))
    ? '../horae-memory-graduation/helpers.js'
    : '../helpers.js';

const {
    countHoraeCandidateTypes,
    classifyCandidateAgainstEntries,
    entryFingerprint,
    extractHoraeCandidates,
    isImportantHoraeEvent,
    normalizeIntegerSetting,
    normalizeIntegerSettings,
    rebalanceHmgConstants,
    shouldProtectExistingEntry,
    sourceOrderFromSummary,
    stableHash,
} = await import(helpersPath);

function trackedEntry() {
    const entry = {
        content: '原始內容',
        comment: '原始標題',
        key: ['角色', '地點'],
        extensions: { hmg: {} },
    };
    entry.extensions.hmg.entryHash = entryFingerprint(entry);
    return entry;
}

test('stableHash 對相同內容產生相同結果', () => {
    assert.equal(stableHash('abc'), stableHash('abc'));
    assert.notEqual(stableHash('abc'), stableHash('abd'));
});

test('完整 fingerprint 未變時允許自動更新', () => {
    assert.equal(shouldProtectExistingEntry(trackedEntry()), false);
});

test('舊條目缺少完整 fingerprint 時保守保護', () => {
    const entry = trackedEntry();
    delete entry.extensions.hmg.entryHash;
    entry.extensions.hmg.contentHash = stableHash(entry.content);
    assert.equal(shouldProtectExistingEntry(entry), true);
});

for (const [field, mutate] of [
    ['內容', (entry) => { entry.content = '人工修改內容'; }],
    ['標題', (entry) => { entry.comment = '人工修改標題'; }],
    ['關鍵字', (entry) => { entry.key = ['新關鍵字']; }],
]) {
    test(`人工修改${field}時禁止自動覆寫`, () => {
        const entry = trackedEntry();
        mutate(entry);
        assert.equal(shouldProtectExistingEntry(entry), true);
    });
}

test('合法的 0 會被保留', () => {
    assert.equal(normalizeIntegerSetting('0', 5, 0, 10), 0);
});

test('空值與非數字退回預設值', () => {
    assert.equal(normalizeIntegerSetting('', 5, 0, 10), 5);
    assert.equal(normalizeIntegerSetting('nope', 5, 0, 10), 5);
});

test('數值依上下界 clamp', () => {
    assert.equal(normalizeIntegerSetting('-1', 5, 0, 10), 0);
    assert.equal(normalizeIntegerSetting('999', 5, 0, 10), 10);
});

test('小數會轉成整數', () => {
    assert.equal(normalizeIntegerSetting('4.9', 5, 0, 10), 4);
});

test('舊版持久化數值會在載入時一次 migration', () => {
    const settings = {
        oldestN: 4.9,
        maxEntries: 999,
        constantCount: -3,
        subApiMaxTokens: 'nope',
    };
    const defaults = { oldestN: 5, maxEntries: 12, constantCount: 1, subApiMaxTokens: 800 };
    const bounds = {
        oldestN: { min: 0, max: 50 },
        maxEntries: { min: 1, max: 50 },
        constantCount: { min: 0, max: 10 },
        subApiMaxTokens: { min: 64, max: 8192 },
    };

    assert.equal(normalizeIntegerSettings(settings, defaults, bounds), true);
    assert.deepEqual(settings, { oldestN: 4, maxEntries: 50, constantCount: 0, subApiMaxTokens: 800 });
    assert.equal(normalizeIntegerSettings(settings, defaults, bounds), false);
});

test('舊設定 migration 保留合法的 0', () => {
    const settings = { oldestN: 0, constantCount: 0 };
    const defaults = { oldestN: 5, constantCount: 1 };
    const bounds = { oldestN: { min: 0, max: 50 }, constantCount: { min: 0, max: 10 } };
    assert.equal(normalizeIntegerSettings(settings, defaults, bounds), false);
    assert.deepEqual(settings, { oldestN: 0, constantCount: 0 });
});

test('摘要來源順序優先使用 Horae id 時間，舊資料退回樓層', () => {
    assert.equal(sourceOrderFromSummary('as_1750000000002', 5), 1750000000002);
    assert.equal(sourceOrderFromSummary('cs_1750000000000', 10), 1750000000000);
    assert.equal(sourceOrderFromSummary('ms_1750000000001', 20), 1750000000001);
    assert.equal(sourceOrderFromSummary('legacy-id', 30), 30);
});

test('重要事件兼容布林標記、簡繁關鍵與英文 level', () => {
    assert.equal(isImportantHoraeEvent({ is_important: true, level: '一般' }), true);
    assert.equal(isImportantHoraeEvent({ level: '关键' }), true);
    assert.equal(isImportantHoraeEvent({ level: '關鍵' }), true);
    assert.equal(isImportantHoraeEvent({ level: 'critical' }), true);
    assert.equal(isImportantHoraeEvent({ level: '一般', is_important: false }), false);
    assert.equal(isImportantHoraeEvent({ level: '關鍵', isSummary: true }), false);
});

test('沒有 autoSummaries 的 Horae 聊天仍能找出 18 筆重要事件', () => {
    const fixture = fs.readFileSync(path.join(testDir, 'fixtures', 'no-auto-summary-chat.jsonl'), 'utf8');
    const chat = fixture.trim().split(/\r?\n/).map(JSON.parse);
    const counts = countHoraeCandidateTypes(extractHoraeCandidates(chat));
    assert.equal(counts.event, 18);
    assert.equal(counts.summary || 0, 0);
});

test('active 摘要取代被覆蓋事件，inactive 摘要還原原事件', () => {
    const chat = [{
        send_date: '2026-01-01T00:00:00.000Z',
        horae_meta: {
            autoSummaries: [{ id: 'as_1750000000000', active: true, summaryText: '合併摘要', coveredIndices: [0] }],
            events: [{ level: '重要', is_important: true, summary: '原事件', _compressedBy: 'as_1750000000000' }],
        },
    }];
    assert.deepEqual(countHoraeCandidateTypes(extractHoraeCandidates(chat)), { summary: 1 });
    chat[0].horae_meta.autoSummaries[0].active = false;
    assert.deepEqual(countHoraeCandidateTypes(extractHoraeCandidates(chat)), { event: 1 });
});

test('永久場景與角色聚合成 typed candidates，現況不會畢業', () => {
    const chat = [{ horae_meta: {} }, {
        horae_meta: {
            locationMemory: { 酒館: { desc: '兩層木造建築' } },
            npcs: { 艾倫: { personality: '沉著' } },
            affection: { 艾倫: { type: 'absolute', value: 70 } },
            mood: { 艾倫: '緊張' },
            costumes: { 艾倫: '黑色外套' },
        },
    }];
    assert.deepEqual(countHoraeCandidateTypes(extractHoraeCandidates(chat)), { location: 1, character: 1 });
});

test('只收重要物品，並排除 sideplay 與 carryover 事件', () => {
    const chat = [
        {
            horae_meta: {
                events: [{ level: '重要', summary: '搬家回顧', _carryoverSeed: true }],
                items: {
                    普通水杯: { importance: '' },
                    王室戒指: { importance: '!!', description: '繼承憑證', holder: '艾倫' },
                },
            },
        },
        { horae_meta: { _skipHorae: true, events: [{ level: '關鍵', summary: '番外事件' }] } },
    ];
    const candidates = extractHoraeCandidates(chat);
    assert.deepEqual(countHoraeCandidateTypes(candidates), { item: 1 });
    assert.equal(candidates[0].entityKey, '王室戒指');
});

test('曾為重要的物品被刪除時產生 tombstone，普通物品不產生', () => {
    const chat = [
        { horae_meta: { items: { 王室戒指: { importance: '!!' }, 水杯: { importance: '' } } } },
        { horae_meta: { deletedItems: ['王室戒指', '水杯'] } },
    ];
    const candidates = extractHoraeCandidates(chat);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].type, 'item');
    assert.equal(candidates[0].action, 'delete');
    assert.equal(candidates[0].entityKey, '王室戒指');
});

test('世界書預檢會在 Sub API 前區分未變、更新、保護與刪除', () => {
    const existing = trackedEntry();
    existing.extensions.hmg.summaryId = 'evt-1';
    existing.extensions.hmg.sourceHash = 'same';
    const entries = { 1: existing };
    assert.equal(classifyCandidateAgainstEntries(entries, { id: 'evt-1', sourceHash: 'same' }).status, 'unchanged');
    assert.equal(classifyCandidateAgainstEntries(entries, { id: 'evt-1', sourceHash: 'new' }).status, 'update');
    assert.equal(classifyCandidateAgainstEntries(entries, { id: 'evt-1', action: 'delete' }).status, 'delete');
    existing.content = '人工修改';
    assert.equal(classifyCandidateAgainstEntries(entries, { id: 'evt-1', sourceHash: 'new' }).status, 'protected');
    assert.equal(classifyCandidateAgainstEntries({}, { id: 'evt-1', action: 'delete' }).status, 'absent-delete');
});

function hmgEntry(uid, sourceOrder, key = ['關鍵字']) {
    return {
        uid,
        content: `內容 ${uid}`,
        comment: `標題 ${uid}`,
        key,
        constant: true,
        ignoreBudget: true,
        extensions: { hmg: { summaryId: `cs_${sourceOrder}`, sourceOrder } },
        hmg_summary_id: `cs_${sourceOrder}`,
    };
}

test('跨批次只保留全域最新 N 條 keyed hmg 藍燈', () => {
    const entries = {
        1: hmgEntry(1, 100),
        2: hmgEntry(2, 200),
        3: hmgEntry(3, 300),
    };
    rebalanceHmgConstants(entries, 1);
    assert.equal(entries[1].constant, false);
    assert.equal(entries[1].ignoreBudget, false);
    assert.equal(entries[2].constant, false);
    assert.equal(entries[3].constant, true);
    assert.equal(entries[3].ignoreBudget, true);
});

test('v0.1.2 缺 sourceOrder 或只剩頂層標記時仍可依摘要 id 重整', () => {
    const older = hmgEntry(1, 1750000000000);
    delete older.extensions.hmg.sourceOrder;
    const newer = {
        uid: 2,
        key: ['新記憶'],
        constant: false,
        ignoreBudget: false,
        hmg_summary_id: 'cs_1750000000001',
    };

    rebalanceHmgConstants({ 1: older, 2: newer }, 1);

    assert.equal(older.constant, false);
    assert.equal(older.ignoreBudget, false);
    assert.equal(newer.constant, true);
    assert.equal(newer.ignoreBudget, true);
});

test('無關鍵字 hmg 常駐但不繞過預算，非 hmg 與內容欄位不被重整', () => {
    const noKey = hmgEntry(1, 100, []);
    noKey.constant = false;
    noKey.ignoreBudget = false;
    const keyed = hmgEntry(2, 200);
    const external = { uid: 3, key: ['外部'], constant: true, ignoreBudget: true };
    const before = { content: keyed.content, comment: keyed.comment, key: [...keyed.key] };

    rebalanceHmgConstants({ 1: noKey, 2: keyed, 3: external }, 0);

    assert.equal(noKey.constant, true);
    assert.equal(noKey.ignoreBudget, false);
    assert.equal(keyed.constant, false);
    assert.equal(keyed.ignoreBudget, false);
    assert.deepEqual({ content: keyed.content, comment: keyed.comment, key: keyed.key }, before);
    assert.equal(external.constant, true);
    assert.equal(external.ignoreBudget, true);
});
