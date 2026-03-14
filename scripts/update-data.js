require('util').inspect.defaultOptions.depth = null;
const fs = require('fs');

// const fetch = require('node-fetch');
// const { HttpsProxyAgent } = require('https-proxy-agent');

const DATA_DIR = './data'
let loopCount = 0

// const ROLLING_RETURNS_WINDOWS = [1,2,3,4,5,6,7,8,9,10,11,12]
// const ROLLING_RETURNS_WINDOWS = [12,10,8,5,3,2,1]
const ROLLING_RETURNS_WINDOWS = [1,2,3,5,8,10]


const agent = process.env.HTTP_PROXY ? new HttpsProxyAgent('http://localhost:3128', { headers: {} }) : undefined;

async function http(url) {
  return fetch(url, { agent })
    .then(async (r) => {
      return {
        status: r.status,
        headers: Object.fromEntries(r.headers.entries()),
        body: await r.text()
      }
    })
    .catch((error) => {
      return { error }
    })
}
const log = {
  debug(...log) {
    console.log('[DEBUG]', ...log)
  },
  info(...log) {
    console.info('[INFO]', ...log)
  },
  warn(...log) {
    console.warn('[WARN]', ...log)
  },
  error(...log) {
    console.error('[ERROR]', ...log)
  },
}
async function sleep(ms) {
  return new Promise(function (resolve, reject) {
    setTimeout(function () { resolve() }, ms)
  })
}


function fmtNum(num) {
  // if (isNaN(num)) throw new Error(num+' is not a number')
  if (num === '') return ''
  if (isNaN(num)) return ''
  return +num.toFixed(2)
}
function toCsv(rows) {
  const headerRow = Object.keys(rows[0]).join(',')
  const dataRows = rows.map(row => Object.values(row).map(val => `"${val}"`).join(','))
  return [headerRow, ...dataRows].join('\n')
}

function parseCategory(amfiCat) {
  let [, type, category] = amfiCat.match(/(.+?)\((.+)\)/)
  // let [scheme, category] = schemeCategory.split(' - ')
  // if (!category) category = scheme
  let [scheme] = category.split(' - ')
  return { type, scheme, category }
}
function parseAMFIFunds(data) {
  data = data.replace(/\r?\n/g, '\n')
  let lines = data.split(/\n/)

  const funds = []
  let fundHouses = {}
  let rawCategories = {}
  let types = {}
  let schemes = {}
  let categories = {}

  const FUND_LINE_REGEX = /^\d+;/

  // below are set as and when those lines are encountered
  // and used by subsequent funds
  let currentFundHouse
  let currentRawCategory
  for (let i = 1; i < lines.length; i++) {
    let line = lines[i]

    // ignore empty lines
    if (line.match(/^\s+$/)) continue

    if (FUND_LINE_REGEX.test(line)) {
      // line with fund data
      let [code, isinDivPayGrowth, isiniDivReinvest, name, nav, date] = line.split(';')

      // fundHouse and rawCategory would have been set while parsing earlier lines
      const fundHouse = currentFundHouse
      const { type, scheme, category } = rawCategories[currentRawCategory]

      types[type] = true
      schemes[scheme] = true
      categories[category] = true

      // TODO
      // growth vs dividend
      // regular vs direct
      // let growth = !!name.match(/growth/i)

      let fund = {
        code,
        name,
        fundHouse,
        rawCategory: currentRawCategory,
        type,
        scheme,
        category,
        nav,
        date,
        isinDivPayGrowth,
        isiniDivReinvest
      }
      funds.push(fund)
    } else if (lines[i + 1] === ' ' && FUND_LINE_REGEX.test(lines[i + 2])) {
      // line with fund house name
      currentFundHouse = line
      fundHouses[currentFundHouse] = true
    } else if (lines[i + 1] === ' ' && lines[i + 3] === ' ') {
      // line with category data
      currentRawCategory = line
      rawCategories[currentRawCategory] = parseCategory(currentRawCategory)
      // let categoryData = parseCategory(currentRawCategory)
    }
  }
  return {
    categories: Object.keys(categories),
    fundHouses: Object.keys(fundHouses),
    // funds: funds.sort((a, b) => (+a.code) - (+b.code)),
    funds,
    // types: Object.keys(types),
    // schemes: Object.keys(schemes),
    // rawCategories: Object.keys(rawCategories),
  }
}

