/**
 * vendorMap.service：只做 3 件事（針對 worlds.vendorMap 設定）
 * - 檢查 vendorMap 是否存在
 * - 驗證格式對不對
 * - 儲存 vendorMap
 *
 * ❌ 無 LINE 對話文字、fallback、世界是否啟用的決策
 *
 * getVendorByItem / getAllVendorMap 為「品項→廠商」靜態映射（用於老闆查詢分組），一併保留
 */

import { itemToVendor } from '../vendorMap.js';
import { getWorldById } from './world.service.js';

// --- 品項→廠商（用於 formatOrdersByVendor / boss-query）---

export function getVendorByItem(itemName) {
  return itemToVendor[itemName] || '其他';
}

export function getAllVendorMap() {
  return itemToVendor;
}

// --- worlds.vendorMap：檢查、驗證、儲存 ---

/**
 * 檢查某世界的 vendorMap 是否存在並回傳解析後的物件
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @returns {Promise<Object|null>} { [vendor]: { [itemName]: number } } 或 null（vendor 即廠商）
 */
export async function getVendorMap(db, worldId) {
  const world = await getWorldById(db, worldId);
  if (!world?.vendorMap) return null;
  try {
    const parsed = JSON.parse(world.vendorMap);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    console.error('❌ 解析 vendorMap 失敗 (worldId:', worldId, '):', err);
    return null;
  }
}

/**
 * 依品項名稱從世界菜單解析廠商（支援含屬性的品項名，用前綴匹配）
 * @param {string} orderItemName - 訂單品項名（可能含屬性，如「珍珠奶茶 冰塊 糖度」）
 * @param {Object} worldVendorMap - { [vendor]: { [itemName]: number|object } }
 * @returns {string|null} 廠商名稱或 null
 */
export function resolveVendorForItemName(orderItemName, worldVendorMap) {
  if (!orderItemName || typeof orderItemName !== 'string') return null;
  let foundVendor = null;
  let longestKey = '';
  for (const vendor of Object.keys(worldVendorMap)) {
    const itemsInVendor = worldVendorMap[vendor];
    if (!itemsInVendor || typeof itemsInVendor !== 'object') continue;
    for (const menuItemName of Object.keys(itemsInVendor)) {
      const exact = orderItemName === menuItemName;
      const prefix = menuItemName.length > 0 && (orderItemName === menuItemName || orderItemName.startsWith(menuItemName + ' '));
      if (exact || prefix) {
        if (menuItemName.length > longestKey.length) {
          longestKey = menuItemName;
          foundVendor = vendor;
        }
      }
    }
  }
  return foundVendor;
}

/**
 * 驗證文字格式是否為合法 vendorMap，回傳解析後的物件或 null
 * 支援：分店\n  品項 數字；分店:\n  - 品項（qty 0）
 * @param {string} text
 * @returns {Object|null} { [branch]: { [itemName]: number } } 或 null
 */
export function validateVendorMapFormat(text) {
  try {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const config = {};
    let currentBranch = null;
    for (const line of lines) {
      if (!line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('-')) {
        currentBranch = line.replace(/:\s*$/, '');
        if (!config[currentBranch]) config[currentBranch] = {};
      } else {
        if (!currentBranch) return null;
        let itemName = '';
        let qty = 0;
        if (line.startsWith('-')) {
          itemName = line.slice(1).trim();
          qty = 0;
        } else {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 2) return null;
          itemName = parts.slice(0, -1).join(' ');
          qty = parseInt(parts[parts.length - 1]);
          if (isNaN(qty) || qty <= 0) return null;
        }
        if (!itemName) return null;
        config[currentBranch][itemName] = qty;
      }
    }
    if (Object.keys(config).length === 0) return null;
    for (const branch of Object.keys(config)) {
      if (Object.keys(config[branch]).length === 0) return null;
    }
    return config;
  } catch {
    return null;
  }
}

/**
 * 儲存 vendorMap 到指定世界（只寫入 worlds.vendorMap，不改 status）
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @param {Object} parsed - 已解析的 { [branch]: { [itemName]: number } }
 * @returns {Promise<void>}
 */
export function saveVendorMap(db, worldId, parsed) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(parsed);
    db.run(
      'UPDATE worlds SET vendorMap = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [json, worldId],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

/** 取得 vendorMap 中品項的數量（支援 number | {qty, attributes}） */
function getItemQty(value) {
  if (value === null || value === undefined) return 0;
  return typeof value === 'object' && value !== null && typeof value.qty === 'number' ? value.qty : Number(value) || 0;
}

/** 取得 vendorMap 中品項的屬性（選填） */
function getItemAttributes(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value !== null && Array.isArray(value.attributes)) return value.attributes;
  return null;
}

