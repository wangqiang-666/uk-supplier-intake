const axios = require("axios");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, { headers = {}, timeoutMs = 30000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, {
        headers,
        timeout: timeoutMs,
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 300) return res.data;
      const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
      throw new Error(`[http] ${res.status} ${res.statusText} for ${url}\n${body}`);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

module.exports = { fetchJson };

