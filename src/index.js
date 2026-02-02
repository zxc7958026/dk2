/**
 * LINE Webhook 接收系統
 * 從官方 LINE 接收訊息並以規定格式存入資料庫
 */

import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initDatabase, closeDatabase } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  createOrder,
  modifyOrderItemByName,
  queryOrdersByDateAndBranch,
  queryAllOrdersByDate,
  getOrderItems,
  getOrderItemById,
  logOrderHistory,
  clearAllOrders,
} from './order.service.js';
import { verifyLineSignature, handleLineEvent, pushLineMessage } from './line.handler.js';
import { getVendorByItem, getVendorMap, formatVendorMap, addItemToMenu, removeItemFromMenu, updateMenuItem, resolveVendorForItemName } from './vendorMap.service.js';
import { getBindings, getWorldById, updateMenuImageUrl, getCurrentWorld, setCurrentWorld, createWorld, bindUserToWorld, updateWorldStatus, updateWorldName, updateOrderFormat, updateDisplayFormat, getAllWorldsForUser, getWorldByCode, getWorldMembers, unbindUserFromWorld, updateExcelMapping, getExcelMapping, getBindingByUserAndWorld } from './world.service.js';
import { detectExcelMapping, parseExcelToVendorMap, getExcelPreview } from './excel.service.js';
import { saveVendorMap } from './vendorMap.service.js';
import multer from 'multer';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join as pathJoin } from 'path';
import { existsSync } from 'fs';
import { formatOrdersByDisplayFormat, formatOrdersByVendorDefault, validateItemByOrderFormat } from './format.service.js';

dotenv.config({ path: join(__dirname, '.env') });

const app = express();
// 資料庫路徑：有 DATA_DIR（雲端 Volume）則用該目錄，否則用 src 目錄
const dataDir = process.env.DATA_DIR || __dirname;
const dbPath = join(dataDir, 'orders.db');
const db = initDatabase(dbPath);
console.log('🗄 使用資料庫檔案:', dbPath);

// 上傳檔案目錄（雲端部署時與 DATA_DIR 一致，可掛 Volume 持久化）
const uploadsRoot = process.env.DATA_DIR ? join(process.env.DATA_DIR, 'uploads') : join(__dirname, '..', 'public', 'uploads');

// 靜態檔案服務（Web 前端）
app.use(express.static(join(__dirname, '..', 'public')));
app.use('/uploads', express.static(uploadsRoot));

// LINE Webhook 需要原始 body 來驗證簽章
app.use('/webhook/line', express.raw({ type: 'application/json' }));
// 其餘路由使用 JSON parser（略過 /webhook/line 以免覆寫原始 body）
const jsonParser = express.json();
app.use((req, res, next) => {
  if (req.path === '/webhook/line') return next();
  jsonParser(req, res, next);
});

// Multer 設定（用於 Excel 檔案上傳）
const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel', // .xls
      'application/vnd.ms-excel.sheet.macroEnabled.12', // .xlsm
    ];
    if (allowedMimes.includes(file.mimetype) || file.originalname.match(/\.(xlsx|xls|xlsm)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('只允許上傳 Excel 檔案 (.xlsx, .xls, .xlsm)'));
    }
  }
});

// Multer 設定（用於圖片上傳）
const imageUpload = multer({
  dest: tmpdir(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(file.originalname.toLowerCase().split('.').pop());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('只允許上傳圖片檔案 (jpeg, jpg, png, gif, webp)'));
    }
  }
});

/**
 * LINE Webhook 端點
 * POST /webhook/line
 * 簽章驗證、解析 body、取 event，其餘委派給 line.handler.handleLineEvent
 */
app.post('/webhook/line', async (req, res) => {
  try {
    const signature = req.headers['x-line-signature'];
    if (!verifyLineSignature(req.body, signature)) {
      console.error('❌ 簽章驗證失敗');
      return res.status(401).send('Unauthorized');
    }
    let body;
    try {
      body = JSON.parse(req.body.toString());
    } catch (err) {
      console.error('❌ LINE Webhook JSON 解析失敗:', err);
      return res.status(400).send('Invalid JSON');
    }
    console.log('📨 收到 LINE Webhook:', JSON.stringify(body, null, 2));
    const event = body.events?.[0];

    await handleLineEvent(db, event);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ 處理錯誤:', err);
    res.sendStatus(500);
  }
});

// 查詢所有訂單（JSON 格式）
app.get('/orders/json', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    const bindings = await getBindings(db, userId);
    const isActive = bindings.some((b) => b.status === 'active');
    if (!isActive) {
      const msg = bindings.length === 0 ? '您尚未加入任何世界' : '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定';
      return res.status(403).json({ error: msg });
    }

    db.all('SELECT * FROM orders ORDER BY created_at DESC', [], (err, rows) => {
      if (err) {
        console.error('❌ 查詢訂單失敗:', err);
        return res.status(500).json({ error: '查詢訂單時發生錯誤，請稍後再試' });
      }
      res.json(rows);
    });
  } catch (err) {
    console.error('❌ 查詢訂單失敗:', err);
    res.status(500).json({ error: '查詢訂單時發生錯誤，請稍後再試' });
  }
});

// 清理所有訂單（API 端點，僅 owner 可執行）
app.delete('/orders', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    const bindings = await getBindings(db, userId);
    const isActive = bindings.some((b) => b.status === 'active');
    if (!isActive) {
      const msg = bindings.length === 0 ? '您尚未加入任何世界' : '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定';
      return res.status(403).json({ error: msg });
    }
    const isWorldOwner = bindings.some((b) => b.role === 'owner');
    if (!isWorldOwner) {
      return res.status(403).json({ error: '僅世界擁有者（老闆）可以清理訂單' });
    }

    const deletedCount = await clearAllOrders(db);
    console.log('✅ 已清空所有訂單');
    res.json({ message: '已清空所有訂單', deletedCount });
  } catch (err) {
    console.error('❌ 清理訂單失敗:', err);
    res.status(500).json({ error: '清理訂單時發生錯誤，請稍後再試' });
  }
});

// ==================== 輔助函數 ====================

/**
 * 取得並驗證使用者的當前世界
 * @returns {Promise<{worldId: number, binding: Object}|null>} 返回當前世界 ID 和綁定資訊，如果沒有則返回 null
 */
async function getAndValidateCurrentWorld(db, userId) {
  const bindings = await getBindings(db, userId);
  if (bindings.length === 0) {
    return null;
  }
  
  // 取得當前世界
  let worldId = await getCurrentWorld(db, userId);
  
  // 如果沒有當前世界，自動設定第一個 active 世界為當前世界
  if (!worldId) {
    const activeBinding = bindings.find((b) => b.status === 'active');
    if (activeBinding) {
      worldId = activeBinding.worldId;
      await setCurrentWorld(db, userId, worldId);
    }
  }
  
  if (!worldId) {
    return null;
  }
  
  const currentBinding = bindings.find((b) => b.worldId === worldId);
  if (!currentBinding || currentBinding.status !== 'active') {
    return null;
  }
  
  return { worldId, binding: currentBinding };
}

// ==================== 訂單管理 API ====================

/**
 * 建立訂單
 * POST /api/orders
 * Body: { items: [{ name: string, qty: number }], userId: string, user?: string }
 */
app.post('/api/orders', async (req, res) => {
  try {
    const { items, userId, user } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    const bindings = await getBindings(db, userId);
    if (bindings.length === 0) {
      return res.status(403).json({ error: '您尚未加入任何世界' });
    }
    
    // 取得當前世界
    let worldId = await getCurrentWorld(db, userId);
    
    // 如果沒有當前世界，自動設定第一個 active 世界為當前世界
    if (!worldId) {
      const activeBinding = bindings.find((b) => b.status === 'active');
      if (activeBinding) {
        worldId = activeBinding.worldId;
        await setCurrentWorld(db, userId, worldId);
      }
    }
    
    // 驗證當前世界是否 active
    if (!worldId) {
      console.log(`⚠️ 訂單提交失敗: userId=${userId}, 沒有當前世界, bindings=${JSON.stringify(bindings)}`);
      return res.status(403).json({ error: '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定' });
    }
    
    const currentBinding = bindings.find((b) => b.worldId === worldId);
    if (!currentBinding) {
      console.log(`⚠️ 訂單提交失敗: userId=${userId}, worldId=${worldId}, 找不到對應的 binding, bindings=${JSON.stringify(bindings)}`);
      return res.status(403).json({ error: '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定' });
    }
    
    // 檢查世界的狀態（不是 binding 的狀態，而是 world 的狀態）
    const world = await getWorldById(db, worldId);
    if (!world) {
      return res.status(404).json({ error: '找不到指定的世界' });
    }
    // TODO(PROD): 正式上線時請恢復為只允許 world.status === 'active'
    // 目前為了方便開發 / 測試，放寬條件讓 vendorMap_setup 也可以下單
    const isWorldActiveForOrder = world.status === 'active' || world.status === 'vendorMap_setup';
    if (!isWorldActiveForOrder) {
      console.log(`⚠️ 訂單提交失敗: userId=${userId}, worldId=${worldId}, world.status=${world?.status || 'null'}`);
      return res.status(403).json({ error: '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定' });
    }
    
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: '缺少必要參數：items' });
    }

    // 驗證輸入
    for (const item of items) {
      if (!item.name || typeof item.name !== 'string' || item.name.trim().length === 0 || item.name.trim().length > 100) {
        return res.status(400).json({ error: `品項名稱格式錯誤：${item.name || '(空)'}` });
      }
      if (typeof item.qty !== 'number' || isNaN(item.qty) || item.qty <= 0 || item.qty > 999999 || !Number.isInteger(item.qty)) {
        return res.status(400).json({ error: `數量格式錯誤：${item.qty}（必須為 1-999999 之間的正整數）` });
      }
    }
    
    // 取得世界的訂購格式規範（用於驗證）
    let orderFormat = null;
    if (world.orderFormat) {
      if (world?.orderFormat) {
        try {
          orderFormat = JSON.parse(world.orderFormat);
        } catch {
          // 解析失敗，忽略
        }
      }
    }
    
    // 訂購格式驗證改為可選（簡化流程，不強制驗證）
    // 如果設定了 orderFormat，可以進行驗證，但不強制
    // if (orderFormat) {
    //   const invalidItems = [];
    //   for (const item of items) {
    //     if (!validateItemByOrderFormat(item.name.trim(), orderFormat)) {
    //       invalidItems.push(item.name);
    //     }
    //   }
    //   if (invalidItems.length > 0) {
    //     return res.status(400).json({ 
    //       error: '訂購格式不符合規範',
    //       invalidItems,
    //       message: `以下品項格式錯誤：${invalidItems.join('、')}`
    //     });
    //   }
    // }
    
    const orderId = await createOrder(
      db,
      null, // branch 欄位設為 null
      items.map((i) => ({ name: i.name.trim(), qty: i.qty })),
      user || null,
      worldId,
      userId || null
    );
    
    // 通知 owner 有新訂單（非同步執行，不影響 API 回應）
    if (worldId) {
      const formattedItems = items.map(i => ({ name: i.name.trim(), qty: i.qty }));
      notifyOwnerNewOrderAPI(db, worldId, orderId, null, formattedItems, user || 'API使用者').catch(err => {
        console.error('❌ API 通知 owner 時發生錯誤:', err);
      });
    }
    
    res.json({ 
      success: true, 
      orderId,
      message: '訂單建立成功' 
    });
  } catch (err) {
    console.error('❌ 建立訂單失敗:', err);
    res.status(500).json({ error: '建立訂單時發生錯誤，請稍後再試' });
  }
});

/**
 * 修改訂單數量
 * PUT /api/orders/items/:itemId
 * Body: { qty: number, userId: string, user?: string }
 */
