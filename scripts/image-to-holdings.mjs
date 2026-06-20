#!/usr/bin/env node
/**
 * 图片持仓识别工具
 * 功能：从基金持仓截图中 OCR 识别文字，解析持仓信息，匹配基金代码，获取最新净值，输出 JSON
 * 用法：node scripts/image-to-holdings.mjs <图片路径> [输出路径]
 */

import Tesseract from 'tesseract.js'
import https from 'https'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ========== 1. 参数解析 ==========
const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('用法: node scripts/image-to-holdings.mjs <图片路径> [输出JSON路径]')
  console.error('示例: node scripts/image-to-holdings.mjs ./screenshot.png ./output.json')
  process.exit(1)
}
const imagePath = path.resolve(args[0])
const outputPath = args[1] ? path.resolve(args[1]) : path.join(ROOT, 'recognized_holdings.json')

if (!fs.existsSync(imagePath)) {
  console.error('图片文件不存在:', imagePath)
  process.exit(1)
}

// ========== 2. 工具函数 ==========
function log(msg) {
  const t = new Date().toISOString().slice(11, 19)
  console.log(`[${t}] ${msg}`)
}

function normalizeName(name) {
  return name
    .replace(/\s+/g, '')
    .replace(/[()（）]/g, '')
    .toLowerCase()
}

function parseAmount(amountStr) {
  let cleaned = String(amountStr).replace(/[,¥￥\s]/g, '')
  const parts = cleaned.split('.')
  if (parts.length > 2) {
    const frac = parts.pop()
    cleaned = parts.join('') + '.' + frac
  }
  const amount = parseFloat(cleaned)
  return isNaN(amount) ? 0 : amount
}

function cleanFundName(name) {
  return name
    .replace(/持有|金额|收益|份额|净值|估值/g, '')
    .replace(/[¥￥%]/g, '')
    .trim()
}

function collapseChineseSpacing(text) {
  if (!text) return text
  let prev = text
  let next = prev.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2')
  while (next !== prev) {
    prev = next
    next = prev.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2')
  }
  return next
}

function isValidFundCode(code) {
  if (/^20[0-9]{4}$/.test(code)) return false
  if (/^[0-2]\d{5}$/.test(code)) {
    const hh = parseInt(code.slice(0, 2))
    const mm = parseInt(code.slice(2, 4))
    const ss = parseInt(code.slice(4, 6))
    if (hh <= 23 && mm <= 59 && ss <= 59) return false
  }
  return true
}

// ========== 3. 相似度计算（编辑距离）==========
function calcSimilarity(str1, str2) {
  const len1 = str1.length
  const len2 = str2.length
  if (len1 === 0) return len2 === 0 ? 100 : 0
  if (len2 === 0) return 0
  const dp = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(null))
  for (let i = 0; i <= len1; i++) dp[i][0] = i
  for (let j = 0; j <= len2; j++) dp[0][j] = j
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  const max = Math.max(len1, len2)
  return ((max - dp[len1][len2]) / max) * 100
}

