import { getVendorByItem } from './vendorMap.service.js';
import { formatOrdersByDisplayFormat } from './format.service.js';

/**
 * order.service：只做 新增訂單、修改訂單、查詢訂單（及輔助）
 *
 * 保留：createOrder, modifyOrderItemByName, queryOrdersByDateAndBranch,
 *       queryAllOrdersByDate, formatOrdersByVendor, clearAllOrders,
 *       getOrderItems, getOrderItemById, logOrderHistory
 *
 * ❌ 不判斷「現在能不能下單」
 * ❌ 不判斷世界是否 active
 * ❌ 不回「你現在不能用」— 權限、世界狀態由 caller（line.flows / index）負責
 */

/**
 * 記錄訂單歷史
 * user:   顯示用名稱（例如 LINE displayName）
 * userId: 真正的使用者識別（用來做「我的訂單」過濾）
 * worldId: 世界 ID（用來做「我收到的訂單」過濾，即使訂單被取消也能查詢）
 */
export function logOrderHistory(db, orderId, actionType, oldData, newData, user = null, userId = null, worldId = null) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO order_history (order_id, action_type, old_data, new_data, user, userId, worldId) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        actionType,
        oldData ? JSON.stringify(oldData) : null,
        newData ? JSON.stringify(newData) : null,
        user,
        userId,
        worldId
      ],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * 查詢訂單的所有品項（orders 表只存現在有效訂單）
 */
export function getOrderItems(db, orderId) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM orders WHERE order_id = ?',
      [orderId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

/**
 * 查詢單一訂單品項
 */
export function getOrderItemById(db, itemId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM orders WHERE id = ?', [itemId], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

/**
 * 建立訂單
 */
export async function createOrder(db, branch, items, user = null, worldId = null, userId = null) {
  return new Promise((resolve, reject) => {
    // 先建立 order_id（使用時間戳 + 隨機數避免衝突）
    // Date.now() * 1000 提供毫秒精度，加上 0-999 的隨機數避免同一毫秒內衝突
    const orderId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    
    const insertPromises = items.map(item => {
      return new Promise((resolveItem, rejectItem) => {
        db.run(
          `INSERT INTO orders (order_id, branch, item, qty, worldId) VALUES (?, ?, ?, ?, ?)`,
          [orderId, branch, item.name, item.qty, worldId],
          function(err) {
            if (err) rejectItem(err);
            else resolveItem(this.lastID);
          }
        );
      });
    });

    Promise.all(insertPromises)
      .then(async () => {
        // 記錄歷史（含 userId 和 worldId，供「我的訂單」和「我收到的訂單」使用）
        await logOrderHistory(
          db,
          orderId,
          '建立訂單',
          null,
          { branch, items },
          user,
          userId,
          worldId
        );
        resolve(orderId);
      })
      .catch(reject);
  });
}

/**
 * 查詢訂單（根據日期，可選分店與世界）
 * @param {string} dateStr - 今天/今日 或 YYYY-MM-DD
 * @param {string} [branch] - 分店篩選，傳 '' 或不傳則不過濾分店（無分店時用）
 * @param {number} [worldId] - 世界 ID，傳入則只回該世界的訂單
 */
export function queryOrdersByDateAndBranch(db, dateStr, branch, worldId) {
  return new Promise((resolve, reject) => {
    const params = [];
    let sql = `SELECT * FROM order_history WHERE action_type = '建立訂單'`;
    if (worldId != null) {
      sql += ` AND worldId = ?`;
      params.push(worldId);
    }
    sql += ` ORDER BY created_at DESC`;

    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      const results = [];
      const today = new Date().toISOString().split('T')[0];

      for (const row of rows) {
        let newData;
        try {
          newData = JSON.parse(row.new_data);
        } catch (err) {
          console.error('❌ 解析訂單資料失敗 (order_id:', row.order_id, '):', err);
          continue;
        }
        if (!newData || typeof newData !== 'object' || !Array.isArray(newData.items)) {
          continue;
        }
        if (worldId != null && row.worldId != null && row.worldId !== worldId) continue;
        // 有傳 branch 且非空字串時才依分店篩選
        if (branch !== undefined && branch !== null && branch !== '') {
          if ((newData.branch || '') !== branch) continue;
        }
          
          // 檢查日期
          const rowDate = row.created_at.split(' ')[0];
          let matchDate = false;
          
          if (dateStr === '今天' || dateStr === '今日') {
            matchDate = (rowDate === today);
          } else {
            // 嘗試解析日期格式 YYYY-MM-DD
            const dateMatch = dateStr.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
            if (dateMatch) {
              const year = dateMatch[1];
              const month = dateMatch[2].padStart(2, '0');
              const day = dateMatch[3].padStart(2, '0');
              const targetDate = `${year}-${month}-${day}`;
              matchDate = (rowDate === targetDate);
            } else {
              // 如果無法解析日期，則匹配所有日期
              matchDate = true;
            }
          }
          
        if (matchDate) {
          results.push({
            orderId: row.order_id,
            branch: newData.branch || '',
            items: newData.items,
            createdAt: row.created_at
          });
        }
      }

      resolve(results);
    });
  });
}

