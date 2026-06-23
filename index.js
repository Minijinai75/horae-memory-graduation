/**
 * Horae 記憶畢業到世界書 — 橋接擴充（v0.2.0）
 *
 * 把 Horae 的重要／關鍵事件與永久資料整理成世界書條目；autoSummaries 有就作壓縮層，沒有也能運作。
 *   - 不靠向量（vectorized=false）、手機友善
 *   - 注入位置 position=0（背景區），與 Horae 末尾的「現況」注入錯開
 *   - 只讀 Horae，從不寫 Horae
 *   - 主流程：USER 框範圍 → Sub API 整理 → USER 逐條確認 → 才寫入
 *
 * 設計依據與已查證的 ST API（皆對照 _st_source / SillyTavern 1.18.0）：
 *   - getContext() 只暴露 loadWorldInfo / saveWorldInfo / updateWorldInfoList /
 *     reloadWorldInfoEditor / getWorldInfoNames / convertCharacterBook / getWorldInfoPrompt（st-context.js:276-282）；
 *     **createWorldInfoEntry 與 createNewWorldInfo 都沒有暴露** → 條目自己手搓；安全建書時明確
 *     import 核心 getSanitizedFilename/createNewWorldInfo，保留檔名清理與撞名確認（見 createBookSafely）。
 *   - 旁路生成走官方 ConnectionManagerRequestService.sendRequest(profileId, prompt, maxTokens, custom)
 *     （shared.js:419；非串流回傳 { content }），走使用者選的「連線設定檔」、不污染聊天。
 *   - 連線設定檔清單在 extensionSettings.connectionManager.profiles（每個 { id, name, ... }）。
 *   - 條目欄位對照 world-info.js:4002-4049 的 newWorldInfoEntryTemplate（baked 於下方）。
 *   - METADATA_KEY = 'world_info'（聊天綁定書），world_info_position.before = 0。
 *
 * AGPL 紅線：MemoryBooks 為 AGPL-3.0，本擴充只學設計模式、未複製其任何程式碼/命名/schema。
 */

'use strict';

import {
    countHoraeCandidateTypes,
    classifyCandidateAgainstEntries,
    entryFingerprint,
    extractHoraeCandidates,
    normalizeIntegerSetting,
    normalizeIntegerSettings,
    rebalanceHmgConstants,
    shouldProtectExistingEntry,
    stableHash,
} from './helpers.js';

/** 命名空間：同時是 extension_settings 的 key 與 DOM/CSS/slash 前綴 */
const MODULE_NAME = 'hmg';
const HMG_VERSION = '0.2.0';
const LOG = `[${MODULE_NAME}]`;

/** ST 世界書條目範本（baked，對照 world-info.js:4002-4049 @1.18.0）。
 *  自己建條目時 clone 它再覆寫欄位，確保條目結構完整、ST 各路徑都讀得到。 */
const WI_ENTRY_TEMPLATE = Object.freeze({
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,           // world_info_logic.AND_ANY
    addMemo: false,
    order: 100,
    position: 0,                 // world_info_position.before（背景區）
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: true,      // 硬原則：避免一條連鎖點亮一堆爆預算（PLAN §8）
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
    extensions: {},
});

/** 預設設定（逐 key 補洞，不覆蓋使用者既有值） */
const defaultSettings = Object.freeze({
    enabled: true,
    subApiEnabled: true,        // 關 = 省錢模式（原文照搬，沿用 Horae 人名／地點等基礎關鍵字）
    connectionProfileId: '',    // 選用的連線設定檔 id（旁路生成用）
    targetBook: '',             // 目標世界書名
    oldestN: 5,                 // 預覽預設勾選排序最前的 N 條
    maxEntries: 12,             // 單次寫入硬上限
    maxTotalEntries: 60,        // 目標世界書內 hmg 條目總上限
    minEventDistance: 0,        // 歷史事件距聊天底部至少 N 樓；0 = 手動流程不限制
    constantCount: 1,           // 最新 N 條設藍燈常駐（其餘靠關鍵字綠燈）
    subApiMaxTokens: 800,       // 每條整理的回應上限
});

/** 數值設定唯一上下界來源：UI、舊設定 migration、主流程共用。 */
const integerSettingBounds = Object.freeze({
    oldestN: Object.freeze({ min: 0, max: 50 }),
    maxEntries: Object.freeze({ min: 1, max: 50 }),
    maxTotalEntries: Object.freeze({ min: 10, max: 300 }),
    minEventDistance: Object.freeze({ min: 0, max: 1000 }),
    constantCount: Object.freeze({ min: 0, max: 10 }),
    subApiMaxTokens: Object.freeze({ min: 64, max: 8192 }),
});

// ---------------------------------------------------------------------------
// 基礎工具
// ---------------------------------------------------------------------------

/** 每次用都重新取 context，不要長期持有（切聊天時 chat/chatMetadata 會整顆換掉）。 */
function getCtx() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

/** 取本擴充設定（建命名空間 + 逐 key 補洞）。 */
function getSettings() {
    const ctx = getCtx();
    const root = ctx?.extensionSettings;
    if (!root) return { ...defaultSettings };
    root[MODULE_NAME] = root[MODULE_NAME] || {};
    const s = root[MODULE_NAME];
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = v;
    }
    // v0.1.1 只檢查非負，可能留下小數或超上限值；載入時修正一次，避免直接觸發大量 API 請求。
    if (normalizeIntegerSettings(s, defaultSettings, integerSettingBounds)) {
        try { ctx.saveSettingsDebounced(); } catch { /* ignore */ }
    }
    return s;
}

function saveSettings() {
    try { getCtx()?.saveSettingsDebounced?.(); } catch { /* ignore */ }
}

/** 防 XSS：純文字一律走 textContent；要組 HTML 字串時用它先轉義。 */
function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 避免條目內容被 ST 巨集系統二次代換：在 {{ }} 中間塞零寬空格（U+200B），外觀幾乎不變、但不再被當巨集。 */
function neutralizeMacros(s) {
    const z = String.fromCharCode(0x200B); // 零寬空格，明確以碼點建立，避免不可見字元被誤改
    return String(s ?? '').replace(/\{\{/g, `{${z}{`).replace(/\}\}/g, `}${z}}`);
}

