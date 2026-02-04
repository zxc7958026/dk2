/**
 * world.service：純資料層，零文案
 *
 * createWorld(db, ownerUserId, initialStatus?)
 * getWorldById(db, worldId)
 * bindUserToWorld(db, userId, worldId, role)
 * updateWorldStatus(db, worldId, status)
 * getBindings(db, userId)
 * deleteWorld(db, worldId) - 僅刪除 status !== 'active' 的世界，先刪 bindings 再刪 world
 * unbindUserFromWorld(db, userId, worldId)
 * updateWorldName(db, worldId, name)
 * setCurrentWorld(db, userId, worldId)
 * getCurrentWorld(db, userId)
 * getAllWorldsForUser(db, userId)
 * generateWorldCode() - 產生亂碼 ID
 * updateWorldCode(db, worldId, worldCode)
 * getWorldByCode(db, worldCode)
 */

/**
 * 產生亂碼世界 ID（8 位隨機字串）
 */
export function generateWorldCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 排除容易混淆的字元
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * @param {import('sqlite3').Database} db
 * @param {string} ownerUserId
 * @param {string} [initialStatus='vendorMap_setup']
 * @returns {Promise<{ id: number, status: string, ownerUserId: string, vendorMap: string|null, created_at: string, updated_at: string }>}
 */
export function createWorld(db, ownerUserId, initialStatus = 'vendorMap_setup') {
  return new Promise((resolve, reject) => {
    const worldCode = generateWorldCode();
    db.run(
      'INSERT INTO worlds (status, ownerUserId, worldCode) VALUES (?, ?, ?)',
      [initialStatus, ownerUserId, worldCode],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        db.get('SELECT * FROM worlds WHERE id = ?', [this.lastID], (e, row) => {
          if (e) reject(e);
          else resolve(row);
        });
      }
    );
  });
}

/**
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @returns {Promise<Object|null>}
 */
export function getWorldById(db, worldId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM worlds WHERE id = ?', [worldId], (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

/**
 * @param {import('sqlite3').Database} db
 * @param {string} userId
 * @param {number} worldId
 * @param {string} role - 'owner' | 'employee'
 * @returns {Promise<void>}
 */
export function bindUserToWorld(db, userId, worldId, role) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO user_world_bindings (userId, worldId, role) VALUES (?, ?, ?)',
      [userId, worldId, role],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

/**
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @param {string} status
 * @returns {Promise<void>}
 */
export function updateWorldStatus(db, worldId, status) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE worlds SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, worldId],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

/**
 * @param {import('sqlite3').Database} db
 * @param {string} userId
 * @returns {Promise<Array<{ worldId: number, role: string, status: string }>>}
 */
