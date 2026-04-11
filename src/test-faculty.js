const axios = require('axios');
const cheerio = require('cheerio');

async function testFacultyOffice() {
  console.log('========== 检查 Faculty Office 数据质量 ==========\n');

  const http = axios.create({
    baseURL: 'https://notarypro.facultyoffice.org.uk',
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  const params = new URLSearchParams({
    'distance[origin]': '',
    'language': 'All',
    'submit': 'Submit',
    'page': 0,
  });

  console.log('正在获取数据...');
  const res = await http.get('/find-a-notary?' + params.toString());
  const $ = cheerio.load(res.data);

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

  console.log(`✓ 成功爬取 ${results.length} 条数据\n`);

  if (results.length === 0) {
    console.log('⚠️  未找到数据');
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

  console.log('\n前3条样本数据：');
  results.slice(0, 3).forEach((item, i) => {
    console.log(`[${i+1}] ${item.name}`);
    console.log(`    公司: ${item.company || '无'}`);
    console.log(`    地址: ${item.address1 || '无'}`);
    console.log(`    城市: ${item.city || '无'}`);
    console.log(`    邮编: ${item.postcode || '无'}`);
    console.log(`    电话: ${item.phone || '无'}`);
    console.log(`    邮箱: ${item.email || '无'}`);
    console.log('');
  });
}

testFacultyOffice().catch(console.error);