app.put('/api/orders/items/:itemId', async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const { qty, userId, user } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    const bindings = await getBindings(db, userId);
    const isActive = bindings.some((b) => b.status === 'active');
    if (!isActive) {
      const msg = bindings.length === 0 ? '您尚未加入任何世界' : '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定';
      return res.status(403).json({ error: msg });
    }

    if (typeof qty !== 'number' || isNaN(qty) || qty <= 0 || qty > 999999 || !Number.isInteger(qty)) {
      return res.status(400).json({ error: '數量格式錯誤（必須為 1-999999 之間的正整數）' });
    }

    const oldItem = await getOrderItemById(db, itemId);
    if (!oldItem) {
      return res.status(404).json({ error: '找不到該訂單品項' });
    }

    // 更新數量
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE orders SET qty = ? WHERE id = ?',
        [qty, itemId],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });

    const newItem = { ...oldItem, qty };
    
    // 記錄歷史（含 userId 和 worldId，供「我的訂單」和「我收到的訂單」使用）
    await logOrderHistory(
      db,
      oldItem.order_id,
      '修改數量',
      { id: oldItem.id, item: oldItem.item, qty: oldItem.qty },
      { id: newItem.id, item: newItem.item, qty: newItem.qty },
      user || null,
      userId || null,
      oldItem.worldId || null
    );

    res.json({ 
      success: true, 
      message: '數量修改成功',
      oldQty: oldItem.qty,
      newQty: qty
    });
  } catch (err) {
    console.error('❌ 修改數量失敗:', err);
    res.status(500).json({ error: '修改訂單數量時發生錯誤，請稍後再試' });
  }
});

/**
 * 新增品項到訂單
 * POST /api/orders/:orderId/items
 * Body: { name: string, qty: number, userId: string, user?: string }
 */
app.post('/api/orders/:orderId/items', async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const { name, qty, userId, user } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    const bindings = await getBindings(db, userId);
    const isActive = bindings.some((b) => b.status === 'active');
    if (!isActive) {
      const msg = bindings.length === 0 ? '您尚未加入任何世界' : '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定';
      return res.status(403).json({ error: msg });
    }

    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 100) {
      return res.status(400).json({ error: '品項名稱格式錯誤（長度需在 1-100 字元之間）' });
    }
    if (typeof qty !== 'number' || isNaN(qty) || qty <= 0 || qty > 999999 || !Number.isInteger(qty)) {
      return res.status(400).json({ error: '數量格式錯誤（必須為 1-999999 之間的正整數）' });
    }

    // 檢查訂單是否存在
    const orderItems = await getOrderItems(db, orderId);
    if (orderItems.length === 0) {
      return res.status(404).json({ error: '找不到該訂單' });
    }

    // 檢查訂單是否屬於使用者的當前世界
    const orderWorldId = orderItems[0].worldId;
    if (orderWorldId !== null) {
      const currentWorld = await getAndValidateCurrentWorld(db, userId);
      if (!currentWorld || currentWorld.worldId !== orderWorldId) {
        return res.status(403).json({ error: '您沒有權限修改此訂單（不屬於您的當前世界）' });
      }
    }

    const branch = orderItems[0].branch;

    // 新增品項（使用 trim 處理名稱，保持相同的 worldId）
    const newItemId = await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO orders (order_id, branch, item, qty, worldId) VALUES (?, ?, ?, ?, ?)',
        [orderId, branch, name.trim(), qty, orderWorldId],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    // 記錄歷史（含 userId 和 worldId，供「我的訂單」和「我收到的訂單」使用）
    await logOrderHistory(
      db,
      orderId,
      '新增品項',
      null,
      { id: newItemId, item: name, qty },
      user || null,
      userId || null,
      orderWorldId || null
    );

    res.json({ 
      success: true, 
      message: '品項新增成功',
      itemId: newItemId
    });
  } catch (err) {
    console.error('❌ 新增品項失敗:', err);
    res.status(500).json({ error: '新增品項時發生錯誤，請稍後再試' });
  }
});

/**
 * 刪除訂單品項
 * DELETE /api/orders/items/:itemId
 * Body: { userId: string, user?: string }
 */
app.delete('/api/orders/items/:itemId', async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const { userId, user } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    const bindings = await getBindings(db, userId);
    const isActive = bindings.some((b) => b.status === 'active');
    if (!isActive) {
      const msg = bindings.length === 0 ? '您尚未加入任何世界' : '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定';
      return res.status(403).json({ error: msg });
    }

    const oldItem = await getOrderItemById(db, itemId);
    if (!oldItem) {
      return res.status(404).json({ error: '找不到該訂單品項' });
    }

    // 檢查訂單是否屬於使用者的當前世界
    if (oldItem.worldId !== null) {
      const currentWorld = await getAndValidateCurrentWorld(db, userId);
      if (!currentWorld || currentWorld.worldId !== oldItem.worldId) {
        return res.status(403).json({ error: '您沒有權限刪除此訂單品項（不屬於您的當前世界）' });
      }
    }

    // 刪除品項
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM orders WHERE id = ?', [itemId], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });

    // 記錄歷史（含 userId 和 worldId，供「我的訂單」和「我收到的訂單」使用）
    await logOrderHistory(
      db,
      oldItem.order_id,
      '刪除品項',
      { id: oldItem.id, item: oldItem.item, qty: oldItem.qty },
      null,
      user || null,
      userId || null,
      oldItem.worldId || null
    );

    res.json({ 
      success: true, 
      message: '品項刪除成功' 
    });
  } catch (err) {
    console.error('❌ 刪除品項失敗:', err);
    res.status(500).json({ error: '刪除品項時發生錯誤，請稍後再試' });
  }
});

/**
 * 取消訂單
 * POST /api/orders/:orderId/cancel
 * Body: { userId: string, user?: string }
 */
app.post('/api/orders/:orderId/cancel', async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const { userId, user } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    const bindings = await getBindings(db, userId);
    const isActive = bindings.some((b) => b.status === 'active');
    if (!isActive) {
      const msg = bindings.length === 0 ? '您尚未加入任何世界' : '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定';
      return res.status(403).json({ error: msg });
    }

    const orderItems = await getOrderItems(db, orderId);
    if (orderItems.length === 0) {
      return res.status(404).json({ error: '找不到該訂單' });
    }

    // 檢查訂單是否屬於使用者的世界
    const orderWorldId = orderItems[0].worldId;
    if (orderWorldId !== null) {
      const userWorldIds = bindings.filter((b) => b.status === 'active').map((b) => b.worldId);
      if (!userWorldIds.includes(orderWorldId)) {
        return res.status(403).json({ error: '您沒有權限取消此訂單（不屬於您的世界）' });
      }
    }

    // 從 orders 表中刪除所有品項（orders 只存現在訂單狀況）
    await new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM orders WHERE order_id = ?',
        [orderId],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });

    // 記錄歷史（歷史記錄保留在 order_history，含 userId 和 worldId）
    const cancelWorldId = orderItems.length > 0 ? orderItems[0].worldId : null;
    await logOrderHistory(
      db,
      orderId,
      '訂單取消',
      orderItems,
      null,
      user || null,
      userId || null,
      cancelWorldId
    );

    res.json({ 
      success: true, 
      message: '訂單已取消' 
    });
  } catch (err) {
    console.error('❌ 取消訂單失敗:', err);
    res.status(500).json({ error: '取消訂單時發生錯誤，請稍後再試' });
  }
});

/**
 * 使用者補救（恢復訂單）
 * POST /api/orders/:orderId/restore
 * Body: { userId: string, user?: string }
 */