export function getBindings(db, userId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT uwb.worldId, uwb.role, w.status
       FROM user_world_bindings uwb
       JOIN worlds w ON w.id = uwb.worldId
       WHERE uwb.userId = ?`,
      [userId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

/**
 * 刪除未完成的世界（status !== 'active'）：先刪該世界的所有綁定，再刪 world。
 * @returns {Promise<boolean>} 已刪除 true；世界不存在或已 active 則 false
 */
export function deleteWorld(db, worldId) {
  return new Promise((resolve, reject) => {
    getWorldById(db, worldId).then((world) => {
      if (!world || world.status === 'active') {
        resolve(false);
        return;
      }
      db.run('DELETE FROM user_world_bindings WHERE worldId = ?', [worldId], function (err) {
        if (err) {
          reject(err);
          return;
        }
        db.run('DELETE FROM worlds WHERE id = ?', [worldId], function (e2) {
          if (e2) reject(e2);
          else resolve(true);
        });
      });
    }).catch(reject);
  });
}

/**
 * 永久刪除世界及其所有相關資料（訂單、歷史、綁定、當前世界、菜單圖片、世界本身）。
 * 僅供世界擁有者（老闆）使用，刪除後無法復原。
 * @returns {Promise<void>}
 */
export function deleteWorldPermanently(db, worldId) {
  return new Promise((resolve, reject) => {
    const run = (sql, params = []) =>
      new Promise((res, rej) => {
        db.run(sql, params, function (err) {
          if (err) rej(err);
          else res();
        });
      });
    (async () => {
      await run('DELETE FROM orders WHERE worldId = ?', [worldId]);
      await run('DELETE FROM order_history WHERE worldId = ?', [worldId]);
      await run('DELETE FROM menu_item_images WHERE worldId = ?', [worldId]).catch(() => {});
      await run('DELETE FROM user_world_bindings WHERE worldId = ?', [worldId]);
      await run('DELETE FROM user_current_world WHERE currentWorldId = ?', [worldId]);
      await run('DELETE FROM worlds WHERE id = ?', [worldId]);
    })()
      .then(resolve)
      .catch(reject);
  });
}

/**
 * 更新世界名稱
 */
export function updateWorldName(db, worldId, name) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE worlds SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [name, worldId], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * 解除使用者與世界的綁定
 */
export function unbindUserFromWorld(db, userId, worldId) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM user_world_bindings WHERE userId = ? AND worldId = ?', [userId, worldId], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * 更新使用者訂購格式規範
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @param {string} orderFormat - JSON 格式的訂購格式規範
 * @returns {Promise<void>}
 */
export function updateOrderFormat(db, worldId, orderFormat) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE worlds SET orderFormat = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [orderFormat, worldId], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * 更新世界「品項下拉選項」定義（來自 Excel「下拉選項」欄位）
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @param {string|null} itemAttributeOptionsJson - JSON 字串 { [itemName]: Array<{ name, options }> }，null 表示清除
 * @returns {Promise<void>}
 */
export function updateItemAttributeOptions(db, worldId, itemAttributeOptionsJson) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE worlds SET itemAttributeOptions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [itemAttributeOptionsJson, worldId], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * 更新老闆查詢顯示格式
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @param {string} displayFormat - JSON 格式的顯示格式模板
 * @returns {Promise<void>}
 */
export function updateDisplayFormat(db, worldId, displayFormat) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE worlds SET displayFormat = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [displayFormat, worldId], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * 更新菜單圖片 URL
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @param {string|null} menuImageUrl - 圖片 URL（null 表示清除）
 * @returns {Promise<void>}
 */
export function updateMenuImageUrl(db, worldId, menuImageUrl) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE worlds SET menuImageUrl = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [menuImageUrl, worldId], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * 查詢世界的所有成員
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @returns {Promise<Array<{ userId: string, role: string, created_at: string }>>}
 */
export function getWorldMembers(db, worldId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT userId, role, created_at 
       FROM user_world_bindings 
       WHERE worldId = ? 
       ORDER BY role DESC, created_at ASC`,
      [worldId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

/**
 * 根據 userId 查詢使用者在指定世界的綁定資訊
 * @param {import('sqlite3').Database} db
 * @param {string} userId
 * @param {number} worldId
 * @returns {Promise<{ userId: string, role: string, created_at: string }|null>}
 */
export function getBindingByUserAndWorld(db, userId, worldId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT userId, role, created_at 
       FROM user_world_bindings 
       WHERE userId = ? AND worldId = ?`,
      [userId, worldId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

/**
 * 設定使用者的當前世界
 * @param {import('sqlite3').Database} db
 * @param {string} userId
 * @param {number} worldId
 * @returns {Promise<void>}
 */
export function setCurrentWorld(db, userId, worldId) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO user_current_world (userId, currentWorldId, updated_at) 
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(userId) DO UPDATE SET currentWorldId = ?, updated_at = CURRENT_TIMESTAMP`,
      [userId, worldId, worldId],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

/**
 * 取得使用者的當前世界 ID
 * @param {import('sqlite3').Database} db
 * @param {string} userId
 * @returns {Promise<number|null>}
 */
export function getCurrentWorld(db, userId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT currentWorldId FROM user_current_world WHERE userId = ?',
      [userId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.currentWorldId : null);
      }
    );
  });
}

/**
 * 取得使用者的所有世界（包含詳細資訊）
 * @param {import('sqlite3').Database} db
 * @param {string} userId
 * @returns {Promise<Array<{ worldId: number, role: string, status: string, name: string|null, worldCode: string|null, ownerUserId: string, created_at: string }>>}
 */
export function getAllWorldsForUser(db, userId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT uwb.worldId, uwb.role, w.status, w.name, w.worldCode, w.ownerUserId, w.created_at
       FROM user_world_bindings uwb
       JOIN worlds w ON w.id = uwb.worldId
       WHERE uwb.userId = ?
       ORDER BY w.created_at DESC`,
      [userId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

/**
 * 更新世界的亂碼 ID
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @param {string} worldCode
 * @returns {Promise<void>}
 */
export function updateWorldCode(db, worldId, worldCode) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE worlds SET worldCode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [worldCode, worldId], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * 根據 worldCode 查詢世界
 * @param {import('sqlite3').Database} db
 * @param {string} worldCode
 * @returns {Promise<Object|null>}
 */
export function getWorldByCode(db, worldCode) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM worlds WHERE worldCode = ?', [worldCode], (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

/**
 * 更新 Excel 欄位對應設定
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @param {string} excelMapping - JSON 格式的 Excel 欄位對應設定
 * @returns {Promise<void>}
 */
export function updateExcelMapping(db, worldId, excelMapping) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE worlds SET excelMapping = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [excelMapping, worldId], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * 取得 Excel 欄位對應設定
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @returns {Promise<Object|null>} 解析後的 Excel 欄位對應設定，或 null
 */
export function getExcelMapping(db, worldId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT excelMapping FROM worlds WHERE id = ?', [worldId], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      if (!row || !row.excelMapping) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(row.excelMapping);
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });
  });
}
