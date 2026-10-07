// Node 冒烟测试的浏览器 API 垫片；必须在 import store 之前先加载
const g = globalThis as Record<string, unknown>;
if (!g.localStorage) {
  const mem: Record<string, string> = {};
  g.localStorage = {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => { mem[k] = String(v); },
    removeItem: (k: string) => { delete mem[k]; }
  };
}
const cryptoObj = g.crypto as { randomUUID?: () => string } | undefined;
if (!cryptoObj?.randomUUID) {
  g.crypto = { randomUUID: () => `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}` };
}
export {};
