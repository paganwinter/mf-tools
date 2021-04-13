const fs = require('fs')
const path = require('path')

const axios = require('axios')

const DATA_DIR = './data'

function getFundsData() {
  return require('../data/funds.json')
}

function getNav(fundCode) {
  let { data } = require('../data/navs/'+fundCode+'.json')
  if (data) {
    return data.map(dat => {
      let [d, m, y] = dat.date.split('-')
      return {
        date: new Date(`${y}-${m}-${d}`),
        nav: parseFloat(dat.nav),
      }
    })    
  }
  // return []
}

function getIndices() {
  let indices = fs.readFileSync(path.join(DATA_DIR,  'indices.csv'), 'utf-8').split(/\r\n/g)
  return indices
}

function getIndReturns(ind) {
  let { data } = require('../data/indices/'+ind+'.json')
  if (data) {
    return data.map(dat => {
      let [d, m, y] = dat.date.split('-')
      return {
        date: new Date(`${y}-${m}-${d}`),
        nav: parseFloat(dat.nav),
      }
    })    
  }
}


function getBenchmark(fund) {
  const map = {
    'Large Cap Fund': 'NIFTY 100',
    'Large & Mid Cap Fund': 'NIFTY LARGEMIDCAP 250',
    'Mid Cap Fund': 'NIFTY MIDCAP 150',
    'Multi Cap Fund': 'NIFTY LARGEMIDCAP 250',
    'Small Cap Fund': 'NIFTY SMALLCAP 50',
  }
  return map[fund.category]
}

module.exports = {
  getFundsData,
  getNav,
  getIndices,
  getIndReturns,
  getBenchmark,
}
