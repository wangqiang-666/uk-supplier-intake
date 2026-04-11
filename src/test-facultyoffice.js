const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');

puppeteer.use(StealthPlugin());

async function checkFacultyOffice() {
  console.log('========== 检查 Faculty Office 爬虫数据质量 ==========\n');

  let browser;
  try {
    console.log('启动浏览器...');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    console.log('正在获取 Faculty Office 数据...');
    await page.goto('https://notarypro.facultyoffice.org.uk/find-a-notary?page=0', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await new Promise(resolve => setTimeout(resolve, 3000));

    const html = await page.content();
    const $ = cheerio.load(html);

    await browser.close();
    const results = [];

    $('.view-content .views-row').slice(0, 10).each((i, el) => {
      const $el = $(el);
      const name = $el.find('.views-field-field-profile-last-name .field-content').text().trim();
      const company = $el.find('.views-field-field-profile-company .field-content').text().trim();
      const address1 = $el.find('.views-field-field-profile-company-address-1 .field-content').text().trim();
      const city = $el.find('.views-field-field-profile-company-city .field-content').text().trim();
      const postcode = $el.find('.views-field-field-profile-company-postcode .field-content').text().trim();
      const phone = $el.find('.views-field-field-profile-business-phone .field-content').text().trim();
      const email = $el.find('.views-field-field-profile-company-email .field-content a').attr('href')?.replace('mailto:', '').trim() || '';

      if (name) results.push({ name, company, address1, city, postcode, phone, email });
    });

    console.log(`✓ 成功爬取 ${results.length} 条测试数据\n`);

    if (results.length === 0) {
      console.log('⚠️  未能提取到数据');
      console.log('页面标题:', $('title').text());
      console.log('查找 .view-content .views-row:', $('.view-content .views-row').length, '个');
      return;
    }

    console.log('字段完整性检查：\n');

    const issues = [];
    results.forEach((item, i) => {
      const itemIssues = [];
      if (!item.name) itemIssues.push('❌ 缺少名称');
      if (!item.address1 && !item.city) itemIssues.push('⚠️  缺少地址');
      if (!item.postcode) itemIssues.push('⚠️  缺少邮编');
      if (!item.phone && !item.email) itemIssues.push('⚠️  缺少联系方式');

      if (itemIssues.length > 0) {
        issues.push({ index: i + 1, name: item.name || '未知', issues: itemIssues });
      }
    });

    if (issues.length === 0) {
      console.log('✓ 所有样本数据质量良好\n');
    } else {
      console.log(`发现 ${issues.length} 条数据存在问题：\n`);
      issues.forEach(item => {
        console.log(`[${item.index}] ${item.name}`);
        item.issues.forEach(issue => console.log(`    ${issue}`));
        console.log('');
      });
    }

    const stats = { total: results.length, withEmail: 0, withPhone: 0, withPostcode: 0, withCompany: 0 };
    results.forEach(item => {
      if (item.email) stats.withEmail++;
      if (item.phone) stats.withPhone++;
      if (item.postcode) stats.withPostcode++;
      if (item.company) stats.withCompany++;
    });

    console.log('数据统计分析：');
    console.log(`  总数: ${stats.total}`);
    console.log(`  有邮箱: ${stats.withEmail} (${(stats.withEmail/stats.total*100).toFixed(1)}%)`);
    console.log(`  有电话: ${stats.withPhone} (${(stats.withPhone/stats.total*100).toFixed(1)}%)`);
    console.log(`  有邮编: ${stats.withPostcode} (${(stats.withPostcode/stats.total*100).toFixed(1)}%)`);
    console.log(`  有公司名: ${stats.withCompany} (${(stats.withCompany/stats.total*100).toFixed(1)}%)`);

  } catch (error) {
    console.error('❌ Faculty Office 检查失败:', error.message);
    if (browser) await browser.close();
  }
}

checkFacultyOffice().catch(console.error);