function toast(type, msg, title = 'Horae→世界書', overrides = {}) {
    try { globalThis.toastr?.[type]?.(msg, title, { timeOut: type === 'error' ? 6000 : 3500, ...overrides }); }
    catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 啟動能力檢測：缺了核心 context 函式就降級提示，不讓擴充靜默壞掉
// ---------------------------------------------------------------------------

// 注意：ST 1.18.0 的 getContext() 只暴露 load/save/reload/update/convert/getPrompt/getNames；
// createNewWorldInfo 由 createBookSafely 明確 import 核心 module，不能假裝是 context 成員。
const REQUIRED_CTX_FNS = ['loadWorldInfo', 'saveWorldInfo', 'getWorldInfoNames', 'saveSettingsDebounced'];

function checkCapabilities(ctx) {
    const missing = REQUIRED_CTX_FNS.filter((fn) => typeof ctx?.[fn] !== 'function');
    return { ok: missing.length === 0, missing };
}

function horaeAvailable() {
    const ctx = getCtx();
    if (Array.isArray(ctx?.chat) && ctx.chat.some((message) => message?.horae_meta)) return true;
    return !!(globalThis.Horae && typeof globalThis.Horae.getChat === 'function');
}

// ---------------------------------------------------------------------------
// Horae 讀取（只讀，不寫）
// ---------------------------------------------------------------------------

/** 拿到目前聊天（SillyTavern context 為主、Horae 公開 API 為備援）。 */
function getHoraeChat() {
    const ctx = getCtx();
    if (Array.isArray(ctx?.chat) && ctx.chat.length) return ctx.chat;
    try {
        const horaeChat = globalThis.Horae?.getChat?.();
        return Array.isArray(horaeChat) ? horaeChat : [];
    } catch {
        return [];
    }
}

/**
 * 取得所有可畢業候選。事件是基礎來源，autoSummaries 只是可選壓縮層；
 * 永久場景與聚合角色／重要物品也由 pure extraction layer 統一產生。
 */
function getGraduatableSummaries() {
    const chat = getHoraeChat();
    let latestState = null;
    try { latestState = globalThis.Horae?.getLatestState?.() ?? null; } catch { /* raw chat fallback */ }
    const minDistance = getSettings().minEventDistance;
    return extractHoraeCandidates(chat, latestState).filter((candidate) =>
        candidate.maxIdx < 0 || candidate.distanceFromBottom >= minDistance);
}

// ---------------------------------------------------------------------------
// Sub API（旁路生成，走連線設定檔）
// ---------------------------------------------------------------------------

function getConnectionProfiles() {
    const ctx = getCtx();
    const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
    return Array.isArray(profiles) ? profiles : [];
}

/** 組整理 prompt：餵 summaryText + 背景，要回嚴格 JSON {title, content, keywords[]}。 */
function buildSubApiPrompt(summary) {
    const bg = summary.background || {};
    const typeNames = {
        event: '重要劇情事件', summary: '壓縮後歷史摘要', location: '永久場景資料',
        character: '角色長期資料', item: '重要物品資料', relationship: '角色關係資料',
    };
    const bgLines = [];
    if (bg.storyDate || bg.storyTime) bgLines.push(`故事時間：${[bg.storyDate, bg.storyTime].filter(Boolean).join(' ')}`);
    if (bg.location) bgLines.push(`地點：${bg.location}`);
    if (bg.characters?.length) bgLines.push(`在場角色：${bg.characters.join('、')}`);
    const bgBlock = bgLines.length ? `\n【背景】\n${bgLines.join('\n')}\n` : '\n';

    return [
        `你是一個負責整理長期記憶的編輯。下面是一筆角色扮演的「${typeNames[summary.type] || '長期記憶'}」。`,
        '請把它改寫成一則「世界書條目」，讓 AI 日後能回想起這段遠期劇情。',
        '要求：',
        '1. content：用過去式、第三人稱客觀敘述，通順精煉，保留關鍵人事物與因果，不要加入摘要裡沒有的內容。',
        '2. title：一句話的條目標題（不超過 20 字）。',
        '3. keywords：3～6 個會在日後對話中自然出現、能觸發這條記憶的關鍵詞（人名、地名、事件代稱、重要物品），用繁體中文。',
        '只輸出 JSON，不要任何額外文字，格式嚴格如下：',
        '{"title":"...","content":"...","keywords":["...","..."]}',
        bgBlock,
        '【來源資料】',
        summary.summaryText,
    ].join('\n');
}

/**
 * 呼叫 Sub API 整理單條摘要。回傳 { title, content, keywords[] }。
 * 失敗時丟出錯誤交給呼叫端決定（省錢模式 fallback / 提示手動）。
 */
async function callSubApi(summary, profileId, signal) {
    const ctx = getCtx();
    const svc = ctx?.ConnectionManagerRequestService;
    if (!svc || typeof svc.sendRequest !== 'function') {
        throw new Error('ConnectionManagerRequestService 不可用（請確認「連線設定檔 / Connection Profiles」擴充已啟用）');
    }
    const s = getSettings();
    const prompt = buildSubApiPrompt(summary);
    const res = await svc.sendRequest(profileId, prompt, Number(s.subApiMaxTokens) || 800, {
        stream: false,
        extractData: true,
        includePreset: true,
        signal,
    });
    const text = typeof res === 'string' ? res : (res?.content ?? '');
    const parsed = parseEntryJson(text);
    if (!parsed) throw new Error('Sub API 回應無法解析為 JSON');
    return parsed;
}

/** 三層 JSON 容錯：① 直接 parse ② 抓 ```json``` 或第一個 {...} 區塊 ③ 失敗回 null。 */
function parseEntryJson(text) {
    const norm = (o) => {
        if (!o || typeof o !== 'object') return null;
        const title = typeof o.title === 'string' ? o.title.trim() : '';
        const content = typeof o.content === 'string' ? o.content.trim()
            : (typeof o.summary === 'string' ? o.summary.trim() : '');
        let keywords = Array.isArray(o.keywords) ? o.keywords : (Array.isArray(o.key) ? o.key : []);
        keywords = keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 8);
        if (!content) return null;
        return { title, content, keywords };
    };

    // ① 直接
    try { const r = norm(JSON.parse(text)); if (r) return r; } catch { /* fall through */ }

    // ② 抓 fenced code block
    const fenced = String(text).match(/```(?:json|jsonc)?\s*([\s\S]*?)```/i);
    if (fenced) {
        try { const r = norm(JSON.parse(fenced[1])); if (r) return r; } catch { /* fall through */ }
    }

    // ②-b 抓第一個平衡的大括號區塊
    const braced = extractFirstJsonObject(String(text));
    if (braced) {
        try { const r = norm(JSON.parse(braced)); if (r) return r; } catch { /* fall through */ }
    }

    return null; // ③ 交給呼叫端
}

