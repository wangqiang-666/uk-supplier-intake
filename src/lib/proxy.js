const axios = require("axios");
const fs = require("fs");
const path = require("path");

const PROXY_CACHE_FILE = path.join(__dirname, "../../data/proxy-cache.json");

/**
 * 免费代理 IP 获取器
 *
 * 支持多个免费代理源
 */

// 从多个免费代理源获取代理列表
async function fetchFreeProxies() {
  const proxies = [];

  // 源 1: ProxyScrape
  try {
    const response = await axios.get("https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all", {
      timeout: 10000,
    });
    const lines = response.data.split("\n").filter(Boolean);
    lines.forEach(line => {
      if (line.includes(":")) {
        proxies.push(`http://${line.trim()}`);
      }
    });
    console.log(`[Proxy] ProxyScrape: 获取 ${lines.length} 个代理`);
  } catch (e) {
    console.log(`[Proxy] ProxyScrape 失败:`, e.message);
  }

  // 源 2: Free-Proxy-List
  try {
    const response = await axios.get("https://www.proxy-list.download/api/v1/get?type=http", {
      timeout: 10000,
    });
    const lines = response.data.split("\n").filter(Boolean);
    lines.forEach(line => {
      if (line.includes(":")) {
        proxies.push(`http://${line.trim()}`);
      }
    });
    console.log(`[Proxy] Free-Proxy-List: 获取 ${lines.length} 个代理`);
  } catch (e) {
    console.log(`[Proxy] Free-Proxy-List 失败:`, e.message);
  }

  return [...new Set(proxies)]; // 去重
}

// 测试代理是否可用
async function testProxy(proxyUrl, timeout = 5000) {
  try {
    const response = await axios.get("https://httpbin.org/ip", {
      proxy: false,
      httpsAgent: new (require("https").Agent)({
        rejectUnauthorized: false,
      }),
      timeout,
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });
    return response.status === 200;
  } catch (e) {
    return false;
  }
}

// 获取一个可用的代理
async function getWorkingProxy() {
  console.log(`[Proxy] 正在获取可用代理...`);

  // 先尝试从缓存读取
  let cachedProxies = [];
  try {
    if (fs.existsSync(PROXY_CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(PROXY_CACHE_FILE, "utf8"));
      const cacheAge = Date.now() - cache.timestamp;
      if (cacheAge < 3600000) { // 1 小时内有效
        cachedProxies = cache.proxies || [];
        console.log(`[Proxy] 从缓存读取 ${cachedProxies.length} 个代理`);
      }
    }
  } catch (e) {
    // 忽略
  }

  // 如果缓存为空，获取新的
  let proxies = cachedProxies.length > 0 ? cachedProxies : await fetchFreeProxies();

  if (proxies.length === 0) {
    console.log(`[Proxy] 未找到可用代理，将不使用代理`);
    return null;
  }

  // 随机选择几个测试
  const testCount = Math.min(5, proxies.length);
  const shuffled = proxies.sort(() => 0.5 - Math.random());
  const toTest = shuffled.slice(0, testCount);

  console.log(`[Proxy] 测试 ${toTest.length} 个代理...`);

  for (const proxy of toTest) {
    console.log(`[Proxy] 测试: ${proxy}`);
    const works = await testProxy(proxy);
    if (works) {
      console.log(`[Proxy] ✓ 找到可用代理: ${proxy}`);

      // 保存到缓存
      try {
        const dir = path.dirname(PROXY_CACHE_FILE);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(PROXY_CACHE_FILE, JSON.stringify({
          timestamp: Date.now(),
          proxies: shuffled, // 保存所有代理
        }, null, 2));
      } catch (e) {
        // 忽略
      }

      return proxy;
    }
  }

  console.log(`[Proxy] 未找到可用代理，将不使用代理`);
  return null;
}

module.exports = {
  fetchFreeProxies,
  testProxy,
  getWorkingProxy,
};
