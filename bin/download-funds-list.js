const fs = require('fs')
const path = require('path')

const axios = require('axios')

const DATA_DIR = './data'


function processCategory(amfiCat) {
  let [, rawCat] = amfiCat.match(/\((.+)\)/)
  let [fundClass, category] = rawCat.split(' - ')
  return { fundClass, category }
}

function parseAMFIFunds(data) {
  data = data.replace(/\r?\n/g, '\n')
  let lines = data.split(/\n/)

  let fundHouses = {}
  let fundClasses = []
  let categories = {}
  let schemes = []
  let rawCategories = []

  let fundHouse
  let fundClass
  let category
  let rawCategory

  const FUND_LINE_REGEX = /^\d+;/

  for (let i = 1; i < lines.length; i++) {
    let line = lines[i]
    if (line === ' ') continue

    if (FUND_LINE_REGEX.test(line)) {
      // line with fund data
      let [code, a, b, name] = line.split(';')
      let growth = !!name.match(/growth/i)
      let scheme = { code, name, fundHouse, rawCategory, fundClass, category, growth }

      schemes.push(scheme)
    } else if (lines[i + 1] === ' ' && FUND_LINE_REGEX.test(lines[i + 2])) {
      // line with fund house data
      fundHouse = line
      fundHouses[fundHouse] = true
    } else if (lines[i + 1] === ' ' && lines[i + 3] === ' ') {
      // line with category data
      rawCategory = line
      let catData = processCategory(rawCategory)
      fundClass = catData.fundClass
      category = catData.category || catData.fundClass
      categories[category] = true
      fundClasses[fundClass] = true
      rawCategories[rawCategory] = true
    }
  }
  return {
    funds: schemes,
    fundHouses: Object.keys(fundHouses),
    fundClasses: Object.keys(fundClasses),
    categories: Object.keys(categories),
    rawCategories: Object.keys(rawCategories),
  }
}

async function downloadFundsList() {
  // let data = fs.readFileSync(path.join(DATA_DIR, '/NAVOpen.txt'), 'utf-8')
  let { data } = await axios.get('https://www.amfiindia.com/spages/NAVOpen.txt')
  fs.writeFileSync(path.join(DATA_DIR, '/NAVOpen.txt'), data)

  let funds = parseAMFIFunds(data)
  fs.writeFileSync(path.join(DATA_DIR, '/funds.json'), JSON.stringify(funds, 0, 2))

  let csv = []
  for (let f of funds.funds) {
    let row = [
      f.code,
      f.fundHouse,
      f.fundClass,
      f.category,
      f.growth,
      f.name,
    ]
    csv.push(row.join(','))
  }
  fs.writeFileSync(path.join(DATA_DIR, '/funds.csv'), csv.join('\n'))

  console.log(funds)
  return funds
}

module.exports = {
  downloadFundsList,
}

async function main() {
  await downloadFundsList()
  console.log(`check '${DATA_DIR}' folder`)
}

main()