function extractFirstJsonObject(text) {
    const start = text.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
        } else {
            if (ch === '"') inStr = true;
            else if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// 條目組裝 + 世界書寫入（upsert）
// ---------------------------------------------------------------------------

/** 在 data.entries 找一個沒用過的整數 uid。 */
function freeUid(data) {
    const entries = data.entries || (data.entries = {});
    let uid = 0;
    while (entries[uid] !== undefined) uid++;
    return uid;
}

/** 人話標題：時光記憶｜故事日期 @地點｜一句話標題 */
function composeComment(item) {
    const bg = item.background || {};
    const typeNames = { event: '事件', summary: '摘要', location: '場景', character: '角色', item: '物品', relationship: '關係' };
    const when = [bg.storyDate, bg.storyTime].filter(Boolean).join(' ');
    const head = ['時光記憶', typeNames[item.summary?.type] || '', when, bg.location ? `@${bg.location}` : ''].filter(Boolean).join('｜');
    const t = item.entry.title ? item.entry.title.replace(/\s+/g, ' ').slice(0, 30) : '';
    return t ? `${head}｜${t}` : head;
}

/** 找既有條目（雙保險去重：extensions.hmg.summaryId 與頂層 hmg_summary_id 任一命中即算）。 */
function findExistingEntry(data, summaryId) {
    for (const uid of Object.keys(data.entries || {})) {
        const e = data.entries[uid];
        if (!e) continue;
        if (e.extensions?.hmg?.summaryId === summaryId || e.hmg_summary_id === summaryId) return e;
    }
    return null;
}

/**
 * 寫入前安全檢查：若目標書是 MemoryBooks 管理的書（含 stmemorybooks===true 條目），先警告並請使用者確認。
 * 書不存在（即將新建）視為安全。回傳 true=可繼續。
 */
async function ensureTargetBookSafe(bookName) {
    const ctx = getCtx();
    try {
        const names = ctx.getWorldInfoNames?.() || [];
        if (!names.includes(bookName)) return true; // 新書，安全
        const data = await ctx.loadWorldInfo(bookName);
        const entries = data?.entries ? Object.values(data.entries) : [];
        const managedByStmb = entries.some((e) => e?.stmemorybooks === true);
        if (!managedByStmb) return true;
        const go = await ctx.callGenericPopup(
            `世界書「${bookName}」看起來由 MemoryBooks 管理。建議另選一本書，避免兩邊互相覆蓋。仍要寫入嗎？`,
            ctx.POPUP_TYPE.CONFIRM, '', { okButton: '仍要寫入', cancelButton: '改選別本' },
        );
        return go === ctx.POPUP_RESULT.AFFIRMATIVE;
    } catch (err) {
        console.warn(LOG, 'ensureTargetBookSafe 檢查失敗（放行）：', err);
        return true; // 檢查本身失敗不應擋住主流程
    }
}

/** 用核心完整流程安全建書，回傳實際（已清理）書名；取消時回 null。 */
async function createBookSafely(requestedName) {
    const [{ createNewWorldInfo }, { getSanitizedFilename }] = await Promise.all([
        import('/scripts/world-info.js'),
        import('/scripts/utils.js'),
    ]);
    const bookName = String(await getSanitizedFilename(requestedName)).trim();
    if (!bookName) throw new Error('世界書名稱清理後為空，請換一個名稱');
    const created = await createNewWorldInfo(bookName, { interactive: true });
    return created ? bookName : null;
}

function deleteExistingEntry(data, summaryId) {
    for (const uid of Object.keys(data.entries || {})) {
        const entry = data.entries[uid];
        if (entry?.extensions?.hmg?.summaryId === summaryId || entry?.hmg_summary_id === summaryId) {
            delete data.entries[uid];
            return true;
        }
    }
    return false;
}

/** 在花 Sub API 費用前先排除來源未變與受人工修改保護的條目。 */
async function filterExistingCandidates(bookName, candidates) {
    const ctx = getCtx();
    const data = await ctx.loadWorldInfo(bookName);
    if (!data || typeof data !== 'object') throw new Error(`讀不到世界書「${bookName}」`);
    const ready = [];
    let unchanged = 0, protectedCount = 0;
    for (const candidate of candidates) {
        const { status } = classifyCandidateAgainstEntries(data.entries, candidate);
        if (status === 'new' || status === 'update' || status === 'delete') ready.push(candidate);
        else if (status === 'protected') protectedCount++;
        else unchanged++;
    }
    return { ready, unchanged, protectedCount };
}

/**
 * 批次 upsert 進目標世界書。items: [{ summary, entry:{title,content,keywords}, isConstant, order, background }]
 * 回傳 { created, updated, skipped }。skipped = 使用者手改過、為保護而跳過的條目。
 */
async function writeEntries(bookName, items) {
    const ctx = getCtx();
    if (!bookName) throw new Error('尚未選擇目標世界書');

    // 寫入流程不隱式建書：目標若被刪除或是舊版留下的未清理名稱，要求使用者重新選擇，避免空檔覆蓋撞名書籍。
    const names = ctx.getWorldInfoNames?.() || [];
    if (!names.includes(bookName)) throw new Error(`目標世界書「${bookName}」不存在，請重新選擇或安全新建`);

    let data = await ctx.loadWorldInfo(bookName);
    if (!data || typeof data !== 'object') throw new Error(`讀不到世界書「${bookName}」`);
    if (!data.entries || typeof data.entries !== 'object') data.entries = {};

    const existingHmgCount = Object.values(data.entries).filter((entry) =>
        entry?.extensions?.hmg?.summaryId || entry?.hmg_summary_id).length;
    const newCount = items.filter((item) => item.summary.action !== 'delete' && !findExistingEntry(data, item.summary.id)).length;
    const totalLimit = getSettings().maxTotalEntries;
    if (existingHmgCount + newCount > totalLimit) {
        throw new Error(`寫入後會有 ${existingHmgCount + newCount} 條 hmg 記憶，超過全書上限 ${totalLimit}；請減少勾選或調高上限`);
    }

    let created = 0, updated = 0, deleted = 0;
    const skipped = [];
    for (const item of items) {
        const summaryId = item.summary.id;
        if (item.summary.action === 'delete') {
            const existing = findExistingEntry(data, summaryId);
            if (!existing) continue;
            if (shouldProtectExistingEntry(existing)) {
                skipped.push(existing.comment || summaryId);
                continue;
            }
            if (deleteExistingEntry(data, summaryId)) deleted++;
            continue;
        }
        const content = neutralizeMacros(item.entry.content);
        const comment = composeComment(item);
        const key = (item.entry.keywords || []).slice(0, 8);
        // 最終防線：無關鍵字的條目一律常駐，否則綠燈掃不到、藍燈又沒設＝永遠不觸發的死條目
        //（涵蓋使用者在確認畫面把關鍵字清空的情況）。
        const isConstant = item.isConstant || key.length === 0;
        const ignoreBudget = isConstant && key.length > 0;

        let e = findExistingEntry(data, summaryId);
        if (e) {
            // 完整保護 content/comment/key；舊版缺 entryHash 時也保守跳過，避免把「無法判斷」當成「未手改」。
            if (shouldProtectExistingEntry(e)) {
                skipped.push(e.comment || summaryId);
                continue;
            }
            // 就地覆寫（保留 uid）。核心欄位一律重設為硬原則值，避免舊條目殘留錯設定（PLAN §3/§8）。
            e.content = content;
            e.comment = comment;
            e.key = key;
            e.constant = isConstant;
            e.vectorized = false;
            e.selective = true;
            e.position = 0;
            e.order = item.order;
            e.probability = 100;
            e.useProbability = true;
            e.preventRecursion = true;
            e.ignoreBudget = ignoreBudget;
            e.disable = false;
            stampMarker(e, summaryId, item);
            updated++;
        } else {
            const uid = freeUid(data);
            e = { uid, ...structuredClone(WI_ENTRY_TEMPLATE) };
            e.content = content;
            e.comment = comment;
            e.key = key;
            e.constant = isConstant;
            e.vectorized = false;     // 硬原則：不靠向量
            e.selective = true;
            e.position = 0;           // 背景區，與 Horae 末尾現況錯開
            e.order = item.order;
            e.probability = 100;
            e.useProbability = true;
            e.preventRecursion = true;
            e.ignoreBudget = ignoreBudget;
            stampMarker(e, summaryId, item);
            data.entries[uid] = e;
            created++;
        }
    }

    // 每批寫入後全域重整，避免每跑一批就多留一批 constant/ignoreBudget。
    rebalanceHmgConstants(data.entries, getSettings().constantCount);

    await ctx.saveWorldInfo(bookName, data, true); // immediately=true，整批唯一落盤點
    try { await Promise.resolve(ctx.reloadWorldInfoEditor?.(bookName)); } catch { /* ignore */ }
    return { created, updated, deleted, skipped };
}

/** 打上 hmg 標記（同時放 extensions.hmg 與頂層，哪個能 save→load 存活都行）。
 *  entryHash 涵蓋 content/comment/key，供下次重跑偵測人工修改；contentHash 留作舊版相容資訊。 */
function stampMarker(entry, summaryId, item) {
    entry.extensions = entry.extensions || {};
    entry.extensions.hmg = {
        source: 'horae',
        summaryId,
        version: HMG_VERSION,
        contentHash: stableHash(String(entry.content ?? '')),
        entryHash: entryFingerprint(entry),
        sourceOrder: Number.isFinite(Number(item.summary?.sourceOrder)) ? Number(item.summary.sourceOrder) : -1,
        sourceHash: item.summary?.sourceHash || '',
        sourceType: item.summary?.type || 'summary',
        entityKey: item.summary?.entityKey || '',
        storyDate: item.background?.storyDate || '',
        location: item.background?.location || '',
    };
    entry.hmg_source = 'horae';
    entry.hmg_summary_id = summaryId;
}

// ---------------------------------------------------------------------------
// 主流程：預覽式批次畢業（USER 框範圍 → Sub API → 逐條確認 → 寫入）
// ---------------------------------------------------------------------------

let currentAbort = null; // 進行中的 Sub API 整理可被取消

async function runGraduateFlow() {
    const ctx = getCtx();
    if (!ctx) { toast('error', '拿不到 SillyTavern context'); return; }
    const s = getSettings();
    if (!s.enabled) { toast('warning', '本擴充目前是停用狀態（面板可開啟）'); return; }

    if (!horaeAvailable()) {
        toast('warning', '這個聊天讀不到任何 Horae 記憶。請在有跑 Horae 的聊天裡使用。');
        return;
    }

    const summaries = getGraduatableSummaries();
    if (!summaries.length) {
        toast('info', '目前沒有可畢業的 Horae 重要事件或永久資料。這不要求開啟自動摘要。');
        return;
    }

    // 目標書必須先選；若目標書是 MemoryBooks 管理的書，先警告再確認（PLAN §12b）
    if (!s.targetBook) { toast('warning', '請先在面板選一本目標世界書（或按 ＋ 新建一本）。'); return; }
    if (!(await ensureTargetBookSafe(s.targetBook))) return;

    let candidates = summaries;
    try {
        const filtered = await filterExistingCandidates(s.targetBook, summaries);
        candidates = filtered.ready;
        if (filtered.unchanged || filtered.protectedCount) {
            toast('info', `已略過 ${filtered.unchanged} 筆來源未變、${filtered.protectedCount} 筆受人工修改保護的記憶，不會重複呼叫 Sub API。`);
        }
    } catch (err) {
        toast('error', `預檢目標世界書失敗：${err?.message || err}`);
        return;
    }
    if (!candidates.length) {
        toast('info', '可畢業資料都已是最新或受人工修改保護，這次不需處理。');
        return;
    }

    // 步驟一：選擇要畢業哪些（歷史事件排前、永久實體排後；上限 maxEntries）
    const picked = await pickSummariesPopup(candidates, s);
    if (!picked || !picked.length) return;

    // 步驟二：整理（Sub API 開啟且有設定檔才走整理，否則省錢模式原文照搬）
    const useSubApi = s.subApiEnabled && !!s.connectionProfileId;
    if (s.subApiEnabled && !s.connectionProfileId) {
        toast('warning', 'Sub API 已開啟但還沒選連線設定檔 → 這次先用「省錢模式」原文照搬。');
    }

    currentAbort?.abort?.();
    currentAbort = new AbortController();
    const signal = currentAbort.signal;

    // 進度 toast：保留 span 參照自己更新文字（對照 vectors/index.js 的進度 toast 寫法），
    // 不要對 toastr.info 的回傳值呼叫 .find()。
    const progressBody = $('<span>').text(`整理中 0/${picked.length}…`);
    const progress = globalThis.toastr?.info?.(
        progressBody, '', { timeOut: 0, extendedTimeOut: 0, closeButton: false, escapeHtml: false },
    );
    const setProgress = (n) => { try { progressBody.text(`整理中 ${n}/${picked.length}…`); } catch { /* ignore */ } };

    const items = [];
    let done = 0, fallbackCount = 0;
    try {
        for (const summary of picked) {
            if (signal.aborted) break;
            let entry, fallback = false;
            if (summary.action === 'delete') {
                entry = { title: `刪除 ${summary.entityKey}`, content: summary.summaryText, keywords: summary.defaultKeywords || [] };
            } else if (useSubApi) {
                try {
                    entry = await callSubApi(summary, s.connectionProfileId, signal);
                    if (!entry.keywords?.length && summary.defaultKeywords?.length) {
                        entry.keywords = summary.defaultKeywords.slice(0, 8);
                    }
                } catch (err) {
                    if (signal.aborted) break;
                    console.warn(LOG, 'Sub API 整理失敗，這條改用原文照搬：', err);
                    entry = passthroughEntry(summary);
                    fallback = true;
                    fallbackCount++;
                }
            } else {
                entry = passthroughEntry(summary);
            }
            items.push({ summary, entry, background: summary.background, fallback });
            setProgress(++done);
        }
    } finally {
        try { globalThis.toastr?.clear?.(progress); } catch { /* ignore */ }
    }

    if (signal.aborted) { toast('info', '已取消整理'); return; }
    if (!items.length) { toast('warning', '沒有可寫入的條目'); return; }
    if (fallbackCount > 0) {
        toast('warning', `有 ${fallbackCount} 條 Sub API 整理失敗，已改用原文照搬與 Horae 基礎關鍵字。可在下一步確認畫面檢視。`);
    }

    // 標記藍燈：最新的 constantCount 條設常駐；沒有關鍵字的條目若不常駐就永遠掃不到，
    // 因此仍設 constant，但不讓它們無上限 ignoreBudget。
    const constantCount = useSubApi ? Math.max(0, Number(s.constantCount) || 0) : items.length;
    items.forEach((it, i) => {
        const rankFromNewest = items.length - 1 - i; // 0 = 最新
        const noKeywords = !(it.entry.keywords && it.entry.keywords.length);
        it.isConstant = (rankFromNewest < constantCount) || noKeywords;
        it.order = 100 + i; // 越舊 order 越小（預算溢出時先砍舊的）
    });

    // 步驟三：逐條確認
    const confirmed = await confirmEntriesPopup(items, s, useSubApi);
    if (!confirmed || !confirmed.length) return;

    // 步驟四：寫入
    try {
        const { created, updated, deleted, skipped } = await writeEntries(s.targetBook, confirmed);
        let msg = `已寫入世界書「${s.targetBook}」：新增 ${created} 條、更新 ${updated} 條、刪除 ${deleted} 條。`;
        if (skipped && skipped.length) {
            msg += ` 另有 ${skipped.length} 條因為可能手動改過或來自舊版、為避免蓋掉而跳過。`;
        }
        toast('success', msg);
        refreshBookSelect();
    } catch (err) {
        console.error(LOG, '寫入失敗：', err);
        toast('error', `寫入失敗：${err?.message || err}`);
    }
}

/** 省錢模式：原文照搬，並沿用 Horae 已知的人名／地點／實體名作基礎關鍵字。 */
function passthroughEntry(summary) {
    const bg = summary.background || {};
    const firstLine = summary.summaryText.split(/[\n。.!?！？]/)[0].slice(0, 30);
    return {
        title: firstLine || (bg.location || '歷史片段'),
        content: summary.summaryText,
        keywords: Array.isArray(summary.defaultKeywords) ? summary.defaultKeywords.slice(0, 8) : [],
    };
}

// ---------------------------------------------------------------------------
// 彈窗 UI（用 ST Popup，原生 <dialog> top layer，不受手機 transform 坑影響）
// ---------------------------------------------------------------------------

/** 步驟一：勾選要畢業的摘要。回傳被勾選的 summary 陣列（最多 maxEntries 條）。 */
async function pickSummariesPopup(summaries, s) {
    const ctx = getCtx();
    const maxEntries = Math.max(1, Number(s.maxEntries) || 12);
    const oldestN = Math.max(0, Number(s.oldestN) || 0);

    const wrap = document.createElement('div');
    wrap.className = 'hmg-popup';
    const intro = document.createElement('div');
    intro.className = 'hmg-intro';
    const counts = countHoraeCandidateTypes(summaries);
    const countText = [
        counts.event ? `重要事件 ${counts.event}` : '', counts.summary ? `壓縮摘要 ${counts.summary}` : '',
        counts.location ? `永久場景 ${counts.location}` : '', counts.character ? `角色 ${counts.character}` : '',
        counts.item ? `重要物品 ${counts.item}` : '', counts.relationship ? `關係 ${counts.relationship}` : '',
    ].filter(Boolean).join('、');
    intro.textContent = `共 ${summaries.length} 條可畢業資料（${countText}）。預設勾選前 ${oldestN} 條（單次上限 ${maxEntries} 條）：`;
    wrap.appendChild(intro);

    const listEl = document.createElement('div');
    listEl.className = 'hmg-list';
    summaries.forEach((sum, i) => {
        const row = document.createElement('label');
        row.className = 'hmg-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'hmg-pick';
        cb.dataset.idx = String(i);
        cb.checked = i < oldestN && i < maxEntries;
        const body = document.createElement('div');
        body.className = 'hmg-row-body';
        const head = document.createElement('div');
        head.className = 'hmg-row-head';
        const bg = sum.background || {};
        const typeNames = { event: '重要事件', summary: '壓縮摘要', location: '永久場景', character: '角色資料', item: '重要物品', relationship: '關係資料' };
        const where = [bg.storyDate, bg.location ? `@${bg.location}` : ''].filter(Boolean).join(' ');
        const distance = sum.maxIdx >= 0 ? `　·　距聊天底部約 ${sum.distanceFromBottom} 樓` : '';
        head.textContent = `${typeNames[sum.type] || '記憶'}｜${sum.importance || ''}${where ? `　·　${where}` : ''}${distance}`;
        const prev = document.createElement('div');
        prev.className = 'hmg-row-prev';
        prev.textContent = sum.summaryText.slice(0, 140) + (sum.summaryText.length > 140 ? '…' : '');
        body.appendChild(head);
        body.appendChild(prev);
        row.appendChild(cb);
        row.appendChild(body);
        listEl.appendChild(row);
    });
    wrap.appendChild(listEl);

    const result = await ctx.callGenericPopup(wrap, ctx.POPUP_TYPE.CONFIRM, '', {
        okButton: '下一步：整理', cancelButton: '取消',
        wide: true, large: true, allowVerticalScrolling: true,
    });
    if (result !== ctx.POPUP_RESULT.AFFIRMATIVE) return null;

    const chosen = [];
    listEl.querySelectorAll('input.hmg-pick:checked').forEach((cb) => {
        chosen.push(summaries[Number(cb.dataset.idx)]);
    });
    if (chosen.length > maxEntries) {
        toast('warning', `一次最多 ${maxEntries} 條，只取排序最前的 ${maxEntries} 條。`);
        return chosen.slice(0, maxEntries);
    }
    return chosen;
}

/** 步驟三：逐條確認整理結果（可逐條取消勾選、可改標題/內容）。回傳要寫入的 items。 */
async function confirmEntriesPopup(items, s, useSubApi) {
    const ctx = getCtx();
    const wrap = document.createElement('div');
    wrap.className = 'hmg-popup';
    const intro = document.createElement('div');
    intro.className = 'hmg-intro';
    intro.textContent = useSubApi
        ? `Sub API 整理完成，共 ${items.length} 條。確認/修改後寫入世界書「${s.targetBook || '（未選）'}」；有關鍵字條目的藍燈會在寫入時依全書最新 N 條重整：`
        : `省錢模式（原文照搬）共 ${items.length} 條。確認後寫入世界書「${s.targetBook || '（未選）'}」：`;
    wrap.appendChild(intro);

    const listEl = document.createElement('div');
    listEl.className = 'hmg-list';
    items.forEach((it, i) => {
        const card = document.createElement('div');
        card.className = 'hmg-card';

        const top = document.createElement('label');
        top.className = 'hmg-card-top';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'hmg-confirm';
        cb.dataset.idx = String(i);
        cb.checked = true;
        const badge = document.createElement('span');
        badge.className = 'hmg-badge';
        const noKeywords = !(it.entry.keywords && it.entry.keywords.length);
        badge.textContent = it.summary.action === 'delete'
            ? '來源已刪除：確認後移除世界書條目'
            : (noKeywords ? '藍燈常駐' : (it.isConstant ? '藍燈候選' : '關鍵字觸發'));
        top.appendChild(cb);
        top.appendChild(badge);
        card.appendChild(top);

        const tLabel = document.createElement('div'); tLabel.className = 'hmg-flabel'; tLabel.textContent = '標題';
        const tIn = document.createElement('input');
        tIn.type = 'text'; tIn.className = 'text_pole hmg-title'; tIn.value = it.entry.title || '';
        const cLabel = document.createElement('div'); cLabel.className = 'hmg-flabel'; cLabel.textContent = '內容';
        const cIn = document.createElement('textarea');
        cIn.className = 'text_pole hmg-content'; cIn.rows = 4; cIn.value = it.entry.content || '';
        const kLabel = document.createElement('div'); kLabel.className = 'hmg-flabel'; kLabel.textContent = '關鍵字（逗號分隔）';
        const kIn = document.createElement('input');
        kIn.type = 'text'; kIn.className = 'text_pole hmg-keys'; kIn.value = (it.entry.keywords || []).join('、');

        card.appendChild(tLabel); card.appendChild(tIn);
        card.appendChild(cLabel); card.appendChild(cIn);
        card.appendChild(kLabel); card.appendChild(kIn);
        listEl.appendChild(card);
    });
    wrap.appendChild(listEl);

    const result = await ctx.callGenericPopup(wrap, ctx.POPUP_TYPE.CONFIRM, '', {
        okButton: '寫入世界書', cancelButton: '取消',
        wide: true, large: true, allowVerticalScrolling: true,
    });
    if (result !== ctx.POPUP_RESULT.AFFIRMATIVE) return null;

    const out = [];
    listEl.querySelectorAll('.hmg-card').forEach((card, i) => {
        const cb = card.querySelector('input.hmg-confirm');
        if (!cb?.checked) return;
        const it = items[i];
        it.entry.title = card.querySelector('.hmg-title')?.value?.trim() || it.entry.title;
        it.entry.content = card.querySelector('.hmg-content')?.value?.trim() || it.entry.content;
        const rawKeys = card.querySelector('.hmg-keys')?.value || '';
        it.entry.keywords = rawKeys.split(/[，,、;；\n]/).map((k) => k.trim()).filter(Boolean).slice(0, 8);
        out.push(it);
    });
    if (!out.length) toast('warning', '沒有勾選任何條目');
    return out;
}

// ---------------------------------------------------------------------------
// 除錯：印出所有 Horae 候選 + save→load 往返驗證標記是否存活
// ---------------------------------------------------------------------------

async function runDebug() {
    const ctx = getCtx();
    if (!ctx) { toast('error', '拿不到 context'); return; }

    const list = getHoraeChat().flatMap((message) =>
        Array.isArray(message?.horae_meta?.autoSummaries) ? message.horae_meta.autoSummaries : []);
    const candidates = getGraduatableSummaries();
    console.log(`${LOG} === DEBUG ===`);
    console.log(`${LOG} Horae 可用：${horaeAvailable()}；候選統計：`, countHoraeCandidateTypes(candidates));
    console.log(`${LOG} autoSummaries 數量：${list.length}`);
    if (list.length) console.log(`${LOG} 第一條 autoSummaries 原貌：`, structuredClone(list[0]));
    console.log(`${LOG} 整理後可畢業清單：`, candidates);

    // save→load 往返：寫一條測試條目到目標書（或臨時書），看標記哪種存活
    const s = getSettings();
    const book = s.targetBook;
    if (!book) {
        toast('info', '已把 Horae 事件／摘要／永久資料候選印到 Console（F12）。設定目標世界書後可做 save→load 測試。');
        return;
    }
    try {
        const testId = `__hmg_debug__${list[0]?.id ?? 'x'}`;
        await writeEntries(book, [{
            summary: { id: testId },
            entry: { title: 'hmg 往返測試', content: '這是一條 hmg save→load 往返測試條目，可手動刪除。', keywords: ['hmg測試'] },
            background: {}, isConstant: false, order: 100,
        }]);
        // 強制重讀（清掉本地快取的方式：直接再 load 一次）
        const data = await ctx.loadWorldInfo(book);
        const found = data && data.entries ? Object.values(data.entries).find(
            (e) => e?.extensions?.hmg?.summaryId === testId || e?.hmg_summary_id === testId,
        ) : null;
        const ext = !!found?.extensions?.hmg;
        const top = found?.hmg_summary_id === testId;
        console.log(`${LOG} 往返結果：找到測試條目=${!!found}；extensions.hmg 存活=${ext}；頂層 hmg_summary_id 存活=${top}`, found);
        toast('success', `往返測試：extensions.hmg=${ext ? '存活' : '消失'}、頂層標記=${top ? '存活' : '消失'}（細節看 Console）。可到世界書手動刪除「hmg 往返測試」。`);
    } catch (err) {
        console.error(LOG, 'debug 往返失敗：', err);
        toast('error', `往返測試失敗：${err?.message || err}`);
    }
}

// ---------------------------------------------------------------------------
// 設定面板（以 JS 動態生成 inline-drawer，免 settings.html、不綁安裝資料夾名）
// ---------------------------------------------------------------------------

function buildPanel() {
    const s = getSettings();
    const drawer = document.createElement('div');
    drawer.id = `${MODULE_NAME}_settings`;
    drawer.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Horae 記憶畢業到世界書</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="${MODULE_NAME}_enabled">
                    <input id="${MODULE_NAME}_enabled" type="checkbox" />
                    <span>啟用本擴充</span>
                </label>

                <label class="checkbox_label" for="${MODULE_NAME}_subapi_enabled">
                    <input id="${MODULE_NAME}_subapi_enabled" type="checkbox" />
                    <span>用 Sub API 整理（關閉＝省錢模式，原文照搬）</span>
                </label>

                <label for="${MODULE_NAME}_profile">Sub API 連線設定檔</label>
                <select id="${MODULE_NAME}_profile" class="text_pole"></select>
                <small class="hmg-hint">在 ST 的「連線設定檔（Connection Profiles）」先存好整理用的便宜模型，這裡選它即可，不用重貼金鑰。</small>

                <label for="${MODULE_NAME}_book">目標世界書</label>
                <div class="hmg-inline">
                    <select id="${MODULE_NAME}_book" class="text_pole"></select>
                    <button id="${MODULE_NAME}_book_refresh" class="menu_button" title="重新整理清單"><i class="fa-solid fa-rotate"></i></button>
                    <button id="${MODULE_NAME}_book_new" class="menu_button" title="新建一本世界書"><i class="fa-solid fa-plus"></i></button>
                </div>
                <small class="hmg-hint">會用搬家功能換新對話的話，請選「角色 / 全域」世界書，別選單一聊天綁定書。</small>

                <div class="hmg-grid">
                    <div>
                        <label for="${MODULE_NAME}_oldestN">預設勾選前 N 條</label>
                        <input id="${MODULE_NAME}_oldestN" type="number" class="text_pole" min="0" max="50" />
                    </div>
                    <div>
                        <label for="${MODULE_NAME}_maxEntries">單次上限</label>
                        <input id="${MODULE_NAME}_maxEntries" type="number" class="text_pole" min="1" max="50" />
                    </div>
                    <div>
                        <label for="${MODULE_NAME}_maxTotalEntries">全書記憶上限</label>
                        <input id="${MODULE_NAME}_maxTotalEntries" type="number" class="text_pole" min="10" max="300" />
                    </div>
                    <div>
                        <label for="${MODULE_NAME}_minEventDistance">事件距底部至少 N 樓</label>
                        <input id="${MODULE_NAME}_minEventDistance" type="number" class="text_pole" min="0" max="1000" />
                    </div>
                    <div>
                        <label for="${MODULE_NAME}_constantCount">藍燈常駐條數</label>
                        <input id="${MODULE_NAME}_constantCount" type="number" class="text_pole" min="0" max="10" />
                    </div>
                </div>

                <hr />
                <div class="hmg-inline">
                    <button id="${MODULE_NAME}_graduate" class="menu_button menu_button_icon">
                        <i class="fa-solid fa-graduation-cap"></i><span>畢業歷史記憶到世界書</span>
                    </button>
                    <button id="${MODULE_NAME}_debug" class="menu_button" title="印出 Horae 可畢業候選並做 save→load 往返測試">除錯</button>
                </div>
                <div class="hmg-status" id="${MODULE_NAME}_status"></div>
            </div>
        </div>`;
    return drawer;
}

function refreshProfileSelect() {
    const s = getSettings();
    const sel = document.getElementById(`${MODULE_NAME}_profile`);
    if (!sel) return;
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = '（未選 / 省錢模式）';
    sel.appendChild(none);
    for (const p of getConnectionProfiles()) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || p.id; // 走 textContent，防使用者命名 XSS
        if (p.id === s.connectionProfileId) opt.selected = true;
        sel.appendChild(opt);
    }
}

function refreshBookSelect() {
    const ctx = getCtx();
    const s = getSettings();
    const sel = document.getElementById(`${MODULE_NAME}_book`);
    if (!sel) return;
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = '（請選擇）';
    sel.appendChild(none);
    const names = ctx?.getWorldInfoNames?.() || [];
    for (const n of names) {
        const opt = document.createElement('option');
        opt.value = n; opt.textContent = n;
        if (n === s.targetBook) opt.selected = true;
        sel.appendChild(opt);
    }
}

function updateStatus() {
    const el = document.getElementById(`${MODULE_NAME}_status`);
    if (!el) return;
    const caps = checkCapabilities(getCtx());
    const parts = [];
    parts.push(`Horae：${horaeAvailable() ? '可讀' : '此聊天讀不到'}`);
    if (horaeAvailable()) {
        const counts = countHoraeCandidateTypes(getGraduatableSummaries());
        const permanent = (counts.location || 0) + (counts.character || 0) + (counts.item || 0) + (counts.relationship || 0);
        parts.push(`候選：事件 ${counts.event || 0}／摘要 ${counts.summary || 0}／永久資料 ${permanent}`);
    }
    parts.push(`核心 API：${caps.ok ? '齊全' : '缺 ' + caps.missing.join('/')}`);
    el.textContent = parts.join('　·　');
}

function bindPanel() {
    const s = getSettings();

    const enabled = document.getElementById(`${MODULE_NAME}_enabled`);
    enabled.checked = !!s.enabled;
    enabled.addEventListener('change', () => { getSettings().enabled = enabled.checked; saveSettings(); });

    const subapi = document.getElementById(`${MODULE_NAME}_subapi_enabled`);
    subapi.checked = !!s.subApiEnabled;
    subapi.addEventListener('change', () => { getSettings().subApiEnabled = subapi.checked; saveSettings(); });

    const profile = document.getElementById(`${MODULE_NAME}_profile`);
    profile.addEventListener('change', () => { getSettings().connectionProfileId = profile.value; saveSettings(); });

    const book = document.getElementById(`${MODULE_NAME}_book`);
    book.addEventListener('change', () => { getSettings().targetBook = book.value; saveSettings(); });

    document.getElementById(`${MODULE_NAME}_book_refresh`).addEventListener('click', (e) => {
        e.preventDefault(); refreshBookSelect(); refreshProfileSelect(); updateStatus();
    });
    document.getElementById(`${MODULE_NAME}_book_new`).addEventListener('click', async (e) => {
        e.preventDefault();
        const ctx = getCtx();
        const name = await ctx.callGenericPopup('新世界書的名稱：', ctx.POPUP_TYPE.INPUT, '');
        if (typeof name !== 'string' || !name.trim()) return;
        try {
            const createdName = await createBookSafely(name.trim());
            if (!createdName) return;
            getSettings().targetBook = createdName; saveSettings();
            refreshBookSelect();
            toast('success', `已新建世界書「${createdName}」並設為目標`);
        } catch (err) { toast('error', `新建失敗：${err?.message || err}`); }
    });

    const numBind = (id, key) => {
        const el = document.getElementById(`${MODULE_NAME}_${id}`);
        el.value = s[key];
        el.addEventListener('change', () => {
            const { min, max } = integerSettingBounds[key];
            getSettings()[key] = normalizeIntegerSetting(el.value, defaultSettings[key], min, max);
            el.value = getSettings()[key]; // 非法輸入時把 UI 拉回有效值
            saveSettings();
        });
    };
    numBind('oldestN', 'oldestN');
    numBind('maxEntries', 'maxEntries');
    numBind('maxTotalEntries', 'maxTotalEntries');
    numBind('minEventDistance', 'minEventDistance');
    numBind('constantCount', 'constantCount');

    document.getElementById(`${MODULE_NAME}_graduate`).addEventListener('click', (e) => { e.preventDefault(); runGraduateFlow(); });
    document.getElementById(`${MODULE_NAME}_debug`).addEventListener('click', (e) => { e.preventDefault(); runDebug(); });
}

// ---------------------------------------------------------------------------
// Slash 指令
// ---------------------------------------------------------------------------

function registerSlash(ctx) {
    const { SlashCommandParser, SlashCommand } = ctx;
    if (!SlashCommandParser || !SlashCommand) return;
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'hmg-graduate',
            helpString: '<div>打開預覽流程（選重要事件／永久資料 → 整理 → 確認 → 寫入）。</div>',
            callback: () => { runGraduateFlow(); return ''; },
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'hmg-debug',
            helpString: '<div>印出 Horae 可畢業候選並做世界書 save→load 往返測試（結果看 Console / F12）。</div>',
            callback: () => { runDebug(); return ''; },
        }));
    } catch (err) {
        console.warn(LOG, 'slash 註冊失敗（可能重複載入）：', err);
    }
}

// ---------------------------------------------------------------------------
// 生命週期 hooks（manifest: activate→init / disable→onDisable）
// ---------------------------------------------------------------------------

export async function init() {
    const ctx = getCtx();
    if (!ctx) { console.error(LOG, 'SillyTavern.getContext() 不可用，放棄初始化'); return; }

    const caps = checkCapabilities(ctx);
    if (!caps.ok) {
        console.error(LOG, '缺少核心 context 函式：', caps.missing);
        toast('error', `本擴充需要的 ST API 缺少：${caps.missing.join('、')}（可能 ST 版本太舊）`);
        // 仍掛面板讓使用者看到狀態，但功能會降級
    }

    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) { console.error(LOG, '找不到設定容器'); return; }

    // 面板骨架是寫死的靜態字串，僅插值 MODULE_NAME（開發者常數），安全。
    host.appendChild(buildPanel());
    refreshProfileSelect();
    refreshBookSelect();
    bindPanel();
    updateStatus();

    // 切聊天時刷新狀態（Horae 可讀性、目標書）
    try { ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, onChatChanged); } catch { /* ignore */ }

    registerSlash(ctx);
    console.log(`${LOG} 初始化完成 v${HMG_VERSION}`);
}

function onChatChanged() {
    updateStatus();
}

export async function onDisable() {
    try { currentAbort?.abort?.(); } catch { /* ignore */ }
    const ctx = getCtx();
    try { ctx?.eventSource?.removeListener?.(ctx.eventTypes.CHAT_CHANGED, onChatChanged); } catch { /* ignore */ }
    const panel = document.getElementById(`${MODULE_NAME}_settings`);
    if (panel) panel.remove();
    console.log(`${LOG} 已停用、清理完成`);
}