app.post('/api/orders/:orderId/restore', async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const { userId, user } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    const bindings = await getBindings(db, userId);
    const isActive = bindings.some((b) => b.status === 'active');
    if (!isActive) {
      const msg = bindings.length === 0 ? '您尚未加入任何世界' : '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定';
      return res.status(403).json({ error: msg });
    }

    // 檢查訂單是否已存在（如果存在則不需要恢復）
    const currentItems = await getOrderItems(db, orderId);
    if (currentItems.length > 0) {
      return res.status(400).json({ error: '訂單已存在，無需恢復' });
    }

    // 檢查歷史記錄中的訂單是否屬於使用者的世界（通過查詢歷史記錄中的訂單來判斷）
    // 注意：歷史記錄中沒有 worldId，所以這裡只能檢查訂單是否存在於使用者的世界中

    // 查詢歷史記錄中最後一筆取消記錄
    const history = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM order_history 
         WHERE order_id = ? AND action_type = '訂單取消' 
         ORDER BY created_at DESC LIMIT 1`,
        [orderId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    if (history.length === 0) {
      return res.status(404).json({ error: '找不到可恢復的訂單記錄' });
    }

    const cancelRecord = history[0];
    let oldData;
    try {
      oldData = JSON.parse(cancelRecord.old_data);
    } catch (err) {
      console.error('❌ 解析訂單歷史記錄失敗:', err);
      return res.status(500).json({ error: '訂單歷史記錄資料損壞，無法恢復' });
    }
    if (!Array.isArray(oldData)) {
      return res.status(500).json({ error: '訂單歷史記錄格式錯誤，無法恢復' });
    }

    // 從歷史記錄恢復訂單品項到 orders 表（使用第一個 active 世界的 worldId）
    const activeBinding = bindings.find((b) => b.status === 'active');
    const worldId = activeBinding ? activeBinding.worldId : null;
    const restorePromises = oldData.map(item => {
      return new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO orders (order_id, branch, item, qty, worldId) 
           VALUES (?, ?, ?, ?, ?)`,
          [orderId, item.branch, item.item, item.qty, worldId],
          function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
          }
        );
      });
    });

    await Promise.all(restorePromises);

    // 記錄歷史（含 worldId）
    await logOrderHistory(
      db,
      orderId,
      '使用者補救',
      null,
      oldData,
      user || null,
      userId || null,
      worldId || null
    );

    res.json({ 
      success: true, 
      message: '訂單已恢復' 
    });
  } catch (err) {
    console.error('❌ 恢復訂單失敗:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 查詢訂單歷史記錄（只有 owner 可以使用）
 * GET /api/order-history?orderId=xxx&userId=xxx
 */
app.get('/api/order-history', async (req, res) => {
  try {
    const { orderId, userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    const bindings = await getBindings(db, userId);
    const isWorldOwner = bindings.some((b) => b.role === 'owner');
    if (!isWorldOwner) {
      return res.status(403).json({ error: '只有世界擁有者可以查詢歷史訂單' });
    }
    
    let query = 'SELECT * FROM order_history';
    let params = [];

    if (orderId) {
      query += ' WHERE order_id = ?';
      params.push(parseInt(orderId));
    }

    query += ' ORDER BY created_at DESC';

    db.all(query, params, (err, rows) => {
      if (err) {
        console.error('❌ 查詢歷史記錄失敗:', err);
        return res.status(500).json({ error: '查詢歷史記錄時發生錯誤，請稍後再試' });
      }

      // 解析 JSON 資料
      const formatted = rows.map(row => {
        let oldData = null;
        let newData = null;
        try {
          oldData = row.old_data ? JSON.parse(row.old_data) : null;
        } catch (err) {
          console.error('❌ 解析 old_data 失敗:', err, 'row.id:', row.id);
        }
        try {
          newData = row.new_data ? JSON.parse(row.new_data) : null;
        } catch (err) {
          console.error('❌ 解析 new_data 失敗:', err, 'row.id:', row.id);
        }
        return {
          ...row,
          old_data: oldData,
          new_data: newData
        };
      });

      res.json(formatted);
    });
  } catch (err) {
    console.error('❌ 查詢歷史記錄失敗:', err);
    res.status(500).json({ error: '查詢歷史記錄時發生錯誤，請稍後再試' });
  }
});

/**
 * 查詢單一訂單詳情
 * GET /api/orders/:orderId?userId=xxx
 *
 * 注意：如果 path 是 /api/orders/my，會交給後面的 /api/orders/my 處理
 */
app.get('/api/orders/:orderId', async (req, res, next) => {
  try {
    // 避免和 /api/orders/my 衝突
    if (req.params.orderId === 'my') {
      return next();
    }

    const orderId = parseInt(req.params.orderId, 10);
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    const bindings = await getBindings(db, userId);
    const isActive = bindings.some((b) => b.status === 'active');
    if (!isActive) {
      const msg = bindings.length === 0 ? '您尚未加入任何世界' : '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定';
      return res.status(403).json({ error: msg });
    }
    const items = await getOrderItems(db, orderId);
    
    if (items.length === 0) {
      return res.status(404).json({ error: '找不到該訂單' });
    }

    // 檢查訂單是否屬於使用者的世界
    const orderWorldId = items[0].worldId;
    if (orderWorldId !== null) {
      const userWorldIds = bindings.filter((b) => b.status === 'active').map((b) => b.worldId);
      if (!userWorldIds.includes(orderWorldId)) {
        return res.status(403).json({ error: '您沒有權限查詢此訂單（不屬於您的世界）' });
      }
    }

    res.json({
      orderId,
      branch: items[0].branch,
      items: items.map(item => ({
        id: item.id,
        item: item.item,
        qty: item.qty,
        created_at: item.created_at
      })),
      created_at: items[0].created_at
    });
  } catch (err) {
    console.error('❌ 查詢訂單失敗:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 老闆查詢訂單明細（按廠商分組）
 * GET /api/boss-query?date=2024-01-15&userId=xxx
 * 或 GET /api/boss-query?date=今天&userId=xxx
 */
app.get('/api/boss-query', async (req, res) => {
  try {
    const { date, userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    const bindings = await getBindings(db, userId);
    const isActive = bindings.some((b) => b.status === 'active');
    if (!isActive) {
      const msg = bindings.length === 0 ? '您尚未加入任何世界' : '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定';
      return res.status(403).json({ error: msg });
    }
    
    if (!date) {
      return res.status(400).json({ error: '缺少必要參數：date' });
    }

    const results = await queryAllOrdersByDate(db, date);
    
    if (results.length === 0) {
      return res.json({
        date,
        message: '查無訂單',
        formatted: '',
        data: {}
      });
    }

    // 簡化流程：統一使用預設格式（按廠商分組）
    const formatted = formatOrdersByVendorDefault(results, getVendorByItem);
    
    // 同時返回結構化資料
    const vendorMap = {};
    for (const order of results) {
      for (const item of order.items) {
        const vendor = getVendorByItem(item.name);
        
        if (!vendorMap[vendor]) {
          vendorMap[vendor] = {};
        }
        
        if (!vendorMap[vendor][order.branch]) {
          vendorMap[vendor][order.branch] = {};
        }
        
        if (!vendorMap[vendor][order.branch][item.name]) {
          vendorMap[vendor][order.branch][item.name] = 0;
        }
        
        vendorMap[vendor][order.branch][item.name] += item.qty;
      }
    }

    res.json({
      date,
      totalOrders: results.length,
      formatted,
      data: vendorMap
    });
  } catch (err) {
    console.error('❌ 老闆查詢失敗:', err);
    res.status(500).json({ error: '查詢訂單明細時發生錯誤，請稍後再試' });
  }
});

// ==================== 格式設定 API ====================

/**
 * 設定使用者訂購格式（僅 owner）
 * PUT /api/worlds/order-format?userId=xxx
 * Body: { orderFormat: string } - JSON 格式的訂購格式規範
 */
app.put('/api/worlds/order-format', async (req, res) => {
  try {
    const { userId } = req.query;
    const { orderFormat } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    if (!orderFormat) {
      return res.status(400).json({ error: '缺少必要參數：orderFormat' });
    }
    
    // 僅允許「當前世界」的 owner 設定訂購格式
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      return res.status(403).json({ error: '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定' });
    }
    if (current.binding.role !== 'owner') {
      return res.status(403).json({ error: '僅世界擁有者可以設定訂購格式' });
    }
    
    const world = await getWorldById(db, current.worldId);
    if (!world) {
      return res.status(404).json({ error: '找不到世界' });
    }
    
    // 驗證格式
    const { validateOrderFormat } = await import('./format.service.js');
    const format = validateOrderFormat(orderFormat);
    if (!format) {
      return res.status(400).json({ error: '訂購格式 JSON 格式錯誤' });
    }
    
    await updateOrderFormat(db, current.worldId, orderFormat);
    
    // 如果世界狀態是 vendorMap_setup，更新為 active（設定完成）
    if (world.status === 'vendorMap_setup') {
      await updateWorldStatus(db, current.worldId, 'active');
    }
    
    res.json({ 
      success: true, 
      message: '訂購格式設定完成' 
    });
  } catch (err) {
    console.error('❌ 設定訂購格式失敗:', err);
    res.status(500).json({ error: '設定訂購格式時發生錯誤，請稍後再試' });
  }
});

/**
 * 設定老闆查詢顯示格式（僅 owner）
 * PUT /api/worlds/display-format?userId=xxx
 * Body: { displayFormat: string } - JSON 格式的顯示格式模板
 */
app.put('/api/worlds/display-format', async (req, res) => {
  try {
    const { userId } = req.query;
    const { displayFormat } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    if (!displayFormat) {
      return res.status(400).json({ error: '缺少必要參數：displayFormat' });
    }
    
    // 僅允許「當前世界」的 owner 設定顯示格式
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      return res.status(403).json({ error: '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定' });
    }
    if (current.binding.role !== 'owner') {
      return res.status(403).json({ error: '僅世界擁有者可以設定顯示格式' });
    }
    
    const world = await getWorldById(db, current.worldId);
    if (!world) {
      return res.status(404).json({ error: '找不到世界' });
    }
    
    // 驗證格式
    const { validateDisplayFormat } = await import('./format.service.js');
    const format = validateDisplayFormat(displayFormat);
    if (!format) {
      return res.status(400).json({ error: '顯示格式 JSON 格式錯誤' });
    }
    
    await updateDisplayFormat(db, current.worldId, displayFormat);
    
    // 如果世界狀態是 vendorMap_setup，更新為 active（設定完成）
    if (world.status === 'vendorMap_setup') {
      await updateWorldStatus(db, current.worldId, 'active');
    }
    
    res.json({ 
      success: true, 
      message: '顯示格式設定完成' 
    });
  } catch (err) {
    console.error('❌ 設定顯示格式失敗:', err);
    res.status(500).json({ error: '設定顯示格式時發生錯誤，請稍後再試' });
  }
});

/**
 * 查詢世界的格式設定（僅 owner）
 * GET /api/worlds/formats?userId=xxx
 */
app.get('/api/worlds/formats', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    const bindings = await getBindings(db, userId);
    const isWorldOwner = bindings.some((b) => b.role === 'owner');
    if (!isWorldOwner) {
      return res.status(403).json({ error: '僅世界擁有者可以查詢格式設定' });
    }
    
    const activeBinding = bindings.find((b) => b.status === 'active');
    if (!activeBinding) {
      return res.status(403).json({ error: '世界尚未啟用' });
    }
    
    const world = await getWorldById(db, activeBinding.worldId);
    
    let orderFormat = null;
    let displayFormat = null;
    
    if (world.orderFormat) {
      try {
        orderFormat = JSON.parse(world.orderFormat);
      } catch {
        // 解析失敗，保持為 null
      }
    }
    
    if (world.displayFormat) {
      try {
        displayFormat = JSON.parse(world.displayFormat);
      } catch {
        // 解析失敗，保持為 null
      }
    }
    
    res.json({
      orderFormat,
      displayFormat,
      orderFormatRaw: world.orderFormat,
      displayFormatRaw: world.displayFormat
    });
  } catch (err) {
    console.error('❌ 查詢格式設定失敗:', err);
    res.status(500).json({ error: '查詢格式設定時發生錯誤，請稍後再試' });
  }
});

/**
 * 設定菜單圖片（僅 owner）
 * PUT /api/worlds/menu-image?userId=xxx
 * Body: { menuImageUrl: string|null } - 圖片 URL（null 表示清除）
 */
app.put('/api/worlds/menu-image', async (req, res) => {
  try {
    const { userId } = req.query;
    const { menuImageUrl } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    const bindings = await getBindings(db, userId);
    const isWorldOwner = bindings.some((b) => b.role === 'owner');
    if (!isWorldOwner) {
      return res.status(403).json({ error: '僅世界擁有者可以設定菜單圖片' });
    }
    
    const activeBinding = bindings.find((b) => b.status === 'active');
    if (!activeBinding) {
      return res.status(403).json({ error: '世界尚未啟用' });
    }
    
    // 如果提供 URL，驗證格式
    if (menuImageUrl !== null && menuImageUrl !== undefined) {
      if (typeof menuImageUrl !== 'string' || menuImageUrl.trim().length === 0) {
        return res.status(400).json({ error: '圖片 URL 格式錯誤' });
      }
      try {
        new URL(menuImageUrl);
      } catch {
        return res.status(400).json({ error: '圖片 URL 格式錯誤，請確認 URL 是否正確' });
      }
    }
    
    await updateMenuImageUrl(db, activeBinding.worldId, menuImageUrl || null);
    
    res.json({ 
      success: true, 
      message: menuImageUrl ? '菜單圖片設定完成' : '菜單圖片已清除',
      menuImageUrl: menuImageUrl || null
    });
  } catch (err) {
    console.error('❌ 設定菜單圖片失敗:', err);
    res.status(500).json({ error: '設定菜單圖片時發生錯誤，請稍後再試' });
  }
});

// ==================== 世界管理 API ====================

/**
 * 創建世界
 * POST /api/worlds
 * Body: { userId: string, name: string }
 */
app.post('/api/worlds', async (req, res) => {
  try {
    const { userId, name } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: '缺少必要參數：name 或名稱格式錯誤' });
    }
    
    // 創建世界（直接設為 active 狀態，簡化流程）
    const world = await createWorld(db, userId, 'active');
    
    // 設定世界名稱
    await updateWorldName(db, world.id, name.trim());
    
    // 綁定使用者為 owner
    await bindUserToWorld(db, userId, world.id, 'owner');
    
    // 設定為當前世界
    await setCurrentWorld(db, userId, world.id);

    // 初始化一張示範訂單（綁定到此世界）
    try {
      await createOrder(
        db,
        '範例世界', // branch：固定為「範例世界」
        [
          { name: '牛奶', qty: 1 },
          { name: '雞蛋', qty: 2 }
        ],
        '媽媽',       // user：顯示為「媽媽」
        world.id,     // worldId：新世界 ID
        userId        // userId：世界擁有者
      );
    } catch (initErr) {
      console.error('⚠️ 建立初始化訂單失敗（略過，不影響創建世界）:', initErr);
      // 不 throw，避免初始化訂單失敗導致世界無法建立
    }

    res.json({
      success: true,
      world: {
        id: world.id,
        name: name.trim(),
        worldCode: world.worldCode,
        status: world.status
      }
    });
  } catch (err) {
    console.error('❌ 創建世界失敗:', err);
    res.status(500).json({ error: '創建世界時發生錯誤，請稍後再試' });
  }
});

/**
 * 取得使用者的世界列表
 * GET /api/worlds?userId=xxx
 */
app.get('/api/worlds', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    const worlds = await getAllWorldsForUser(db, userId);
    
    res.json({
      success: true,
      worlds: worlds.map(w => ({
        id: w.worldId,
        name: w.name || `世界 #${String(w.worldId).padStart(6, '0')}`,
        worldCode: w.worldCode,
        role: w.role,
        status: w.status
      }))
    });
  } catch (err) {
    console.error('❌ 取得世界列表失敗:', err);
    res.status(500).json({ error: '取得世界列表時發生錯誤，請稍後再試' });
  }
});

/**
 * 設定當前世界
 * PUT /api/worlds/current
 * Body: { userId: string, worldId: number }
 */
