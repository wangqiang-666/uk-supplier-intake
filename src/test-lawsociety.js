const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');

puppeteer.use(StealthPlugin());

async function checkLawSociety() {
  console.log('========== 检查 Law Society 爬虫数据质量 ==========\n');

  let browser;
  try {
    console.log('启动浏览器...');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    const testUrl = 'https://solicitors.lawsociety.org.uk/search/results?Pro=True&Page=1';
    console.log('访问测试页面...');
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await new Promise(resolve => setTimeout(resolve, 5000));

    const html = await page.content();
    const $ = cheerio.load(html);

    console.log('页面标题:', $('title').text());
    console.log('查找结果容器...\n');

    // 尝试多种选择器
    const selectors = [
      '.search-results .result-item',
      '.view-content .views-row',
      '.results-list .result',
      'article',
      '.solicitor-result'
    ];

    let results = [];
    for (const selector of selectors) {
      const count = $(selector).length;
      console.log('选择器', selector, '找到', count, '个元素');

      if (count > 0) {
        $(selector).slice(0, 10).each((i, el) => {
          const $el = $(el);
          const name = $el.find('h3, h2, .title, .name').first().text().trim();
          const address = $el.find('.address, .location').first().text().trim();
          const phone = $el.find('.phone, .tel').first().text().trim();
          const email = $el.find('a[href^="mailto:"]').attr('href')?.replace('mailto:', '').trim() || '';

          if (name) results.push({ name, address, phone, email });
        });

        if (results.length > 0) break;
      }
    }

    await browser.close();

    console.log('\n✓ 成功爬取', results.length, '条测试数据\n');

    if (results.length === 0) {
      console.log('⚠️  未能提取到数据，可能需要调整选择器');
      console.log('页面HTML片段:');
      console.log(html.substring(0, 1000));
      return;
    }

    console.log('字段完整性检查：\n');

    const issues = [];
    results.forEach((item, i) => {
      const itemIssues = [];
      if (!item.name) itemIssues.push('❌ 缺少名称');
      if (!item.address) itemIssues.push('⚠️  缺少地址');
      if (!item.phone && !item.email) itemIssues.push('⚠️  缺少联系方式');

      if (itemIssues.length > 0) {
        issues.push({ index: i + 1, name: item.name || '未知', issues: itemIssues });
      }
    });

    if (issues.length === 0) {
      console.log('✓ 所有样本数据质量良好\n');
    } else {
      console.log('发现', issues.length, '条数据存在问题：\n');
      issues.forEach(item => {
        console.log(`[${item.index}] ${item.name}`);
        item.issues.forEach(issue => console.log(`    ${issue}`));
        console.log('');
      });
    }

    const stats = { total: results.length, withEmail: 0, withPhone: 0, withAddress: 0 };
    results.forEach(item => {
      if (item.email) stats.withEmail++;
      if (item.phone) stats.withPhone++;
      if (item.address) stats.withAddress++;
    });

    console.log('数据统计分析：');
    console.log(`  总数: ${stats.total}`);
    console.log(`  有邮箱: ${stats.withEmail} (${(stats.withEmail/stats.total*100).toFixed(1)}%)`);
    console.log(`  有电话: ${stats.withPhone} (${(stats.withPhone/stats.total*100).toFixed(1)}%)`);
    console.log(`  有地址: ${stats.withAddress} (${(stats.withAddress/stats.total*100).toFixed(1)}%)`);

  } catch (error) {
    console.error('❌ Law Society 检查失败:', error.message);
    if (browser) await browser.close();
  }
}

checkLawSociety().catch(console.error);
