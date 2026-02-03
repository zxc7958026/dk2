import sqlite3 from 'sqlite3';

/**
 * 初始化資料庫連線
 */
export function initDatabase(dbPath = './orders.db') {
  const db = new sqlite3.Database(dbPath);

  db.serialize(() => {
    // 檢查並新增 order_id 欄位（如果不存在）
    db.run(
      `
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        branch TEXT,
        item TEXT,
        qty INTEGER,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `,
      (err) => {
        if (err) console.error('建立 orders 表錯誤:', err);
        else {
          // 檢查 order_id 和 worldId 欄位是否存在，不存在則新增
          db.all('PRAGMA table_info(orders)', (err, columns) => {
            if (!err) {
              const hasOrderId = columns.some((col) => col.name === 'order_id');
              if (!hasOrderId) {
                db.run('ALTER TABLE orders ADD COLUMN order_id INTEGER', (err) => {
                  if (err) console.error('新增 order_id 欄位錯誤:', err);
                });
              }
              const hasWorldId = columns.some((col) => col.name === 'worldId');
              if (!hasWorldId) {
                db.run('ALTER TABLE orders ADD COLUMN worldId INTEGER', (err) => {
                  if (err) console.error('新增 worldId 欄位錯誤:', err);
                });
              }
            }
          });
        }
      }
    );

    // 建立訂單歷史記錄表
    db.run(
      `
      CREATE TABLE IF NOT EXISTS order_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        action_type TEXT NOT NULL,
        old_data TEXT,
        new_data TEXT,
        user TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `,
      (err) => {
        if (err) {
          console.error('建立 order_history 表錯誤:', err);
        } else {
          // 檢查 userId 和 worldId 欄位是否存在，不存在則新增
          db.all('PRAGMA table_info(order_history)', (err, columns) => {
            if (!err) {
              const hasUserId = columns.some((col) => col.name === 'userId');
              if (!hasUserId) {
                db.run('ALTER TABLE order_history ADD COLUMN userId TEXT', (err) => {
                  if (err) console.error('新增 order_history.userId 欄位錯誤:', err);
                });
              }
              const hasWorldId = columns.some((col) => col.name === 'worldId');
              if (!hasWorldId) {
                db.run('ALTER TABLE order_history ADD COLUMN worldId INTEGER', (err) => {
                  if (err) console.error('新增 order_history.worldId 欄位錯誤:', err);
                });
              }
            }
          });
        }
      }
    );

    // 建立世界表
    db.run(`
      CREATE TABLE IF NOT EXISTS worlds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL DEFAULT 'none',
        ownerUserId TEXT,
        vendorMap TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) console.error('建立 worlds 表錯誤:', err);
      else {
        // 檢查 vendorMap、name 欄位是否存在，不存在則新增
        db.all("PRAGMA table_info(worlds)", (err, columns) => {
          if (!err) {
            const hasVendorMap = columns.some(col => col.name === 'vendorMap');
            if (!hasVendorMap) {
              db.run("ALTER TABLE worlds ADD COLUMN vendorMap TEXT", (err) => {
                if (err) console.error('新增 vendorMap 欄位錯誤:', err);
              });
            }
            const hasName = columns.some(col => col.name === 'name');
            if (!hasName) {
              db.run("ALTER TABLE worlds ADD COLUMN name TEXT", (err) => {
                if (err) console.error('新增 name 欄位錯誤:', err);
              });
            }
            const hasOrderFormat = columns.some(col => col.name === 'orderFormat');
            if (!hasOrderFormat) {
              db.run("ALTER TABLE worlds ADD COLUMN orderFormat TEXT", (err) => {
                if (err) console.error('新增 orderFormat 欄位錯誤:', err);
              });
            }
            const hasDisplayFormat = columns.some(col => col.name === 'displayFormat');
            if (!hasDisplayFormat) {
              db.run("ALTER TABLE worlds ADD COLUMN displayFormat TEXT", (err) => {
                if (err) console.error('新增 displayFormat 欄位錯誤:', err);
              });
            }
            const hasMenuImageUrl = columns.some(col => col.name === 'menuImageUrl');
            if (!hasMenuImageUrl) {
              db.run("ALTER TABLE worlds ADD COLUMN menuImageUrl TEXT", (err) => {
                if (err) console.error('新增 menuImageUrl 欄位錯誤:', err);
              });
            }
            const hasWorldCode = columns.some(col => col.name === 'worldCode');
            if (!hasWorldCode) {
              db.run("ALTER TABLE worlds ADD COLUMN worldCode TEXT", (err) => {
                if (err) console.error('新增 worldCode 欄位錯誤:', err);
              });
            }
            const hasExcelMapping = columns.some(col => col.name === 'excelMapping');
            if (!hasExcelMapping) {
              db.run("ALTER TABLE worlds ADD COLUMN excelMapping TEXT", (err) => {
                if (err) console.error('新增 excelMapping 欄位錯誤:', err);
              });
            }
            const hasItemAttributeOptions = columns.some(col => col.name === 'itemAttributeOptions');
            if (!hasItemAttributeOptions) {
              db.run("ALTER TABLE worlds ADD COLUMN itemAttributeOptions TEXT", (err) => {
                if (err) console.error('新增 itemAttributeOptions 欄位錯誤:', err);
              });
            }
          }
        });
      }
    });

    // 建立使用者世界綁定表
    db.run(`
      CREATE TABLE IF NOT EXISTS user_world_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        worldId INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'employee',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(userId, worldId)
      )
    `, (err) => {
      if (err) console.error('建立 user_world_bindings 表錯誤:', err);
      else {
        // 檢查 role 欄位是否存在，不存在則新增
        db.all("PRAGMA table_info(user_world_bindings)", (err, columns) => {
          if (!err) {
            const hasRole = columns.some(col => col.name === 'role');
            if (!hasRole) {
              db.run("ALTER TABLE user_world_bindings ADD COLUMN role TEXT NOT NULL DEFAULT 'employee'", (err) => {
                if (err) console.error('新增 role 欄位錯誤:', err);
              });
            }
          }
        });
      }
    });

    // 建立使用者當前世界表
    db.run(`
      CREATE TABLE IF NOT EXISTS user_current_world (
        userId TEXT PRIMARY KEY,
        currentWorldId INTEGER NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) console.error('建立 user_current_world 表錯誤:', err);
    });

    // 建立品項圖片表
    db.run(`
      CREATE TABLE IF NOT EXISTS menu_item_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worldId INTEGER NOT NULL,
        vendor TEXT NOT NULL,
        itemName TEXT NOT NULL,
        imageUrl TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(worldId, vendor, itemName)
      )
    `, (err) => {
      if (err) console.error('建立 menu_item_images 表錯誤:', err);
    });
  });

  return db;
}

/**
 * 關閉資料庫連線
 */
export function closeDatabase(db) {
  if (db) {
    db.close((err) => {
      if (err) {
        console.error('關閉資料庫時發生錯誤:', err);
      } else {
        console.log('資料庫連線已關閉');
      }
    });
  }
}