app.put('/api/worlds/current', async (req, res) => {
  try {
    const { userId, worldId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    if (!worldId || typeof worldId !== 'number') {
      return res.status(400).json({ error: '缺少必要參數：worldId 或格式錯誤' });
    }
    
    // 檢查使用者是否有權限使用此世界
    const bindings = await getBindings(db, userId);
    const hasAccess = bindings.some(b => b.worldId === worldId);
    if (!hasAccess) {
      return res.status(403).json({ error: '您沒有權限使用此世界' });
    }
    
    // 設定為當前世界
    await setCurrentWorld(db, userId, worldId);
    
    res.json({
      success: true,
      message: '當前世界設定成功'
    });
  } catch (err) {
    console.error('❌ 設定當前世界失敗:', err);
    res.status(500).json({ error: '設定當前世界時發生錯誤，請稍後再試' });
  }
});

/**
 * 加入世界
 * POST /api/worlds/join
 * Body: { userId: string, worldId?: number, worldCode?: string }
 */
app.post('/api/worlds/join', async (req, res) => {
  try {
    const { userId, worldId, worldCode } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    if (!worldId && !worldCode) {
      return res.status(400).json({ error: '請提供 worldId 或 worldCode' });
    }
    
    // 根據 worldId 或 worldCode 查詢世界
    let world;
    if (worldCode) {
      world = await getWorldByCode(db, worldCode.toUpperCase());
      if (!world) {
        return res.status(404).json({ error: '找不到此世界代碼' });
      }
    } else {
      world = await getWorldById(db, worldId);
      if (!world) {
        return res.status(404).json({ error: '找不到此世界' });
      }
    }
    
    // 檢查使用者是否已經加入此世界
    const bindings = await getBindings(db, userId);
    if (bindings.some((b) => b.worldId === world.id)) {
      return res.status(400).json({ error: '您已經加入此世界' });
    }
    
    // 加入世界
    await bindUserToWorld(db, userId, world.id, 'employee');
    
    // 設定為當前世界
    await setCurrentWorld(db, userId, world.id);
    
    res.json({
      success: true,
      message: '成功加入世界',
      world: {
        id: world.id,
        name: world.name,
        worldCode: world.worldCode
      }
    });
  } catch (err) {
    console.error('❌ 加入世界失敗:', err);
    res.status(500).json({ error: '加入世界時發生錯誤，請稍後再試' });
  }
});

/**
 * 取得世界成員名單
 * GET /api/worlds/:worldId/members?userId=xxx
 */
app.get('/api/worlds/:worldId/members', async (req, res) => {
  try {
    const worldId = parseInt(req.params.worldId);
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    if (!worldId || isNaN(worldId)) {
      return res.status(400).json({ error: '無效的世界 ID' });
    }
    
    // 檢查使用者是否有權限查看此世界的成員
    const bindings = await getBindings(db, userId);
    const hasAccess = bindings.some(b => b.worldId === worldId);
    if (!hasAccess) {
      return res.status(403).json({ error: '您沒有權限查看此世界的成員' });
    }
    
    // 取得成員列表
    const members = await getWorldMembers(db, worldId);
    
    // 取得成員的 LINE 顯示名稱（如果有設定 LINE_CHANNEL_ACCESS_TOKEN）
    const LINE_CHANNEL_ACCESS_TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim();
    let membersWithName = members;
    
    if (LINE_CHANNEL_ACCESS_TOKEN && members.length > 0) {
      membersWithName = await Promise.all(
        members.map(async (m) => {
          let displayName = m.userId;
          try {
            const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${m.userId}`, {
              headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
            });
            if (profileRes.ok) {
              const profile = await profileRes.json();
              displayName = profile.displayName || m.userId;
            }
          } catch (e) {
            console.warn('⚠️ 取得成員顯示名稱失敗:', e.message || e);
          }
          return { ...m, displayName };
        })
      );
    } else {
      // 若無法呼叫 LINE API，至少帶上 userId 當作顯示名稱
      membersWithName = members.map(m => ({
        ...m,
        displayName: m.userId
      }));
    }
    
    res.json({
      success: true,
      members: membersWithName.map(m => ({
        userId: m.userId,
        role: m.role,
        created_at: m.created_at,
        displayName: m.displayName || m.userId
      }))
    });
  } catch (err) {
    console.error('❌ 查詢成員名單失敗:', err);
    res.status(500).json({ error: '查詢成員名單時發生錯誤，請稍後再試' });
  }
});

/**
 * 剔除世界成員（僅 owner）
 * POST /api/worlds/:worldId/remove-member
 * Body: { userId: string, targetUserId: string }
 */
app.post('/api/worlds/:worldId/remove-member', async (req, res) => {
  try {
    const worldId = parseInt(req.params.worldId);
    const { userId, targetUserId } = req.body || {};
    if (!userId || !targetUserId) {
      return res.status(400).json({ error: '缺少必要參數：userId 或 targetUserId' });
    }
    if (!worldId || isNaN(worldId)) {
      return res.status(400).json({ error: '無效的世界 ID' });
    }

    if (userId === targetUserId) {
      return res.status(400).json({ error: '無法剔除自己' });
    }

    // 確認呼叫者在該世界是 owner
    const bindings = await getBindings(db, userId);
    const ownerBinding = bindings.find(b => b.worldId === worldId && b.role === 'owner' && b.status === 'active');
    if (!ownerBinding) {
      return res.status(403).json({ error: '僅世界擁有者可以剔除成員' });
    }

    // 檢查目標是否在世界內
    const targetBinding = await getBindingByUserAndWorld(db, targetUserId, worldId);
    if (!targetBinding) {
      return res.status(404).json({ error: '找不到該成員' });
    }

    // 不允許剔除 owner
    if (targetBinding.role === 'owner') {
      return res.status(403).json({ error: '無法剔除世界擁有者' });
    }

    await unbindUserFromWorld(db, targetUserId, worldId);

    res.json({
      success: true,
      message: '已剔除成員'
    });
  } catch (err) {
    console.error('❌ 剔除成員失敗 (API):', err);
    res.status(500).json({ error: '剔除成員時發生錯誤，請稍後再試' });
  }
});

/**
 * 退出世界
 * POST /api/worlds/leave
 * Body: { userId: string, worldId: number }
 */
app.post('/api/worlds/leave', async (req, res) => {
  try {
    const { userId, worldId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    if (!worldId || typeof worldId !== 'number') {
      return res.status(400).json({ error: '缺少必要參數：worldId 或格式錯誤' });
    }
    
    // 檢查使用者是否已加入此世界
    const bindings = await getBindings(db, userId);
    const binding = bindings.find(b => b.worldId === worldId);
    if (!binding) {
      return res.status(404).json({ error: '您尚未加入此世界' });
    }
    
    // 檢查是否為世界擁有者
    if (binding.role === 'owner') {
      return res.status(403).json({ error: '世界擁有者無法退出世界' });
    }
    
    // 退出世界
    await unbindUserFromWorld(db, userId, worldId);
    
    // 如果當前世界是此世界，清除或更新當前世界設定
    const currentWorldId = await getCurrentWorld(db, userId);
    if (currentWorldId === worldId) {
      // 設定為其他世界，如果有的話
      const remainingBindings = bindings.filter(b => b.worldId !== worldId);
      if (remainingBindings.length > 0) {
        await setCurrentWorld(db, userId, remainingBindings[0].worldId);
      } else {
        // 沒有其他世界，刪除當前世界設定
        await new Promise((resolve, reject) => {
          db.run('DELETE FROM user_current_world WHERE userId = ?', [userId], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
    }
    
    res.json({
      success: true,
      message: '已退出世界'
    });
  } catch (err) {
    console.error('❌ 退出世界失敗:', err);
    res.status(500).json({ error: '退出世界時發生錯誤，請稍後再試' });
  }
});

/**
 * 查詢我收到的訂單（當前世界的所有訂單，僅 owner）
 * GET /api/orders/received?userId=xxx&date=今天
 */
app.get('/api/orders/received', async (req, res) => {
  try {
    const { userId, date } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }

    // 只允許「當前世界」的 owner 查詢
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      return res.status(403).json({ error: '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定' });
    }
    if (current.binding.role !== 'owner') {
      return res.status(403).json({ error: '僅世界擁有者可以查看收到的訂單' });
    }
    
    const dateStr = date || '今天';
    const today = new Date().toISOString().split('T')[0];
    
    // 從 order_history 查詢「當前世界」的所有訂單
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT *
         FROM order_history
         WHERE action_type = '建立訂單'
         ORDER BY created_at DESC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
    
    // 過濾並格式化結果
    const results = [];
    
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
      
      // 檢查日期
      const rowDate = row.created_at.split(' ')[0];
      let matchDate = false;
      
      if (dateStr === '今天' || dateStr === '今日') {
        matchDate = (rowDate === today);
      } else if (dateStr === '全部' || dateStr === '') {
        matchDate = true;
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
      
      if (!matchDate) {
        continue;
      }

      // 僅保留屬於「當前世界」的訂單
      // 優先從 order_history.worldId 取得（即使訂單被取消也能查詢）
      let orderWorldId = row.worldId;
      // 如果 order_history 中沒有 worldId（舊資料），則從 orders 表查詢
      if (orderWorldId === null || orderWorldId === undefined) {
        const orderItems = await getOrderItems(db, row.order_id);
        if (orderItems && orderItems.length > 0) {
          orderWorldId = orderItems[0].worldId;
        }
      }
      // 如果還是沒有 worldId，跳過此訂單
      if (orderWorldId === null || orderWorldId === undefined || orderWorldId !== current.worldId) {
        continue;
      }
      
      results.push({
        orderId: row.order_id,
        branch: newData.branch,
        items: newData.items,
        createdAt: row.created_at,
        user: row.user, // 顯示下單者名稱
        userId: row.userId // 下單者 userId
      });
    }
    
    // 以訂購人為主排序，其次依建立時間新→舊
    const sorted = results.sort((a, b) => {
      const ua = (a.user || '').localeCompare ? (a.user || '') : String(a.user || '');
      const ub = (b.user || '').localeCompare ? (b.user || '') : String(b.user || '');
      if (ua !== ub) {
        return ua.localeCompare(ub, 'zh-Hant');
      }
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    
    res.json({
      success: true,
      orders: sorted
    });
  } catch (err) {
    console.error('❌ 查詢收到的訂單失敗:', err);
    res.status(500).json({ error: '查詢訂單時發生錯誤，請稍後再試' });
  }
});

/**
 * 匯出我收到的訂單為 Excel（僅 owner）
 * GET /api/orders/received/export?userId=xxx&date=今天&columns=...
 */
app.get('/api/orders/received/export', async (req, res) => {
  try {
    const { userId, date, columns } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }

    // 只允許「當前世界」的 owner 匯出
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      return res.status(403).json({ error: '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定' });
    }
    if (current.binding.role !== 'owner') {
      return res.status(403).json({ error: '僅世界擁有者可以匯出訂單' });
    }
    
    const dateStr = date || '今天';
    const today = new Date().toISOString().split('T')[0];
    
    // 解析欄位設定
    let columnConfig = null;
    if (columns) {
      try {
        columnConfig = JSON.parse(decodeURIComponent(columns));
      } catch {
        // 解析失敗，使用預設
      }
    }
    
    // 預設欄位順序（與前端設定欄位一致）
    const defaultColumns = [
      { key: 'user', label: '訂購人', enabled: true },
      { key: 'vendor', label: '廠商', enabled: true },
      { key: 'itemName', label: '品項名稱', enabled: true },
      { key: 'qty', label: '數量', enabled: true },
      { key: 'orderId', label: '訂單ID', enabled: true },
      { key: 'createdAt', label: '建立時間', enabled: true },
      { key: 'branch', label: '分店', enabled: false },
      { key: 'userId', label: '訂購人ID', enabled: false }
    ];
    
    // 取得世界的 vendorMap（用於查找廠商）
    const vendorMap = await getVendorMap(db, current.worldId);
    
    // 取得啟用的欄位並保持順序
    const activeColumns = (columnConfig || defaultColumns)
      .filter(col => col.enabled !== false);
    
    // 建立欄位標題對應（key -> label）
    const columnLabels = {};
    activeColumns.forEach(col => {
      columnLabels[col.key] = col.label;
    });
    
    // 從 order_history 查詢「當前世界」的所有訂單（與 /api/orders/received 相同邏輯）
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT *
         FROM order_history
         WHERE action_type = '建立訂單'
         ORDER BY created_at DESC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
    
    // 過濾並格式化結果
    const results = [];
    
    for (const row of rows) {
      let newData;
      try {
        newData = JSON.parse(row.new_data);
      } catch (err) {
        continue;
      }
      
      if (!newData || typeof newData !== 'object' || !Array.isArray(newData.items)) {
        continue;
      }
      
      // 檢查日期
      const rowDate = row.created_at.split(' ')[0];
      let matchDate = false;
      
      if (dateStr === '今天' || dateStr === '今日') {
        matchDate = (rowDate === today);
      } else if (dateStr === '全部' || dateStr === '') {
        matchDate = true;
      } else {
        const dateMatch = dateStr.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if (dateMatch) {
          const year = dateMatch[1];
          const month = dateMatch[2].padStart(2, '0');
          const day = dateMatch[3].padStart(2, '0');
          const targetDate = `${year}-${month}-${day}`;
          matchDate = (rowDate === targetDate);
        } else {
          matchDate = true;
        }
      }
      
      if (!matchDate) {
        continue;
      }

      // 僅保留屬於「當前世界」的訂單
      // 優先從 order_history.worldId 取得（即使訂單被取消也能查詢）
      let orderWorldId = row.worldId;
      // 如果 order_history 中沒有 worldId（舊資料），則從 orders 表查詢
      if (orderWorldId === null || orderWorldId === undefined) {
        const orderItems = await getOrderItems(db, row.order_id);
        if (orderItems && orderItems.length > 0) {
          orderWorldId = orderItems[0].worldId;
        }
      }
      // 如果還是沒有 worldId，跳過此訂單
      if (orderWorldId === null || orderWorldId === undefined || orderWorldId !== current.worldId) {
        continue;
      }
      
      // 將每個品項展開為一行
      for (const item of newData.items) {
        const itemName = item.name || item.item || '';
        const vendor = (vendorMap && itemName) ? (resolveVendorForItemName(itemName, vendorMap) || getVendorByItem(itemName) || '') : '';
        
        // 建立一筆「欄位 key 為主」的資料列
        const rowData = {
          orderId: row.order_id,
          branch: newData.branch,
          vendor: vendor || '',
          itemName,
          qty: item.qty || 0,
          user: row.user || '',
          userId: row.userId || '',
          createdAt: row.created_at
        };
        
        results.push(rowData);
      }
    }
    
    // 以訂購人為主排序，其次依建立時間新→舊
    results.sort((a, b) => {
      const ua = (a.user || '').localeCompare ? (a.user || '') : String(a.user || '');
      const ub = (b.user || '').localeCompare ? (b.user || '') : String(b.user || '');
      if (ua !== ub) {
        return ua.localeCompare(ub, 'zh-Hant');
      }
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    // 產生 Excel（確保欄位順序）
    const XLSX = (await import('xlsx')).default;
    
    // 建立標題列（按照使用者設定的順序）
    const headers = activeColumns.map(col => col.label);
    
    // 建立資料列（按照標題順序）
    const dataRows = results.map(row => {
      return activeColumns.map(col => {
        const key = col.key;
        if (key === 'createdAt') {
          // 格式化時間為 YYYY-MM-DD HH:mm
          const date = new Date(row.createdAt);
          return date.toISOString().slice(0, 16).replace('T', ' ');
        }
        return row[key] ?? '';
      });
    });
    
    // 合併標題和資料
    const worksheetData = [headers, ...dataRows];
    
    const ws = XLSX.utils.aoa_to_sheet(worksheetData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '訂單');
    
    // 產生 buffer
    const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    // 設定檔名
    let filename = '訂單';
    if (dateStr === '今天' || dateStr === '今日') {
      filename = `訂單_${today}.xlsx`;
    } else if (dateStr === '全部' || dateStr === '') {
      filename = '訂單_全部.xlsx';
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      filename = `訂單_${dateStr}.xlsx`;
    } else {
      filename = `訂單_${today}.xlsx`;
    }
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(excelBuffer);
  } catch (err) {
    console.error('❌ 匯出 Excel 失敗:', err);
    res.status(500).json({ error: '匯出 Excel 時發生錯誤，請稍後再試' });
  }
});

/**
 * 預覽我收到的訂單欄位（僅 owner，給前端顯示用）
 * GET /api/orders/received/preview?userId=xxx&date=今天
 */
app.get('/api/orders/received/preview', async (req, res) => {
  try {
    const { userId, date } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }

    // 只允許「當前世界」的 owner 查看
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      return res.status(403).json({ error: '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定' });
    }
    if (current.binding.role !== 'owner') {
      return res.status(403).json({ error: '僅世界擁有者可以查看收到的訂單' });
    }
    
    const dateStr = date || '今天';
    const today = new Date().toISOString().split('T')[0];
    
    // 取得世界的 vendorMap（用於查找廠商）
    const vendorMap = await getVendorMap(db, current.worldId);
    
    // 預設欄位順序（與 Excel 匯出 / 前端設定一致）
    const defaultColumns = [
      { key: 'user', label: '訂購人', enabled: true },
      { key: 'vendor', label: '廠商', enabled: true },
      { key: 'itemName', label: '品項名稱', enabled: true },
      { key: 'qty', label: '數量', enabled: true },
      { key: 'orderId', label: '訂單ID', enabled: true },
      { key: 'createdAt', label: '建立時間', enabled: true },
      { key: 'branch', label: '分店', enabled: false },
      { key: 'userId', label: '訂購人ID', enabled: false }
    ];
    
    const activeColumns = defaultColumns.filter(col => col.enabled !== false);
    
    // 從 order_history 查詢「當前世界」的所有訂單（與 /api/orders/received/export 相同邏輯）
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT *
         FROM order_history
         WHERE action_type = '建立訂單'
         ORDER BY created_at DESC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
    
    const results = [];
    
    for (const row of rows) {
      let newData;
      try {
        newData = JSON.parse(row.new_data);
      } catch (err) {
        continue;
      }
      
      if (!newData || typeof newData !== 'object' || !Array.isArray(newData.items)) {
        continue;
      }
      
      // 檢查日期
      const rowDate = row.created_at.split(' ')[0];
      let matchDate = false;
      
      if (dateStr === '今天' || dateStr === '今日') {
        matchDate = (rowDate === today);
      } else if (dateStr === '全部' || dateStr === '') {
        matchDate = true;
      } else {
        const dateMatch = dateStr.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if (dateMatch) {
          const year = dateMatch[1];
          const month = dateMatch[2].padStart(2, '0');
          const day = dateMatch[3].padStart(2, '0');
          const targetDate = `${year}-${month}-${day}`;
          matchDate = (rowDate === targetDate);
        } else {
          matchDate = true;
        }
      }
      
      if (!matchDate) continue;
      
      // 僅保留屬於「當前世界」的訂單
      // 優先從 order_history.worldId 取得（即使訂單被取消也能查詢）
      let orderWorldId = row.worldId;
      // 如果 order_history 中沒有 worldId（舊資料），則從 orders 表查詢
      if (orderWorldId === null || orderWorldId === undefined) {
        const orderItems = await getOrderItems(db, row.order_id);
        if (orderItems && orderItems.length > 0) {
          orderWorldId = orderItems[0].worldId;
        }
      }
      // 如果還是沒有 worldId，跳過此訂單
      if (orderWorldId === null || orderWorldId === undefined || orderWorldId !== current.worldId) {
        continue;
      }
      
      // 將每個品項展開為一行
      for (const item of newData.items) {
        const itemName = item.name || item.item || '';
        const vendor = (vendorMap && itemName) ? (resolveVendorForItemName(itemName, vendorMap) || getVendorByItem(itemName) || '') : '';
        
        results.push({
          orderId: row.order_id,
          branch: newData.branch,
          vendor: vendor || '',
          itemName,
          qty: item.qty || 0,
          user: row.user || '',
          userId: row.userId || '',
          createdAt: row.created_at
        });
      }
    }
    
    // 以訂購人為主排序，其次依建立時間新→舊
    results.sort((a, b) => {
      const ua = (a.user || '').localeCompare ? (a.user || '') : String(a.user || '');
      const ub = (b.user || '').localeCompare ? (b.user || '') : String(b.user || '');
      if (ua !== ub) {
        return ua.localeCompare(ub, 'zh-Hant');
      }
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    res.json({
      success: true,
      columns: activeColumns,
      rows: results
    });
  } catch (err) {
    console.error('❌ 預覽收到的訂單失敗:', err);
    res.status(500).json({ error: '查詢訂單時發生錯誤，請稍後再試' });
  }
});

/**
 * 查詢我的訂單
 * GET /api/orders/my?userId=xxx&date=今天
 */
app.get('/api/orders/my', async (req, res) => {
  try {
    const { userId, date, worldId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }

    // 檢查使用者是否有加入任何世界（但不限制只顯示當前世界）
    const bindings = await getBindings(db, userId);
    if (bindings.length === 0) {
      return res.status(403).json({ error: '您尚未加入任何世界' });
    }
    
    // 如果提供了 worldId，檢查使用者是否有權限查看該世界
    let filterWorldId = null;
    if (worldId) {
      const worldIdNum = parseInt(worldId, 10);
      if (!isNaN(worldIdNum)) {
        const hasAccess = bindings.some(b => b.worldId === worldIdNum);
        if (hasAccess) {
          filterWorldId = worldIdNum;
        } else {
          return res.status(403).json({ error: '您沒有權限查看此世界的訂單' });
        }
      }
    }
    
    const dateStr = date || '今天';
    // 使用資料庫時間計算「今天」（與 created_at 使用相同的時間來源）
    // SQLite 的 CURRENT_TIMESTAMP 使用系統本地時間，所以我們也用本地時區
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  // 額外計算「昨天」：對使用者來說，「今天」預設顯示「今天 + 昨天」的單，避免跨日就查不到昨天下的訂單
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = `${yesterdayDate.getFullYear()}-${String(yesterdayDate.getMonth() + 1).padStart(2, '0')}-${String(yesterdayDate.getDate()).padStart(2, '0')}`;
  console.log(`📅 日期查詢: dateStr=${dateStr}, today=${today}, yesterday=${yesterday}, 系統時間=${now.toISOString()}, 本地時間=${now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
    
    // 從 order_history 查詢「這個使用者」建立的訂單
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT *
         FROM order_history
         WHERE action_type = '建立訂單'
           AND userId = ?
         ORDER BY created_at DESC`,
        [userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
    
    // 過濾並格式化結果
    const results = [];
    
    console.log(`🔍 查詢我的訂單: userId=${userId}, date=${dateStr}, 找到 ${rows.length} 筆歷史記錄`);
    
    for (const row of rows) {
      let newData;
      try {
        newData = JSON.parse(row.new_data);
      } catch (err) {
        console.error('❌ 解析訂單資料失敗 (order_id:', row.order_id, '):', err);
        continue;
      }
      
      // 檢查 newData 格式（branch 改為可選，因為新訂單可能固定為 '多分店'）
      if (!newData || typeof newData !== 'object' || !Array.isArray(newData.items)) {
        console.log(`⚠️ 訂單 ${row.order_id} 格式錯誤: newData=`, JSON.stringify(newData).substring(0, 100));
        continue;
      }
      
      // 檢查日期
      // 將 created_at 轉為本地時區的日期（如果資料庫存的是 UTC）
      let rowDate;
      try {
        const rowDateObj = new Date(row.created_at);
        // 使用本地時區取得日期部分
        rowDate = `${rowDateObj.getFullYear()}-${String(rowDateObj.getMonth() + 1).padStart(2, '0')}-${String(rowDateObj.getDate()).padStart(2, '0')}`;
      } catch (e) {
        // fallback：直接取字串前 10 字元
        rowDate = row.created_at.split(' ')[0];
      }
      
      let matchDate = false;
      
      if (dateStr === '今天' || dateStr === '今日') {
        // 「今天」視為「今天 + 昨天」的訂單，確保昨天下的單隔天仍然查得到
        matchDate = (rowDate === today || rowDate === yesterday);
      } else if (dateStr === '全部' || dateStr === '') {
        matchDate = true;
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
      
      if (!matchDate) {
        console.log(`⚠️ 訂單 ${row.order_id} 日期不匹配: row.created_at=${row.created_at}, rowDate=${rowDate}, dateStr=${dateStr}, today=${today}`);
        continue;
      }

      // 查詢訂單的世界資訊（顯示所有世界的訂單，但標註世界名稱）
      const orderItems = await getOrderItems(db, row.order_id);
      if (!orderItems || orderItems.length === 0) {
        console.log(`⚠️ 訂單 ${row.order_id} 找不到 orderItems`);
        continue;
      }
      const orderWorldId = orderItems[0].worldId;
      
      // 如果指定了世界篩選，只保留該世界的訂單
      if (filterWorldId !== null && orderWorldId !== filterWorldId) {
        continue;
      }
      
      // 查詢世界資訊（名稱、代碼）
      let worldName = null;
      let worldCode = null;
      if (orderWorldId !== null && orderWorldId !== undefined) {
        const world = await getWorldById(db, orderWorldId);
        if (world) {
          worldName = world.name || `世界 #${String(world.id).padStart(6, '0')}`;
          worldCode = world.worldCode || null;
        }
      }
      
      results.push({
        orderId: row.order_id,
        branch: newData.branch || '多分店',
        items: newData.items,
        createdAt: row.created_at,
        user: row.user, // 保留顯示名稱，用於顯示「誰點的」
        worldId: orderWorldId,
        worldName: worldName,
        worldCode: worldCode
      });
    }
    
    console.log(`📊 最終結果: ${results.length} 筆訂單`);
    
    res.json({
      success: true,
      orders: results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    });
  } catch (err) {
    console.error('❌ 查詢我的訂單失敗:', err);
    res.status(500).json({ error: '查詢訂單時發生錯誤，請稍後再試' });
  }
});

// ==================== 菜單管理 API ====================

/**
 * 查看菜單
 * GET /api/menu?userId=xxx
 */
app.get('/api/menu', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    // 以「當前世界」為主，而不是任一 active 世界
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      const bindings = await getBindings(db, userId);
      const msg = bindings.length === 0
        ? '您尚未加入任何世界'
        : '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定';
      return res.status(403).json({ error: msg });
    }
    
    const world = await getWorldById(db, current.worldId);
    const vendorMap = await getVendorMap(db, current.worldId);
    
    if (!vendorMap || Object.keys(vendorMap).length === 0) {
      return res.json({
        menu: null,
        formatted: '菜單為空',
        message: '老闆尚未設定菜單',
        menuImageUrl: world?.menuImageUrl || null,
        orderFormat: null
      });
    }
    
    const formatted = formatVendorMap(vendorMap);
    
    // 從 vendorMap 提取 itemAttributes（品項對應的屬性列表，供前端訂單格式參考）
    const itemAttributes = {};
    for (const vendor of Object.keys(vendorMap)) {
      for (const itemName of Object.keys(vendorMap[vendor])) {
        const val = vendorMap[vendor][itemName];
        if (typeof val === 'object' && val !== null && Array.isArray(val.attributes) && val.attributes.length > 0) {
          if (!itemAttributes[vendor]) itemAttributes[vendor] = {};
          itemAttributes[vendor][itemName] = val.attributes;
        }
      }
    }
    
    let orderFormat = null;
    if (world.orderFormat) {
      try {
        orderFormat = JSON.parse(world.orderFormat);
      } catch { /* ignore */ }
    }
    
    // 取得所有品項的圖片
    const itemImages = await new Promise((resolve, reject) => {
      db.all(
        'SELECT vendor, itemName, imageUrl FROM menu_item_images WHERE worldId = ?',
        [current.worldId],
        (err, rows) => {
          if (err) reject(err);
          else {
            const imageMap = {};
            rows.forEach(row => {
              if (!imageMap[row.vendor]) imageMap[row.vendor] = {};
              imageMap[row.vendor][row.itemName] = row.imageUrl;
            });
            resolve(imageMap);
          }
        }
      );
    });
    
    res.json({
      menu: vendorMap,
      formatted,
      menuImageUrl: world?.menuImageUrl || null,
      orderFormat,
      itemImages: itemImages || {},
      itemAttributes: Object.keys(itemAttributes).length > 0 ? itemAttributes : undefined
    });
  } catch (err) {
    console.error('❌ 查看菜單失敗:', err);
    res.status(500).json({ error: '查看菜單時發生錯誤，請稍後再試' });
  }
});

/**
 * 新增品項到菜單（僅 owner）
 * POST /api/menu/items?userId=xxx
 * Body: { branch: string, itemName: string, qty?: number }
 */
app.post('/api/menu/items', async (req, res) => {
  try {
    const { userId } = req.query;
    const { branch, itemName, qty = 0 } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    if (!branch || !itemName) {
      return res.status(400).json({ error: '缺少必要參數：branch 和 itemName' });
    }
    
    // 僅允許當前世界的 owner 管理菜單
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      return res.status(403).json({ error: '世界尚未啟用' });
    }
    if (current.binding.role !== 'owner') {
      return res.status(403).json({ error: '僅世界擁有者可以管理菜單' });
    }
    
    // 驗證輸入
    if (typeof branch !== 'string' || branch.trim().length === 0 || branch.trim().length > 100) {
      return res.status(400).json({ error: '分店名稱格式錯誤' });
    }
    if (typeof itemName !== 'string' || itemName.trim().length === 0 || itemName.trim().length > 100) {
      return res.status(400).json({ error: '品項名稱格式錯誤' });
    }
    if (typeof qty !== 'number' || qty < 0 || qty > 999999 || !Number.isInteger(qty)) {
      return res.status(400).json({ error: '數量格式錯誤（必須為 0-999999 之間的正整數）' });
    }
    
    await addItemToMenu(db, current.worldId, branch.trim(), itemName.trim(), qty);
    
    res.json({
      success: true,
      message: '品項已新增到菜單',
      branch: branch.trim(),
      itemName: itemName.trim(),
      qty
    });
  } catch (err) {
    console.error('❌ 新增品項失敗:', err);
    res.status(500).json({ error: '新增品項時發生錯誤，請稍後再試' });
  }
});

