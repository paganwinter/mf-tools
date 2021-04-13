const fs = require('fs')
const path = require('path')

const axios = require('axios')

const DATA_DIR = './data'


const {
  getFundsData,
} = require('./utils')

async function sleep(ms) {
  return new Promise(function (resolve, reject) {
    setTimeout(function () {
      resolve()
    }, ms)
  })
}

async function fetchNav(schemeCode) {
  try {
    let { data } = await axios.get(`https://api.mfapi.in/mf/${schemeCode}`)
    return { data }
  } catch (error) {
    return { error }
  }
}

async function downloadNavs(funds) {
  for (let f of funds) {
    fetchNav(f.code).then(({ error, data }) => {
      if (error) {
        console.log(' ', f.code, error.message)
        fs.writeFileSync(path.join(DATA_DIR, '/navs/failed/'+f.code), error.message)
        return
      }
      console.log(' ', f.code, 'done')
      fs.writeFileSync(path.join(DATA_DIR, '/navs/'+f.code+'.json'), JSON.stringify(data, 0, 2))
    })
    await sleep(20)
  }
}

async function downloadFailedNavs() {
  let failed = fs.readdirSync(path.join(DATA_DIR, '/navs/failed'))
  for (let fCode of failed) {
    fetchNav(fCode).then(({ error, data }) => {
      if (error) {
        console.log(' ', fCode, error.message)
        return
      }
      console.log(' ', fCode, 'done')
      fs.writeFileSync(path.join(DATA_DIR, '/navs/'+fCode+'.json'), JSON.stringify(data, 0, 2))
      fs.unlinkSync(path.join(DATA_DIR, '/navs/failed/'+fCode))
    })
    await sleep(20)
  }
}


async function main() {
  let { funds } = getFundsData()
  let growthFunds = funds.filter(f => f.name.match(/growth/i))
  let targetFunds = growthFunds
  console.log(targetFunds.length)
  // await downloadNavs(targetFunds)
  console.log(targetFunds.length)

  downloadFailedNavs()
}

main()

