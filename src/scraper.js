const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Magic Circle and Silver Circle law firms - auto-exclude
const EXCLUDED_FIRM_PATTERNS = [
  /allen\s*&\s*overy/i,
  /clifford\s*chance/i,
  /freshfields\s*bruckhaus\s*deringer/i,
  /linklaters/i,
  /sullivan\s*&\s*cromwell/i,
  /herbert\s*smith\s*freehills/i,
  /magic\s*circle/i,
  /silver\s*circle/i,
  // Silver Circle
  /berwin\s*leighton\s*paisner/i,
  /brodies/i,
  /burges\s*salmon/i,
  /clyde\s*&\s*co/i,
  /dla\s*piper/i,
  /eversheds\s*sutherland/i,
  /taylor\s*wessing/i,
  /addleshaw\s*goddard/i,
  /ashurst/i,
  /dentons/i,
  /kpmg\s*law/i,
  /pwc\s*law/i,
  // Other high-end global firms
  /skadden/i,
  /latham\s*&\s*watkins/i,
  /white\s*&\s*case/i,
  /davis\s*polk/i,
  /cleary\s*gottlieb/i,
  /shearman\s*&\s*sterling/i,
  /norton\s*rose\s*fulbright/i,
  /baker\s*mckenzie/i,
  /houston\s*&\s*harrison/i,
  /charlton\s*&\s*co/i,
];

// Government/regulatory bodies - auto-exclude
const EXCLUDED_ORG_PATTERNS = [
  /bar\s*standards\s*board/i,
  /crown\s*prosecution\s*service/i,
  /government/i,
  /hmcts/i,
  /ministry\s*of\s*justice/i,
  /sra\s*-|sra$/i,
  /law\s*society/i,
  /legal\s*aid/i,
  /public\s*prosecutor/i,
  /in-house\s*counsel/i,
  /inhouse\s*solicitor/i,
  /internal\s*counsel/i,
];

// Non-UK countries - auto-exclude
const EXCLUDED_COUNTRIES = [
  'hong kong',
  'hongkong',
  'china',
  'singapore',
  'australia',
  'new zealand',
  'canada',
  'usa',
  'united states',
  'dubai',
  'uae',
  'middle east',
];

// Excluded name
const EXCLUDED_NAME = 'nurgus malik';

// UK cities/areas for checking - for London City identification
const LONDON_CITY_POSTCODES = [
  'EC1', 'EC2', 'EC3', 'EC4',  // City of London
  'SW1A', // Westminster
];

class SRAScraper {
  constructor() {
    this.dataFile = path.join(__dirname, '../data/organisations.json');
    this.filteredFile = path.join(__dirname, '../data/filtered_organisations.json');
    this.statsFile = path.join(__dirname, '../data/scrape_stats.json');
  }

  async fetchData() {
    const apiKey = process.env.SRA_API_KEY;
    const apiUrl = process.env.SRA_API_URL;

    if (!apiKey || !apiUrl) {
      throw new Error('SRA_API_KEY and SRA_API_URL must be set in .env');
    }

    console.log('Fetching data from SRA API...');
    
    try {
      const response = await axios.get(apiUrl, {
        headers: {
          'Cache-Control': 'no-cache',
          'Ocp-Apim-Subscription-Key': apiKey,
        },
        timeout: 60000, // 60 second timeout
      });

      console.log(`Fetched ${response.data.Organisations?.length || 0} organisations`);
      return response.data;
    } catch (error) {
      console.error('Error fetching data:', error.message);
      throw error;
    }
  }

  // Check if firm is in excluded patterns
  isExcludedFirm(org) {
    const name = org.PracticeName || '';
    const tradingNames = org.TradingNames || [];
    
    // Check practice name
    for (const pattern of EXCLUDED_FIRM_PATTERNS) {
      if (pattern.test(name)) return { excluded: true, reason: `Excluded firm pattern: ${pattern}` };
    }
    
    // Check trading names
    for (const tn of tradingNames) {
      for (const pattern of EXCLUDED_FIRM_PATTERNS) {
        if (pattern.test(tn)) return { excluded: true, reason: `Excluded trading name pattern: ${pattern}` };
      }
    }

    return { excluded: false };
  }

  // Check if organisation is in excluded org patterns
  isExcludedOrg(org) {
    const name = org.PracticeName || '';
    
    for (const pattern of EXCLUDED_ORG_PATTERNS) {
      if (pattern.test(name)) return { excluded: true, reason: `Excluded organisation: ${pattern}` };
    }

    return { excluded: false };
  }