/**
 * 從菜單刪除品項（僅 owner）
 * DELETE /api/menu/items?userId=xxx&branch=xxx&itemName=xxx
 */
app.delete('/api/menu/items', async (req, res) => {
  try {
    const { userId, branch, itemName } = req.query;
    
    if (!userId || !branch || !itemName) {
      return res.status(400).json({ error: '缺少必要參數：userId、branch 和 itemName' });
    }
    
    // 僅允許當前世界的 owner 管理菜單
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      return res.status(403).json({ error: '世界尚未啟用' });
    }
    if (current.binding.role !== 'owner') {
      return res.status(403).json({ error: '僅世界擁有者可以管理菜單' });
    }
    
    const success = await removeItemFromMenu(db, current.worldId, branch, itemName);
    
    if (success) {
      res.json({
        success: true,
        message: '品項已從菜單刪除'
      });
    } else {
      res.status(404).json({ error: '找不到指定的品項' });
    }
  } catch (err) {
    console.error('❌ 刪除品項失敗:', err);
    res.status(500).json({ error: '刪除品項時發生錯誤，請稍後再試' });
  }
});

/**
 * 修改菜單品項（僅 owner）
 * PUT /api/menu/items?userId=xxx
 * Body: { branch: string, oldItemName: string, newItemName?: string, qty?: number }
 */
