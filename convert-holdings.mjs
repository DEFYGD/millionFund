#!/usr/bin/env node

/**
 * 持仓数据转换工具
 * 用途：将截图中的基金持仓数据转换为项目所需的JSON格式
 * 使用方法：node convert-holdings.mjs
 * 
 * 功能特点：
 * 1. 使用项目中的fund-list.json进行精确基金名称匹配
 * 2. 支持模糊匹配（编辑距离算法）
 * 3. 获取最新基金净值计算份额和买入净值
 * 4. 自动识别QDII基金
 * 5. 输出格式与sample.json完全一致
 */

import https from 'https'
import fs from 'fs'

// ==================== 配置参数 ====================
const INPUT_DATA = [
    { name: '浦银安盛全球智能科技(QDII)A', holdingAmount: 74870.07, profit: 21297.00 },
    { name: '华夏全球科技先锋混合(QDII)C', holdingAmount: 116719.41, profit: 20181.60 },
    { name: '银华海外数字经济量化选股混合发起式(QDII)C', holdingAmount: 100992.93, profit: 15742.93 },
    { name: '招商中证半导体产业ETF发起式联接C', holdingAmount: 52249.63, profit: 2903.34 },
    { name: '广发全球精选股票(QDII)人民币C', holdingAmount: 40206.25, profit: 806.25 },
    { name: '东方人工智能主题混合C', holdingAmount: 115460.45, profit: 752.95 }
]

const OUTPUT_FILE = './converted_holdings.json'
const FUND_LIST_FILE = './fund-list.json'
const REQUEST_DELAY = 500 // 请求间隔（毫秒）

// ==================== 工具函数 ====================

/**
 * 规范化基金名称
 */
function normalizeName(name) {
    return name
        .replace(/\s+/g, '')
        .replace(/[()（）]/g, '')
        .toLowerCase()
}

/**
 * 计算字符串相似度（编辑距离算法）
 */
function calculateSimilarity(str1, str2) {
    const len1 = str1.length
    const len2 = str2.length

    if (len1 === 0) return len2 === 0 ? 100 : 0
    if (len2 === 0) return 0

    const matrix = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(null))

    for (let i = 0; i <= len1; i++) matrix[i][0] = i
    for (let j = 0; j <= len2; j++) matrix[0][j] = j

    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            const cost = str1[i - 1] === str2[j - 1] ? 0 : 1
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            )
        }
    }

    const maxLength = Math.max(len1, len2)
    const distance = matrix[len1][len2]
    return ((maxLength - distance) / maxLength) * 100
}

/**
 * 通过基金名称查找基金代码
 */
function findFundCode(name, fundList) {
    // 步骤1：精确匹配
    const exactMatch = fundList.find(fund => fund.name === name)
    if (exactMatch) {
        return {...exactMatch, score: 100, matchType: '精确匹配' }
    }

    // 步骤2：模糊匹配
    const normalizedName = normalizeName(name)
    let bestMatch = null
    let bestScore = 0

    for (const fund of fundList) {
        const similarity = calculateSimilarity(normalizedName, normalizeName(fund.name))

        let bonus = 0
            // 基金公司名称匹配加分
        if (fund.name.substring(0, 2) === name.substring(0, 2)) bonus += 20
            // 基金类型(A/C/E)匹配加分
        const typeMatch = name.includes('A') === fund.name.includes('A') &&
            name.includes('C') === fund.name.includes('C')
        if (typeMatch) bonus += 10

        const totalScore = similarity + bonus
        if (totalScore > bestScore) {
            bestScore = totalScore
            bestMatch = fund
        }
    }

    return bestScore >= 70 ? {...bestMatch, score: bestScore, matchType: '模糊匹配' } :
        null
}

/**
 * 获取基金最新净值（优先使用pingzhongdata接口）
 */
function fetchFundNetValue(code) {
    return new Promise((resolve, reject) => {
        // 优先使用pingzhongdata接口
        const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`

        https.get(url, { headers: { 'Referer': 'https://fund.eastmoney.com/' } }, (res) => {
            let data = ''
            res.on('data', (chunk) => { data += chunk })
            res.on('end', () => {
                try {
                    const match = data.match(/Data_netWorthTrend\s*=\s*(\[.*?\])/)
                    if (match) {
                        const trend = JSON.parse(match[1])
                        if (trend.length > 0) {
                            const latest = trend[trend.length - 1]
                            const fundNameMatch = data.match(/fS_name\s*=\s*['"]([^'"]+)['"]/)
                            const fundName = fundNameMatch ? fundNameMatch[1] : ''
                            resolve({
                                netValue: latest.y,
                                date: latest.x ? new Date(latest.x).toISOString().split('T')[0] : '',
                                changeRate: latest.r || 0,
                                fundName: fundName
                            })
                            return
                        }
                    }
                    throw new Error('无净值数据')
                } catch {
                    // 备用：使用估值接口
                    fetchEstimate(code).then(resolve).catch(reject)
                }
            })
        }).on('error', () => fetchEstimate(code).then(resolve).catch(reject))
    })
}

/**
 * 使用估值接口获取净值（备用）
 */
function fetchEstimate(code) {
    return new Promise((resolve, reject) => {
        const url = `https://fundgz.1234567.com.cn/js/${code}.js`
        https.get(url, { headers: { 'Referer': 'https://fund.eastmoney.com/' } }, (res) => {
            let data = ''
            res.on('data', (chunk) => { data += chunk })
            res.on('end', () => {
                try {
                    const match = data.match(/jsonpgz\((.*)\)/)
                    if (match) {
                        const fundData = JSON.parse(match[1])
                        resolve({
                            netValue: parseFloat(fundData.gsz || fundData.dwjz || '0'),
                            date: fundData.jzrq || '',
                            changeRate: parseFloat(fundData.gszzl || fundData.jzzl || '0'),
                            fundName: fundData.name || ''
                        })
                    } else {
                        reject(new Error('无法解析数据'))
                    }
                } catch (e) {
                    reject(e)
                }
            })
        }).on('error', reject)
    })
}