/**
 * 格式化 vendorMap 為可讀的文字格式
 * @param {Object} vendorMap - { [vendor]: { [itemName]: number|{qty,attributes} } }（vendor 即廠商）
 * @returns {string} 格式化的文字
 */
export function formatVendorMap(vendorMap) {
  if (!vendorMap || typeof vendorMap !== 'object') return '菜單為空';
  
  let output = '📋 菜單\n\n';
  const vendors = Object.keys(vendorMap).sort();
  
  for (const vendor of vendors) {
    output += `${vendor}\n`;
    const items = Object.keys(vendorMap[vendor]).sort();
    for (const itemName of items) {
      const val = vendorMap[vendor][itemName];
      const qty = getItemQty(val);
      const attrs = getItemAttributes(val);
      const attrStr = attrs && attrs.length > 0 ? ` [${attrs.join(', ')}]` : '';
      if (qty === 0) {
        output += `  - ${itemName}${attrStr}\n`;
      } else {
        output += `  ${itemName} ${qty}${attrStr}\n`;
      }
    }
    output += '\n';
  }
  
  return output.trim();
}

/**
 * 新增品項到菜單
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @param {string} branch - 廠商名稱（參數名稱保持 branch 以保持向後相容）
 * @param {string} itemName - 品項名稱
 * @param {number} qty - 數量（可選，預設 0）
 * @returns {Promise<boolean>} 是否成功
 */
export async function addItemToMenu(db, worldId, branch, itemName, qty = 0) {
  const vendorMap = await getVendorMap(db, worldId);
  if (!vendorMap) {
    // 如果沒有 vendorMap，建立新的
    const newMap = { [branch]: { [itemName]: qty } };
    await saveVendorMap(db, worldId, newMap);
    return true;
  }
  
  if (!vendorMap[branch]) {
    vendorMap[branch] = {};
  }
  
  vendorMap[branch][itemName] = qty;
  await saveVendorMap(db, worldId, vendorMap);
  return true;
}

/**
 * 從菜單刪除品項
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @param {string} branch - 廠商名稱（參數名稱保持 branch 以保持向後相容）
 * @param {string} itemName - 品項名稱
 * @returns {Promise<boolean>} 是否成功（品項存在則 true，不存在則 false）
 */
export async function removeItemFromMenu(db, worldId, branch, itemName) {
  const vendorMap = await getVendorMap(db, worldId);
  if (!vendorMap || !vendorMap[branch] || !vendorMap[branch][itemName]) {
    return false;
  }
  
  delete vendorMap[branch][itemName];
  
  // 如果分店沒有品項了，刪除分店
  if (Object.keys(vendorMap[branch]).length === 0) {
    delete vendorMap[branch];
  }
  
  // 如果整個 vendorMap 都空了，保留至少一個空物件
  if (Object.keys(vendorMap).length === 0) {
    vendorMap['未分類'] = {};
  }
  
  await saveVendorMap(db, worldId, vendorMap);
  return true;
}

/**
 * 修改菜單品項
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @param {string} branch - 廠商名稱（參數名稱保持 branch 以保持向後相容）
 * @param {string} oldItemName - 舊品項名稱
 * @param {string} newItemName - 新品項名稱（可選，不提供則只修改數量）
 * @param {number} qty - 新數量（可選）
 * @returns {Promise<boolean>} 是否成功
 */
export async function updateMenuItem(db, worldId, branch, oldItemName, newItemName = null, qty = null) {
  const vendorMap = await getVendorMap(db, worldId);
  if (!vendorMap || !vendorMap[branch] || !vendorMap[branch][oldItemName]) {
    return false;
  }
  
  const currentQty = vendorMap[branch][oldItemName];
  
  // 如果提供了新品項名稱，則重命名
  if (newItemName && newItemName !== oldItemName) {
    delete vendorMap[branch][oldItemName];
    vendorMap[branch][newItemName] = qty !== null ? qty : currentQty;
  } else if (qty !== null) {
    // 只修改數量
    vendorMap[branch][oldItemName] = qty;
  }
  
  await saveVendorMap(db, worldId, vendorMap);
  return true;
}
