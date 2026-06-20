#!/usr/bin/env node
/**
 * 从基金列表图片提取基金代码后，批量获取净值并生成 converted_holdings.json
 * 数据源：天天基金网 fundgz.1234567.com.cn
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUTPUT = path.join(ROOT, 'converted_holdings.json')

// ========== 从3张图片中提取的基金数据 ==========
// code: 6位基金代码 / sector: 图片中关联板块 / rawName: 图片中显示的名称
const RAW_FUNDS = [
  // --- 第1张图片 ---
  { code: '012700', sector: '证券',     rawName: '易方达中证全指证券公司ETF' },
  { code: '015927', sector: '光伏',     rawName: '西部利得绿色能源混合A' },
  { code: '021634', sector: '香港科技', rawName: '招商中证香港科技ETF发起式' },
  { code: '024460', sector: '港股科技', rawName: '华商致远回报C' },
  { code: '018927', sector: '电池',     rawName: '南方中证电池主题指数' },
  { code: '013416', sector: '医疗器械', rawName: '永赢中证全指医疗器械ETF' },
  { code: '290008', sector: '锂矿',     rawName: '泰信发展主题混合' },
  { code: '159310', sector: '',         rawName: '天弘中证芯片产业ETF' },
  { code: '159898', sector: '',         rawName: '招商中证全指医疗器械ETF' },
  { code: '588200', sector: '',         rawName: '嘉实上证科创板芯片ETF' },
  { code: '004433', sector: '申万有色', rawName: '南方中证申万有色金属ETF' },

  // --- 第2张图片 ---
  { code: '014109', sector: '大盘股',   rawName: '融通内需驱动混合C' },
  { code: '019144', sector: '商业航天', rawName: '东财景气驱动混合发起式C' },
  { code: '025637', sector: '脑机接口', rawName: '泰信互联网+主题混合C' },
  { code: '017193', sector: '工业有色', rawName: '天弘中证工业有色金属' },
  { code: '159157', sector: '工业有色', rawName: '天弘中证工业有色金属ETF' },
  { code: '014408', sector: '机器人',   rawName: '创金合信兴选产业趋势混合' },
  { code: '019875', sector: '稀有金属', rawName: '广发中证稀有金属ETF发起式' },
  { code: '017811', sector: '半导体材料', rawName: '东方人工智能主题混合C' },
  { code: '011892', sector: 'CPO',      rawName: '易方达先锋成长混合C' },
  { code: '024481', sector: 'CPO',      rawName: '财通品质甄选C' },
  { code: '013157', sector: '高端制造', rawName: '前海开源新经济混合C' },

  // --- 第3张图片 ---
  { code: '005359', sector: '国产算力', rawName: '东方阿尔法精选混合C' },
]

// ========== API: 获取基金净值 ==========
function fetchFundInfo(code) {
  return new Promise((resolve, reject) => {
    // 通过系统 HTTP 代理发送请求
    const proxyHost = '127.0.0.1'
    const proxyPort = 18080
    const targetUrl = `http://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`

    const req = http.request(
      {
        host: proxyHost,
        port: proxyPort,
        path: targetUrl,
        method: 'GET',
        headers: {
          'Host': 'fundgz.1234567.com.cn',
          'User-Agent': 'curl/8.0',
          'Accept': '*/*',
        },
        timeout: 10000,
      },
      (res) => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          try {
            const m = data.match(/jsonpgz\((.*)\)/)
            if (!m || !m[1]) return resolve(null)
            resolve(JSON.parse(m[1]))
          } catch { resolve(null) }
        })
      }
    )
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
    req.end()
  })
}

// ========== 主流程 ==========
async function main() {
  console.log(`共 ${RAW_FUNDS.length} 只基金，开始获取最新净值...\n`)

  const holdings = []
  let okCount = 0
  let failCount = 0

  for (let i = 0; i < RAW_FUNDS.length; i++) {
    const item = RAW_FUNDS[i]
    const idx = String(i + 1).padStart(2, '0')
    try {
      const info = await fetchFundInfo(item.code)
      // 解析净值：优先用估算净值 gsz，否则用单位净值 dwjz
      const gsz = parseFloat(info?.gsz || '0')
      const dwjz = parseFloat(info?.dwjz || '0')
      const netValue = gsz > 0 ? gsz : (dwjz > 0 ? dwjz : 1)
      const fundName = info?.name || item.rawName
      const date = info?.gztime || info?.jzrq || ''

      holdings.push({
        code: item.code,
        name: fundName,
        buyNetValue: netValue,
        shares: 0,
        buyDate: date,
        holdingDays: 0,
        industrySectors: item.sector,
        createdAt: Date.now(),
        source: 'image-ocr',
        isQDII: /QDII|港|海外|全球/i.test(fundName),
      })

      okCount++
      console.log(`  [${idx}] ✓ ${item.code}  ${fundName}  净值:${netValue}  [${item.sector}]`)

      await new Promise(r => setTimeout(r, 350))
    } catch (err) {
      failCount++
      // 失败也保留记录，但用图片中的名称和默认净值
      holdings.push({
        code: item.code,
        name: item.rawName,
        buyNetValue: 1,
        shares: 0,
        buyDate: '',
        holdingDays: 0,
        industrySectors: item.sector,
        createdAt: Date.now(),
        source: 'image-ocr-fallback',
        isQDII: false,
      })
      console.log(`  [${idx}] ✗ ${item.code}  ${item.rawName}  获取失败 (${err.message})`)
    }
  }

  // ========== 生成输出 ==========
  const result = {
    version: '1.0',
    exportDate: new Date().toISOString(),
    source: '3张基金列表图片',
    fundCount: holdings.length,
    holdings: holdings,
    summary: {
      totalValue: 0,
      totalProfit: 0,
      totalProfitRate: 0,
      todayProfit: 0,
      note: '⚠️ 图片为基金观察列表，不含持仓金额。totalValue/totalProfit 需用户手动补充持仓金额后计算。',
    },
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2), 'utf-8')

  console.log(`\n=============================`)
  console.log(`成功: ${okCount} 只  |  失败: ${failCount} 只`)
  console.log(`JSON已生成: ${OUTPUT}`)
  console.log(`=============================`)
  console.log(`\n提示: 图片仅显示基金列表，不含持仓金额/份额。`)
  console.log(`如需计算持仓，请编辑 JSON 中每只基金的 buyNetValue(买入净值) 和 shares(份额)。`)
}

main().catch(err => {
  console.error('执行失败:', err)
  process.exit(1)
})
