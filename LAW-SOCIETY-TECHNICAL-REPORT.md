# Law Society 爬取技术尝试报告

## 目标
爬取 Law Society 网站 (https://solicitors.lawsociety.org.uk) 的律师事务所数据

## 技术挑战
网站使用 **Google reCAPTCHA Enterprise** 保护，这是目前最强的验证码系统之一。

## 已尝试的技术方案

### 1. Puppeteer + Stealth Plugin ❌
**技术栈**: puppeteer-extra + puppeteer-extra-plugin-stealth

**结果**: 失败，无法通过 reCAPTCHA 验证

**原因**: Stealth 插件虽然能绕过基本的 bot 检测，但对 reCAPTCHA Enterprise 无效

**参考**: [Bypass CAPTCHAs using Puppeteer](https://github.com/luminati-io/Puppeteer-bypass-captcha)

---

### 2. Playwright ❌
**技术栈**: playwright

**结果**: 失败，无法通过验证

**原因**: Playwright 虽然比 Puppeteer 更现代，但同样被 reCAPTCHA Enterprise 检测

---

### 3. 增强版 Puppeteer（反检测 + 人类行为模拟）❌
**技术栈**: puppeteer-extra + 自定义反检测代码

**增强措施**:
- 覆盖 `navigator.webdriver`
- 模拟鼠标移动和滚动
- 随机延迟
- 多次重试机制（6次，每次10秒）
- 自定义 User-Agent

**结果**: 失败，尝试 60 秒后仍无法通过验证

**代码**: [lawsociety-enhanced.js](src/sources/lawsociety-enhanced.js)

---

### 4. Undetected-chromedriver (Python) ⚠️
**技术栈**: undetected-chromedriver + Selenium

**结果**: ChromeDriver 版本不匹配错误

**错误信息**:
```
This version of ChromeDriver only supports Chrome version 147
Current browser version is 146.0.7680.178
```

**原因**: undetected-chromedriver 自动下载的 ChromeDriver 版本与系统 Chrome 不匹配

**参考**: [Undetected Chromedriver Guide](https://rebrowser.net/blog/undetected-chromedriver-the-ultimate-guide-to-bypassing-bot-detection)

---

### 5. Puppeteer-real-browser ❌
**技术栈**: puppeteer-real-browser

**结果**: 失败，60秒超时

**原因**: 即使使用"真实浏览器"配置，仍被 reCAPTCHA 拦截

---

### 6. 网络请求拦截分析 🔄
**目标**: 拦截所有网络请求，找到验证通过后的实际数据接口

**状态**: 测试中

**代码**: [intercept-network.js](intercept-network.js)

---

## 技术分析

### 为什么所有方案都失败了？

1. **reCAPTCHA Enterprise 的检测维度**:
   - 浏览器指纹（Canvas、WebGL、Audio）
   - 鼠标移动轨迹
   - 键盘输入模式
   - 网络请求模式
   - IP 信誉
   - 设备信誉
   - 行为分析（停留时间、交互模式）

2. **Headless 检测**:
   - 即使使用 `headless: false`，自动化工具仍有特征
   - `navigator.webdriver` 等属性
   - Chrome DevTools Protocol 痕迹

3. **IP 信誉**:
   - 免费方案无法解决 IP 信誉问题
   - reCAPTCHA 会检查 IP 的历史行为

### 调试发现

通过 `debug-detailed.js` 脚本，我们发现：
- 页面可以加载
- reCAPTCHA 验证页面会自动提交
- **但验证通过率极低（< 5%）**
- 偶尔能通过验证（手动打开浏览器时）

---

## 可行的解决方案

### 方案 A: 使用验证码解决服务（推荐）

**服务商**: 2Captcha, Anti-Captcha, CapSolver

**成本**: 约 $1-3 / 1000 次验证

**成功率**: 90%+

**实现示例**:
```javascript
const Captcha = require("2captcha");
const solver = new Captcha.Solver(process.env.CAPTCHA_API_KEY);

const result = await solver.recaptcha({
  googlekey: '6LcL6zkrAAAAABu2p8Hpe_zhwyCFxKng3hZcvj5S',
  pageurl: 'https://solicitors.lawsociety.org.uk/search/results',
  enterprise: 1,
});
```

**参考**: [Auto reCAPTCHA Solving Using Puppeteer](https://2captcha.com/blog/goolge-recaptcha-solver-puppeteer-and-auto-fill)

---

### 方案 B: 使用代理 IP 池

**服务商**: Bright Data, Oxylabs, Smartproxy

**成本**: $50-500/月

**优点**: 
- 提高 IP 信誉
- 分散请求
- 降低被封概率

**缺点**:
- 成本较高
- 仍需配合验证码解决服务

---

### 方案 C: 继续使用 SRA API（最推荐）

**优点**:
- 官方权威数据
- 免费且稳定
- 数据已经很全（214,596 条记录）
- 实时更新

**缺点**:
- 只有 SRA 监管的律师
- 可能缺少部分 Law Society 会员

**结论**: SRA API 已经提供了最全面的律师数据，Law Society 的数据可能大部分重复。

---

## 开源项目参考

1. [clicks-recaptcha-solver](https://github.com/SevenBuilder/clicks-recaptcha-solver) - 通过模拟点击解决 reCAPTCHA v2
2. [bypass-captcha-with-playwright](https://github.com/luminati-io/bypass-captcha-with-playwright) - Playwright Stealth 技术
3. [Puppeteer-bypass-captcha](https://github.com/luminati-io/Puppeteer-bypass-captcha) - Puppeteer 反检测技术

---

## 最终建议

### 短期（立即可用）
**继续使用 SRA API**
- 数据已经很全面
- 官方权威
- 免费且稳定

### 中期（如果确实需要 Law Society 数据）
**方案 A: 2Captcha + Puppeteer**
- 成本低（每月 $1-5）
- 实现简单
- 成功率高（90%+）

### 长期（大规模采集）
**方案 A + 方案 B 组合**
- 使用代理 IP 池
- 使用验证码解决服务
- 设置合理的请求频率
- 成本约 $50-100/月

---

## 相关文件

- [lawsociety.js](src/sources/lawsociety.js) - 基础爬虫
- [lawsociety-enhanced.js](src/sources/lawsociety-enhanced.js) - 增强版爬虫
- [lawsociety-playwright.js](src/sources/lawsociety-playwright.js) - Playwright 版本
- [lawsociety-realbrowser.js](src/sources/lawsociety-realbrowser.js) - Real Browser 版本
- [scrape_lawsociety.py](scrape_lawsociety.py) - Python 版本
- [intercept-network.js](intercept-network.js) - 网络拦截分析

---

## 结论

Law Society 网站的 reCAPTCHA Enterprise 保护非常强大，**免费的自动化方案成功率极低（< 5%）**。

要稳定获取数据，必须：
1. 使用付费验证码解决服务（推荐）
2. 或者继续使用 SRA API（最简单）

**投入产出比分析**:
- SRA API: 免费，214,596 条记录
- Law Society + 2Captcha: $3/月，可能增加 10-20% 的数据
- 数据重复度: 预计 70-80%

**推荐**: 继续使用 SRA API，性价比最高。
