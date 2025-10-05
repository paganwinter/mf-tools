const fs = require('fs')
const path = require('path')

const moment = require('moment')


// selection
// https://freefincal.com/introduction-downside-upside-capture-ratios/
// https://freefincal.com/nov-2017-freefincal-equity-mutual-fund-outperformance-screener/
// https://freefincal.com/equity-mutual-fund-performance-screener-september-2020/
// https://freefincal.com/mutual-fund-downside-protection-importance/
// https://freefincal.com/automated-mutual-fund-screener/
// https://freefincal.com/download-new-versions-mutual-fund-lump-sum-sip-screeners/

// monitoring
// https://freefincal.com/how-to-review-your-mutual-fund-portfolio/
// https://freefincal.com/insight-screening-mutual-funds-consistent-outperformance/


const {
  getFundsData,
  getNav,
} = require('./lib/utils')
const utils = require('./lib/utils')

function fmtNum(num) {
  return num.toFixed(2)
}

function calcCgr(start, end, years) {
  return ((Math.pow(end/start, 1/years) - 1) * 100)
}

/*
function calcRollingReturns_old(navs, years) {
  const offset = years * 365
  let cagrs = []
  const oldestEntryIdx = navs.length - offset
  for (let i = 0; i < oldestEntryIdx; i++) {
    const newest = navs[i]
    const oldest = navs[i + offset]
    const cagr = calcCgr(oldest.nav, newest.nav, years)
    if (cagr < -100) console.log(cagr)
    cagrs.push(cagr)
  }

  let min = '-'
  let max = '-'
  let avg = '-'
  if (cagrs.length > 0) {
    min = fmtNum(Math.min(...cagrs))
    max = fmtNum(Math.max(...cagrs))
    avg = fmtNum(cagrs.reduce((acc, item) => (acc + item), 0) / cagrs.length)
  }

  return { cagrs, min, max, avg }
}
*/

function calcIndexRollingReturns(navs, years) {
  let cagrs = {}
  for (let endDtStr in navs) {
    let startDt = moment(endDtStr).subtract(years, 'years')
    let startDtStr = moment(startDt).format('yyyy-MM-DD')

    if (navs[startDtStr]) {
      let startNav = navs[startDtStr]
      let endNav = navs[endDtStr]
      let cagr = calcCgr(startNav, endNav, years)
      cagrs[`${startDtStr}_${endDtStr}`] = cagr
    }
  }
  return cagrs
}

function calcRollingReturns(navs, years, indexData) {
  let cagrs = []
  let bmBeat = []
  let bmDiff = []
  let overlapCount = 0
  let benchmarkBeatCount = 0

  for (let endDtStr in navs) {
    let startDt = moment(endDtStr).subtract(years, 'years')
    let startDtStr = moment(startDt).format('yyyy-MM-DD')

    if (navs[startDtStr]) {
      let startNav = navs[startDtStr]
      let endNav = navs[endDtStr]
      let cagr = calcCgr(startNav, endNav, years)
      cagrs.push(cagr)

      if (indexData && indexData[years]) {
        let benchmarkCagr = indexData[years][`${startDtStr}_${endDtStr}`]
        if (typeof benchmarkCagr !== 'undefined') {
          overlapCount++
          if (cagr > benchmarkCagr) {
            benchmarkBeatCount++
          }
          // bmBeat.push(cagr > benchmarkCagr)
          bmDiff.push(cagr - benchmarkCagr)
        }  
      }
    }
  }

  let min
  let max
  let avg
  let count = cagrs.length
  let percNeg
  let percPos
  // let benchmarkBeatPerc = fmtNum(bmBeat.filter(beat => beat).length / bmBeat.length * 100)
  // let avgOverBenchmark = fmtNum(bmDiff.reduce((acc, item) => (acc + item), 0) / bmDiff.length)
  let benchmarkBeatPerc
  let avgOverBenchmark

  if (overlapCount) {
    benchmarkBeatPerc = fmtNum(benchmarkBeatCount / overlapCount * 100)
  }
  if (bmDiff.length) {
    avgOverBenchmark = fmtNum(bmDiff.reduce((acc, item) => (acc + item), 0) / bmDiff.length)
  }

  if (cagrs.length > 0) {
    min = fmtNum(Math.min(...cagrs))
    max = fmtNum(Math.max(...cagrs))
    avg = fmtNum(cagrs.reduce((acc, item) => (acc + item), 0) / cagrs.length)
    percNeg = fmtNum(cagrs.filter(c => c < 0).length / count * 100)
    percPos = fmtNum(cagrs.filter(c => c > 0).length / count * 100)
  }
  return { years, cagrs, min, max, avg, count, percNeg, percPos,
    benchmarkBeatPerc,
    avgOverBenchmark,
  }
}