app.put('/api/menu/items', async (req, res) => {
  try {
    const { userId } = req.query;
    const { branch, oldItemName, newItemName, qty } = req.body;
    
    if (!userId || !branch || !oldItemName) {
      return res.status(400).json({ error: '缺少必要參數：userId、branch 和 oldItemName' });
    }
    
    // 僅允許當前世界的 owner 管理菜單
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      return res.status(403).json({ error: '世界尚未啟用' });
    }
    if (current.binding.role !== 'owner') {
      return res.status(403).json({ error: '僅世界擁有者可以管理菜單' });
    }
    
    // 驗證輸入
    if (typeof branch !== 'string' || branch.trim().length === 0) {
      return res.status(400).json({ error: '分店名稱格式錯誤' });
    }
    if (typeof oldItemName !== 'string' || oldItemName.trim().length === 0) {
      return res.status(400).json({ error: '舊品項名稱格式錯誤' });
    }
    if (newItemName && (typeof newItemName !== 'string' || newItemName.trim().length === 0)) {
      return res.status(400).json({ error: '新品項名稱格式錯誤' });
    }
    if (qty !== undefined && (typeof qty !== 'number' || qty < 0 || qty > 999999 || !Number.isInteger(qty))) {
      return res.status(400).json({ error: '數量格式錯誤（必須為 0-999999 之間的正整數）' });
    }
    
    const success = await updateMenuItem(
      db,
      current.worldId,
      branch.trim(),
      oldItemName.trim(),
      newItemName ? newItemName.trim() : null,
      qty !== undefined ? qty : null
    );
    
    if (success) {
      res.json({
        success: true,
        message: '品項已修改'
      });
    } else {
      res.status(404).json({ error: '找不到指定的品項' });
    }
  } catch (err) {
    console.error('❌ 修改品項失敗:', err);
    res.status(500).json({ error: '修改品項時發生錯誤，請稍後再試' });
  }
});

// ==================== Excel 上傳 API ====================

/**
 * 上傳 Excel 並智能偵測欄位
 * POST /api/menu/upload-excel?userId=xxx
 * FormData: { file: File }
 */
app.post('/api/menu/upload-excel', upload.single('file'), async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: '請選擇要上傳的 Excel 檔案' });
    }
    
    // 僅允許「當前世界」的 owner 上傳 Excel，並綁定到該世界
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      await unlink(req.file.path).catch(() => {});
      return res.status(403).json({ error: '世界尚未啟用或尚未完成設定' });
    }
    if (current.binding.role !== 'owner') {
      await unlink(req.file.path).catch(() => {});
      return res.status(403).json({ error: '僅世界擁有者可以上傳 Excel 菜單' });
    }
    
    // 讀取 Excel 檔案
    const XLSX = (await import('xlsx')).default;
    const workbook = XLSX.readFile(req.file.path);
    
    // 取得預覽資料
    const preview = getExcelPreview(workbook);
    
    // 嘗試智能偵測欄位
    const detectedMapping = detectExcelMapping(workbook);
    
    // 取得已儲存的欄位對應（如果有的話）
    const savedMapping = await getExcelMapping(db, current.worldId);
    
    // 優先使用已儲存的對應，如果沒有則使用偵測結果
    const mapping = savedMapping || detectedMapping;
    
    // 清理上傳的檔案
    await unlink(req.file.path).catch(() => {});
    
    if (!mapping) {
      return res.status(400).json({
        error: '無法自動偵測 Excel 欄位格式',
        preview,
        needsMapping: true,
        message: '請手動設定欄位對應'
      });
    }
    
    // 嘗試解析 Excel
    const vendorMap = parseExcelToVendorMap(workbook, mapping);
    
    if (!vendorMap) {
      return res.status(400).json({
        error: '無法解析 Excel 內容',
        preview,
        detectedMapping,
        needsMapping: true,
        message: '請檢查 Excel 格式或手動設定欄位對應'
      });
    }
    
    // 儲存 vendorMap 到當前世界
    await saveVendorMap(db, current.worldId, vendorMap);
    
    // 如果偵測成功且沒有已儲存的對應，儲存欄位對應設定
    if (detectedMapping && !savedMapping) {
      await updateExcelMapping(db, current.worldId, JSON.stringify(detectedMapping));
    }
    
    res.json({
      success: true,
      message: 'Excel 菜單匯入成功',
      vendorMap,
      mapping: detectedMapping ? 'auto' : 'saved',
      preview
    });
  } catch (err) {
    // 清理上傳的檔案
    if (req.file) {
      await unlink(req.file.path).catch(() => {});
    }
    console.error('❌ 上傳 Excel 失敗:', err);
    res.status(500).json({ error: err.message || '上傳 Excel 時發生錯誤，請稍後再試' });
  }
});

/**
 * 使用指定的欄位對應解析 Excel
 * POST /api/menu/parse-excel?userId=xxx
 * Body: { mapping: { branchColumn?, itemColumn, qtyColumn, hasHeader, startRow } }
 * FormData: { file: File }
 */
