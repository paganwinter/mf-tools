// Index Data:
// https://www1.nseindia.com/products/dynaContent/equities/indices/historicalindices.jsp?indexType=NIFTY 50&fromDate=01-01-2020&toDate=01-10-2020

// Total Return Index:
// https://www1.nseindia.com/products/content/equities/indices/historical_total_return.html
// https://www1.nseindia.com/products/dynaContent/equities/indices/total_returnindices.jsp?indexType=NIFTY 50&fromDate=01-01-2020&toDate=01-10-2020
// https://www1.nseindia.com/products/dynaContent/equities/indices/total_returnindices.jsp?indexType=NIFTY 50&fromDate=01-01-2020&toDate=10-10-2020

const fs = require('fs')
const path = require('path')

const axios = require('axios')
const moment = require('moment')

const { INDICES } = require('../lib/data.js')


const DATA_DIR = './data'

console.log(INDICES)

const startYear = 2006
const endYear = 2021
let years = []
for (let yr = startYear; yr <= endYear; yr++) {
  years.push(yr)
}
years = years.reverse()
console.log(years)


async function sleep(ms) {
  return new Promise(function (resolve, reject) {
    setTimeout(function () {
      resolve()
    }, ms)
  })
}


function parseIndices(htmlStr) {
  let matches = htmlStr.match(/"Total Returns Index":(.+):<\/div>/i)
  let rawIndices = matches[1]

  let indices = rawIndices.split(':').map(r => {
    let [dt, nav] = r.split(',')
    dt = new Date(dt)
    return {
      date: moment(dt).format('DD-MM-yyyy'),
      nav: nav.replace(/"/g, ''),
    }
  })
  // console.log(indices)

  return indices.reverse()
}

async function fetchReturns(ind) {
  const indexType = encodeURIComponent(ind)
  let calls = []
  for (let yr of years) {
    const fromDate = '02-01-'+yr
    const toDate = '31-12-'+yr
    // console.log('  ', toDate)
    const nseUrl = `https://www.nseindia.com/products/dynaContent/equities/indices/total_returnindices.jsp?indexType=${indexType}&fromDate=${fromDate}&toDate=${toDate}`
    console.log(nseUrl)
    calls.push(axios.get(nseUrl))
  }
  try {
    let rawData = await Promise.all(calls)
    let indices = []
    rawData.forEach(yr => {
      let yearlyInd = parseIndices(yr.data)
      indices = indices.concat(yearlyInd)
    })  
    return { data: indices }
  } catch(error) {
    return { error }
  }
}

async function main() {
  for (let ind of INDICES) {
    // console.log(ind)
    fetchReturns(ind)
      .then(({ error, data }) => {
        if (error) return console.log(' failed', ind, error.message)
        // console.log('  got', ind)
        let fileCont = { data }
        fs.writeFileSync(path.join(DATA_DIR, 'indices', ind+'.json'), JSON.stringify(fileCont, 0, 2))
      })
    await sleep(100)
  }
}

main()