function calculateStats(navs, benchmark) {
  let stats = {}

  // s01: No of rollling return entries Index (1 Years)
  // s02: No of rollling return entries Fund (1 years)
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
  let rollingReturns = []
  for (let i = 1; i <= 10; i++) {
    let rr = calcRollingReturns(navs, i, benchmark)
    rollingReturns.push(rr)
  }
  stats.rollingReturns = rollingReturns

  // trailing returns for various periods

  // stats.alpha = calcAlpha()
  // stats.beta = calcBeta()
  // stats.rSq = calcRSq()
  // stats.stdDev = calcStdDev()
  // stats.sharpe = calcSharpe()

  return stats
}



async function main() {
  let { funds, fundHouses, categories, rawCategories } = getFundsData()
  console.log('Total', funds.length)
  console.log()

  console.log('Fund count by fund house')
  for (let house of fundHouses) {
    let houseFunds = funds.filter(f => f.fundHouse === house)
    console.log(house, houseFunds.length)
  }
  console.log()

  console.log('Fund count by category')
  for (let cat of categories) {
    let catFunds = funds.filter(f => f.category === cat)
    console.log(cat, catFunds.length)
  }
  console.log()

  console.log('Fund count by raw category')
  for (let rawCat of rawCategories) {
    let rawCatFunds = funds.filter(f => f.rawCategory === rawCat)
    console.log(rawCat, rawCatFunds.length)
  }
  console.log()

  /////////////////////////////////////
  // GET INDEX STATS //

  let indices = utils.getIndices()
  let benchmarkMap = {}
  for (let ind of indices) {
    benchmarkMap[ind] = {}
    let retArr = utils.getIndReturns(ind)
    let retMap = {}
    for (let r of retArr) {
      retMap[moment(r.date).format('yyyy-MM-DD')] = r.nav
    }

    for (let i = 1; i <= 10; i++) {
      benchmarkMap[ind][i] = calcIndexRollingReturns(retMap, i)
    }
  }
  console.log('calculated beanchmarks')
  console.log(Object.keys(benchmarkMap))

  /////////////////////////////////////

  let growthFunds = funds.filter(f => f.name.match(/growth/i))
  let equityGrowthFunds = funds.filter(f => {
    return (
      f.name.match(/growth/i)
      && !f.name.match(/direct/i)
      && f.fundClass.match(/Equity Scheme/i)
    )
  })
  let otherSchemeFunds = funds.filter(f => {
    return (
      f.name.match(/growth/i)
      && !f.name.match(/direct/i)
      && f.fundClass.match(/Other Scheme/i)
    )
  })
  let targetFunds = []
    .concat(equityGrowthFunds)
    .concat(otherSchemeFunds)

  // targetFunds = growthFunds.filter(f => {
  //   return (
  //     f.name.match(/mirae asset/i)
  //     && !f.name.match(/direct/i)
  //   )
  // })
  // targetFunds = funds.filter(f => f.code === '118834')

  // console.log(targetFunds)
  console.log('Total', targetFunds.length)
  console.log()
  let rows = []
  for (let fund of targetFunds) {
    let { code, name, fundClass, category } = fund
    let navArr = getNav(code)
    let navMap = {}
    for (let n of navArr) {
      navMap[moment(n.date).format('yyyy-MM-DD')] = n.nav
    }

    let benchmarkName = utils.getBenchmark(fund)
    let benchmarkData = benchmarkMap[benchmarkName]
    fund.stats = calculateStats(navMap, benchmarkData)

    let row = []
    row.push(code)
    row.push(name)
    row.push(fundClass)
    row.push(category)

    let { rollingReturns } = fund.stats
    let avg = rollingReturns.map(r => r.avg)
    let cnt = rollingReturns.map(r => r.count)
    let pos = rollingReturns.map(r => r.percPos)
    let neg = rollingReturns.map(r => r.percNeg)
    let beatPerc = rollingReturns.map(r => r.benchmarkBeatPerc)
    let beatAvg = rollingReturns.map(r => r.avgOverBenchmark)

    row = row
      .concat(avg)
      .concat(beatPerc)
      .concat(beatAvg)
      .concat(pos)
      .concat(neg)
      .concat(cnt)

    // console.log(name.padEnd(50, ' '), neg.join(' '), pos.join(' '))
    rows.push(row.join(','))
    console.log(row.join(' '))
    // console.log(name)
  }
  let csvData = rows.join('\n')
  fs.writeFileSync('./mf-analysis.csv', csvData)

  console.log()
  console.log('Total', targetFunds.length)
  console.log()
}

main()