let navRetries = 0
async function refreshNavs(funds) {
  log.info('Refreshing NAVs for selected funds...');

  const navStart = new Date();

  const opDir = DATA_DIR+'/navs'
  if (!fs.existsSync(opDir)){
    fs.mkdirSync(opDir, { recursive: true });
  }
  const failed = []
  let count = 1
  await Promise.all(funds.map(async (fund, i) => {
    await sleep(i * 25)
    let response
    try {
      response = await http(`https://api.mfapi.in/mf/${fund.code}`)
      const navs = JSON.parse(response.body).data.map(({ date, nav }) => ({ date: date.split('-').reverse().join('-'), nav: parseFloat(nav) }))
      // log.info('Writing '+DATA_DIR+'/navs/'+fund.code+'.csv')
      const navsCsv = []
      // navsCsv.push('code,class,category,fundHouse,name,aum')
      // navsCsv.push(`${fund.code},${fund.fundClass},${fund.category},${fund.fundHouse},${fund.name},${fund.aum}`)
      navsCsv.push('date,nav')
      navs.forEach(i => {
        navsCsv.push(`${i.date},${i.nav}`)
      })
      fs.writeFileSync(`${opDir}/${fund.code}.csv`, navsCsv.join('\n'))
      // fs.writeFileSync(`${opDir}/${fund.code}-${fund.name.replace(/(\/|\s)/, '-')}.csv`, navsCsv.join('\n'))
      // log.debug(`Got NAVs for ${fund.code} (${fund.name})`)
      // log.debug('NAV remaining:', (funds.length - i), ` done: ${fund.code} ${fund.name}`)
      log.debug('NAV:', count++, '/', funds.length, `got ${fund.code} ${fund.name}`)
    } catch (error) {
      failed.push({ ...fund, error })
      log.error(fund.code)
      log.error({ response, error })
    }
  }))

  if (failed.length > 0) {
    log.error(failed.map(({code,name}) => (`${code}: ${name}`)))
    log.error('FAILED NAVs:', failed.length)
    if (navRetries <= 10) {
      log.info('Retrying...')
      navRetries++
      await refreshNavs(failed)
    } else {
      log.warn('Retried failing NAVs 10 times, but some still failed; not updating for those...')
    }
  }

  log.info(`- Finished fetching NAVs in ${(new Date() - navStart)/1000} s`);
}


function calculateCagr(startNAV, endNAV, years) {
  // const cagr = (Math.pow(endNAV / startNAV, 1 / years) - 1) * 100;
  const cagr = ((endNAV / startNAV) ** (1 / years) - 1) * 100;
  // return +cagr.toFixed(2);
  return cagr;
}
function calculateRollingReturns(opts) {
  // const days = (navs[navs.length - 1].date - navs[0].date) / (1000 * 60 * 60 * 24);
  // const years = days / 365;
  // const navsPerYear = navs.length / years;
  // console.log('days:', days, 'navs:', navs.length, years, navsPerYear.toFixed(2), 'navs/year');
  // // console.log(navs[0].date, 'to', navs[navs.length - 1].date, ' count:', navs.length)

  const { navs, windowYears } = opts;
  const startDate = opts.startDate ? new Date(opts.startDate) : navs[0].date
  const navList = navs.slice(navs.findIndex(n => n.date >= startDate))

  // // assume 52 * 7 days in a year so that (date minus 364 days) is guaranteed to be the same day of the week
  // // this helps avoid sitations where previous date is a weekend when there is no NAV data
  // const daysInWindow = windowYears * 52 * 7
  // const latestNAVDate = navList[navList.length - 1].date
  // const cagrs = []
  // for (let i = 0, len = navList.length; i < len; i++) {
  //   const buyNAV = navList[i].nav;
  //   const buyDate = navList[i].date;
  //   let sellDate = new Date(buyDate);
  //   sellDate.setDate(buyDate.getDate() + daysInWindow)
  //   // if sellDate is greater than latest nav date, exit the loop
  //   if (sellDate > latestNAVDate) break

  //   const sellItem = navList.find(i => i.date >= sellDate)
  //   if (sellItem) {
  //     const sellNAV = sellItem.nav
  //     let cagr = calculateCagr(buyNAV, sellNAV, windowYears)
  //     cagrs.push({ buyDate, buyNAV, sellDate, sellNAV, cagr })
  //     // // cagrs.push({ buyDate: buyDateStr, sellDate: sellDateStr, cagr })
  //     // // cagrs.push([windowYears, buyDateStr, sellDateStr, cagr])
  //     // cagrs.push([buyDateStr, sellDateStr, cagr])
  //   }
  // }

  // assume 250 NAV days in a year (actual is 240-241)
  const daysInWindow = windowYears * 250
  const cagrs = []
  const startIndex = navs.findIndex(n => n.date >= startDate)
  if (startIndex < 0) return cagrs

  const endIndex = navs.length - daysInWindow

  try {
    for (let i = startIndex; i <= endIndex; i++) {
      const buyNAV = navs[i].nav;
      const buyDate = navs[i].date;

      const sellItem = navs[i + daysInWindow]
      if (sellItem) {
        const sellNAV = sellItem.nav
        const sellDate = sellItem.date
        let cagr = calculateCagr(buyNAV, sellNAV, windowYears)
        // cagrs.push({ buyDate, buyNAV, sellDate, sellNAV, cagr })
        cagrs.push([buyDate, buyNAV, sellDate, sellNAV, cagr])
      }
    }
  } catch (error) {
    console.log(opts.fund)
    console.log(startIndex)
    throw error
  }

  return cagrs;
}