/**
 * 查詢指定日期的所有訂單（老闆查詢，可依世界篩選）
 * @param {number} [worldId] - 若傳入則只回該世界的訂單
 */
export function queryAllOrdersByDate(db, dateStr, worldId) {
  return new Promise((resolve, reject) => {
    let sql = `SELECT * FROM order_history WHERE action_type = '建立訂單'`;
    const params = [];
    if (worldId != null) {
      sql += ` AND worldId = ?`;
      params.push(worldId);
    }
    sql += ` ORDER BY created_at DESC`;

    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      const results = [];
      const today = new Date().toISOString().split('T')[0];

      for (const row of rows) {
        let newData;
        try {
          newData = JSON.parse(row.new_data);
        } catch (err) {
          console.error('❌ 解析訂單資料失敗 (order_id:', row.order_id, '):', err);
          continue;
        }
        if (!newData || typeof newData !== 'object' || !Array.isArray(newData.items)) {
          continue;
        }
        const rowDate = row.created_at.split(' ')[0];
        let matchDate = false;
        if (dateStr === '今天' || dateStr === '今日') {
          matchDate = (rowDate === today);
        } else {
          const dateMatch = dateStr.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
          if (dateMatch) {
            const targetDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
            matchDate = (rowDate === targetDate);
          } else {
            matchDate = true;
          }
        }
        if (matchDate) {
          results.push({
            orderId: row.order_id,
            branch: newData.branch != null ? newData.branch : '',
            items: newData.items,
            createdAt: row.created_at,
            lineDisplayName: row.user || null,
          });
        }
      }
      resolve(results);
    });
  });
}

/**
 * 根據 vendorMap 將訂單按廠商分組並格式化（僅老闆查詢使用，品項後附點單者）
 */
export function formatOrdersByVendor(orders) {
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

  let output = '';
  const vendors = Object.keys(vendorMap).sort();
  for (const vendor of vendors) {
    output += `${vendor}\n`;
    const branches = Object.keys(vendorMap[vendor]).sort();
    for (const branch of branches) {
      if (branch !== '') output += ` ${branch}\n`;
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

/**
 * 修改訂單品項數量（根據品項名稱）
 * @param {Array<number>} worldIds - 使用者所屬的世界 ID 列表，用於過濾訂單
 */
export async function modifyOrderItemByName(db, itemName, change, isSet = false, worldIds = null) {
  return new Promise((resolve, reject) => {
    // 先查詢所有包含該品項的訂單，如果提供了 worldIds 則只查詢屬於這些世界的訂單
    let query = 'SELECT * FROM orders WHERE item = ?';
    const params = [itemName];
    if (worldIds && Array.isArray(worldIds) && worldIds.length > 0) {
      const placeholders = worldIds.map(() => '?').join(',');
      query += ` AND (worldId IS NULL OR worldId IN (${placeholders}))`;
      params.push(...worldIds);
    }
    db.all(
      query,
      params,
      async (err, items) => {
        if (err) {
          reject(err);
          return;
        }

        if (items.length === 0) {
          resolve({ modified: 0, message: `找不到品項：${itemName}` });
          return;
        }

        const results = [];
        
        for (const item of items) {
          let newQty;
          if (isSet) {
            newQty = change;
          } else {
            newQty = item.qty + change;
            if (newQty < 0) newQty = 0;
          }

          // 如果數量為 0，則刪除品項
          if (newQty === 0) {
            await new Promise((resolveUpdate, rejectUpdate) => {
              db.run(
                'DELETE FROM orders WHERE id = ?',
                [item.id],
                function(updateErr) {
                  if (updateErr) rejectUpdate(updateErr);
                  else {
                    // 記錄歷史（刪除品項）
                    logOrderHistory(
                      db,
                      item.order_id,
                      '刪除品項',
                      { id: item.id, item: item.item, qty: item.qty },
                      null,
                      'LINE',
                      null,
                      item.worldId || null
                    ).then(() => resolveUpdate(this.changes))
                     .catch(rejectUpdate);
                  }
                }
              );
            });

            results.push({
              orderId: item.order_id,
              branch: item.branch,
              item: item.item,
              oldQty: item.qty,
              newQty: 0,
              deleted: true
            });
          } else {
            // 更新數量
            await new Promise((resolveUpdate, rejectUpdate) => {
              db.run(
                'UPDATE orders SET qty = ? WHERE id = ?',
                [newQty, item.id],
                function(updateErr) {
                  if (updateErr) rejectUpdate(updateErr);
                  else {
                    // 記錄歷史
                    logOrderHistory(
                      db,
                      item.order_id,
                      '修改數量',
                      { id: item.id, item: item.item, qty: item.qty },
                      { id: item.id, item: item.item, qty: newQty },
                      'LINE',
                      null,
                      item.worldId || null
                    ).then(() => resolveUpdate(this.changes))
                     .catch(rejectUpdate);
                  }
                }
              );
            });

            results.push({
              orderId: item.order_id,
              branch: item.branch,
              item: item.item,
              oldQty: item.qty,
              newQty: newQty,
              deleted: false
            });
          }
        }

        resolve({ modified: results.length, results });
      }
    );
  });
}

/**
 * 清理所有訂單
 */
export function clearAllOrders(db) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM orders', function(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}