app.post('/api/menu/parse-excel', upload.single('file'), async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      if (req.file) await unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: '請選擇要上傳的 Excel 檔案' });
    }
    
    const { mapping } = req.body;
    if (!mapping) {
      await unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: '缺少必要參數：mapping' });
    }
    
    let parsedMapping;
    try {
      parsedMapping = typeof mapping === 'string' ? JSON.parse(mapping) : mapping;
    } catch {
      await unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'mapping 格式錯誤' });
    }
    
    if (!parsedMapping.itemColumn || !parsedMapping.qtyColumn) {
      await unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'mapping 必須包含 itemColumn 和 qtyColumn' });
    }
    
    // 僅允許「當前世界」的 owner 匯入 Excel
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      await unlink(req.file.path).catch(() => {});
      return res.status(403).json({ error: '世界尚未啟用或尚未完成設定' });
    }
    if (current.binding.role !== 'owner') {
      await unlink(req.file.path).catch(() => {});
      return res.status(403).json({ error: '僅世界擁有者可以上傳 Excel 菜單' });
    }
    
    // 讀取 Excel 檔案
    const XLSX = (await import('xlsx')).default;
    const workbook = XLSX.readFile(req.file.path);
    
    // 解析 Excel
    const vendorMap = parseExcelToVendorMap(workbook, parsedMapping);
    
    // 清理上傳的檔案
    await unlink(req.file.path).catch(() => {});
    
    if (!vendorMap) {
      // 提供更詳細的錯誤訊息
      const preview = getExcelPreview(workbook);
      const errorDetails = {
        error: '無法解析 Excel 內容，請檢查欄位對應設定',
        hint: '可能的原因：\n1. 欄位對應設定不正確（品項欄位或數量欄位錯誤）\n2. Excel 資料格式問題（數量為 0 或負數）\n3. 起始行設定錯誤（hasHeader 設定不正確）',
        mapping: parsedMapping,
        preview: preview
      };
      console.error('❌ Excel 解析失敗:', errorDetails);
      return res.status(400).json(errorDetails);
    }
    
    // 儲存 vendorMap 與欄位對應到當前世界
    await saveVendorMap(db, current.worldId, vendorMap);
    await updateExcelMapping(db, current.worldId, JSON.stringify(parsedMapping));
    
    res.json({
      success: true,
      message: 'Excel 菜單匯入成功',
      vendorMap
    });
  } catch (err) {
    if (req.file) {
      await unlink(req.file.path).catch(() => {});
    }
    console.error('❌ 解析 Excel 失敗:', err);
    res.status(500).json({ error: err.message || '解析 Excel 時發生錯誤，請稍後再試' });
  }
});

/**
 * 取得 Excel 預覽（不匯入）
 * POST /api/menu/preview-excel?userId=xxx
 * FormData: { file: File }
 */
app.post('/api/menu/preview-excel', upload.single('file'), async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      if (req.file) await unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: '請選擇要預覽的 Excel 檔案' });
    }
    
    // 僅允許「當前世界」的 owner 預覽 Excel
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      await unlink(req.file.path).catch(() => {});
      return res.status(403).json({ error: '世界尚未啟用或尚未完成設定' });
    }
    if (current.binding.role !== 'owner') {
      await unlink(req.file.path).catch(() => {});
      return res.status(403).json({ error: '僅世界擁有者可以預覽 Excel' });
    }
    
    // 讀取 Excel 檔案
    const XLSX = (await import('xlsx')).default;
    const workbook = XLSX.readFile(req.file.path);
    
    // 取得預覽資料
    const preview = getExcelPreview(workbook);
    
    // 嘗試智能偵測欄位
    const detectedMapping = detectExcelMapping(workbook);
    
    // 取得已儲存的欄位對應（當前世界）
    const savedMapping = await getExcelMapping(db, current.worldId);
    
    // 清理上傳的檔案
    await unlink(req.file.path).catch(() => {});
    
    res.json({
      preview,
      detectedMapping,
      savedMapping,
      hasSavedMapping: !!savedMapping
    });
  } catch (err) {
    if (req.file) {
      await unlink(req.file.path).catch(() => {});
    }
    console.error('❌ 預覽 Excel 失敗:', err);
    res.status(500).json({ error: err.message || '預覽 Excel 時發生錯誤，請稍後再試' });
  }
});

/**
 * 更新 Excel 欄位對應設定
 * PUT /api/menu/excel-mapping?userId=xxx
 * Body: { mapping: { branchColumn?, itemColumn, qtyColumn, hasHeader, startRow } }
 */
app.put('/api/menu/excel-mapping', async (req, res) => {
  try {
    const { userId } = req.query;
    const { mapping } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    if (!mapping) {
      return res.status(400).json({ error: '缺少必要參數：mapping' });
    }
    
    if (!mapping.itemColumn || !mapping.qtyColumn) {
      return res.status(400).json({ error: 'mapping 必須包含 itemColumn 和 qtyColumn' });
    }
    
    // 僅允許「當前世界」的 owner 設定 Excel 欄位對應
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      return res.status(403).json({ error: '世界尚未啟用或尚未完成設定' });
    }
    if (current.binding.role !== 'owner') {
      return res.status(403).json({ error: '僅世界擁有者可以設定 Excel 欄位對應' });
    }
    
    await updateExcelMapping(db, current.worldId, JSON.stringify(mapping));
    
    res.json({
      success: true,
      message: 'Excel 欄位對應設定已儲存',
      mapping
    });
  } catch (err) {
    console.error('❌ 更新 Excel 欄位對應失敗:', err);
    res.status(500).json({ error: '更新 Excel 欄位對應時發生錯誤，請稍後再試' });
  }
});

/**
 * 上傳品項圖片（僅 owner）
 * POST /api/menu/items/image?userId=xxx&vendor=xxx&itemName=xxx
 * FormData: { image: File }
 */
