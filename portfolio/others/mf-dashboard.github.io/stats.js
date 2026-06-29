async function getMFDetails(endpoint) {
  const url =
    "https://groww.in/v1/api/data/mf/web/v4/scheme/search/" + endpoint;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error("Error fetching MF details:", err);
    return null;
  }
}

async function getFundStats(schemeCode) {
  const url = `https://groww.in/v1/api/data/mf/web/v1/scheme/portfolio/${schemeCode}/stats`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error("Error fetching MF stats:", err);
    return null;
  }
}

async function getFundNAVHistory(schemeCode) {
  const url = `https://api.mfapi.in/mf/${schemeCode}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! ${response.status}`);
    const data = await response.json();
    return data;
  } catch (err) {
    console.error("Error fetching NAV history:", err);
    return null;
  }
}

async function getFundDetails(searchKey) {
  try {
    const mfData = await getMFDetails(searchKey);
    if (!mfData || !mfData.scheme_code) return null;

    const stats = await getFundStats(mfData.scheme_code);
    const navHistory = await getFundNAVHistory(mfData.scheme_code);

    return {
      amc: mfData.amc_info.name,
      scheme_name: mfData.scheme_name,
      scheme_code: mfData.scheme_code,
      plan_type: mfData.plan_type,
      scheme_type: mfData.scheme_type,
      isin: mfData.isin,
      category: mfData.category,
      sub_category: mfData.sub_category,
      second_category: mfData.category_info?.category,
      holdings: mfData.holdings || [],
      expense_ratio: mfData.expense_ratio,
      aum: mfData.aum,
      groww_rating: mfData.groww_rating,
      return_stats: mfData.return_stats?.[0] || {},
      sip_return: mfData?.sip_return || {},
      portfolio_stats: stats || {},
      latest_nav: navHistory?.data?.[0]?.nav || 0,
      latest_nav_date: navHistory?.data?.[0]?.date || 0,
      nav_history: navHistory?.data || [],
      meta: navHistory?.meta || {},
      benchmark: mfData?.benchmark || "",
    };
  } catch (err) {
    console.error("Error fetching fund details:", err);
    return null;
  }
}

async function fetchMFStats(searchKeys) {
  try {
    const allFunds = {};

    for (const searchKey of searchKeys) {
      const fundDetails = await getFundDetails(searchKey);
      if (fundDetails && fundDetails.isin) {
        allFunds[fundDetails.isin] = fundDetails;
      }
    }

    return allFunds;
  } catch (err) {
    console.error("Error in fetchMFStats:", err);
    return {};
  }
}