/**
 * 格式化金额显示
 */
function formatMoney(value) {
    return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ==================== 主函数 ====================
async function main() {
    console.log('========================================')
    console.log('      持仓数据转换工具 v1.0')
    console.log('========================================\n')

    // 1. 读取基金列表
    let fundList
    try {
        const data = fs.readFileSync(FUND_LIST_FILE, 'utf-8')
        fundList = JSON.parse(data)
        console.log(`✓ 已加载 ${fundList.length.toLocaleString()} 只基金数据`)
    } catch (error) {
        console.error(`✗ 读取基金列表失败: ${error.message}`)
        process.exit(1)
    }

    // 2. 处理每只基金
    const holdings = []
    let totalValue = 0,
        totalProfit = 0,
        todayProfit = 0

    for (const item of INPUT_DATA) {
        console.log(`\n────────────────────────────────────────`)
        console.log(`处理: ${item.name}`)

        // 查找基金代码
        const found = findFundCode(item.name, fundList)
        if (!found) {
            console.log(`✗ 无法找到匹配的基金`)
            continue
        }

        console.log(`✓ ${found.matchType}: ${found.code} - ${found.name}`)
        if (found.score < 100) console.log(`  相似度: ${found.score.toFixed(2)}%`)

        // 获取净值
        try {
            const { netValue, date, changeRate, fundName } = await fetchFundNetValue(found.code)
            console.log(`✓ 最新净值: ${netValue} (${date})`)

            // 计算份额和买入净值
            const buyAmount = item.holdingAmount - item.profit
            const shares = item.holdingAmount / netValue
            const buyNetValue = buyAmount / shares

            // 添加到结果
            holdings.push({
                code: found.code,
                name: fundName || found.name,
                buyNetValue: buyNetValue,
                shares: shares,
                buyDate: date,
                holdingDays: 0,
                industrySectors: '',
                createdAt: Date.now(),
                source: 'manual',
                isQDII: item.name.includes('QDII')
            })

            totalValue += item.holdingAmount
            totalProfit += item.profit
            todayProfit += shares * (netValue * changeRate / 100)

            console.log(`✓ 份额: ${shares.toFixed(4)}`)
            console.log(`✓ 买入净值: ${buyNetValue.toFixed(6)}`)
            console.log(`✓ 持仓金额: ${formatMoney(item.holdingAmount)}`)
            console.log(`✓ 持仓收益: +${formatMoney(item.profit)}`)

            // 请求间隔
            await new Promise(r => setTimeout(r, REQUEST_DELAY))
        } catch (error) {
            console.log(`✗ 获取净值失败: ${error.message}`)
        }
    }

    // 3. 计算汇总数据
    const totalCost = totalValue - totalProfit
    const totalProfitRate = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0

    // 4. 生成结果
    const result = {
        version: '1.0',
        exportDate: new Date().toISOString(),
        holdings: holdings,
        summary: {
            totalValue: totalValue,
            totalProfit: totalProfit,
            totalProfitRate: totalProfitRate,
            todayProfit: todayProfit
        }
    }

    // 5. 输出结果
    console.log(`\n────────────────────────────────────────`)
    console.log('转换结果汇总:')
    console.log(`────────────────────────────────────────`)
    console.log(`基金数量: ${holdings.length} 只`)
    console.log(`总资产: ${formatMoney(totalValue)}`)
    console.log(`总收益: ${totalProfit >= 0 ? '+' : ''}${formatMoney(totalProfit)}`)
    console.log(`收益率: ${totalProfitRate >= 0 ? '+' : ''}${totalProfitRate.toFixed(2)}%`)
    console.log(`今日收益: ${todayProfit >= 0 ? '+' : ''}${formatMoney(todayProfit)}`)

    // 6. 保存文件
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2))
    console.log(`\n✓ 结果已保存到: ${OUTPUT_FILE}`)
    console.log('\n========================================')
    console.log('              转换完成')
    console.log('========================================')
}

main().catch(console.error)