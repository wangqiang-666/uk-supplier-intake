const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
require('dotenv').config();

puppeteer.use(StealthPlugin());

// ============ 1. SRA API 数据质量检查 ============
async function validateSRAData() {
  console.log('\n========== 检查 SRA API 数据质量 ==========\n');

  const apiKey = process.env.SRA_API_KEY;
  const apiUrl = process.env.SRA_API_URL || 'https://sra-prod-apim.azure-api.net/datashare/api/V1/organisation/GetAll';

  if (!apiKey) throw new Error('缺少 SRA_API_KEY');

  try {
    console.log('正在获取 SRA 数据...');
    const response = await axios.get(apiUrl, {
      headers: { 'Cache-Control': 'no-cache', 'Ocp-Apim-Subscription-Key': apiKey },
      timeout: 120000,
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 100 * 1024 * 1024,
    });

    const orgs = response.data?.Organisations || [];
    console.log(`✓ 获取到 ${orgs.length} 条组织数据\n`);

    const sample = orgs.slice(0, 20);
    const issues = [];

    console.log('字段完整性检查（前20条样本）：\n');

    for (let i = 0; i < sample.length; i++) {
      const org = sample[i];
      const orgIssues = [];

      if (!org.SraNumber && !org.Id) orgIssues.push('❌ 缺少 SRA 编号');
      if (!org.PracticeName || org.PracticeName.trim() === '') orgIssues.push('❌ 缺少机构名称');
      if (!org.AuthorisationStatus) orgIssues.push('⚠️  缺少授权状态');

      const offices = org.Offices || [];
      if (offices.length === 0) {
        orgIssues.push('❌ 没有办公地址');
      } else {
        const office = offices[0];
        if (!office.Address1 && !office.Town) orgIssues.push('❌ 地址信息不完整');
        if (!office.Postcode) orgIssues.push('⚠️  缺少邮编');
        if (!office.Email && !office.PhoneNumber) orgIssues.push('⚠️  缺少联系方式');
        if (office.Country && !/(united kingdom|uk|england|scotland|wales|northern ireland)/i.test(office.Country)) {
          orgIssues.push(`⚠️  非英国地址: ${office.Country}`);
        }
      }

      if (!org.WorkArea || org.WorkArea.length === 0) orgIssues.push('⚠️  缺少工作领域');
      if (org.PracticeName && /test|demo|sample|example|xxx|zzz/i.test(org.PracticeName)) {
        orgIssues.push('❌ 疑似测试数据');
      }

      if (orgIssues.length > 0) {
        issues.push({
          index: i + 1,
          name: org.PracticeName || '未知',
          sraNumber: org.SraNumber || org.Id || '无',
          issues: orgIssues,
        });
      }
    }

    if (issues.length === 0) {
      console.log('✓ 所有样本数据质量良好\n');
    } else {
      console.log(`发现 ${issues.length} 条数据存在问题：\n`);
      issues.forEach(item => {
        console.log(`[${item.index}] ${item.name} (SRA: ${item.sraNumber})`);
        item.issues.forEach(issue => console.log(`    ${issue}`));
        console.log('');
      });
    }

    const stats = { total: orgs.length, withEmail: 0, withPhone: 0, withWebsite: 0, withWorkArea: 0, withPostcode: 0, ukOnly: 0 };
    orgs.forEach(org => {
      const office = (org.Offices || [])[0] || {};
      if (office.Email) stats.withEmail++;
      if (office.PhoneNumber) stats.withPhone++;
      if (office.Website) stats.withWebsite++;
      if (org.WorkArea && org.WorkArea.length > 0) stats.withWorkArea++;
      if (office.Postcode) stats.withPostcode++;
      if (!office.Country || /(united kingdom|uk|england|scotland|wales|northern ireland)/i.test(office.Country)) stats.ukOnly++;
    });

    console.log('数据统计分析：');
    console.log(`  总数: ${stats.total}`);
    console.log(`  有邮箱: ${stats.withEmail} (${(stats.withEmail/stats.total*100).toFixed(1)}%)`);
    console.log(`  有电话: ${stats.withPhone} (${(stats.withPhone/stats.total*100).toFixed(1)}%)`);
    console.log(`  有网站: ${stats.withWebsite} (${(stats.withWebsite/stats.total*100).toFixed(1)}%)`);
    console.log(`  有工作领域: ${stats.withWorkArea} (${(stats.withWorkArea/stats.total*100).toFixed(1)}%)`);
    console.log(`  有邮编: ${stats.withPostcode} (${(stats.withPostcode/stats.total*100).toFixed(1)}%)`);
    console.log(`  英国地址: ${stats.ukOnly} (${(stats.ukOnly/stats.total*100).toFixed(1)}%)`);

    return { source: 'SRA API', success: true, totalRecords: orgs.length, issuesFound: issues.length, stats };
  } catch (error) {
    console.error('❌ SRA API 检查失败:', error.message);
    return { source: 'SRA API', success: false, error: error.message };
  }
}