// ========== 4. 从文本中解析持仓 ==========
function parseHoldingsFromText(text) {
  const holdings = []
  const normalized = collapseChineseSpacing(text)
  const rawLines = normalized.split('\n').map(l => l.trim()).filter(Boolean)

  // 预处理行合并
  let lines = rawLines.slice()

  // 合并名称(代码) 格式
  lines = lines.map(line => {
    const m = line.match(/([\u4e00-\u9fa5A-Za-z0-9·\s]+)[（(](\d{6})[)）]/)
    if (m) return `${m[1].trim()} ${m[2]}`
    return line
  })

  // 合并单独的 C/A 类行到上一行
  const res = []
  for (const line of lines) {
    const t = line.trim()
    if (res.length > 0 && (/^[AC]$/.test(t) || /^[AC]类$/.test(t))) {
      res[res.length - 1] = `${res[res.length - 1]} ${t}`
    } else {
      res.push(line)
    }
  }
  lines = res

  // 合并纯名称行和下一行
  const merged = []
  let buf = ''
  for (const line of lines) {
    if (/^\d{6}$/.test(line) && buf) {
      merged.push(`${buf} ${line}`)
      buf = ''
    } else if (/^[A-Za-z\u4e00-\u9fa5]+[A-Za-z0-9\u4e00-\u9fa5]*$/.test(line) && !/\d/.test(line)) {
      buf = line
    } else {
      if (buf) { merged.push(`${buf} ${line}`); buf = '' }
      else merged.push(line)
    }
  }
  if (buf) merged.push(buf)
  lines = merged

  // 逐行解析
  for (const line of lines) {
    // 模式1: 代码 + 名称 + 金额
    let m = line.match(/(\d{6})\s*([A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5]*)\s+([\d,]+\.?\d*)/)
    if (m) {
      holdings.push({ code: m[1], name: cleanFundName(m[2]), amount: parseAmount(m[3]), confidence: 0.9 })
      continue
    }
    // 模式2: 名称 + 代码 + 金额
    m = line.match(/([A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5]*)\s*(\d{6})\s+([\d,]+\.?\d*)/)
    if (m) {
      holdings.push({ code: m[2], name: cleanFundName(m[1]), amount: parseAmount(m[3]), confidence: 0.9 })
      continue
    }
    // 模式3: 代码 + 金额
    m = line.match(/(\d{6})\s+([\d,]+\.?\d*)/)
    if (m && parseAmount(m[2]) >= 100) {
      const code = m[1]
      holdings.push({ code, name: '', amount: parseAmount(m[2]), confidence: 0.7 })
      continue
    }
    // 模式4: 名称 + 金额 (支付宝风格)
    m = line.match(/([A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5]{2,})\s*.*?[¥￥]?\s*([\d,]+\.?\d{2})/)
    if (m) {
      const amt = parseAmount(m[2])
      if (amt >= 100) {
        const codeMatch = line.match(/\d{6}/)
        holdings.push({
          code: codeMatch ? codeMatch[0] : '',
          name: cleanFundName(m[1]),
          amount: amt,
          confidence: 0.6
        })
        continue
      }
    }
  }

  // 回退：从全文中提取 code 和金额的位置配对
  if (holdings.length === 0) {
    const codeRe = /\b(\d{6})\b/g
    const amountRe = /[¥￥]?\s*(\d{1,3}(?:,?\d{3})*(?:\.\d+)?|\d+)(?!\d)/g
    const codes = []
    const amounts = []
    let mm
    while ((mm = codeRe.exec(normalized)) !== null) {
      if (isValidFundCode(mm[1])) codes.push({ code: mm[1], idx: mm.index })
    }
    while ((mm = amountRe.exec(normalized)) !== null) {
      const amt = parseAmount(mm[1])
      if (amt >= 100) amounts.push({ amount: amt, idx: mm.index })
    }
    for (const c of codes) {
      let best = null, bestDist = Infinity
      for (const a of amounts) {
        const dist = Math.abs(a.idx - c.idx)
        if (dist < bestDist) { bestDist = dist; best = a }
      }
      const left = Math.max(0, c.idx - 40)
      const ctx = normalized.slice(left, c.idx)
      const nm = ctx.match(/([\u4e00-\u9fa5·]{2,15})\s*$/)
      holdings.push({
        code: c.code,
        name: nm ? cleanFundName(nm[1]) : '',
        amount: best ? best.amount : 0,
        confidence: 0.4
      })
    }
  }

  return holdings
}

// ========== 5. 基金名称匹配（从 fund-list.json）==========
function matchFundCode(holding, fundList) {
  if (holding.code) {
    const exact = fundList.find(f => f.code === holding.code)
    if (exact) return { ...exact, score: 100, matchType: '精确匹配' }
  }
  if (!holding.name) return null
  const norm = normalizeName(holding.name)
  let best = null, bestScore = 0
  for (const fund of fundList) {
    const sim = calcSimilarity(norm, normalizeName(fund.name))
    let bonus = 0
    if (fund.name.substring(0, 2) === holding.name.substring(0, 2)) bonus += 20
    if (holding.name.includes('A') === fund.name.includes('A') &&
        holding.name.includes('C') === fund.name.includes('C')) bonus += 10
    const total = sim + bonus
    if (total > bestScore) { bestScore = total; best = fund }
  }
  return bestScore >= 50 ? { ...best, score: bestScore, matchType: '模糊匹配' } : null
}

