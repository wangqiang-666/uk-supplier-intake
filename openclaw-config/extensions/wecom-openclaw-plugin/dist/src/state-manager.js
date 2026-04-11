/**
 * 企业微信全局状态管理模块
 *
 * 负责管理 WSClient 实例、消息状态（带 TTL 清理）、ReqId 存储
 * 解决全局 Map 的内存泄漏问题
 */
import { createPersistentReqIdStore } from "./reqid-store.js";
import { MESSAGE_STATE_TTL_MS, MESSAGE_STATE_CLEANUP_INTERVAL_MS, MESSAGE_STATE_MAX_SIZE, } from "./const.js";
// ============================================================================
// WSClient 实例管理
// ============================================================================
/** WSClient 实例管理 */
const wsClientInstances = new Map();
/**
 * 获取指定账户的 WSClient 实例
 */
export function getWeComWebSocket(accountId) {
    return wsClientInstances.get(accountId) ?? null;
}
/**
 * 设置指定账户的 WSClient 实例
 */
export function setWeComWebSocket(accountId, client) {
    wsClientInstances.set(accountId, client);
}
/**
 * 删除指定账户的 WSClient 实例
 */
export function deleteWeComWebSocket(accountId) {
    wsClientInstances.delete(accountId);
}
/** 消息状态管理 */
const messageStates = new Map();
/** 定期清理定时器 */
let cleanupTimer = null;
/**
 * 启动消息状态定期清理（自动 TTL 清理 + 容量限制）
 */
export function startMessageStateCleanup() {
    if (cleanupTimer)
        return;
    cleanupTimer = setInterval(() => {
        pruneMessageStates();
    }, MESSAGE_STATE_CLEANUP_INTERVAL_MS);
    // 允许进程退出时不阻塞
    if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
        cleanupTimer.unref();
    }
}
/**
 * 停止消息状态定期清理
 */
export function stopMessageStateCleanup() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}
/**
 * 清理过期和超量的消息状态条目
 */
function pruneMessageStates() {
    const now = Date.now();
    // 1. 清理过期条目
    for (const [key, entry] of messageStates) {
        if (now - entry.createdAt >= MESSAGE_STATE_TTL_MS) {
            messageStates.delete(key);
        }
    }
    // 2. 容量限制：如果仍超过最大条目数，按时间淘汰最旧的
    if (messageStates.size > MESSAGE_STATE_MAX_SIZE) {
        const sorted = [...messageStates.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
        const toRemove = sorted.slice(0, messageStates.size - MESSAGE_STATE_MAX_SIZE);
        for (const [key] of toRemove) {
            messageStates.delete(key);
        }
    }
}
/**
 * 设置消息状态
 */
export function setMessageState(messageId, state) {
    messageStates.set(messageId, {
        state,
        createdAt: Date.now(),
    });
}
/**
 * 获取消息状态
 */
export function getMessageState(messageId) {
    const entry = messageStates.get(messageId);
    if (!entry)
        return undefined;
    // 检查 TTL
    if (Date.now() - entry.createdAt >= MESSAGE_STATE_TTL_MS) {
        messageStates.delete(messageId);
        return undefined;
    }
    return entry.state;
}
/**
 * 删除消息状态
 */
export function deleteMessageState(messageId) {
    messageStates.delete(messageId);
}
/**
 * 清空所有消息状态
 */
export function clearAllMessageStates() {
    messageStates.clear();
}
// ============================================================================
// ReqId 持久化存储管理（按 accountId 隔离）
// ============================================================================
/**
 * ReqId 持久化存储管理
 * 参考 createPersistentDedupe 模式：内存 + 磁盘双层、文件锁、原子写入、TTL 过期、防抖写入
 * 重启后可从磁盘恢复，确保主动推送消息时能获取到 reqId
 */
const reqIdStores = new Map();
function getOrCreateReqIdStore(accountId) {
    let store = reqIdStores.get(accountId);
    if (!store) {
        store = createPersistentReqIdStore(accountId);
        reqIdStores.set(accountId, store);
    }
    return store;
}
// ============================================================================
// ReqId 操作函数
// ============================================================================
/**
 * 设置 chatId 对应的 reqId（写入内存 + 防抖写磁盘）
 */
export function setReqIdForChat(chatId, reqId, accountId = "default") {
    getOrCreateReqIdStore(accountId).set(chatId, reqId);
}
/**
 * 获取 chatId 对应的 reqId（异步：优先内存，miss 时查磁盘并回填内存）
 */
export async function getReqIdForChatAsync(chatId, accountId = "default") {
    return getOrCreateReqIdStore(accountId).get(chatId);
}
/**
 * 获取 chatId 对应的 reqId（同步：仅内存，保留向后兼容）
 */
export function getReqIdForChat(chatId, accountId = "default") {
    return getOrCreateReqIdStore(accountId).getSync(chatId);
}
/**
 * 删除 chatId 对应的 reqId
 */
export function deleteReqIdForChat(chatId, accountId = "default") {
    getOrCreateReqIdStore(accountId).delete(chatId);
}
/**
 * 启动时预热 reqId 缓存（从磁盘加载到内存）
 *
 * 注意：由于移除了磁盘存储，此函数现在只返回 0（无预热条目）
 */
export async function warmupReqIdStore(accountId = "default", log) {
    // 由于移除了磁盘存储，不再需要预热过程
    log?.("[WeCom] reqid-store warmup: no-op (disk storage removed)");
    return 0;
}
/**
 * 立即将 reqId 数据刷写到磁盘（用于优雅退出）
 *
 * 注意：由于移除了磁盘存储，此函数现在是无操作
 */
export async function flushReqIdStore(accountId = "default") {
    // 由于移除了磁盘存储，不再需要刷写操作
}
// ============================================================================
// 全局 cleanup（断开连接时释放所有资源）
// ============================================================================
/**
 * 清理指定账户的所有资源
 */
export async function cleanupAccount(accountId) {
    // 1. 断开 WSClient
    const wsClient = wsClientInstances.get(accountId);
    if (wsClient) {
        try {
            wsClient.disconnect();
        }
        catch {
            // 忽略断开连接时的错误
        }
        wsClientInstances.delete(accountId);
    }
    // 2. 由于移除了磁盘存储，不再需要 flush reqId 存储
    // 注意：不删除 store，因为重连后可能还需要
}
/**
 * 清理所有资源（用于进程退出）
 */
export async function cleanupAll() {
    // 停止定期清理
    stopMessageStateCleanup();
    // 清理所有 WSClient
    for (const [accountId, wsClient] of wsClientInstances) {
        try {
            wsClient.disconnect();
        }
        catch {
            // 忽略
        }
    }
    wsClientInstances.clear();
    // 由于移除了磁盘存储，不再需要 flush 所有 reqId 存储
    // 清空消息状态
    clearAllMessageStates();
}