// ============ 2. Law Society 数据质量检查 ============
async function validateLawSocietyData() {
  console.log('\n========== 检查 Law Society 爬虫数据质量 ==========\n');

  let browser;
  try {
    console.log('启动浏览器...');
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    const testUrl = 'https://solicitors.lawsociety.org.uk/search/results?Pro=True&Page=1';
    console.log('访问测试页面...');
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 等待页面加载
    await new Promise(resolve => setTimeout(resolve, 3000));

    const html = await page.content();
    const $ = cheerio.load(html);

    const results = [];
    $('.search-results .result-item, .view-content .views-row').slice(0, 10).each((i, el) => {
      const $el = $(el);
      const name = $el.find('h3, .views-field-title, .result-title').first().text().trim();
      const address = $el.find('.address, .views-field-field-profile-company-address, .result-address').first().text().trim();
      const phone = $el.find('.phone, .views-field-field-profile-business-phone, .result-phone').first().text().trim();
      const email = $el.find('a[href^="mailto:"]').attr('href')?.replace('mailto:', '').trim() || '';

      if (name) results.push({ name, address, phone, email });
    });

    await browser.close();

    console.log(`✓ 成功爬取 ${results.length} 条测试数据\n`);
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
      console.log(`发现 ${issues.length} 条数据存在问题：\n`);
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

    return { source: 'Law Society', success: true, totalRecords: results.length, issuesFound: issues.length, stats };
  } catch (error) {
    console.error('❌ Law Society 检查失败:', error.message);
    if (browser) await browser.close();
    return { source: 'Law Society', success: false, error: error.message };
  }
}

// ============ 3. Faculty Office 数据质量检查 ============
async function validateFacultyOfficeData() {
  console.log('\n========== 检查 Faculty Office 爬虫数据质量 ==========\n');

  try {
    console.log('正在获取 Faculty Office 数据...');
    const response = await axios.get('https://notarypro.facultyoffice.org.uk/find-a-notary?page=0', {
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    const $ = cheerio.load(response.data);
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

    return { source: 'Faculty Office', success: true, totalRecords: results.length, issuesFound: issues.length, stats };
  } catch (error) {
    console.error('❌ Faculty Office 检查失败:', error.message);
    return { source: 'Faculty Office', success: false, error: error.message };
  }
}

// ============ 主函数 ============
async function main() {
  console.log('========================================');
  console.log('   数据质量检查工具');
  console.log('   检查 3 个数据源的数据质量');
  console.log('========================================');

  const results = [];

  // 检查 SRA API
  const sraResult = await validateSRAData();
  results.push(sraResult);

  // 检查 Law Society
  const lawSocietyResult = await validateLawSocietyData();
  results.push(lawSocietyResult);

  // 检查 Faculty Office
  const facultyOfficeResult = await validateFacultyOfficeData();
  results.push(facultyOfficeResult);

  // 总结
  console.log('\n========================================');
  console.log('   检查总结');
  console.log('========================================\n');

  results.forEach(result => {
    if (result.success) {
      console.log(`✓ ${result.source}: 成功`);
      console.log(`  - 总记录数: ${result.totalRecords}`);
      console.log(`  - 发现问题: ${result.issuesFound} 条`);
    } else {
      console.log(`❌ ${result.source}: 失败`);
      console.log(`  - 错误: ${result.error}`);
    }
    console.log('');
  });

  console.log('检查完成！');
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { validateSRAData, validateLawSocietyData, validateFacultyOfficeData };