app.post('/api/menu/items/image', imageUpload.single('image'), async (req, res) => {
  try {
    const { userId, vendor, itemName } = req.query;
    
    if (!userId || !vendor || !itemName) {
      if (req.file) await unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: '缺少必要參數：userId, vendor, itemName' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: '請選擇圖片檔案' });
    }
    
    // 僅允許「當前世界」的 owner 上傳圖片
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      if (req.file) await unlink(req.file.path).catch(() => {});
      return res.status(403).json({ error: '世界尚未啟用或尚未完成設定' });
    }
    if (current.binding.role !== 'owner') {
      if (req.file) await unlink(req.file.path).catch(() => {});
      return res.status(403).json({ error: '僅世界擁有者可以上傳圖片' });
    }
    
    // 檢查是否已有舊圖片，如果有則先刪除
    const existingRow = await new Promise((resolve, reject) => {
      db.get(
        'SELECT imageUrl FROM menu_item_images WHERE worldId = ? AND vendor = ? AND itemName = ?',
        [current.worldId, vendor, itemName],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    
    if (existingRow && existingRow.imageUrl) {
      const oldImagePath = join(__dirname, '..', 'public', existingRow.imageUrl);
      await unlink(oldImagePath).catch(() => {});
    }
    
    // 將圖片移動到上傳目錄（本地 public/uploads，雲端 DATA_DIR/uploads）
    if (!existsSync(uploadsRoot)) {
      await mkdir(uploadsRoot, { recursive: true });
    }
    const fileName = `${current.worldId}_${vendor}_${itemName}_${Date.now()}.${req.file.originalname.split('.').pop()}`;
    const targetPath = join(uploadsRoot, fileName);
    
    // 讀取並寫入檔案
    const fileContent = await import('fs/promises').then(m => m.readFile(req.file.path));
    await writeFile(targetPath, fileContent);
    await unlink(req.file.path).catch(() => {});
    
    const imageUrl = `/uploads/${fileName}`;
    
    // 儲存或更新資料庫
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO menu_item_images (worldId, vendor, itemName, imageUrl, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(worldId, vendor, itemName) 
         DO UPDATE SET imageUrl = ?, updated_at = datetime('now')`,
        [current.worldId, vendor, itemName, imageUrl, imageUrl],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
    
    res.json({
      success: true,
      imageUrl,
      message: '圖片上傳成功'
    });
  } catch (err) {
    if (req.file) await unlink(req.file.path).catch(() => {});
    console.error('❌ 上傳圖片失敗:', err);
    res.status(500).json({ error: err.message || '上傳圖片時發生錯誤，請稍後再試' });
  }
});

/**
 * 上傳菜單圖片（僅 owner）
 * POST /api/menu/image?userId=xxx
 * FormData: { image: File }
 */
app.post('/api/menu/image', imageUpload.single('image'), async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      if (req.file) await unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: '請選擇圖片檔案' });
    }
    
    // 僅允許「當前世界」的 owner 上傳圖片
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      if (req.file) await unlink(req.file.path).catch(() => {});
      return res.status(403).json({ error: '世界尚未啟用或尚未完成設定' });
    }
    if (current.binding.role !== 'owner') {
      if (req.file) await unlink(req.file.path).catch(() => {});
      return res.status(403).json({ error: '僅世界擁有者可以上傳菜單圖片' });
    }
    
    // 檢查是否已有舊圖片，如果有則先刪除
    const world = await getWorldById(db, current.worldId);
    if (world && world.menuImageUrl) {
      const oldImagePath = join(__dirname, '..', 'public', world.menuImageUrl);
      await unlink(oldImagePath).catch(() => {});
    }
    
    // 將圖片移動到上傳目錄（本地 public/uploads，雲端 DATA_DIR/uploads）
    if (!existsSync(uploadsRoot)) {
      await mkdir(uploadsRoot, { recursive: true });
    }
    const fileName = `menu_${current.worldId}_${Date.now()}.${req.file.originalname.split('.').pop()}`;
    const targetPath = join(uploadsRoot, fileName);
    
    // 讀取並寫入檔案
    const fileContent = await import('fs/promises').then(m => m.readFile(req.file.path));
    await writeFile(targetPath, fileContent);
    await unlink(req.file.path).catch(() => {});
    
    const imageUrl = `/uploads/${fileName}`;
    
    // 更新資料庫
    await updateMenuImageUrl(db, current.worldId, imageUrl);
    
    res.json({
      success: true,
      imageUrl,
      message: '菜單圖片上傳成功'
    });
  } catch (err) {
    if (req.file) await unlink(req.file.path).catch(() => {});
    console.error('❌ 上傳菜單圖片失敗:', err);
    res.status(500).json({ error: err.message || '上傳菜單圖片時發生錯誤，請稍後再試' });
  }
});

/**
 * 刪除菜單圖片（僅 owner）
 * DELETE /api/menu/image?userId=xxx
 */
app.delete('/api/menu/image', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    // 僅允許「當前世界」的 owner 刪除圖片
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      return res.status(403).json({ error: '世界尚未啟用或尚未完成設定' });
    }
    if (current.binding.role !== 'owner') {
      return res.status(403).json({ error: '僅世界擁有者可以刪除菜單圖片' });
    }
    
    // 取得圖片 URL
    const world = await getWorldById(db, current.worldId);
    if (world && world.menuImageUrl) {
      // 刪除檔案
      const imagePath = join(__dirname, '..', 'public', world.menuImageUrl);
      await unlink(imagePath).catch(() => {});
    }
    
    // 更新資料庫
    await updateMenuImageUrl(db, current.worldId, null);
    
    res.json({
      success: true,
      message: '菜單圖片已刪除'
    });
  } catch (err) {
    console.error('❌ 刪除菜單圖片失敗:', err);
    res.status(500).json({ error: '刪除菜單圖片時發生錯誤，請稍後再試' });
  }
});

/**
 * 刪除品項圖片（僅 owner）
 * DELETE /api/menu/items/image?userId=xxx&vendor=xxx&itemName=xxx
 */
app.delete('/api/menu/items/image', async (req, res) => {
  try {
    const { userId, vendor, itemName } = req.query;
    
    if (!userId || !vendor || !itemName) {
      return res.status(400).json({ error: '缺少必要參數：userId, vendor, itemName' });
    }
    
    // 僅允許「當前世界」的 owner 刪除圖片
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      return res.status(403).json({ error: '世界尚未啟用或尚未完成設定' });
    }
    if (current.binding.role !== 'owner') {
      return res.status(403).json({ error: '僅世界擁有者可以刪除圖片' });
    }
    
    // 取得圖片 URL
    const row = await new Promise((resolve, reject) => {
      db.get(
        'SELECT imageUrl FROM menu_item_images WHERE worldId = ? AND vendor = ? AND itemName = ?',
        [current.worldId, vendor, itemName],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    
    if (row && row.imageUrl) {
      // 刪除檔案
      const imagePath = join(__dirname, '..', 'public', row.imageUrl);
      await unlink(imagePath).catch(() => {});
    }
    
    // 刪除資料庫記錄
    await new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM menu_item_images WHERE worldId = ? AND vendor = ? AND itemName = ?',
        [current.worldId, vendor, itemName],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
    
    res.json({
      success: true,
      message: '圖片已刪除'
    });
  } catch (err) {
    console.error('❌ 刪除圖片失敗:', err);
    res.status(500).json({ error: '刪除圖片時發生錯誤，請稍後再試' });
  }
});

/**
 * 取得 Excel 欄位對應設定
 * GET /api/menu/excel-mapping?userId=xxx
 */
app.get('/api/menu/excel-mapping', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    // 僅允許「當前世界」的 owner 查看 Excel 欄位對應
    const current = await getAndValidateCurrentWorld(db, userId);
    if (!current) {
      return res.status(403).json({ error: '世界尚未啟用或尚未完成設定' });
    }
    if (current.binding.role !== 'owner') {
      return res.status(403).json({ error: '僅世界擁有者可以查看 Excel 欄位對應' });
    }
    
    const mapping = await getExcelMapping(db, current.worldId);
    
    res.json({
      mapping: mapping || null,
      hasMapping: !!mapping
    });
  } catch (err) {
    console.error('❌ 取得 Excel 欄位對應失敗:', err);
    res.status(500).json({ error: '取得 Excel 欄位對應時發生錯誤，請稍後再試' });
  }
});

// ==================== 測試／設定 API ====================

/**
 * 前端設定（含測試用 userId）
 * GET /api/config
 */
app.get('/api/config', (req, res) => {
  res.json({
    testUserId: process.env.WEB_TEST_USER_ID || null
  });
});

// ==================== LINE Login 相關 API ====================

/**
 * 除錯：回傳目前使用的 redirect_uri，方便與 LINE Developers 後台比對
 * GET /api/auth/redirect-uri
 */
app.get('/api/auth/redirect-uri', (req, res) => {
  const redirectUri = getLineLoginRedirectUri(req);
  res.json({
    redirectUri,
    hint: '請在 LINE Developers → 你的 Provider → LINE Login Channel → LINE Login settings → Callback URL 新增「完全一致」的網址（含 http、port、路徑，不可多尾斜線）',
  });
});

/**
 * 取得 LINE Login redirect_uri（與 LINE Developers 註冊值必須完全一致）
 * 請在 LINE Developers → LINE Login Channel → LINE Login settings → Callback URL 新增此網址
 */
function getLineLoginRedirectUri(req) {
  const raw = process.env.LINE_LOGIN_REDIRECT_URI;
  if (raw && String(raw).trim()) {
    return String(raw).trim();
  }
  return `${req.protocol}://${req.get('host')}/api/auth/line-login-callback`;
}

/**
 * LINE Login 初始化（重導向到 LINE 授權頁）
 * GET /api/auth/line-login
 */
app.get('/api/auth/line-login', (req, res) => {
  const LINE_LOGIN_CHANNEL_ID = (process.env.LINE_LOGIN_CHANNEL_ID || '').trim();
  const LINE_LOGIN_REDIRECT_URI = getLineLoginRedirectUri(req);
  const state = crypto.randomBytes(16).toString('hex');

  if (!LINE_LOGIN_CHANNEL_ID) {
    console.error('❌ LINE_LOGIN_CHANNEL_ID 未設定');
    return res.status(500).send('LINE Login 未設定，請設定 .env');
  }

  console.log('📤 LINE Login redirect_uri:', LINE_LOGIN_REDIRECT_URI);

  const authUrl = `https://access.line.me/oauth2/v2.1/authorize?` +
    `response_type=code&` +
    `client_id=${LINE_LOGIN_CHANNEL_ID}&` +
    `redirect_uri=${encodeURIComponent(LINE_LOGIN_REDIRECT_URI)}&` +
    `state=${state}&` +
    `scope=profile%20openid&` +
    `bot_prompt=aggressive`;

  res.redirect(authUrl);
});

/**
 * LINE Login Callback（處理 OAuth callback）
 * GET /api/auth/line-login-callback?code=xxx&state=xxx
 */
app.get('/api/auth/line-login-callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).json({ error: '缺少授權碼' });
    }

    const LINE_LOGIN_CHANNEL_ID = (process.env.LINE_LOGIN_CHANNEL_ID || '').trim();
    const LINE_LOGIN_CHANNEL_SECRET = (process.env.LINE_LOGIN_CHANNEL_SECRET || '').trim();
    const LINE_LOGIN_REDIRECT_URI = getLineLoginRedirectUri(req);
    
    // 1. 用 code 換取 access token
    const tokenResponse = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: LINE_LOGIN_REDIRECT_URI,
        client_id: LINE_LOGIN_CHANNEL_ID,
        client_secret: LINE_LOGIN_CHANNEL_SECRET
      })
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('❌ LINE Login Token 取得失敗:', errorText);
      return res.status(400).json({ error: 'LINE 登入失敗，請重試' });
    }
    
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    const idToken = tokenData.id_token;
    
    // 2. 用 access token 取得使用者資訊
    const profileResponse = await fetch('https://api.line.me/v2/profile', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    if (!profileResponse.ok) {
      const errorText = await profileResponse.text();
      console.error('❌ LINE Profile 取得失敗:', errorText);
      return res.status(400).json({ error: '取得使用者資訊失敗' });
    }
    
    const profile = await profileResponse.json();
    
    // 3. 驗證 ID Token（可選，但建議實作）
    // 這裡簡化處理，實際應驗證 JWT signature
    
    // 4. 檢查使用者是否已加入官方帳（透過 LINE Messaging API）
    const isJoined = await checkUserJoinedOfficialAccount(profile.userId);
    
    // 5. 建立或更新 session（簡化版：使用 localStorage，實際應使用 session/cookie）
    // 將資料編碼後重導向到前端，前端從 URL 參數取得
    const loginData = {
      userId: profile.userId,
      displayName: profile.displayName,
      pictureUrl: profile.pictureUrl || null,
      isOfficialAccountJoined: isJoined
    };
    
    // 將資料編碼為 base64，透過 URL 參數傳遞給前端
    const encodedData = Buffer.from(JSON.stringify(loginData)).toString('base64');
    
    // 重導向到前端頁面，帶上登入資料
    res.redirect(`/?login=${encodeURIComponent(encodedData)}`);
  } catch (err) {
    console.error('❌ LINE Login Callback 處理錯誤:', err);
    res.status(500).json({ error: '登入處理時發生錯誤，請稍後再試' });
  }
});

/**
 * 檢查使用者是否已加入官方帳
 * GET /api/auth/check-official-account?userId=xxx
 */
app.get('/api/auth/check-official-account', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: '缺少必要參數：userId' });
    }
    
    const isJoined = await checkUserJoinedOfficialAccount(userId);
    
    res.json({
      isJoined,
      userId
    });
  } catch (err) {
    console.error('❌ 檢查官方帳狀態失敗:', err);
    res.status(500).json({ error: '檢查官方帳狀態時發生錯誤，請稍後再試' });
  }
});

/**
 * 取得使用者資訊（透過 session）
 * GET /api/auth/profile?userId=xxx
 */
app.get('/api/auth/profile', async (req, res) => {
  try {
    // 簡化版：從 query string 取得 userId
    // 實際應從 session 或 JWT token 取得
    const userId = req.query.userId;
    
    if (!userId) {
      return res.status(401).json({ error: '未登入' });
    }
    
    // 這裡可以從資料庫取得使用者資訊，或呼叫 LINE API
    // 簡化版：返回基本資訊
    res.json({
      userId,
      displayName: '使用者' // 實際應從資料庫或 LINE API 取得
    });
  } catch (err) {
    console.error('❌ 取得使用者資訊失敗:', err);
    res.status(500).json({ error: '取得使用者資訊時發生錯誤，請稍後再試' });
  }
});

/**
 * 檢查使用者是否已加入官方帳（透過 LINE Messaging API）
 * @param {string} userId - LINE User ID
 * @returns {Promise<boolean>}
 */
async function checkUserJoinedOfficialAccount(userId) {
  try {
    const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    
    if (!LINE_CHANNEL_ACCESS_TOKEN) {
      console.warn('⚠️ LINE_CHANNEL_ACCESS_TOKEN 未設定，無法檢查官方帳狀態');
      return false;
    }
    
    // 使用 LINE Messaging API 的 Get profile 端點
    // 如果使用者未加入，會返回 400 錯誤
    const response = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: {
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      }
    });
    
    if (response.ok) {
      return true; // 使用者已加入
    } else if (response.status === 400) {
      return false; // 使用者未加入
    } else {
      console.error('❌ 檢查官方帳狀態時發生錯誤:', await response.text());
      return false;
    }
  } catch (err) {
    console.error('❌ 檢查官方帳狀態失敗:', err);
    return false;
  }
}

// 啟動伺服器
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`🚀 伺服器運行在 port ${PORT}`);
  console.log(`📡 Webhook 端點: http://localhost:${PORT}/webhook/line`);
  console.log(`🌐 Web 前端: http://localhost:${PORT}`);
});
server.on('error', (err) => {
  console.error('❌ 伺服器啟動失敗:', err.message);
  if (err.code === 'EADDRINUSE') console.error(`   port ${PORT} 已被佔用，可改 PORT 或關閉佔用程式`);
  process.exit(1);
});

/**
 * 通知 owner 有新訂單（API 版本）
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @param {number} orderId
 * @param {string} branch
 * @param {Array<{name: string, qty: number}>} items
 * @param {string} ordererName - 下單者名稱
 */
async function notifyOwnerNewOrderAPI(db, worldId, orderId, branch, items, ordererName) {
  if (!worldId) return;
  
  try {
    const world = await getWorldById(db, worldId);
    if (!world || !world.ownerUserId) {
      console.warn(`⚠️ 找不到世界 ${worldId} 的 owner，無法發送通知`);
      return;
    }
    
    const ownerUserId = world.ownerUserId;
    
    // 依廠商分組品項：使用「該世界的 menu/vendorMap」判斷廠商；品項名含屬性時用「前綴匹配」
    const worldVendorMap = await getVendorMap(db, worldId);
    const vendorItemsMap = {};
    for (const item of items) {
      let vendor = null;
      if (worldVendorMap && typeof worldVendorMap === 'object') {
        vendor = resolveVendorForItemName(item.name, worldVendorMap);
      }
      if (!vendor) vendor = getVendorByItem(item.name) || '其他';
      if (!vendorItemsMap[vendor]) vendorItemsMap[vendor] = [];
      vendorItemsMap[vendor].push(item);
    }

    // 格式化通知訊息（單一則訊息）
    let notificationMsg = '';
    notificationMsg += `訂單 ID: ${orderId}\n`;
    notificationMsg += `下單者: ${ordererName || '未知'}\n\n`;
    
    const vendors = Object.keys(vendorItemsMap).sort();
    vendors.forEach((vendor) => {
      notificationMsg += `${vendor}：\n`;
      vendorItemsMap[vendor].forEach((item) => {
        notificationMsg += `• ${item.name} ${item.qty}\n`;
      });
      notificationMsg += `\n`;
    });
    
    notificationMsg = notificationMsg.trimEnd();
    
    // 發送通知
    const success = await pushLineMessage(ownerUserId, notificationMsg);
    
    if (success) {
      console.log(`✅ 已通知 owner (${ownerUserId}) 有新訂單 (${orderId})`);
    } else {
      console.warn(`⚠️ 通知 owner (${ownerUserId}) 失敗，可能未加 Bot 為好友`);
    }
  } catch (err) {
    console.error('❌ 通知 owner 時發生錯誤:', err);
  }
}

// 優雅關閉
process.on('SIGTERM', () => {
  closeDatabase(db);
  process.exit(0);
});

process.on('SIGINT', () => {
  closeDatabase(db);
  process.exit(0);
});