function calculateRanks(funds, fundRollingReturns) {
  // calculate fund rank for each period
  let rrsByPeriod = {}
  funds.forEach(({ code }) => {
    const rollingReturns = fundRollingReturns
      ? fundRollingReturns[code]
      : JSON.parse(fs.readFileSync(DATA_DIR+'/rolling-returns/'+code+'.json', 'utf-8')).rollingReturns
    Object.keys(rollingReturns).forEach(years => {
      rollingReturns[years].forEach(([, start, end, cagr]) => {
        const period = `${years}_${start}_${end}`
        rrsByPeriod[period] = rrsByPeriod[period] ?? { period, funds: {} }
        rrsByPeriod[period].funds[code] = cagr
      })
    })
  })
  const fundRanks = {}
  Object.values(rrsByPeriod).forEach(day => {
    // filter out days with less than 3 funds
    if (Object.keys(day.funds).length < 3) return
    const rankedFunds = Object.entries(day.funds).sort((a, b) => b[1] - a[1]).map(([code, cagr], i) => ({ code, cagr, rank: i+1 }))
    rankedFunds.forEach(f => {
      fundRanks[f.code] = fundRanks[f.code] ?? { ranks: [] }
      fundRanks[f.code].ranks.push(f.rank)
    })
  })
  Object.entries(fundRanks).forEach(([code, { ranks }]) => {
    fundRanks[code].avg = fmtNum(calculateAverage(ranks))
  })
  return fundRanks
}


