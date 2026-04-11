const { fetchJson } = require("../lib/http");
const { validateEmail, normalizeEmail, normalizePhone, normalizePostcode } = require("../lib/validators");

const DEFAULT_URL = "https://sra-prod-apim.azure-api.net/datashare/api/V1/organisation/GetAll";

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function containsAny(text, keywords) {
  const t = norm(text);
  for (const k of keywords) {
    const kk = norm(k);
    if (!kk) continue;
    if (t.includes(kk)) return k;
  }
  return null;
}

function looksLikeUkCountry(country) {
  const c = norm(country);
  if (!c) return true; // unknown => do not over-reject
  return /(united kingdom|uk|england|scotland|wales|northern ireland)/i.test(country);
}

async function fetchAllOrganisations() {
  const apiUrl = process.env.SRA_API_URL || DEFAULT_URL;
  const key = process.env.SRA_API_KEY;
  if (!key || key === "YOUR_SRA_SUBSCRIPTION_KEY") {
    throw new Error("Missing SRA_API_KEY (subscription key). Put it in environment, not in git.");
  }

  const data = await fetchJson(apiUrl, {
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Cache-Control": "no-cache",
    },
    timeoutMs: 60000,
    retries: 2,
  });

  const orgs = data?.Organisations || data?.organisations || [];
  const count = data?.Count ?? data?.count ?? orgs.length;
  return { count, orgs };
}

function filterOrganisations(orgs, { workAreas = [], maxOrgs = 0 } = {}) {
  const wantedAreas = workAreas.map((w) => String(w || "").trim()).filter(Boolean);
  const out = [];

  for (const o of orgs) {
    const wa = o?.WorkArea || o?.workAreas || o?.practicingAreas || [];
    const waArr = Array.isArray(wa) ? wa : [];

    if (wantedAreas.length > 0) {
      const match = waArr.some((a) => containsAny(a, wantedAreas));
      if (!match) continue;
    }

    const office = (o?.Offices || o?.offices || [])[0] || {};
    const country = office?.Country || office?.country || "";
    if (!looksLikeUkCountry(country)) continue;

    const email = (office?.Email ?? office?.email ?? "").trim();
    if (!email) continue; // 无邮箱的律所跳过，营销必须有联系方式

    out.push(o);
    if (maxOrgs > 0 && out.length >= maxOrgs) break;
  }

  return out;
}

function mapOrganisationRow(o) {
  const office = (o?.Offices || o?.offices || [])[0] || {};
  const workAreas = Array.isArray(o?.WorkArea)
    ? o.WorkArea
    : Array.isArray(o?.workAreas)
      ? o.workAreas
      : [];

  const sraNumber = String(o?.SraNumber ?? o?.sraNumber ?? o?.sraId ?? o?.organisationId ?? o?.Id ?? "").trim();
  const name = String(o?.PracticeName ?? o?.organisationName ?? o?.name ?? "").trim() || "无";

  // 提取并验证邮箱
  let email = String(office?.Email ?? office?.email ?? "").trim();
  if (email && validateEmail(email)) {
    email = normalizeEmail(email);
  } else {
    email = "";
  }

  // 提取并标准化电话
  let telephone = String(office?.PhoneNumber ?? office?.telephone ?? "").trim();
  if (telephone) {
    telephone = normalizePhone(telephone);
  }

  // 提取并标准化邮编
  let postcode = String(office?.Postcode ?? office?.postcode ?? "").trim();
  if (postcode) {
    postcode = normalizePostcode(postcode);
  }

  return {
    source: "sra_api",
    external_id: sraNumber || "待人工复核",
    name,
    authorisation_status: String(o?.AuthorisationStatus ?? o?.authorisationStatus ?? o?.status ?? "").trim(),
    organisation_type: String(o?.OrganisationType ?? o?.organisationType ?? o?.AuthorisationType ?? "").trim(),
    work_areas: workAreas,

    address_line1: String(office?.Address1 ?? office?.addressLine1 ?? "").trim(),
    address_line2: String(office?.Address2 ?? office?.addressLine2 ?? "").trim(),
    address_line3: String(office?.Address3 ?? office?.addressLine3 ?? "").trim(),
    city: String(office?.Town ?? office?.city ?? "").trim(),
    county: String(office?.County ?? office?.county ?? "").trim(),
    postcode,
    country: String(office?.Country ?? office?.country ?? "").trim(),
    telephone,
    email,
    website: String(office?.Website ?? office?.website ?? "").trim(),
    office_type: String(office?.OfficeType ?? office?.officeType ?? "").trim(),

    source_url: sraNumber
      ? `https://www.sra.org.uk/consumers/register/organisation/?sraNumber=${encodeURIComponent(sraNumber)}`
      : "",
    raw_json: o,
  };
}

module.exports = {
  fetchAllOrganisations,
  filterOrganisations,
  mapOrganisationRow,
};