  // Check if address is in non-UK location
  hasNonUKAddress(org) {
    const offices = org.Offices || [];
    
    for (const office of offices) {
      const fullAddress = [
        office.Address1,
        office.Address2,
        office.Address3,
        office.Address4,
        office.Town,
        office.County,
        office.Country,
        office.Postcode,
      ].join(' ').toLowerCase();

      // Check country
      if (office.Country) {
        for (const country of EXCLUDED_COUNTRIES) {
          if (office.Country.toLowerCase().includes(country)) {
            return { excluded: true, reason: `Non-UK country: ${office.Country}` };
          }
        }
      }

      // Check for HK, Singapore, Australia in address
      for (const country of EXCLUDED_COUNTRIES) {
        if (fullAddress.includes(country)) {
          return { excluded: true, reason: `Non-UK location in address` };
        }
      }
    }

    return { excluded: false };
  }

  // Check if it's an in-house team
  isInHouseTeam(org) {
    const name = org.PracticeName || '';
    const workArea = org.WorkArea || [];
    
    // Check for in-house indicators in name
    if (/in-?house/i.test(name)) {
      return { excluded: true, reason: 'In-house team' };
    }

    // Check work area for government/other employers
    const workAreaStr = workArea.join(' ').toLowerCase();
    if (/in-?house\s*team|government|department/i.test(workAreaStr)) {
      return { excluded: true, reason: 'In-house/government team' };
    }

    return { excluded: false };
  }

  // Check if name matches excluded person
  isExcludedPerson(org) {
    const name = org.PracticeName || '';
    
    if (name.toLowerCase().includes(EXCLUDED_NAME)) {
      return { excluded: true, reason: `Excluded person: ${EXCLUDED_NAME}` };
    }

    return { excluded: false };
  }

  // Check for partner indicators in name
  isPartnerLevel(org) {
    const name = org.PracticeName || '';
    const indicators = [
      /managing\s*partner/i,
      /senior\s*partner/i,
      /equity\s*partner/i,
      /salaried\s*partner/i,
      /partner\s*-\s*/i,
      /managing\s*director/i,
      /ceo/i,
      /founder\s*&\s*partner/i,
    ];

    for (const indicator of indicators) {
      if (indicator.test(name)) {
        return { isPartner: true, reason: `Partner indicator: ${indicator}` };
      }
    }

    return { isPartner: false };
  }

  // Check if firm is located in City of London (premium area)
  isCityOfLondon(org) {
    const offices = org.Offices || [];
    
    for (const office of offices) {
      const postcode = office.Postcode || '';
      const upperPostcode = postcode.toUpperCase();
      
      for (const prefix of LONDON_CITY_POSTCODES) {
        if (upperPostcode.startsWith(prefix)) {
          return { isCityOfLondon: true, postcode };
        }
      }
    }

    return { isCityOfLondon: false };
  }

  // Check for immigration/private client specialty
  hasRelevantSpecialty(org) {
    const workArea = org.WorkArea || [];
    const reservedActivities = org.ReservedActivites || [];
    const allFields = [...workArea, ...reservedActivities].join(' ').toLowerCase();

    const immigrationKeywords = [
      'immigration',
      'nationality',
      'citizenship',
      'visa',
      'asylum',
      'human rights',
    ];

    const privateClientKeywords = [
      'private client',
      'wealth management',
      'estate planning',
      'probate',
      'trusts',
      'wills',
      'family',
      'personal injury',
    ];

    const hasImmigration = immigrationKeywords.some(kw => allFields.includes(kw));
    const hasPrivateClient = privateClientKeywords.some(kw => allFields.includes(kw));

    return {
      hasRelevantSpecialty: hasImmigration || hasPrivateClient,
      hasImmigration,
      hasPrivateClient,
    };
  }