function refreshStats(funds) {
  // #region stats of  interest
  /*
  // s01: No of rolling return entries Index (1 Years)
  // s02: No of rolling return entries Fund (1 years)
  // s03: No of times fund has outperformed index (1 years)
  // s04: (s03/s02) rolling return outperformance Consistency Score

  // s05: upside performance consistency (percent of times fund performed better than category benchmark when benchmark was moving up)
  // s06: downside protection consistency (percent of times fund performed better than category benchmark when benchmark was moving down)

  // upside-capture-ratio = Upside-CAGR-Fund/Upside-CAGR-Index
  // downside-capture-ratio = Downside-CAGR-Fund/Downside-CAGR-Index
  // capture ratio = (upside capture / downside capture) - higher the better
  // upside capture consistency = percent of times upside-capture-ratio was > 100%
  // downside capture consistency = percent of times downside-capture-ratio was < 100%

  // s07: no of times fund outperformed index by 25%
  // s08: no of times fund underperformed index by 25%
  // s09: % outperformance (by 25%)
  // s10: % underperformance (by 25%)

  // srinivesh screener
  // % of various periods where the fund’s CAGR was among the top N in the category
  // % of times when the fund's return was greater than the category median
  // % of times when the fund's return was greater than the category median

  // rolling returns for various periods
  // count, min, max, average, negative-%, positive-%
  // count of outperfromance over index, percent
  // rolling return outperformance consistency score
  // upside performance consistency
  // downside protection consistency

  // trailing returns for various periods

  // stats.alpha = calcAlpha()
  // stats.beta = calcBeta()
  // stats.rSq = calcRSq()
  // stats.stdDev = calcStdDev()
  // stats.sharpe = calcSharpe()



  // risk
  // - beta
  // - standard deviation
  // - tracking error
  // - capture ratio
  // - value at risk
  // performance
  // - alpha
  // - sharpe ratio
  // - rolling returns
  // - sortino ratio
  // - treynor ratio
  // cost
  // - AUM
  // - turnover ratio
  // - total expense ratio
  // - management fee
  // - transaction costs
  // - load fees

  // important metrics
  // - rolling returns - done
  // - standard deviation - done
  // - beta
  // - sharpe ratio
  // - AUM
  // - TER
  */
   // #endregion


   const categories = new Set([...funds.map(f => f.category)])

  const allFundRollingRetuns = {}

  const fundStats = funds.map((fund, i) => {
    const startTime = new Date()
    log.debug('stats remaining:', (funds.length - i), ` calculating for: ${fund.code} ${fund.name}`)
    const { nav, returns: rollingReturns } = JSON.parse(fs.readFileSync(`${DATA_DIR}/rolling-returns/${fund.code}.json`, 'utf-8'))
    allFundRollingRetuns[fund.code] = rollingReturns
    // if (nav.count < 500) return null

    // const stats = calculateStats(navs)
    const rollingReturnsStatsByYear = {}
    let allFundRRs = []
    Object.entries(rollingReturns).forEach(([years, cagrs]) => {
      // const { count, min, max, avg, distribution } = rrData
      const cagrValues = cagrs.map(([windowYears, start, end, cagr]) => cagr)
      const count = cagrValues.length
      allFundRRs.push(cagrValues)

      // TODO:
      // overall rank based on avg for each window
      // rank within category based on avg for each window
      // const average = fmtNum(cagrValues.reduce((acc, item) => (acc + item), 0) / cagrValues.length)
      const average = fmtNum(calculateAverage(cagrValues))

      rollingReturnsStatsByYear[years] = {
        count,
        min: fmtNum(Math.min(...cagrValues)),
        max: fmtNum(Math.max(...cagrValues)),
        avg: average,
        stdDev: fmtNum(calculateStandardDeviation(cagrValues, average)),
        median: fmtNum(calculateMedian(cagrValues)),
        distribution: {
          '<0': (count && fmtNum(cagrValues.filter(c => c < 0).length / count * 100)) ?? 0,
          '0-10': (count && fmtNum(cagrValues.filter(c => c >= 0 && c < 10).length / count * 100)) ?? 0,
          '10-20': (count && fmtNum(cagrValues.filter(c => c >= 10 && c < 20).length / count * 100)) ?? 0,
          '20-30': (count && fmtNum(cagrValues.filter(c => c >= 20 && c < 30).length / count * 100)) ?? 0,
          '>30': (count && fmtNum(cagrValues.filter(c => c >= 30).length / count * 100)) ?? 0,
        }
      }
    })

    allFundRRs = allFundRRs.flat()
    const overallCount = allFundRRs.length
    // const overallAverage = fmtNum(allFundRRs.reduce((acc, item) => (acc + item), 0) / allFundRRs.length)
    const overallAverage = fmtNum(calculateAverage(allFundRRs))
    const rollingReturnsStatsOverall = {
      count: overallCount,
      min: fmtNum(Math.min(...allFundRRs)),
      max: fmtNum(Math.max(...allFundRRs)),
      avg: overallAverage,
      stdDev: fmtNum(calculateStandardDeviation(allFundRRs, overallAverage)),
      median: fmtNum(calculateMedian(allFundRRs)),
      distribution: {
        '<0': (overallCount && fmtNum(allFundRRs.filter(c => c < 0).length / overallCount * 100)) ?? 0,
        '0-10': (overallCount && fmtNum(allFundRRs.filter(c => c >= 0 && c < 10).length / overallCount * 100)) ?? 0,
        '10-20': (overallCount && fmtNum(allFundRRs.filter(c => c >= 10 && c < 20).length / overallCount * 100)) ?? 0,
        '20-30': (overallCount && fmtNum(allFundRRs.filter(c => c >= 20 && c < 30).length / overallCount * 100)) ?? 0,
        '>30': (overallCount && fmtNum(allFundRRs.filter(c => c >= 30).length / overallCount * 100)) ?? 0,
      }
    }

    const duration = new Date() - startTime
    const stats = {
      duration,
      nav,
      rollingReturnStats: {
        overall: rollingReturnsStatsOverall,
        byYear: rollingReturnsStatsByYear,
      }
    }

    return { ...fund, stats }
  })


  // TODO
  // // calculate ranks within category
  // categories.forEach(cat => {
  //   log.debug('Calculating ranks for '+cat)
  //   const catFunds = funds.filter(f=>f.category === cat)
  //   const fundRanks = calculateRanks(catFunds, allFundRollingRetuns)
  //   Object.entries(fundRanks).forEach(([code, rank]) => {
  //     const fundItem = fundStats.find(f => f.code === code)
  //     fundItem.stats.rollingReturnStats.overall.avgRank = rank.avg
  //   })
  // })


  // // #region categoryStats
  // // calculate category average
  // const categoryStats = {}
  // // const fundsStats = JSON.parse(fs.readFileSync(`${DATA_DIR}/fund-stats.json`))
  // categories.forEach(cat => {
  //   categoryStats[cat] = {
  //     name: cat,
  //     rollingReturnStats: {
  //       overall: {},
  //       byYear: {},
  //     }
  //   }
  //   const categoryFundAverages = fundStats
  //     .filter(f => f.category===cat)
  //     .map(f => f.stats.rollingReturnStats.overall.avg)
  //     .filter(avg => avg)
  //   categoryStats[cat].rollingReturnStats.overall = {
  //     avg: fmtNum(calculateAverage(categoryFundAverages)),
  //     median: fmtNum(calculateMedian(categoryFundAverages)),
  //     min: Math.min(...categoryFundAverages),
  //     max: Math.max(...categoryFundAverages),
  //   }
  //   ROLLING_RETURNS_WINDOWS.forEach((years) => {
  //     const categoryFundAverages = fundStats
  //       .filter(f => f.category===cat)
  //       .map(f => f.stats.rollingReturnStats.byYear[years].avg)
  //       .filter(avg => avg !== 0)
  //     categoryStats[cat].rollingReturnStats.byYear[years] = {
  //       avg: fmtNum(calculateAverage(categoryFundAverages)),
  //       median: fmtNum(calculateMedian(categoryFundAverages)),
  //       min: Math.min(...categoryFundAverages),
  //       max: Math.max(...categoryFundAverages),
  //     }
  //   })
  // })
  // // console.log(categoryStats['Open Ended Schemes(Equity Scheme - Small Cap Fund)'])
  // // #endregion


  fs.writeFileSync(`${DATA_DIR}/fund-stats.json`, JSON.stringify({
    fundStats,
    // categoryStats
  }, 0, 2))
  return {
    fundStats,
    // categoryStats
  }
}



