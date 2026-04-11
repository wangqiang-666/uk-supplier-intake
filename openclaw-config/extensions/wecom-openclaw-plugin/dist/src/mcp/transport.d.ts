/**
 * MCP Streamable HTTP 传输层模块
 *
 * 负责:
 * - MCP JSON-RPC over HTTP 通信（发送请求、解析响应）
 * - Streamable HTTP session 生命周期管理（initialize 握手 → Mcp-Session-Id 维护 → 失效重建）
 * - 自动检测无状态 Server：如果 initialize 响应未返回 Mcp-Session-Id，
 *   则标记为无状态模式，后续请求跳过握手和 session 管理
 * - SSE 流式响应解析
 * - MCP 配置运行时缓存（通过 WSClient 拉取 URL 并缓存在内存中）
 */
/** 媒体下载请求超时时间（毫秒），base64 编码的媒体文件最大可达 ~27MB */
export declare const MEDIA_DOWNLOAD_TIMEOUT_MS = 120000;
/**
 * MCP JSON-RPC 错误
 *
 * 携带服务端返回的 JSON-RPC error.code，
 * 用于上层按错误码进行差异化处理（如特定错误码触发缓存清理）。
 */
export declare class McpRpcError extends Error {
    readonly code: number;
    readonly data?: unknown | undefined;
    constructor(code: number, message: string, data?: unknown | undefined);
}
/**
 * MCP HTTP 错误
 *
 * 携带 HTTP 状态码，用于精确判断 session 失效（404）等场景，
 * 避免通过字符串匹配 "404" 导致的误判。
 */
export declare class McpHttpError extends Error {
    readonly statusCode: number;
    constructor(statusCode: number, message: string);
}
/**
 * 清理指定品类的所有 MCP 缓存（配置、会话、无状态标记）
 *
 * 当 MCP Server 返回特定错误码时调用，确保下次请求重新拉取配置并重建会话。
 *
 * @param category - MCP 品类名称
 */
export declare function clearCategoryCache(category: string): void;
/** tools/list 返回的工具描述 */
export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}
/** sendJsonRpc 的可选配置 */
export interface SendJsonRpcOptions {
    /** 自定义 HTTP 请求超时时间（毫秒），默认使用 HTTP_REQUEST_TIMEOUT_MS */
    timeoutMs?: number;
}
/**
 * 发送 JSON-RPC 请求到 MCP Server（Streamable HTTP 协议）
 *
 * 自动管理 session 生命周期：
 * - 无状态 Server：跳过 session 管理，直接发送请求
 * - 有状态 Server：首次调用先执行 initialize 握手，session 失效（404）时自动重建并重试
 *
 * @param category - MCP 品类名称
 * @param method - JSON-RPC 方法名
 * @param params - JSON-RPC 参数
 * @param options - 可选配置（如自定义超时）
 * @returns JSON-RPC result
 */
export declare function sendJsonRpc(category: string, method: string, params?: Record<string, unknown>, options?: SendJsonRpcOptions): Promise<unknown>;
