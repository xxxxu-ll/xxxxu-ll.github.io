// 世界服务客户端：身份、同步、聊天、存档
// 后端地址：本地开发走同源 /api；线上由 src/api-base.js 注入 Cloudflare Worker 地址。
import { API_BASE } from './api-base.js';

export const DEFAULT_API = 'https://yanyuan-world.yanyuan.workers.dev/api';

export function resolveApiBase() {
  const override = (typeof localStorage !== 'undefined' && localStorage.getItem('yanyuan.api')) || '';
  if (override) return override.replace(/\/+$/, '');
  if (API_BASE) return API_BASE.replace(/\/+$/, '');
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || location.protocol === 'file:') return '/api';
  return DEFAULT_API;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error', retryable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const REQUEST_TIMEOUT = 12000;

export class Api {
  constructor(base = resolveApiBase()) {
    this.base = base;
    this.token = null;
    this.online = false;
    this.lastError = null;
  }

  setToken(t) { this.token = t; }

  async _fetch(path, { method = 'POST', body = null, auth = true, timeout = REQUEST_TIMEOUT } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const headers = { 'Accept': 'application/json' };
    if (body !== null) headers['Content-Type'] = 'application/json';
    if (auth && this.token) headers['Authorization'] = 'Bearer ' + this.token;
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        cache: 'no-store',
        mode: 'cors',
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = e && e.name === 'AbortError';
      throw new ApiError(aborted ? '网络超时' : '无法连接世界服务', { code: aborted ? 'timeout' : 'network', retryable: true });
    }
    clearTimeout(timer);
    let data = null;
    const text = await res.text().catch(() => '');
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!res.ok) {
      const code = (data && data.error) || 'http_' + res.status;
      const msg = (data && data.message) || httpMessage(res.status);
      throw new ApiError(msg, { status: res.status, code, retryable: res.status >= 500 || res.status === 429 });
    }
    if (data === null) throw new ApiError('世界服务返回了无法解析的内容', { code: 'bad_json', retryable: true });
    return data;
  }

  health() { return this._fetch('/health', { method: 'GET', auth: false, timeout: 6000 }); }

  createPlayer(name, appearance, profile = {}) {
    return this._fetch('/players', { body: { name, appearance, profile }, auth: false });
  }

  session(token) {
    this.token = token;
    return this._fetch('/session', { body: {} });
  }

  sync({ x, y, dir, moving, mode, since }) {
    return this._fetch('/sync', { body: { x, y, dir, moving, mode, since }, timeout: 9000 });
  }

  chat(text) { return this._fetch('/chat', { body: { text } }); }

  saveProgress(progress) { return this._fetch('/progress', { body: { progress } }); }

  saveProfile(patch) { return this._fetch('/profile', { body: patch }); }
}

function httpMessage(status) {
  if (status === 401) return '身份已失效，请用恢复码重新登录';
  if (status === 403) return '没有权限访问这个角色';
  if (status === 409) return '这个昵称已经被占用了';
  if (status === 429) return '操作太频繁，请稍后再试';
  if (status >= 500) return '世界服务暂时不可用';
  return '请求失败（' + status + '）';
}

/** 带指数退避的重试封装，用于启动期的健康检查 */
export async function retry(fn, { tries = 4, base = 700, max = 5000, onRetry } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); } catch (e) {
      last = e;
      if (e instanceof ApiError && !e.retryable) throw e;
      if (i === tries - 1) break;
      const wait = Math.min(max, base * Math.pow(1.8, i));
      onRetry && onRetry(i + 1, wait, e);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last;
}