function generateReportCsv({ fundStats, categoryStats }) {
  const statsCsvRows = []
  fundStats.forEach(fund => {
    const { code, name, scheme, category, aum, stats } = fund
    const { rollingReturnStats } = stats

    const categoryParts = category.replaceAll(',', ' ').split(' - ')
    const categorySimple = categoryParts[1] ?? categoryParts[0]

    let row = {
      category: categorySimple,
      name: name.replaceAll(',', ' '),
      shortlist: '',
      code,
      scheme: scheme.replaceAll(',', ' '),
      aum,
      earliestNavDate: stats.nav.earliestNavDate,
      navCount: stats.nav.count,
    }

    row['cat-avg'] = categoryStats?.[fund.category].rollingReturnStats.overall.avg
    row['rr-all-rank'] = rollingReturnStats.overall.avgRank ?? ''
    row['rr-all-avg'] = rollingReturnStats.overall.avg ?? ''
    Object.entries(rollingReturnStats.byYear).forEach(([years, rrStats]) => {
      // row[`rr-${years}-avg`] = Math.round(rrStats.avg ?? '')
      row[`rr-${years}-avg`] = rrStats.avg ?? ''
    });

    row['rr-all-count'] = rollingReturnStats.overall.count ?? ''
    row['rr-all-avg-'] = rollingReturnStats.overall.avg ?? ''
    row['rr-all-stddev'] = rollingReturnStats.overall.stdDev ?? ''
    row['rr-all-median'] = rollingReturnStats.overall.median ?? ''
    row['rr-all-min'] = rollingReturnStats.overall.min ?? ''
    row['rr-all-max'] = rollingReturnStats.overall.max ?? ''
    Object.entries(rollingReturnStats.overall.distribution ?? {}).forEach(([range, dist]) => {
      row[`rr-all-dist-${range}`] = dist ?? ''
    })

    // const interestedYears = [12,10,8,5,3,2,1]
    const interestedYears = ROLLING_RETURNS_WINDOWS
    interestedYears.forEach(years => {
      const rrStats = rollingReturnStats.byYear[years]
      row[`rr-${years}-count`] = rrStats.count ?? ''
      row[`rr-${years}-avg-`] = rrStats.avg ?? ''
      row[`rr-${years}-stddev`] = rrStats.stdDev ?? ''
      row[`rr-${years}-median`] = rrStats.median ?? ''
      row[`rr-${years}-min`] = rrStats.min ?? ''
      row[`rr-${years}-max`] = rrStats.max ?? ''
      Object.entries(rrStats.distribution ?? {}).forEach(([range, dist]) => {
        row[`rr-${years}-dist-${range}`] = dist ?? ''
      })
    })

    // Object.entries(rollingReturnsStatsByYear).forEach(([years, rrStats]) => {
    //   row[`rr-${years}-count`] = rrStats.count ?? ''
    // })
    // Object.entries(rollingReturnsStatsByYear).forEach(([years, rrStats]) => {
    //   Object.entries(rrStats.distribution ?? {}).forEach(([range, dist]) => {
    //     row[`rr-${years}-dist-${range}`] = dist ?? ''
    //   })
    // })
    // console.log(row)
    // console.log(fund.stats.rollingReturnsStats.map(({avg}) => (avg ?? 0)).join(' '))
    statsCsvRows.push(row)
  })
  // const headerRow = Object.keys(statsCsvRows[1]).join(',')
  // return headerRow + '\n' + statsCsvRows.map(row => Object.values(row).join(',')).join('\n')
  return statsCsvRows.length ? toCsv(statsCsvRows) : ''
}