  // Main filtering function
  filterOrganisations(data) {
    const organisations = data.Organisations || [];
    const filtered = [];
    const excluded = [];

    let stats = {
      total: organisations.length,
      excludedFirm: 0,
      excludedOrg: 0,
      excludedNonUK: 0,
      excludedInHouse: 0,
      excludedPerson: 0,
      excludedSRA: 0,
      partnerLevel: 0,
      cityOfLondon: 0,
      hasSpecialty: 0,
      lowPriority: 0,
      passed: 0,
    };

    for (const org of organisations) {
      const exclusionReasons = [];

      // Check 1: Excluded person (Nurgus Malik)
      const personCheck = this.isExcludedPerson(org);
      if (personCheck.excluded) {
        stats.excludedPerson++;
        excluded.push({ org, reason: personCheck.reason });
        continue;
      }

      // Check 2: Excluded firm patterns (Magic Circle, etc.)
      const firmCheck = this.isExcludedFirm(org);
      if (firmCheck.excluded) {
        stats.excludedFirm++;
        excluded.push({ org, reason: firmCheck.reason });
        continue;
      }

      // Check 3: Excluded organisation (government, regulators)
      const orgCheck = this.isExcludedOrg(org);
      if (orgCheck.excluded) {
        stats.excludedOrg++;
        excluded.push({ org, reason: orgCheck.reason });
        continue;
      }

      // Check 4: Non-UK address
      const addressCheck = this.hasNonUKAddress(org);
      if (addressCheck.excluded) {
        stats.excludedNonUK++;
        excluded.push({ org, reason: addressCheck.reason });
        continue;
      }

      // Check 5: In-house team
      const inHouseCheck = this.isInHouseTeam(org);
      if (inHouseCheck.excluded) {
        stats.excludedInHouse++;
        excluded.push({ org, reason: inHouseCheck.reason });
        continue;
      }

      // Collect all reasons for this organisation
      let isPartner = false;
      let isCityOfLondon = false;
      let hasSpecialty = false;

      // Check partner level
      const partnerCheck = this.isPartnerLevel(org);
      if (partnerCheck.isPartner) {
        isPartner = true;
        stats.partnerLevel++;
      }

      // Check City of London
      const cityCheck = this.isCityOfLondon(org);
      if (cityCheck.isCityOfLondon) {
        isCityOfLondon = true;
        stats.cityOfLondon++;
      }

      // Check specialty
      const specialtyCheck = this.hasRelevantSpecialty(org);
      if (specialtyCheck.hasRelevantSpecialty) {
        hasSpecialty = true;
        stats.hasSpecialty++;
      }

      // Determine priority
      let priority = 'medium';
      let notes = [];

      // High priority: Has relevant specialty AND not partner AND not City of London
      if (hasSpecialty && !isPartner && !isCityOfLondon) {
        priority = 'high';
        notes.push('匹配移民/私人客户专业领域');
      }

      // Low priority conditions
      if (isPartner || isCityOfLondon) {
        priority = 'low';
        if (isPartner) notes.push('合伙人级别，不建议主动邀约');
        if (isCityOfLondon) notes.push('伦敦金融城核心区');
      }

      // Check if it's an SME (small/medium firm)
      const noOfOffices = org.NoOfOffices || 0;
      let firmSize = 'unknown';
      if (noOfOffices <= 1) firmSize = 'sole practitioner';
      else if (noOfOffices <= 5) firmSize = 'small';
      else if (noOfOffices <= 20) firmSize = 'medium';
      else firmSize = 'large';

      const filteredOrg = {
        ...org,
        metadata: {
          priority,
          notes,
          isPartner,
          isCityOfLondon,
          firmSize,
          hasImmigrationSpecialty: specialtyCheck.hasImmigration,
          hasPrivateClientSpecialty: specialtyCheck.hasPrivateClient,
          filteredAt: new Date().toISOString(),
        },
      };

      if (priority === 'low') {
        stats.lowPriority++;
      } else {
        stats.passed++;
      }

      filtered.push(filteredOrg);
    }

    // Sort by priority: high first, then medium, then low
    filtered.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.metadata.priority] - priorityOrder[b.metadata.priority];
    });

    stats.excluded = excluded.length;
    stats.filtered = filtered.length;

    return { filtered, excluded, stats };
  }

  async saveData(data, filename) {
    const dir = path.dirname(filename);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filename, JSON.stringify(data, null, 2), 'utf-8');
  }

  async run() {
    console.log('Starting SRA scraper...');
    
    try {
      // Step 1: Fetch data
      const data = await this.fetchData();
      await this.saveData(data, this.dataFile);
      console.log(`Saved raw data to ${this.dataFile}`);

      // Step 2: Filter data
      console.log('Filtering organisations...');
      const { filtered, excluded, stats } = this.filterOrganisations(data);
      
      await this.saveData(filtered, this.filteredFile);
      console.log(`Saved filtered data to ${this.filteredFile}`);

      // Save excluded for audit
      await this.saveData(excluded, path.join(__dirname, '../data/excluded.json'));
      
      // Save stats
      await this.saveData(stats, this.statsFile);

      // Print summary
      console.log('\n=== SCRAPE SUMMARY ===');
      console.log(`Total organisations: ${stats.total}`);
      console.log(`Passed filters: ${stats.filtered}`);
      console.log(`  - High priority: ${stats.passed}`);
      console.log(`  - Low priority: ${stats.lowPriority}`);
      console.log(`Excluded:`);
      console.log(`  - Excluded firm: ${stats.excludedFirm}`);
      console.log(`  - Excluded org: ${stats.excludedOrg}`);
      console.log(`  - Non-UK: ${stats.excludedNonUK}`);
      console.log(`  - In-house: ${stats.excludedInHouse}`);
      console.log(`  - Excluded person: ${stats.excludedPerson}`);
      console.log(`Partner level: ${stats.partnerLevel}`);
      console.log(`City of London: ${stats.cityOfLondon}`);
      console.log(`Has relevant specialty: ${stats.hasSpecialty}`);

      return { filtered, excluded, stats };
    } catch (error) {
      console.error('Scraper error:', error);
      throw error;
    }
  }
}

// Run if called directly
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  const scraper = new SRAScraper();
  scraper.run()
    .then(() => {
      console.log('\nScraping complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Scraping failed:', error);
      process.exit(1);
    });
}

module.exports = SRAScraper;