// ========== 6. 获取基金净值（天天基金网 API）==========
function fetchNetValue(code) {
  return new Promise((resolve, reject) => {
    const url = `https://fundgz.1234567.com.cn/js/${code}.js`
    https.get(url, { headers: { 'Referer': 'https://fund.eastmoney.com/' } }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const m = data.match(/jsonpgz\((.*)\)/)
          if (!m) return reject(new Error(`无法解析 ${code}`))
          const d = JSON.parse(m[1])
          resolve({
            netValue: parseFloat(d.dwjz || d.gsz || 0),
            date: d.jzrq || '',
            name: d.name || '',
          })
        } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

// ========== 主函数 ==========
async function main() {
  log('开始处理图片:', path.basename(imagePath))

  // 第一步: OCR 识别
  log('步骤 1/3: 正在进行 OCR 文字识别 (中文+英文)...')
  const ocrResult = await Tesseract.recognize(imagePath, 'chi_sim+eng', {
    logger: m => {
      if (m.status && m.progress) {
        const pct = Math.round(m.progress * 100)
        if (pct % 20 === 0) log(`  OCR 进度: ${pct}% - ${m.status}`)
      }
    }
  })
  const rawText = ocrResult.data.text
  log(`  OCR 完成，识别到 ${rawText.length} 字符`)
  if (rawText.length < 20) {
    console.warn('警告: 识别到的字符较少，图片可能不清晰')
  }

  // 第二步: 解析文本提取持仓
  log('步骤 2/3: 正在解析持仓数据...')
  const parsed = parseHoldingsFromText(rawText)
  log(`  初步解析到 ${parsed.length} 条持仓记录`)

  if (parsed.length === 0) {
    console.error('未从图片中识别到任何持仓信息')
    console.error('原始识别文本前300字符:', rawText.slice(0, 300))
    process.exit(1)
  }

  // 第三步: 匹配基金代码 & 获取净值
  log('步骤 3/3: 匹配基金代码并获取最新净值...')
  const fundList = JSON.parse(fs.readFileSync(path.join(ROOT, 'fund-list.json'), 'utf-8'))
  log(`  已加载 ${fundList.length} 只基金数据`)

  const finalHoldings = []
  let totalValue = 0, totalProfit = 0

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i]
    const matched = matchFundCode(item, fundList)
    if (!matched) {
      log(`  [${i + 1}/${parsed.length}] 未匹配到基金: ${item.name || item.code}`)
      continue
    }

    try {
      const { netValue, date, name } = await fetchNetValue(matched.code)
      const shares = item.amount > 0 && netValue > 0 ? item.amount / netValue : 0

      finalHoldings.push({
        code: matched.code,
        name: name || matched.name,
        buyNetValue: netValue,
        shares: shares,
        buyDate: date,
        holdingDays: 0,
        industrySectors: '',
        createdAt: Date.now(),
        source: 'ocr',
        isQDII: (name || '').toLowerCase().includes('qdii') || matched.name.includes('QDII')
      })

      totalValue += item.amount
      log(`  [${i + 1}/${parsed.length}] ${matched.code} ${matched.name} 金额:¥${item.amount.toFixed(2)} 净值:${netValue} (${date})`)

      await new Promise(r => setTimeout(r, 200))
    } catch (err) {
      log(`  [${i + 1}/${parsed.length}] 获取净值失败: ${matched.code} ${matched.name}`)
      finalHoldings.push({
        code: matched.code,
        name: matched.name,
        buyNetValue: 1,
        shares: item.amount,
        buyDate: new Date().toISOString().slice(0, 10),
        holdingDays: 0,
        industrySectors: '',
        createdAt: Date.now(),
        source: 'ocr',
        isQDII: matched.name.includes('QDII')
      })
      totalValue += item.amount
    }
  }

  // 生成输出
  const result = {
    version: '1.0',
    exportDate: new Date().toISOString(),
    ocrTextLength: rawText.length,
    rawOcrText: rawText.slice(0, 2000),
    holdings: finalHoldings,
    summary: {
      totalValue: totalValue,
      totalProfit: 0,
      totalProfitRate: 0,
      todayProfit: 0,
      recognizedCount: parsed.length,
      matchedCount: finalHoldings.length,
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2))
  log(' ')
  log('======================================')
  log(`处理完成! 共识别 ${parsed.length} 条，成功匹配 ${finalHoldings.length} 只基金`)
  log(`总资产估值: ¥${totalValue.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`)
  log(`输出文件: ${outputPath}`)
  log('======================================')
}

main().catch(err => {
  console.error('处理失败:', err)
  process.exit(1)
})
