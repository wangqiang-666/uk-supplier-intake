# Law Society 数据采集解决方案

## 问题分析

Law Society 网站 (https://solicitors.lawsociety.org.uk) 使用了 **Google reCAPTCHA Enterprise** 保护，这使得自动化爬取变得困难。

## 可行方案对比

### 方案 1：使用验证码解决服务（推荐）

**工具**: 2Captcha, Anti-Captcha, CapSolver 等

**优点**:
- 成功率高（90%+）
- 实现相对简单
- 稳定可靠

**缺点**:
- 需要付费（约 $1-3 / 1000 次验证）
- 每次验证需要 10-30 秒

**实现示例**:
```bash
npm install 2captcha
```

```javascript
const Captcha = require("2captcha");
const solver = new Captcha.Solver(process.env.CAPTCHA_API_KEY);

// 在爬虫中使用
const result = await solver.recaptcha({
  googlekey: '6LcL6zkrAAAAABu2p8Hpe_zhwyCFxKng3hZcvj5S',
  pageurl: 'https://solicitors.lawsociety.org.uk/search/results',
  enterprise: 1,
});

await page.evaluate((token) => {
  document.querySelector('.gtoken').value = token;
  document.querySelector('#captcha').submit();
}, result.data);
```

**成本估算**:
- 每天采集 1 次 = 每月约 $0.10
- 每天采集 10 次 = 每月约 $1.00

---

### 方案 2：使用 Puppeteer Stealth + 等待

**工具**: puppeteer-extra-plugin-stealth（已安装）

**优点**:
- 免费
- 已经实现基础框架

**缺点**:
- 成功率不稳定（30-70%）
- 可能被检测为机器人
- 需要较长等待时间

**当前状态**: 
- ✅ 已实现
- ⚠️ 需要测试成功率

---

### 方案 3：寻找替代数据源

**选项**:
1. **SRA API**（已实现）- 官方监管数据，最权威
2. **Companies House API** - 公司注册信息
3. **LinkedIn** - 律所信息（需要 API 或爬虫）
4. **Legal 500 / Chambers** - 律所排名网站

**推荐**: 
SRA API 已经提供了最全面的律师事务所数据，Law Society 的数据可能大部分重复。

---

### 方案 4：手动导出 + 自动化处理

**流程**:
1. 手动访问 Law Society 网站
2. 导出数据（如果有导出功能）
3. 使用脚本处理导出的文件

**优点**:
- 100% 成功率
- 无需绕过验证

**缺点**:
- 需要人工操作
- 更新频率受限

---

### 方案 5：使用代理 IP 池 + 浏览器指纹伪装

**工具**: 
- Bright Data / Oxylabs（住宅代理）
- FingerprintJS（指纹伪装）

**优点**:
- 可以绕过部分检测
- 适合大规模爬取

**缺点**:
- 成本较高（$50-500/月）
- 实现复杂
- 仍可能被 reCAPTCHA 拦截

---

## 推荐方案

### 短期（立即可用）
**继续使用 SRA API**
- 数据已经很全面
- 官方权威
- 免费且稳定

### 中期（如果确实需要 Law Society 数据）
**方案 1: 2Captcha + Puppeteer**
- 成本低（每月 $1-5）
- 实现简单
- 成功率高

### 长期（大规模采集）
**方案 1 + 方案 5 组合**
- 使用代理 IP 池
- 使用验证码解决服务
- 设置合理的请求频率

---

## 实现优先级

1. ✅ **SRA API** - 已完成，继续使用
2. ⏳ **测试当前 Puppeteer 方案** - 看看免费方案能否工作
3. 🔄 **如果免费方案失败，集成 2Captcha** - 成本低，效果好
4. 📊 **评估数据重复度** - 确认是否真的需要 Law Society 数据

---

## 下一步行动

1. 运行 `node debug-lawsociety.js` 查看当前方案是否能通过验证
2. 如果失败，决定是否投入 2Captcha（约 $3/月）
3. 如果不需要，继续使用 SRA API 即可

---

## 相关文件

- [src/sources/lawsociety.js](src/sources/lawsociety.js) - 爬虫实现
- [debug-lawsociety.js](debug-lawsociety.js) - 调试脚本
- [test-lawsociety.js](test-lawsociety.js) - 测试脚本