async function main() {
  const start = new Date()

  const steps = {
    // REFRESH_FUNDS_LIST: true,
    // REFRESH_NAVS: true,
    // REFRESH_ROLLING_RETURNS: true,
    // REFRESH_STATS: true,
    // REFRESH_REPORT : true,
  }

  if (!fs.existsSync(DATA_DIR)){
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (steps.REFRESH_FUNDS_LIST) {
    log.info(`Downloading www.amfiindia.com/spages/NAVOpen.txt`)
    // NOTE: https://www.amfiindia.com/nav-history-download
    const amfiData = await http('https://www.amfiindia.com/spages/NAVOpen.txt')
    if (amfiData.status === 200) {
      // log.info(amfiData)
      fs.writeFileSync(DATA_DIR+'/NAVOpen.txt', amfiData.body)
      log.info(`- Saved NAVOpen.txt`)
    }

    log.info('Parsing raw funds data')
    let fundsData = parseAMFIFunds(fs.readFileSync(DATA_DIR+'/NAVOpen.txt', 'utf-8'))
    log.info('- Funds count:', fundsData.funds.length)
    fs.writeFileSync(DATA_DIR+'/funds-all.json', JSON.stringify(fundsData, null, 2))
    log.info(`- Saved funds-all.json`)
  }


  const { funds, categories } = JSON.parse(fs.readFileSync(DATA_DIR+'/funds-all.json', 'utf-8'))

  log.info('Filtering funds...')
  let selectedFunds = funds
  log.info('- All funds count:', selectedFunds.length)
  selectedFunds = selectedFunds.filter(fund => !fund.name.match(/idcw/i))
  selectedFunds = selectedFunds.filter(fund => !fund.name.match(/dividend/i))
  selectedFunds = selectedFunds.filter(fund => !fund.name.match(/Income Distribution cum Capital Withdrawal/i))
  selectedFunds = selectedFunds.filter(fund => !fund.name.match(/regular plan/i))
  selectedFunds = selectedFunds.filter(fund => !fund.name.match(/regular - /i))
  // selectedFunds = selectedFunds.filter(fund => !fund.name.match(/bonus/i))
  // selectedFunds = selectedFunds.filter(fund => fund.category.match(/Equity|Other|Hybrid/i))
  // selectedFunds = selectedFunds.filter(fund => fund.nav !== '0')

  // for debugging
  // selectedFunds = selectedFunds.slice(0, 10)
  // selectedFunds = funds.filter(f => ['118834'].includes(f.code))
  // selectedFunds = funds.filter(f => f.category.includes('Large'))
  // selectedFunds = funds.filter(f => ['153397', '153420', '153442'].includes(f.code))
  // selectedFunds = funds.filter(f => f.name.match(/direct/i) && f.name.match(/regular/i))

  // selectedFunds.forEach(fund => { console.info(fund.code, fund.category, fund.name) })
  log.info('- Selected funds count:', selectedFunds.length)
  // fs.writeFileSync(`${DATA_DIR}/funds-selected.json`, JSON.stringify(selectedFunds, null, 2));
  // log.info('- Saved funds-selected.json');


  if (steps.REFRESH_NAVS) {
    await refreshNavs(selectedFunds);
  }


  // selectedFunds = selectedFunds.slice(0, 5)
  // selectedFunds = selectedFunds.filter(f => f.code==='100872')
  console.log(selectedFunds.length)

  selectedFunds.forEach((fund, i) => {
    // console.log(fund)
    // log.debug('rolling-returns remaining:', (selectedFunds.length - i), ` calculating for: ${fund.code} ${fund.name}`)
    console.log('Processing fund:', i+1, '/', selectedFunds.length, fund.code, fund.category, fund.name)
    const navs = fs.readFileSync(`${DATA_DIR}/navs/${fund.code}.csv`, 'utf-8').split('\n').slice(1).reverse().map(line => {
      const [date, nav] = line.split(',')
      return { date: new Date(date), nav: +nav }
    });
    // console.log(navs)

    fund.navCount = navs.length;
    fund.oldestNAVDate = navs[0].date;
    fund.currentNAV = navs[navs.length - 1].nav;

    let startDate = new Date('2015-01-01');
    let rollingReturns = {};
    ROLLING_RETURNS_WINDOWS.forEach((windowYears) => {
      rollingReturns[`${windowYears}`] = calculateRollingReturns({ fund, navs, windowYears, startDate })
    });
    // console.log(rollingReturns)
    fs.writeFileSync(`${DATA_DIR}/rolling-returns/${fund.code}.json`, JSON.stringify(rollingReturns));
    fund.rollingReturns = {};
  })

  fs.writeFileSync(`${DATA_DIR}/test.json`, JSON.stringify(funds, null, 2));


  if (steps.REFRESH_ROLLING_RETURNS) {
    refreshRollingReturns(selectedFunds)
  }

  if (steps.REFRESH_STATS) {
    log.info('Calculating stats...')
    refreshStats(selectedFunds)
  }

  // const stats = JSON.parse(fs.readFileSync(`${DATA_DIR}/fund-stats.json`))
  // const funds = filterFunds(master.funds)
  //   .filter(f=>f.category === 'Mid Cap Fund')
  //   .sort((a, b) => (+a.code) - (+b.code))
  // const result = calculateRanks(funds)

  if (steps.REFRESH_REPORT) {
    log.info('Generating reports...')
    const stats = JSON.parse(fs.readFileSync(`${DATA_DIR}/fund-stats.json`))
    fs.writeFileSync(`${DATA_DIR}/fund-stats.csv`, generateReportCsv(stats))
  }

  log.info(`Completed in ${(new Date() - start)/1000} s`)

  // if (steps.REFRESH_REPORT) {
  //   log.info('Generating reports...')
  //   const stats = JSON.parse(fs.readFileSync(`${DATA_DIR}/fund-stats.json`))
  //   fs.writeFileSync(`${DATA_DIR}/fund-stats-all.csv`, generateReportCsv(stats))
  //   // fs.writeFileSync(`${DATA_DIR}/fund-stats-large.csv`, generateReportCsv(fundsStats.filter(f => f.category === 'Large Cap Fund')));
  //   // fs.writeFileSync(`${DATA_DIR}/fund-stats-large-mid.csv`, generateReportCsv(fundsStats.filter(f => f.category === 'Large & Mid Cap Fund')));
  //   // fs.writeFileSync(`${DATA_DIR}/fund-stats-mid.csv`, generateReportCsv(fundsStats.filter(f => f.category === 'Mid Cap Fund')));
  //   // fs.writeFileSync(`${DATA_DIR}/fund-stats-small.csv`, generateReportCsv(fundsStats.filter(f => f.category === 'Small Cap Fund')));
  //   // fs.writeFileSync(`${DATA_DIR}/fund-stats-others.csv`, generateReportCsv(fundsStats.filter(f => !['Large Cap Fund', 'Large & Mid Cap Fund', 'Mid Cap Fund', 'Small Cap Fund'].includes(f.category))));
  // }
}
main();
