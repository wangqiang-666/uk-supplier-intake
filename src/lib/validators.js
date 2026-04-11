/**
 * 数据验证工具
 * 用于验证组织数据的各个字段格式
 */

/**
 * 验证邮箱格式
 */
function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email.trim());
}

/**
 * 验证英国电话号码格式
 */
function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  // 移除空格和常见分隔符
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');
  // 英国电话号码：+44 或 0 开头，后跟10位数字
  return /^(\+44|0)[0-9]{10}$/.test(cleaned);
}

/**
 * 验证英国邮编格式
 */
function validatePostcode(postcode) {
  if (!postcode || typeof postcode !== 'string') return false;
  // 英国邮编格式：AA9A 9AA, A9A 9AA, A9 9AA, A99 9AA, AA9 9AA, AA99 9AA
  const regex = /^[A-Z]{1,2}[0-9]{1,2}[A-Z]?\s?[0-9][A-Z]{2}$/i;
  return regex.test(postcode.trim());
}

/**
 * 验证URL格式
 */
function validateUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * 验证组织数据完整性
 */
function validateOrganisation(org) {
  const errors = [];
  const warnings = [];

  // 必填字段检查
  if (!org.name || org.name.trim() === '') {
    errors.push('缺少机构名称');
  }

  if (!org.external_id || org.external_id.trim() === '') {
    errors.push('缺少外部ID');
  }

  if (!org.source || org.source.trim() === '') {
    errors.push('缺少数据源标识');
  }

  // 联系方式检查
  const hasEmail = org.email && org.email.trim() !== '';
  const hasPhone = org.telephone && org.telephone.trim() !== '';

  if (!hasEmail && !hasPhone) {
    warnings.push('缺少联系方式（邮箱和电话都没有）');
  }

  // 格式验证
  if (hasEmail && !validateEmail(org.email)) {
    errors.push(`邮箱格式无效: ${org.email}`);
  }

  if (hasPhone && !validatePhone(org.telephone)) {
    warnings.push(`电话格式可能无效: ${org.telephone}`);
  }

  if (org.postcode && !validatePostcode(org.postcode)) {
    warnings.push(`邮编格式可能无效: ${org.postcode}`);
  }

  if (org.website && !validateUrl(org.website)) {
    warnings.push(`网站URL格式无效: ${org.website}`);
  }

  // 地址完整性检查
  const hasAddress = (org.address_line1 || org.city || org.postcode);
  if (!hasAddress) {
    warnings.push('缺少地址信息');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 清理和标准化电话号码
 */
function normalizePhone(phone) {
  if (!phone) return '';
  // 移除空格和分隔符
  let cleaned = phone.replace(/[\s\-\(\)]/g, '');
  // 如果以0开头，转换为+44
  if (cleaned.startsWith('0')) {
    cleaned = '+44' + cleaned.substring(1);
  }
  return cleaned;
}

/**
 * 清理和标准化邮编
 */
function normalizePostcode(postcode) {
  if (!postcode) return '';
  // 转大写，确保有空格
  const cleaned = postcode.toUpperCase().replace(/\s+/g, '');
  // 在最后3个字符前插入空格
  if (cleaned.length >= 5) {
    return cleaned.slice(0, -3) + ' ' + cleaned.slice(-3);
  }
  return cleaned;
}

/**
 * 清理和标准化邮箱
 */
function normalizeEmail(email) {
  if (!email) return '';
  return email.trim().toLowerCase();
}

/**
 * 批量验证组织数据
 */
function validateOrganisations(orgs) {
  const results = {
    total: orgs.length,
    valid: 0,
    invalid: 0,
    withWarnings: 0,
    details: [],
  };

  orgs.forEach((org, index) => {
    const validation = validateOrganisation(org);

    if (validation.valid) {
      results.valid++;
      if (validation.warnings.length > 0) {
        results.withWarnings++;
      }
    } else {
      results.invalid++;
    }

    if (!validation.valid || validation.warnings.length > 0) {
      results.details.push({
        index,
        name: org.name || '未知',
        external_id: org.external_id || '无',
        ...validation,
      });
    }
  });

  return results;
}

module.exports = {
  validateEmail,
  validatePhone,
  validatePostcode,
  validateUrl,
  validateOrganisation,
  validateOrganisations,
  normalizePhone,
  normalizePostcode,
  normalizeEmail,
};
