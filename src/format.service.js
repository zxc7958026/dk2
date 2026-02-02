/**
 * format.service：處理訂購格式和顯示格式
 * - 驗證訂購格式規範
 * - 根據訂購格式驗證使用者輸入
 * - 根據顯示格式模板格式化查詢結果
 */

import { getWorldById } from './world.service.js';

/**
 * 驗證訂購格式規範 JSON
 * @param {string} formatJson - JSON 字串
 * @returns {Object|null} 解析後的格式規範或 null
 */
export function validateOrderFormat(formatJson) {
  try {
    const format = JSON.parse(formatJson);
    if (!format || typeof format !== 'object') return null;
    
    // 支援兩種格式：
    // 1. { requiredFields: [], itemFormat: 'string' } - 舊格式
    // 2. { items: [{ name: string, attributes: [] }] } - 新格式（客戶訂單格式）
    if (format.items) {
      // 新格式：檢查 items 是否為陣列
      if (!Array.isArray(format.items)) return null;
      // 驗證每個 item 的格式
      for (const item of format.items) {
        if (!item || typeof item !== 'object') return null;
        if (typeof item.name !== 'string') return null;
        if (item.attributes && !Array.isArray(item.attributes)) return null;
      }
      return format;
    } else {
      // 舊格式：{ requiredFields: [], itemFormat: 'string' }
      if (!Array.isArray(format.requiredFields)) return null;
      if (format.itemFormat && typeof format.itemFormat !== 'string') return null;
      return format;
    }
  } catch {
    return null;
  }
}

/**
 * 驗證顯示格式模板 JSON
 * @param {string} formatJson - JSON 字串
 * @returns {Object|null} 解析後的格式模板或 null
 */
export function validateDisplayFormat(formatJson) {
  try {
    const format = JSON.parse(formatJson);
    if (!format || typeof format !== 'object') return null;
    
    // 基本格式：{ template: 'string', showUsers: boolean, sortBy: 'string' }
    if (!format.template || typeof format.template !== 'string') return null;
    
    return format;
  } catch {
    return null;
  }
}

/**
 * 根據訂購格式規範驗證使用者輸入
 * @param {string} itemName - 品項名稱
 * @param {Object|null} orderFormat - 訂購格式規範
 * @returns {boolean} 是否符合格式
 */
export function validateItemByOrderFormat(itemName, orderFormat) {
  if (!orderFormat) return true; // 沒有格式規範則不驗證
  
  // 如果設定了 requiredFields，檢查品項名稱是否包含這些欄位
  if (orderFormat.requiredFields && orderFormat.requiredFields.length > 0) {
    for (const field of orderFormat.requiredFields) {
      if (!itemName.includes(field)) {
        return false;
      }
    }
  }
  
  // 如果設定了 itemFormat，使用正則表達式驗證
  if (orderFormat.itemFormat) {
    try {
      const regex = new RegExp(orderFormat.itemFormat);
      if (!regex.test(itemName)) {
        return false;
      }
    } catch {
      // 正則表達式錯誤，忽略
    }
  }
  
  return true;
}

/**
 * 根據顯示格式模板格式化訂單查詢結果
 * @param {Array} orders - 訂單列表
 * @param {Object|null} displayFormat - 顯示格式模板
 * @param {Function} getVendorByItem - 取得品項對應的廠商
 * @returns {string} 格式化後的文字
 */
export function formatOrdersByDisplayFormat(orders, displayFormat, getVendorByItem) {
  if (!displayFormat || !displayFormat.template) {
    // 使用預設格式
    return formatOrdersByVendorDefault(orders, getVendorByItem);
  }
  
  // 建立廠商 -> 分店 -> 品項的結構
  const vendorMap = {};
  
  for (const order of orders) {
    const who = order.lineDisplayName || null;
    for (const item of order.items) {
      const vendor = getVendorByItem(item.name);
      if (!vendorMap[vendor]) vendorMap[vendor] = {};
      if (!vendorMap[vendor][order.branch]) vendorMap[vendor][order.branch] = {};
      const key = item.name;
      if (!vendorMap[vendor][order.branch][key]) {
        vendorMap[vendor][order.branch][key] = { total: 0, byUser: {} };
      }
      const rec = vendorMap[vendor][order.branch][key];
      rec.total += item.qty;
      if (who) rec.byUser[who] = (rec.byUser[who] || 0) + item.qty;
    }
  }
  
  // 根據模板格式化
  let output = '';
  const vendors = Object.keys(vendorMap).sort();
  
  for (const vendor of vendors) {
    const branches = Object.keys(vendorMap[vendor]).sort();
    for (const branch of branches) {
      const items = Object.keys(vendorMap[vendor][branch]).sort();
      for (const itemName of items) {
        const rec = vendorMap[vendor][branch][itemName];
        const names = Object.keys(rec.byUser || {}).filter(Boolean).sort();
        
        // 替換模板變數
        let line = displayFormat.template
          .replace(/\{vendor\}/g, vendor)
          .replace(/\{branch\}/g, branch)
          .replace(/\{item\}/g, itemName)
          .replace(/\{qty\}/g, rec.total);
        
        if (displayFormat.showUsers !== false && names.length > 0) {
          line = line.replace(/\{users\}/g, `(${names.join('、')})`);
        } else {
          line = line.replace(/\{users\}/g, '');
        }
        
        // 處理換行符號
        line = line.replace(/\\n/g, '\n');
        
        output += line + '\n';
      }
    }
  }
  
  return output.trim();
}

/**
 * 預設的格式化函數（原本的 formatOrdersByVendor）
 */
export function formatOrdersByVendorDefault(orders, getVendorByItem) {
  const vendorMap = {};
  
  for (const order of orders) {
    const who = order.lineDisplayName || null;
    for (const item of order.items) {
      const vendor = getVendorByItem(item.name);
      if (!vendorMap[vendor]) vendorMap[vendor] = {};
      if (!vendorMap[vendor][order.branch]) vendorMap[vendor][order.branch] = {};
      const key = item.name;
      if (!vendorMap[vendor][order.branch][key]) {
        vendorMap[vendor][order.branch][key] = { total: 0, byUser: {} };
      }
      const rec = vendorMap[vendor][order.branch][key];
      rec.total += item.qty;
      if (who) rec.byUser[who] = (rec.byUser[who] || 0) + item.qty;
    }
  }

  let output = '';
  const vendors = Object.keys(vendorMap).sort();
  for (const vendor of vendors) {
    output += `${vendor}\n`;
    const branches = Object.keys(vendorMap[vendor]).sort();
    for (const branch of branches) {
      output += ` ${branch}\n`;
      const items = Object.keys(vendorMap[vendor][branch]).sort();
      for (const itemName of items) {
        const rec = vendorMap[vendor][branch][itemName];
        const names = Object.keys(rec.byUser || {}).filter(Boolean).sort();
        const suffix = names.length ? ` (${names.join('、')})` : '';
        output += `    ${itemName} ${rec.total}${suffix}\n`;
      }
    }
  }
  
  return output.trim();
}
