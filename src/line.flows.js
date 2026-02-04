/**
 * LINE 各階段流程：文案、呼叫 service、回覆
 * handler 只做「判斷階段 → 呼叫對應 flow」，不寫文案、不直接叫 service
 */

import {
  createOrder,
  modifyOrderItemByName,
  queryOrdersByDateAndBranch,
  queryAllOrdersByDate,
  formatOrdersByVendor,
  clearAllOrders,
} from './order.service.js';
import {
  getWorldById,
  createWorld,
  bindUserToWorld,
  updateWorldStatus,
  updateWorldName,
  getBindings,
  deleteWorld,
  deleteWorldPermanently,
  unbindUserFromWorld,
  updateOrderFormat,
  updateDisplayFormat,
  updateMenuImageUrl,
  getWorldMembers,
  getBindingByUserAndWorld,
  setCurrentWorld,
  getCurrentWorld,
  getAllWorldsForUser,
  getWorldByCode,
} from './world.service.js';
import { validateVendorMapFormat, saveVendorMap, getVendorMap, formatVendorMap, addItemToMenu, removeItemFromMenu, updateMenuItem, getVendorByItem, resolveVendorForItemName } from './vendorMap.service.js';
import { validateOrderFormat, validateDisplayFormat, validateItemByOrderFormat, formatOrdersByDisplayFormat, formatOrdersByVendorDefault } from './format.service.js';

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

async function getLineDisplayName(userId) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) return null;
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.displayName || null;
  } catch {
    return null;
  }
}

/** @typedef {{ reply: (token: string, msg: string) => Promise<void> }} Reply */

const formatWorldId = (id) => String(id).padStart(6, '0');

export async function flowFollow(db, userId, replyToken, state, { reply }) {
  if (!state.hasBinding) {
    await reply(replyToken, `歡迎使用訂單系統 👋

請選擇你要做的事：
1️⃣ 加入既有世界
2️⃣ 建立新世界（當老闆）

請直接回覆 1 或 2

輸入「重來」可重新選擇`);
  }
}

export async function flowPreWorld(db, userId, text, replyToken, state, intent, { reply }) {
  if (intent.type === 'RESTART') {
    await reply(replyToken, `好，我們重新來一次 🙂

請選擇：
1️⃣ 加入世界
2️⃣ 建立新世界`);
    return;
  }
  if (intent.type === 'JOIN_WORLD') {
    await reply(replyToken, `請輸入世界 ID
（例如：1 或 #000001）

輸入「重來」可重新選擇`);
    return;
  }
  if (intent.type === 'INPUT_WORLD_ID') {
    if (!intent.worldId) {
      await reply(replyToken, `請輸入世界 ID
（例如：1 或 #000001）

輸入「重來」可重新選擇`);
      return;
    }
    try {
      const world = await getWorldById(db, intent.worldId);
      if (!world) {
        await reply(replyToken, `❌ 找不到這個世界
請確認世界 ID 是否正確

請選擇：
1️⃣ 重新輸入世界 ID
2️⃣ 建立新世界

輸入「重來」可重新選擇`);
        return;
      }
      const bindings = await getBindings(db, userId);
      if (bindings.some((b) => b.worldId === intent.worldId)) {
        await reply(replyToken, '您已經加入此世界');
        return;
      }
      await bindUserToWorld(db, userId, intent.worldId, 'employee');
      await setCurrentWorld(db, userId, intent.worldId);
      const worldCode = world.worldCode ? ` (代碼: ${world.worldCode})` : '';
      await reply(replyToken, world.name ? `✅ 成功加入世界「${world.name}」${worldCode}\n\n現在可以開始使用訂單功能了！\n\n輸入「幫助」查看可用指令` : `✅ 成功加入世界 #${formatWorldId(intent.worldId)}${worldCode}\n\n現在可以開始使用訂單功能了！\n\n輸入「幫助」查看可用指令`);
    } catch (err) {
      console.error('❌ 加入世界失敗:', err);
      await reply(replyToken, '❌ 加入世界時發生錯誤，請稍後再試');
    }
    return;
  }
  if (intent.type === 'CREATE_WORLD') {
    try {
      const bindings = await getBindings(db, userId);
      if (bindings.some((b) => b.role === 'owner')) {
        await reply(replyToken, '您已經擁有世界，無法重複建立');
        return;
      }
      const world = await createWorld(db, userId, 'vendorMap_setup');
      await bindUserToWorld(db, userId, world.id, 'owner');
      await setCurrentWorld(db, userId, world.id);
      const worldCode = world.worldCode ? `\n世界代碼: ${world.worldCode}` : '';
      await reply(replyToken, `✅ 世界建立完成！${worldCode}

下一步：請設定訂單格式（vendorMap）

📋 基本格式範例：
全聯
  雞蛋 10
  牛奶 5
  吐司 3

📋 進階格式範例（含屬性）：
UNIQLO
  T恤 黑 M 10
  T恤 白 S 5
  T恤 藍 L 3

💡 格式說明：
• 第一行：廠商/類別名稱
• 後續行：品項名稱 數量（需縮排，用空格分隔）
• 品項名稱可包含屬性（如顏色、尺寸）
• 數量必須是數字，放在最後

請直接貼上你要的格式

輸入「重來」放棄建立並重新選擇`);
    } catch (err) {
      console.error('❌ 建立世界失敗:', err);
      await reply(replyToken, '❌ 建立世界時發生錯誤，請稍後再試');
    }
  }
}

/**
 * 世界設定中階段使用「重來」：owner 刪除未完成世界，employee 僅解除綁定；回主選單。
 */
export async function flowRestartInWorldSetup(db, userId, replyToken, state, { reply }) {
  try {
    const bindings = await getBindings(db, userId);
    if (state.isOwner) {
      const ob = bindings.find((b) => b.role === 'owner' && b.status !== 'active');
      if (ob) await deleteWorld(db, ob.worldId);
    } else {
      const toUnbind = bindings.filter((b) => b.status !== 'active');
      for (const b of toUnbind) await unbindUserFromWorld(db, userId, b.worldId);
    }
    await reply(replyToken, `好，我們重新來一次 🙂

請選擇：
1️⃣ 加入世界
2️⃣ 建立新世界`);
  } catch (err) {
    console.error('❌ 重來（世界設定中）失敗:', err);
    await reply(replyToken, '❌ 操作失敗，請稍後再試');
  }
}

export async function flowVendorMapSetup(db, userId, text, replyToken, state, { reply }) {
  try {
    const bindings = await getBindings(db, userId);
    const ob = bindings.find((b) => b.role === 'owner' && b.status === 'vendorMap_setup');
    if (!ob) {
      await reply(replyToken, '訂單規格設定失敗，世界將無法生成');
      return;
    }
    const parsed = validateVendorMapFormat(text);
    if (!parsed) {
      // 分析格式錯誤原因
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      let errorMsg = '❌ 訂單格式設定失敗\n\n';
      
      if (lines.length === 0) {
        errorMsg += '您沒有輸入任何內容\n\n';
      } else if (lines.length === 1) {
        errorMsg += '格式不完整：只有一行內容\n\n';
        errorMsg += '📋 正確格式：\n廠商名稱\n  品項名稱 數量\n  品項名稱 數量\n\n';
      } else {
        const hasVendor = lines.some(line => !line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('-'));
        if (!hasVendor) {
          errorMsg += '缺少廠商/類別名稱（第一行應為廠商名稱）\n\n';
        } else {
          let hasValidItem = false;
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('-')) hasValidItem = true;
            else if (line.match(/\s+\d+$/)) hasValidItem = true;
          }
          if (!hasValidItem) {
            errorMsg += '缺少品項資訊（廠商名稱下方應有品項列表）\n\n';
          } else {
            errorMsg += '品項格式錯誤\n\n';
          }
        }
      }
      errorMsg += '📋 正確格式範例：\n\n';
      errorMsg += '範例 1（基本）：\n飲料\n  珍珠奶茶 10\n  紅茶 5\n  綠茶 3\n\n';
      errorMsg += '範例 2（- 符號，數量 0）：\n飲料\n  - 珍珠奶茶\n  - 紅茶\n\n';
      errorMsg += '範例 3（多廠商）：\n飲料\n  珍珠奶茶 10\n  紅茶 5\n便當\n  雞腿飯 20\n  排骨飯 15\n\n';
      errorMsg += '💡 格式說明：\n';
      errorMsg += '• 第一行：廠商/類別名稱（不可縮排）\n';
      errorMsg += '• 後續行：品項名稱 數量（需縮排，空格分隔）\n';
      errorMsg += '• 或使用：- 品項名稱（數量為 0）\n';
      errorMsg += '• 數量為正整數（1-999999）\n\n';
      errorMsg += '請重新輸入正確格式（或輸入「重來」放棄建立）';
      
      await updateWorldStatus(db, ob.worldId, 'failed');
      await reply(replyToken, errorMsg);
      return;
    }
    await saveVendorMap(db, ob.worldId, parsed);
    await updateWorldStatus(db, ob.worldId, 'world_naming');
    await reply(replyToken, `請為自己創立的世界取名: 「世界名稱」`);
  } catch (err) {
    console.error('❌ 設定 vendorMap 失敗:', err);
    await reply(replyToken, '❌ 設定訂單格式時發生錯誤，請稍後再試');
  }
}

export async function flowWorldNaming(db, userId, text, replyToken, state, { reply }) {
  try {
    const bindings = await getBindings(db, userId);
    const ob = bindings.find((b) => b.role === 'owner' && b.status === 'world_naming');
    if (!ob) {
      await reply(replyToken, '無法設定世界名稱，請重新開始');
      return;
    }
    const name = text.trim();
    if (!name) {
      await reply(replyToken, '請輸入有效的世界名稱');
      return;
    }
    await updateWorldName(db, ob.worldId, name);
    await updateWorldStatus(db, ob.worldId, 'active');
    await reply(replyToken, `🎉 訂單格式設定完成！

你現在可以：
- 開始記訂單
- 邀請使用者加入（請他們輸入世界 ID: #${formatWorldId(ob.worldId)}）

輸入「幫助」查看可用指令`);
  } catch (err) {
    console.error('❌ 設定世界名稱失敗:', err);
    await reply(replyToken, '❌ 設定世界名稱時發生錯誤，請稍後再試');
  }
}

export async function flowHelp(db, userId, replyToken, state, { reply }) {
  const helpMsg = state.isOwner
    ? `📋 可用指令（老闆）：

🔹 訂單相關：
• 記訂單：品項 數量（每行一筆）
• 查訂單：查詢 日期
• 修改訂單：修改 品項名稱 ±數量
• 老闆查詢：老闆查詢 日期（查看所有訂單，按廠商分組）

🔹 世界管理：
• 我的店家：查看所有已加入的世界
• 當前店家：查看目前使用的世界
• 切換世界：切換到其他世界
• 刪除/退出世界：老闆為刪除世界（需二次確認），消費者為退出世界
• 清理訂單：清理（清除所有訂單）
• 查看成員：查看成員（查看世界成員名單）
• 剔除成員：剔除成員 [User ID]（移除世界成員）

🔹 格式設定：
• 設定訂購格式：設定訂購格式（設定訂單格式規範）
• 設定顯示格式：設定顯示格式（設定老闆查詢顯示格式）

🔹 菜單管理：
• 菜單格式：菜單格式（查看菜單格式說明）
• 設定菜單：設定菜單後換行貼上整份菜單（覆蓋目前菜單）
• 查看菜單：查看菜單
• 新增品項：新增品項\\n廠商\\n品項名稱 [數量]
• 刪除品項：刪除品項\\n廠商\\n品項名稱
• 修改品項：修改品項\\n廠商\\n舊品項\\n新品項 [數量]
• 設定菜單圖片：設定菜單圖片\\n[圖片 URL]`
    : `📋 可用指令（員工）：

🔹 訂單相關：
• 記訂單：品項 數量（每行一筆）
• 查訂單：查詢 日期
• 修改訂單：修改 品項名稱 ±數量

🔹 世界管理：
• 我的店家：查看所有已加入的世界
• 當前店家：查看目前使用的世界
• 切換世界：切換到其他世界
• 退出世界：離開某個世界（消費者）

🔹 其他：
• 查看菜單：查看菜單`;
  await reply(replyToken, helpMsg);
}

/**
 * 通知 owner 有新訂單
 * @param {import('sqlite3').Database} db
 * @param {number} worldId
 * @param {number} orderId
 * @param {string} branch
 * @param {Array<{name: string, qty: number}>} items
 * @param {string} ordererName - 下單者名稱（LINE 顯示名稱）
 */
async function notifyOwnerNewOrder(db, worldId, orderId, branch, items, ordererName) {
  if (!worldId) return; // 如果沒有 worldId，不通知
  
  try {
    // 取得世界的 owner
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
    const { pushLineMessage } = await import('./line.handler.js');
    const success = await pushLineMessage(ownerUserId, notificationMsg);
    
    if (success) {
      console.log(`✅ 已通知 owner (${ownerUserId}) 有新訂單 (${orderId})`);
    } else {
      console.warn(`⚠️ 通知 owner (${ownerUserId}) 失敗，可能未加 Bot 為好友`);
    }
  } catch (err) {
    console.error('❌ 通知 owner 時發生錯誤:', err);
    // 不拋出錯誤，避免影響訂單建立流程
  }
}

/**
 * 通知消費者（下單者）訂單已送出
 */
async function notifyConsumerNewOrder(db, worldId, orderId, items, consumerUserId, ordererName) {
  if (!worldId || !consumerUserId) return;
  try {
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
    let msg = `📦 您的訂單已送出\n訂單 ID: ${orderId}\n\n`;
    const vendors = Object.keys(vendorItemsMap).sort();
    vendors.forEach((vendor) => {
      msg += `${vendor}：\n`;
      vendorItemsMap[vendor].forEach((item) => {
        msg += `• ${item.name} x${item.qty}\n`;
      });
      msg += `\n`;
    });
    msg = msg.trimEnd();
    const { pushLineMessage } = await import('./line.handler.js');
    const success = await pushLineMessage(consumerUserId, msg);
    if (success) {
      console.log(`✅ 已通知消費者 (${consumerUserId}) 訂單已送出 (${orderId})`);
    } else {
      console.warn(`⚠️ 通知消費者 (${consumerUserId}) 失敗，可能未加 Bot 為好友`);
    }
  } catch (err) {
    console.error('❌ 通知消費者時發生錯誤:', err);
  }
}

/**
 * 查看世界成員名單
 */
export async function flowViewMembers(db, userId, replyToken, state, { reply }) {
  try {
    const bindings = await getBindings(db, userId);
    const ob = bindings.find((b) => b.role === 'owner' && b.status === 'active');
    if (!ob) {
      await reply(replyToken, '❌ 僅世界擁有者可以查看成員名單');
      return;
    }
    
    const members = await getWorldMembers(db, ob.worldId);
    
    if (members.length === 0) {
      await reply(replyToken, '📋 成員名單\n\n目前沒有任何成員');
      return;
    }
    
    let msg = '📋 成員名單\n\n';
    
    // 獲取 LINE 顯示名稱（需要 LINE API）
    const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
    const memberInfo = await Promise.all(
      members.map(async (member) => {
        let displayName = member.userId;
        if (LINE_CHANNEL_ACCESS_TOKEN) {
          try {
            const res = await fetch(`https://api.line.me/v2/bot/profile/${member.userId}`, {
              headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
            });
            if (res.ok) {
              const profile = await res.json();
              displayName = profile.displayName || member.userId;
            }
          } catch {
            // 無法取得顯示名稱，使用 userId
          }
        }
        return {
          ...member,
          displayName,
        };
      })
    );
    
    // 分組顯示：owner 和 employee
    const owners = memberInfo.filter(m => m.role === 'owner');
    const employees = memberInfo.filter(m => m.role === 'employee');
    
    if (owners.length > 0) {
      msg += '👑 擁有者：\n';
      owners.forEach((member, idx) => {
        const date = new Date(member.created_at).toLocaleDateString('zh-TW');
        msg += `${idx + 1}. ${member.displayName}\n   ID: ${member.userId}\n   加入時間：${date}\n`;
      });
      msg += '\n';
    }
    
    if (employees.length > 0) {
      msg += '👥 員工：\n';
      employees.forEach((member, idx) => {
        const date = new Date(member.created_at).toLocaleDateString('zh-TW');
        msg += `${idx + 1}. ${member.displayName}\n   ID: ${member.userId}\n   加入時間：${date}\n`;
      });
    }
    
    msg += `\n總共 ${members.length} 位成員`;
    
    await reply(replyToken, msg.trim());
  } catch (err) {
    console.error('❌ 查看成員失敗:', err);
    await reply(replyToken, '❌ 查看成員時發生錯誤，請稍後再試');
  }
}

/**
 * 剔除世界成員
 */
export async function flowRemoveMember(db, userId, memberCmd, replyToken, state, { reply }) {
  try {
    const bindings = await getBindings(db, userId);
    const ob = bindings.find((b) => b.role === 'owner' && b.status === 'active');
    if (!ob) {
      await reply(replyToken, '❌ 僅世界擁有者可以剔除成員');
      return;
    }
    
    if (memberCmd.type === 'REMOVE_MEMBER_PROMPT') {
      await reply(replyToken, `❌ 剔除成員格式錯誤\n\n缺少成員 ID\n\n📋 正確格式：\n剔除成員\n[成員的 LINE User ID]\n\n💡 說明：\n• 使用「查看成員」可查看所有成員\n• 成員 ID 是 LINE 的 User ID（通常是一串長字串）\n• 只能剔除員工，無法剔除擁有者\n\n請輸入成員 ID（或輸入「取消」放棄操作）`);
      return;
    }
    
    if (memberCmd.targetUserId.trim() === '取消') {
      await reply(replyToken, '已取消剔除成員操作');
      return;
    }
    
    const targetUserId = memberCmd.targetUserId.trim();
    
    // 檢查目標使用者是否存在於世界中
    const targetBinding = await getBindingByUserAndWorld(db, targetUserId, ob.worldId);
    if (!targetBinding) {
      await reply(replyToken, `❌ 找不到該成員\n\n請確認成員 ID 是否正確\n\n使用「查看成員」可查看所有成員的 ID`);
      return;
    }
    
    // 不能剔除 owner
    if (targetBinding.role === 'owner') {
      await reply(replyToken, '❌ 無法剔除世界擁有者\n\n只能剔除員工成員');
      return;
    }
    
    // 不能剔除自己（雖然理論上 owner 不會是 employee，但還是檢查一下）
    if (targetUserId === userId) {
      await reply(replyToken, '❌ 無法剔除自己\n\n您是世界的擁有者');
      return;
    }
    
    // 執行剔除
    await unbindUserFromWorld(db, targetUserId, ob.worldId);
    
    // 嘗試獲取被剔除者的顯示名稱
    const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
    let displayName = targetUserId;
    if (LINE_CHANNEL_ACCESS_TOKEN) {
      try {
        const res = await fetch(`https://api.line.me/v2/bot/profile/${targetUserId}`, {
          headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
        });
        if (res.ok) {
          const profile = await res.json();
          displayName = profile.displayName || targetUserId;
        }
      } catch {
        // 無法取得顯示名稱，使用 userId
      }
    }
    
    await reply(replyToken, `✅ 已剔除成員\n\n成員：${displayName}\n\n該成員已無法再使用此世界的訂單功能`);
  } catch (err) {
    console.error('❌ 剔除成員失敗:', err);
    await reply(replyToken, '❌ 剔除成員時發生錯誤，請稍後再試');
  }
}

/**
 * 查看菜單（依「當前世界」顯示，與切換世界一致）
 */
export async function flowViewMenu(db, userId, replyToken, state, { reply }) {
  try {
    const currentWorldId = state.currentWorldId;
    if (!currentWorldId) {
      await reply(replyToken, '❌ 請先選擇世界\n\n輸入「切換世界」選擇要查看的世界');
      return;
    }
    const bindings = await getBindings(db, userId);
    const currentBinding = bindings.find((b) => b.worldId === currentWorldId);
    if (!currentBinding) {
      await reply(replyToken, '❌ 找不到當前世界\n\n請輸入「切換世界」重新選擇');
      return;
    }
    if (currentBinding.status !== 'active') {
      await reply(replyToken, '❌ 當前世界尚未啟用\n\n請等待老闆完成設定，或切換到其他世界');
      return;
    }
    const world = await getWorldById(db, currentWorldId);
    const vendorMap = await getVendorMap(db, currentWorldId);
    
    const messages = [];
    
    // 如果有菜單圖片，先顯示圖片
    if (world?.menuImageUrl) {
      messages.push({
        type: 'image',
        originalContentUrl: world.menuImageUrl,
        previewImageUrl: world.menuImageUrl
      });
    }
    
    // 顯示文字菜單
    if (!vendorMap || Object.keys(vendorMap).length === 0) {
      if (world?.menuImageUrl) {
        messages.push({ type: 'text', text: '📋 菜單（文字版為空）' });
      } else {
        await reply(replyToken, '📋 菜單為空\n\n老闆尚未設定菜單');
        return;
      }
    } else {
      const formatted = formatVendorMap(vendorMap);
      messages.push({ type: 'text', text: formatted });
    }
    
    // 使用 replyLineMessages 發送多個訊息
    const { replyLineMessages } = await import('./line.handler.js');
    await replyLineMessages(replyToken, messages);
  } catch (err) {
    console.error('❌ 查看菜單失敗:', err);
    await reply(replyToken, '❌ 查看菜單時發生錯誤，請稍後再試');
  }
}

/**
 * 新增品項到菜單
 */
export async function flowAddMenuItem(db, userId, menuCmd, replyToken, state, { reply }) {
  try {
    const bindings = await getBindings(db, userId);
    const ob = bindings.find((b) => b.role === 'owner' && b.status === 'active');
    if (!ob) {
      await reply(replyToken, '❌ 僅世界擁有者可以管理菜單');
      return;
    }
    
    const success = await addItemToMenu(db, ob.worldId, menuCmd.branch, menuCmd.itemName, menuCmd.qty);
    if (success) {
      await reply(replyToken, `✅ 已新增品項到菜單\n\n廠商: ${menuCmd.branch}\n品項: ${menuCmd.itemName}\n數量: ${menuCmd.qty}`);
    } else {
      await reply(replyToken, '❌ 新增品項失敗');
    }
  } catch (err) {
    console.error('❌ 新增品項失敗:', err);
    await reply(replyToken, '❌ 新增品項時發生錯誤，請稍後再試');
  }
}

/**
 * 從菜單刪除品項
 */
export async function flowRemoveMenuItem(db, userId, menuCmd, replyToken, state, { reply }) {
  try {
    const bindings = await getBindings(db, userId);
    const ob = bindings.find((b) => b.role === 'owner' && b.status === 'active');
    if (!ob) {
      await reply(replyToken, '❌ 僅世界擁有者可以管理菜單');
      return;
    }
    
    const success = await removeItemFromMenu(db, ob.worldId, menuCmd.branch, menuCmd.itemName);
    if (success) {
      await reply(replyToken, `✅ 已從菜單刪除品項\n\n廠商: ${menuCmd.branch}\n品項: ${menuCmd.itemName}`);
    } else {
      await reply(replyToken, `❌ 找不到品項「${menuCmd.itemName}」\n\n請確認廠商和品項名稱是否正確`);
    }
  } catch (err) {
    console.error('❌ 刪除品項失敗:', err);
    await reply(replyToken, '❌ 刪除品項時發生錯誤，請稍後再試');
  }
}

/**
 * 修改菜單品項
 */
export async function flowUpdateMenuItem(db, userId, menuCmd, replyToken, state, { reply }) {
  try {
    const bindings = await getBindings(db, userId);
    const ob = bindings.find((b) => b.role === 'owner' && b.status === 'active');
    if (!ob) {
      await reply(replyToken, '❌ 僅世界擁有者可以管理菜單');
      return;
    }
    
    const success = await updateMenuItem(db, ob.worldId, menuCmd.branch, menuCmd.oldItemName, menuCmd.newItemName, menuCmd.qty);
    if (success) {
      let msg = `✅ 已修改菜單品項\n\n廠商: ${menuCmd.branch}\n`;
      if (menuCmd.newItemName !== menuCmd.oldItemName) {
        msg += `品項: ${menuCmd.oldItemName} → ${menuCmd.newItemName}\n`;
      }
      if (menuCmd.qty !== null) {
        msg += `數量: ${menuCmd.qty}\n`;
      }
      await reply(replyToken, msg.trim());
    } else {
      await reply(replyToken, `❌ 找不到品項「${menuCmd.oldItemName}」\n\n請確認廠商和品項名稱是否正確`);
    }
  } catch (err) {
    console.error('❌ 修改品項失敗:', err);
    await reply(replyToken, '❌ 修改品項時發生錯誤，請稍後再試');
  }
}

/**
 * 菜單格式說明（讓老闆知道如何填寫菜單）
 */
export async function flowMenuFormatHelp(db, userId, replyToken, state, { reply }) {
  const msg =
    '📋 菜單格式說明\n\n' +
    '🔹 建立新世界時：在「請設定訂單格式」那一步，直接貼上整份菜單即可。\n\n' +
    '🔹 已有世界要更新整份菜單：輸入「設定菜單」後換行，貼上整份菜單（會覆蓋目前菜單）。\n\n' +
    '📝 格式規則：\n' +
    '• 第一行：廠商/類別名稱（不可縮排）\n' +
    '• 後續行：品項名稱 數量（需縮排一至兩格，品項與數量用空格分隔）\n' +
    '• 或使用：- 品項名稱（數量為 0）\n' +
    '• 數量為正整數（1-999999）\n\n' +
    '📌 範例：\n' +
    '飲料\n' +
    '  珍珠奶茶 10\n' +
    '  紅茶 5\n' +
    '  綠茶 3\n' +
    '便當\n' +
    '  雞腿飯 20\n' +
    '  排骨飯 15\n\n' +
    '💡 多廠商時，每個廠商名稱佔一行（不縮排），底下為該廠商的品項列表。';
  await reply(replyToken, msg);
}

/**
 * 對已有世界一次貼上整份菜單（覆蓋目前菜單，僅老闆）
 */
export async function flowSetMenuFull(db, userId, content, replyToken, state, { reply }) {
  try {
    if (!state.currentWorldId) {
      await reply(replyToken, '❌ 請先選擇世界\n\n輸入「切換世界」選擇要設定菜單的世界');
      return;
    }
    const bindings = await getBindings(db, userId);
    const ob = bindings.find((b) => b.worldId === state.currentWorldId && b.role === 'owner' && b.status === 'active');
    if (!ob) {
      await reply(replyToken, '❌ 僅世界擁有者可以設定菜單，且世界須已啟用');
      return;
    }
    if (!content || !content.trim()) {
      await reply(
        replyToken,
        '📋 設定菜單方式：請在同一則訊息中，第一行輸入「設定菜單」，換行後貼上整份菜單。\n\n輸入「菜單格式」可查看菜單格式說明。'
      );
      return;
    }
    const parsed = validateVendorMapFormat(content);
    if (!parsed) {
      await reply(
        replyToken,
        '❌ 菜單格式錯誤\n\n請輸入「菜單格式」查看格式說明。\n格式要點：第一行為廠商名稱，後續行縮排並寫「品項名稱 數量」。'
      );
      return;
    }
    await saveVendorMap(db, ob.worldId, parsed);
    const totalItems = Object.values(parsed).reduce((sum, items) => sum + Object.keys(items).length, 0);
    await reply(replyToken, `✅ 菜單已更新\n\n共 ${Object.keys(parsed).length} 個廠商/類別，${totalItems} 個品項。\n輸入「查看菜單」可確認內容。`);
  } catch (err) {
    console.error('❌ 設定菜單失敗:', err);
    await reply(replyToken, '❌ 設定菜單時發生錯誤，請稍後再試');
  }
}

/**
 * 設定菜單圖片
 */
export async function flowSetMenuImage(db, userId, menuImageCmd, replyToken, state, { reply }) {
  try {
    const bindings = await getBindings(db, userId);
    const ob = bindings.find((b) => b.role === 'owner' && b.status === 'active');
    if (!ob) {
      await reply(replyToken, '❌ 僅世界擁有者可以設定菜單圖片');
      return;
    }
    
    if (menuImageCmd.type === 'CLEAR_MENU_IMAGE') {
      await updateMenuImageUrl(db, ob.worldId, null);
      await reply(replyToken, '✅ 已清除菜單圖片');
      return;
    }
    
    if (menuImageCmd.type === 'SET_MENU_IMAGE_PROMPT') {
      // 如果是指令（非 URL），提示輸入 URL
      await reply(replyToken, `📷 設定菜單圖片

請輸入圖片 URL：

格式：
設定菜單圖片
https://example.com/menu.jpg

說明：
• 圖片 URL 必須是公開可訪問的網址
• 支援常見圖片格式（jpg, png, gif 等）
• 輸入「清除菜單圖片」可移除圖片

請輸入圖片 URL（或輸入「取消」放棄設定）`);
      return;
    }
    
    if (menuImageCmd.type === 'SET_MENU_IMAGE') {
      // 如果 URL 格式無效
      if (menuImageCmd.invalid) {
        await reply(replyToken, '❌ 圖片 URL 格式錯誤，請確認 URL 是否正確\n\n請重新輸入圖片 URL（或輸入「取消」放棄設定）');
        return;
      }
      
      // 驗證並設定 URL
      try {
        new URL(menuImageCmd.url);
        await updateMenuImageUrl(db, ob.worldId, menuImageCmd.url);
        await reply(replyToken, `✅ 已設定菜單圖片\n\n圖片 URL: ${menuImageCmd.url}`);
      } catch (err) {
        await reply(replyToken, '❌ 圖片 URL 格式錯誤，請確認 URL 是否正確\n\n請重新輸入圖片 URL（或輸入「取消」放棄設定）');
      }
      return;
    }
  } catch (err) {
    console.error('❌ 設定菜單圖片失敗:', err);
    await reply(replyToken, '❌ 設定菜單圖片時發生錯誤，請稍後再試');
  }
}

/**
 * 設定使用者訂購格式
 */
export async function flowSetOrderFormat(db, userId, text, replyToken, state, { reply }) {
  try {
    const bindings = await getBindings(db, userId);
    const ob = bindings.find((b) => b.role === 'owner' && b.status === 'active');
    if (!ob) {
      await reply(replyToken, '❌ 僅世界擁有者可以設定訂購格式');
      return;
    }
    
    const world = await getWorldById(db, ob.worldId);
    
    // 檢查是否為指令（非 JSON）
    if (text === '設定訂購格式' || text === '設定下單格式' || text.startsWith('設定訂購格式') || text.startsWith('設定下單格式')) {
      await reply(replyToken, `📋 設定使用者訂購格式

請輸入 JSON 格式的訂購格式規範：

範例 1（要求包含特定欄位）：
{
  "requiredFields": ["大杯", "正常甜", "正常冰"]
}

範例 2（使用正則表達式）：
{
  "itemFormat": "^.+\\s+(大杯|中杯|小杯)\\s+(正常甜|半糖|微糖|無糖)\\s+(正常冰|少冰|去冰)$"
}

範例 3（兩者結合）：
{
  "requiredFields": ["大杯"],
  "itemFormat": "^.+\\s+(正常甜|半糖|微糖|無糖)\\s+(正常冰|少冰|去冰)$"
}

說明：
• requiredFields：品項名稱必須包含的欄位（陣列，可選）
• itemFormat：品項名稱必須符合的正則表達式（字串，可選）
• 兩者可同時使用，必須都符合才算通過
• 如果都不設定，則不進行格式驗證

請直接貼上 JSON 格式（或輸入「取消」放棄設定）`);
      return;
    }
    
    // 檢查是否為取消
    if (text.trim() === '取消') {
      await reply(replyToken, '已取消設定訂購格式');
      return;
    }
    
    // 解析並驗證格式
    const format = validateOrderFormat(text);
    if (!format) {
      await reply(replyToken, '❌ JSON 格式錯誤，請檢查格式是否正確\n\n請重新輸入 JSON 格式（或輸入「取消」放棄設定）');
      return;
    }
    
    await updateOrderFormat(db, ob.worldId, text);
    await reply(replyToken, '✅ 訂購格式設定完成！\n\n使用者下單時將根據此格式驗證\n\n輸入「幫助」查看其他指令');
  } catch (err) {
    console.error('❌ 設定訂購格式失敗:', err);
    await reply(replyToken, '❌ 設定訂購格式時發生錯誤，請稍後再試');
  }
}

/**
 * 設定老闆查詢顯示格式
 */
export async function flowSetDisplayFormat(db, userId, text, replyToken, state, { reply }) {
  try {
    const bindings = await getBindings(db, userId);
    const ob = bindings.find((b) => b.role === 'owner' && b.status === 'active');
    if (!ob) {
      await reply(replyToken, '❌ 僅世界擁有者可以設定顯示格式');
      return;
    }
    
    const world = await getWorldById(db, ob.worldId);
    
    // 檢查是否為指令（非 JSON）
    if (text === '設定顯示格式' || text === '設定查詢格式' || text.startsWith('設定顯示格式') || text.startsWith('設定查詢格式')) {
      await reply(replyToken, `📋 設定老闆查詢顯示格式

請輸入 JSON 格式的顯示格式模板：

範例 1（預設格式）：
{
  "template": "{vendor}\\n {branch}\\n    {item} {qty}{users}",
  "showUsers": true
}

範例 2（簡化格式）：
{
  "template": "{item} x{qty}{users}",
  "showUsers": true
}

範例 3（不顯示點單者）：
{
  "template": "{vendor} - {branch} - {item} {qty}",
  "showUsers": false
}

範例 4（表格格式）：
{
  "template": "{vendor} | {branch} | {item} | {qty}{users}",
  "showUsers": true
}

可用變數：
• {vendor}：廠商名稱
• {branch}：廠商/類別名稱
• {item}：品項名稱
• {qty}：數量
• {users}：點單者列表（格式：(使用者A、使用者B)）

說明：
• template：顯示模板（字串，\\n 代表換行）
• showUsers：是否顯示點單者（布林值，預設 true）

請直接貼上 JSON 格式（或輸入「取消」放棄設定）`);
      return;
    }
    
    // 檢查是否為取消
    if (text.trim() === '取消') {
      await reply(replyToken, '已取消設定顯示格式');
      return;
    }
    
    // 解析並驗證格式
    const format = validateDisplayFormat(text);
    if (!format) {
      await reply(replyToken, '❌ JSON 格式錯誤，請檢查格式是否正確\n\n請重新輸入 JSON 格式（或輸入「取消」放棄設定）');
      return;
    }
    
    await updateDisplayFormat(db, ob.worldId, text);
    await reply(replyToken, '✅ 顯示格式設定完成！\n\n老闆查詢時將使用此格式顯示\n\n輸入「幫助」查看其他指令');
  } catch (err) {
    console.error('❌ 設定顯示格式失敗:', err);
    await reply(replyToken, '❌ 設定顯示格式時發生錯誤，請稍後再試');
  }
}

export async function flowClear(db, userId, replyToken, state, { reply }) {
  if (!state.isWorldActive) {
    const msg = !state.hasBinding ? '您尚未加入任何世界' : '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定';
    await reply(replyToken, `❌ ${msg}`);
    return;
  }
  if (!state.isOwner) {
    await reply(replyToken, '❌ 僅世界擁有者（老闆）可以清理訂單');
    return;
  }
  try {
    const deletedCount = await clearAllOrders(db);
    console.log(`✅ 已清理 ${deletedCount} 筆訂單`);
    await reply(replyToken, `✅ 已清理所有訂單（共 ${deletedCount} 筆）`);
  } catch (err) {
    console.error('❌ 清理訂單失敗:', err);
    await reply(replyToken, '❌ 清理訂單時發生錯誤');
    throw err;
  }
}

export async function flowOrder(db, userId, parsed, replyToken, state, { reply }) {
  try {
    const bindings = await getBindings(db, userId);
    const worldId = state.currentWorldId || (bindings.find((b) => b.status === 'active')?.worldId ?? null);
    const worldIds = bindings.filter((b) => b.status === 'active').map((b) => b.worldId);
    
    // 取得世界的訂購格式規範（用於驗證）
    let orderFormat = null;
    if (worldId) {
      const world = await getWorldById(db, worldId);
      if (world?.orderFormat) {
        try {
          orderFormat = JSON.parse(world.orderFormat);
        } catch {
          // 解析失敗，忽略
        }
      }
    }

    if (parsed.type === 'CREATE') {
      // 訂購格式驗證改為可選（簡化流程，不強制驗證）
      // if (orderFormat) {
      //   const invalidItems = [];
      //   for (const item of parsed.items) {
      //     if (!validateItemByOrderFormat(item.name, orderFormat)) {
      //       invalidItems.push(item.name);
      //     }
      //   }
      //   if (invalidItems.length > 0) {
      //     let errorMsg = `❌ 訂購格式不符合規範\n\n以下品項格式錯誤：\n${invalidItems.map(i => `• ${i}`).join('\n')}\n\n`;
      //     
      //     // 顯示要求的格式
      //     if (orderFormat.requiredFields && orderFormat.requiredFields.length > 0) {
      //       errorMsg += `📋 品項名稱必須包含以下欄位：\n${orderFormat.requiredFields.map(f => `• ${f}`).join('\n')}\n\n`;
      //     }
      //     
      //     if (orderFormat.itemFormat) {
      //       errorMsg += `📋 品項名稱必須符合格式：\n${orderFormat.itemFormat}\n\n`;
      //     }
      //     
      //     // 提供範例
      //     errorMsg += '💡 正確格式範例：\n';
      //     if (orderFormat.requiredFields && orderFormat.requiredFields.length > 0) {
      //       const example = `大杯紙杯 ${orderFormat.requiredFields.join(' ')}`;
      //       errorMsg += `• ${example}\n`;
      //     } else if (orderFormat.itemFormat) {
      //       // 嘗試從正則表達式提取範例
      //       errorMsg += '• 請參考設定的格式規範\n';
      //     }
      //     
      //     errorMsg += '\n請確認品項名稱是否符合設定的訂購格式';
      //     
      //     await reply(replyToken, errorMsg);
      //     return;
      //   }
      // }
      
      const displayName = await getLineDisplayName(userId);
      const orderId = await createOrder(db, parsed.branch, parsed.items, displayName || 'LINE', worldId, userId);
      console.log(`✅ 已存入訂單 worldId=${worldId}，共 ${parsed.items.length} 項，訂單 ID: ${orderId}`);
      let replyMsg = `✅ 訂單已建立\n訂單 ID: ${orderId}\n`;
      parsed.items.forEach((item) => { replyMsg += `${item.name} x${item.qty}\n`; });
      await reply(replyToken, replyMsg.trim());
      await notifyOwnerNewOrder(db, worldId, orderId, parsed.branch, parsed.items, displayName || 'LINE');
      // 通知消費者（下單者）訂單資訊
      await notifyConsumerNewOrder(db, worldId, orderId, parsed.items, userId, displayName || 'LINE');
    } else if (parsed.type === 'MODIFY' || parsed.type === 'MODIFY_SET') {
      const result = await modifyOrderItemByName(
        db,
        parsed.item,
        parsed.type === 'MODIFY_SET' ? parsed.qty : parsed.change,
        parsed.type === 'MODIFY_SET',
        worldIds
      );
      if (result.modified === 0) {
        await reply(replyToken, `❌ ${result.message}`);
      } else {
        let replyMsg = `✅ 已修改 ${result.modified} 筆訂單\n品項: ${parsed.item}\n`;
        result.results.forEach((r) => {
          if (r.deleted) {
            replyMsg += `訂單 ${r.orderId}: 已刪除 (數量為 0)\n`;
          } else {
            const changeStr = parsed.type === 'MODIFY_SET'
              ? `設為 ${r.newQty}`
              : `${r.oldQty} → ${r.newQty} (${parsed.change > 0 ? '+' : ''}${parsed.change})`;
            replyMsg += `訂單 ${r.orderId}: ${changeStr}\n`;
          }
        });
        await reply(replyToken, replyMsg.trim());
      }
    } else if (parsed.type === 'QUERY') {
      const results = await queryOrdersByDateAndBranch(db, parsed.date, parsed.branch, worldId);
      if (results.length === 0) {
        await reply(replyToken, `📋 查無訂單\n日期: ${parsed.date}`);
      } else {
        let replyMsg = `📋 查詢結果 (共 ${results.length} 筆)\n日期: ${parsed.date}\n\n`;
        results.forEach((order, idx) => {
          replyMsg += `訂單 ${idx + 1} (ID: ${order.orderId})\n`;
          order.items.forEach((item) => { replyMsg += `  ${item.name} x${item.qty}\n`; });
          replyMsg += `建立時間: ${order.createdAt}\n\n`;
        });
        await reply(replyToken, replyMsg.trim());
      }
    } else if (parsed.type === 'BOSS_QUERY') {
      const results = await queryAllOrdersByDate(db, parsed.date, worldId);
      if (results.length === 0) {
        await reply(replyToken, `📋 查無訂單\n日期: ${parsed.date}`);
      } else {
        // 簡化流程：LINE 查詢統一使用預設格式（按廠商分組）
        const formatted = formatOrdersByVendorDefault(results, getVendorByItem);
        await reply(replyToken, `📋 老闆查詢結果\n日期: ${parsed.date}\n\n${formatted}`);
      }
    }
  } catch (err) {
    console.error('❌ 處理訊息失敗:', err);
    await reply(replyToken, '❌ 處理訊息時發生錯誤');
  }
}

// 分析輸入文本，判斷可能的錯誤原因
function analyzeInputError(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { type: 'EMPTY', message: '請輸入內容' };
  }

  const first = lines[0];
  
  // 檢查是否為下訂單格式（每行「品項名稱 數量」，無分店）
  if (first !== '修改' && first !== '改' && first !== '查詢' && first !== '老闆查詢' && first !== '老闆查') {
    if (lines.length === 1) {
      const m = first.match(/^(.+?)\s+(\d+)$/);
      if (!m) {
        return {
          type: 'ORDER_MISSING_ITEMS',
          message: '❌ 下訂單格式錯誤\n\n請輸入「品項名稱 數量」，每行一筆。\n\n📋 正確格式：\n品項名稱 數量\n品項名稱 數量\n\n💡 範例：\n珍珠奶茶 5\n紅茶 3'
        };
      }
    }
    const itemErrors = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === lines.length - 1 && /^(\d{4}[-/]\d{1,2}[-/]\d{1,2})(?:\s|$)/.test(line)) continue;
      const itemMatch = line.match(/^(.+?)\s+(\d+)$/);
      if (!itemMatch) {
        if (/\d/.test(line)) {
          itemErrors.push({ line: i + 1, text: line, reason: '數量格式錯誤（數量必須是正整數，且與品項名稱用空格分隔）' });
        } else {
          itemErrors.push({ line: i + 1, text: line, reason: '缺少數量（格式：品項名稱 數量）' });
        }
      } else {
        const qty = Number(itemMatch[2]);
        if (qty <= 0) itemErrors.push({ line: i + 1, text: line, reason: '數量必須大於 0' });
        else if (qty > 999999) itemErrors.push({ line: i + 1, text: line, reason: '數量超過上限（最多 999999）' });
        else if (!Number.isInteger(qty)) itemErrors.push({ line: i + 1, text: line, reason: '數量必須是整數' });
      }
    }
    if (itemErrors.length > 0) {
      const errorDetails = itemErrors.map(e => `第 ${e.line} 行「${e.text}」：${e.reason}`).join('\n');
      return {
        type: 'ORDER_ITEM_ERROR',
        message: `❌ 下訂單格式錯誤\n\n${errorDetails}\n\n📋 正確格式：\n品項名稱 數量\n品項名稱 數量\n\n💡 範例：\n珍珠奶茶 5\n紅茶 3\n\n⚠️ 注意：\n• 品項名稱和數量之間用空格分隔\n• 數量為 1-999999 正整數`
      };
    }
  }
  
  // 檢查是否為修改格式
  if (first === '修改' || first === '改') {
    if (lines.length < 2) {
      return {
        type: 'MODIFY_MISSING_ITEM',
        message: '❌ 修改訂單格式錯誤\n\n缺少品項名稱\n\n📋 正確格式：\n修改\n品項名稱\n+5（或 -3、=10）\n\n💡 範例：\n修改\n大杯紙杯\n+10（增加 10 個）\n修改\n大杯紙杯\n-5（減少 5 個）\n修改\n大杯紙杯\n=20（設為 20 個）'
      };
    }
    if (lines.length < 3) {
      return {
        type: 'MODIFY_MISSING_CHANGE',
        message: '❌ 修改訂單格式錯誤\n\n缺少數量變化\n\n📋 正確格式：\n修改\n品項名稱\n+5（或 -3、=10）\n\n💡 範例：\n修改\n大杯紙杯\n+10（增加 10 個）\n修改\n大杯紙杯\n-5（減少 5 個）\n修改\n大杯紙杯\n=20（設為 20 個）'
      };
    }
    const changeStr = lines[2];
    const numMatch = changeStr.match(/^[+\-=]?(\d+)$/);
    if (!numMatch) {
      return {
        type: 'MODIFY_INVALID_CHANGE',
        message: `❌ 修改訂單格式錯誤\n\n數量格式錯誤：「${changeStr}」\n\n📋 正確格式：\n修改\n品項名稱\n+5（或 -3、=10）\n\n💡 範例：\n修改\n大杯紙杯\n+10（增加 10 個）\n修改\n大杯紙杯\n-5（減少 5 個）\n修改\n大杯紙杯\n=20（設為 20 個）\n\n⚠️ 注意：\n• 使用 +數字 表示增加\n• 使用 -數字 表示減少\n• 使用 =數字 表示設定為指定數量\n• 數字必須是正整數（1-999999）`
      };
    }
    const num = Number(numMatch[1]);
    if (num === 0) {
      return {
        type: 'MODIFY_ZERO_NUMBER',
        message: `❌ 修改訂單格式錯誤\n\n數量不能為 0\n\n📋 正確格式：\n修改\n品項名稱\n+5（或 -3、=10）\n\n💡 範例：\n修改\n大杯紙杯\n+10（增加 10 個）\n修改\n大杯紙杯\n-5（減少 5 個）\n修改\n大杯紙杯\n=20（設為 20 個）\n\n⚠️ 注意：\n• 如果要將數量設為 0，請使用「=0」（會自動刪除該品項）\n• 使用 +數字 表示增加\n• 使用 -數字 表示減少\n• 使用 =數字 表示設定為指定數量\n• 數字必須是正整數（1-999999）`
      };
    }
    if (num < 0 || num > 999999 || !Number.isInteger(num)) {
      return {
        type: 'MODIFY_INVALID_NUMBER',
        message: `❌ 修改訂單格式錯誤\n\n數量必須是 1-999999 之間的正整數\n\n📋 正確格式：\n修改\n品項名稱\n+5（或 -3、=10）`
      };
    }
  }
  
  if (first === '查詢') {
    if (lines.length < 2) {
      return {
        type: 'QUERY_MISSING_DATE',
        message: '❌ 查詢格式錯誤\n\n缺少日期\n\n📋 正確格式：\n查詢\n今天（或 2024-01-15）\n\n💡 範例：\n查詢\n今天\n查詢\n2024-01-15'
      };
    }
  }
  
  // 檢查是否為老闆查詢格式
  if (first === '老闆查詢' || first === '老闆查') {
    if (lines.length < 2) {
      return {
        type: 'BOSS_QUERY_MISSING_DATE',
        message: '❌ 老闆查詢格式錯誤\n\n缺少日期\n\n📋 正確格式：\n老闆查詢\n今天（或 2024-01-15）\n\n💡 範例：\n老闆查詢\n今天\n老闆查詢\n2024-01-15'
      };
    }
  }
  
  return null;
}

/**
 * 查看所有世界
 */
export async function flowViewAllWorlds(db, userId, replyToken, state, { reply }) {
  try {
    const worlds = await getAllWorldsForUser(db, userId);
    if (worlds.length === 0) {
      await reply(replyToken, '❌ 您尚未加入任何世界\n\n請選擇：\n1️⃣ 加入既有世界\n2️⃣ 建立新世界');
      return;
    }
    
    const currentWorldId = await getCurrentWorld(db, userId);
    let msg = '📋 我的店家列表：\n\n';
    
    for (let i = 0; i < worlds.length; i++) {
      const w = worlds[i];
      const isCurrent = w.worldId === currentWorldId;
      const prefix = isCurrent ? '👉 ' : '   ';
      const roleIcon = w.role === 'owner' ? '👑' : '👤';
      const statusText = w.status === 'active' ? '✅ 啟用中' : w.status === 'vendorMap_setup' ? '⏳ 設定中' : '❌ 未啟用';
      const worldName = w.name || `世界 #${formatWorldId(w.worldId)}`;
      const worldCode = w.worldCode ? ` (${w.worldCode})` : '';
      
      msg += `${prefix}${i + 1}. ${roleIcon} ${worldName}${worldCode}\n`;
      msg += `    ${statusText}\n`;
      if (isCurrent) {
        msg += `    目前使用中\n`;
      }
      msg += '\n';
    }
    
    msg += '💡 提示：\n';
    msg += '• 輸入「切換世界」可切換到其他店家\n';
    msg += '• 輸入「當前店家」查看目前使用的店家\n';
    msg += '• 輸入「刪除世界」或「退出世界」可刪除/離開店家';
    
    await reply(replyToken, msg);
  } catch (err) {
    console.error('❌ 查看所有世界失敗:', err);
    await reply(replyToken, '❌ 查詢世界列表時發生錯誤，請稍後再試');
  }
}

/**
 * 查看當前世界
 */
export async function flowViewCurrentWorld(db, userId, replyToken, state, { reply }) {
  try {
    const currentWorldId = await getCurrentWorld(db, userId);
    if (!currentWorldId) {
      await reply(replyToken, '❌ 您尚未設定當前世界\n\n請先加入或建立一個世界');
      return;
    }
    
    const world = await getWorldById(db, currentWorldId);
    if (!world) {
      await reply(replyToken, '❌ 找不到當前世界\n\n請使用「切換世界」選擇一個世界');
      return;
    }
    
    const bindings = await getBindings(db, userId);
    const currentBinding = bindings.find((b) => b.worldId === currentWorldId);
    const role = currentBinding ? (currentBinding.role === 'owner' ? '👑 擁有者' : '👤 員工') : '未知';
    const statusText = world.status === 'active' ? '✅ 啟用中' : world.status === 'vendorMap_setup' ? '⏳ 設定中' : '❌ 未啟用';
    const worldName = world.name || `世界 #${formatWorldId(currentWorldId)}`;
    const worldCode = world.worldCode ? `\n世界代碼: ${world.worldCode}` : '';
    
    let msg = `📍 當前店家資訊：\n\n`;
    msg += `名稱: ${worldName}${worldCode}\n`;
    msg += `角色: ${role}\n`;
    msg += `狀態: ${statusText}\n`;
    
    if (world.status === 'active') {
      msg += `\n💡 現在可以：\n`;
      msg += `• 記訂單\n`;
      msg += `• 查訂單\n`;
      msg += `• 修改訂單\n`;
      if (currentBinding?.role === 'owner') {
        msg += `• 老闆查詢\n`;
        msg += `• 清理訂單\n`;
      }
    } else {
      msg += `\n⚠️ 此世界尚未完成設定\n`;
      if (currentBinding?.role === 'owner') {
        msg += `請先完成世界設定`;
      } else {
        msg += `請等待老闆完成設定`;
      }
    }
    
    msg += `\n\n輸入「幫助」查看所有可用指令`;
    
    await reply(replyToken, msg);
  } catch (err) {
    console.error('❌ 查看當前世界失敗:', err);
    await reply(replyToken, '❌ 查詢當前世界時發生錯誤，請稍後再試');
  }
}

/**
 * 切換世界提示
 */
export async function flowSwitchWorldPrompt(db, userId, replyToken, state, { reply }) {
  try {
    const worlds = await getAllWorldsForUser(db, userId);
    if (worlds.length === 0) {
      await reply(replyToken, '❌ 您尚未加入任何世界\n\n請選擇：\n1️⃣ 加入既有世界\n2️⃣ 建立新世界');
      return;
    }
    
    if (worlds.length === 1) {
      await reply(replyToken, '❌ 您只有一個世界，無需切換\n\n輸入「我的店家」查看世界列表');
      return;
    }
    
    const currentWorldId = await getCurrentWorld(db, userId);
    let msg = '🔄 切換世界\n\n';
    msg += '請輸入要切換的世界 ID 或代碼：\n\n';
    
    for (let i = 0; i < worlds.length; i++) {
      const w = worlds[i];
      const isCurrent = w.worldId === currentWorldId;
      const prefix = isCurrent ? '👉 ' : '   ';
      const worldName = w.name || `世界 #${formatWorldId(w.worldId)}`;
      const worldCode = w.worldCode ? ` (${w.worldCode})` : '';
      const currentText = isCurrent ? ' [目前使用中]' : '';
      
      msg += `${prefix}${i + 1}. ${worldName}${worldCode}${currentText}\n`;
    }
    
    msg += '\n💡 輸入方式：\n';
    msg += '• 世界 ID：例如 1 或 #000001\n';
    msg += '• 世界代碼：例如 ABC12345\n';
    msg += '• 或直接輸入世界 ID/代碼';
    
    await reply(replyToken, msg);
  } catch (err) {
    console.error('❌ 切換世界提示失敗:', err);
    await reply(replyToken, '❌ 查詢世界列表時發生錯誤，請稍後再試');
  }
}

/**
 * 切換世界
 */
export async function flowSwitchWorld(db, userId, worldCmd, replyToken, state, { reply }) {
  try {
    let world = null;
    
    if (worldCmd.worldId) {
      world = await getWorldById(db, worldCmd.worldId);
    } else if (worldCmd.worldCode) {
      world = await getWorldByCode(db, worldCmd.worldCode);
    }
    
    if (!world) {
      await reply(replyToken, '❌ 找不到這個世界\n\n請確認世界 ID 或代碼是否正確\n\n輸入「切換世界」查看可用世界列表');
      return;
    }
    
    const bindings = await getBindings(db, userId);
    const binding = bindings.find((b) => b.worldId === world.id);
    if (!binding) {
      await reply(replyToken, '❌ 您尚未加入此世界\n\n請先加入此世界後才能切換\n\n輸入「我的店家」查看已加入的世界');
      return;
    }
    
    await setCurrentWorld(db, userId, world.id);
    console.log(`✅ LINE 已切換世界 userId=${userId} currentWorldId=${world.id} (${world.name || world.id})`);
    const worldName = world.name || `世界 #${formatWorldId(world.id)}`;
    const worldCode = world.worldCode ? ` (代碼: ${world.worldCode})` : '';
    const statusText = world.status === 'active' ? '✅ 已切換' : '⚠️ 已切換（此世界尚未完成設定）';
    
    let msg = `${statusText}到「${worldName}」${worldCode}\n\n`;
    
    if (world.status === 'active') {
      msg += '現在可以開始使用訂單功能了！\n\n';
      msg += '輸入「幫助」查看可用指令';
    } else {
      msg += binding.role === 'owner' 
        ? '請先完成世界設定\n\n輸入「重來」可重新開始設定'
        : '請等待老闆完成世界設定';
    }
    
    await reply(replyToken, msg);
  } catch (err) {
    console.error('❌ 切換世界失敗:', err);
    await reply(replyToken, '❌ 切換世界時發生錯誤，請稍後再試');
  }
}

/**
 * 刪除/退出世界提示（老闆=刪除世界需二次確認，消費者=退出世界）
 */
export async function flowLeaveWorldPrompt(db, userId, replyToken, state, { reply }) {
  try {
    const worlds = await getAllWorldsForUser(db, userId);
    if (worlds.length === 0) {
      await reply(replyToken, '❌ 您尚未加入任何世界');
      return;
    }
    const isOwner = state.isOwner;
    let msg = isOwner ? '🗑️ 刪除世界\n\n' : '🚪 退出世界\n\n';
    if (isOwner) {
      msg += '您是此世界的擁有者（老闆）。刪除後該世界所有內容（訂單、菜單、成員等）將永久刪除，無法復原。\n\n';
      msg += '請輸入要刪除的世界 ID 或代碼：\n\n';
    } else {
      msg += '請輸入要退出的世界 ID 或代碼：\n\n';
    }
    for (let i = 0; i < worlds.length; i++) {
      const w = worlds[i];
      const worldName = w.name || `世界 #${formatWorldId(w.worldId)}`;
      const worldCode = w.worldCode ? ` (${w.worldCode})` : '';
      const roleText = w.role === 'owner' ? ' [擁有者/老闆]' : '';
      msg += `   ${i + 1}. ${worldName}${worldCode}${roleText}\n`;
    }
    msg += '\n💡 輸入方式：\n';
    msg += '• 世界 ID：例如 1 或 #000001\n';
    msg += '• 世界代碼：例如 ABC12345\n';
    if (isOwner) {
      msg += '• 輸入後會再請您「確認刪除世界」一次\n';
      msg += '• 或直接輸入「確認刪除世界 [ID/代碼]」執行刪除';
    } else {
      msg += '• 或直接輸入「退出世界 [ID/代碼]」';
    }
    await reply(replyToken, msg);
  } catch (err) {
    console.error('❌ 刪除/退出世界提示失敗:', err);
    await reply(replyToken, '❌ 查詢世界列表時發生錯誤，請稍後再試');
  }
}

/**
 * 刪除/退出世界：老闆選世界時只顯示二次確認提示；消費者直接退出
 */
export async function flowLeaveWorld(db, userId, worldCmd, replyToken, state, { reply }) {
  try {
    let world = null;
    if (worldCmd.worldId) {
      world = await getWorldById(db, worldCmd.worldId);
    } else if (worldCmd.worldCode) {
      world = await getWorldByCode(db, worldCmd.worldCode);
    }
    if (!world) {
      await reply(replyToken, '❌ 找不到這個世界\n\n請確認世界 ID 或代碼是否正確\n\n輸入「刪除世界」或「退出世界」查看列表');
      return;
    }
    const bindings = await getBindings(db, userId);
    const binding = bindings.find((b) => b.worldId === world.id);
    if (!binding) {
      await reply(replyToken, '❌ 您尚未加入此世界');
      return;
    }
    const worldName = world.name || `世界 #${formatWorldId(world.id)}`;
    const worldCodeStr = world.worldCode ? ` 或 ${world.worldCode}` : '';
    // 老闆：不直接刪除，要求輸入「確認刪除世界 [ID/代碼]」
    if (binding.role === 'owner') {
      const msg =
        `⚠️ 刪除後該世界所有內容將永久刪除，無法復原。\n\n` +
        `包含：訂單、訂單歷史、菜單、成員、設定等。\n\n` +
        `若確定要刪除「${worldName}」，請輸入：\n` +
        `確認刪除世界 ${world.id}${worldCodeStr ? `\n或\n確認刪除世界 ${world.worldCode}` : ''}`;
      await reply(replyToken, msg);
      return;
    }
    // 消費者：直接解除綁定
    const currentWorldId = await getCurrentWorld(db, userId);
    const isCurrent = currentWorldId === world.id;
    await unbindUserFromWorld(db, userId, world.id);
    if (isCurrent) {
      db.run('DELETE FROM user_current_world WHERE userId = ?', [userId], (err) => {
        if (err) console.error('❌ 清除當前世界失敗:', err);
      });
    }
    const remainingWorlds = bindings.filter((b) => b.worldId !== world.id);
    let msg = `✅ 已退出「${worldName}」\n\n`;
    if (remainingWorlds.length === 0) {
      msg += '您現在沒有任何世界了\n\n請選擇：\n1️⃣ 加入既有世界\n2️⃣ 建立新世界';
    } else {
      msg += `您還有 ${remainingWorlds.length} 個世界\n\n`;
      if (isCurrent) msg += '⚠️ 已清除當前世界設定，請使用「切換世界」選擇要使用的世界';
      else msg += '輸入「我的店家」查看剩餘的世界';
    }
    await reply(replyToken, msg);
  } catch (err) {
    console.error('❌ 退出世界失敗:', err);
    await reply(replyToken, '❌ 退出世界時發生錯誤，請稍後再試');
  }
}

/**
 * 老闆確認刪除世界（已輸入「確認刪除世界 [ID/代碼]」）
 */
export async function flowConfirmDeleteWorld(db, userId, worldCmd, replyToken, state, { reply }) {
  try {
    let world = null;
    if (worldCmd.worldId) {
      world = await getWorldById(db, worldCmd.worldId);
    } else if (worldCmd.worldCode) {
      world = await getWorldByCode(db, worldCmd.worldCode);
    }
    if (!world) {
      await reply(replyToken, '❌ 找不到這個世界\n\n請確認世界 ID 或代碼是否正確');
      return;
    }
    const bindings = await getBindings(db, userId);
    const binding = bindings.find((b) => b.worldId === world.id);
    if (!binding || binding.role !== 'owner') {
      await reply(replyToken, '❌ 僅世界擁有者（老闆）可以刪除世界');
      return;
    }
    const currentWorldId = await getCurrentWorld(db, userId);
    const worldName = world.name || `世界 #${formatWorldId(world.id)}`;
    await deleteWorldPermanently(db, world.id);
    if (currentWorldId === world.id) {
      db.run('DELETE FROM user_current_world WHERE userId = ?', [userId], (err) => {
        if (err) console.error('❌ 清除當前世界失敗:', err);
      });
    }
    console.log(`✅ LINE 已刪除世界 userId=${userId} worldId=${world.id} (${worldName})`);
    const remaining = await getBindings(db, userId);
    let msg = `✅ 已刪除世界「${worldName}」，該世界所有內容已永久移除。\n\n`;
    if (remaining.length === 0) {
      msg += '您現在沒有任何世界了\n\n請選擇：\n1️⃣ 加入既有世界\n2️⃣ 建立新世界';
    } else {
      msg += `您還有 ${remaining.length} 個世界。輸入「我的店家」查看。`;
    }
    await reply(replyToken, msg);
  } catch (err) {
    console.error('❌ 刪除世界失敗:', err);
    await reply(replyToken, '❌ 刪除世界時發生錯誤，請稍後再試');
  }
}

function getFallbackStage(state) {
  if (!state.hasBinding) return { name: '加入或建立世界', example: '1、2，或「重來」' };
  if (!state.isWorldActive) {
    const note = '此世界尚未完成設定\n・員工請等待老闆完成設定\n・老闆可繼續進行設定';
    const customSuffix = state.isOwner
      ? `格式範例：\n廠商A\n  品項1 10\n  品項2 10\n\n輸入「重來」放棄建立並重新選擇`
      : '輸入「重來」可重新選擇世界';
    return { name: '世界設定中', note, customSuffix };
  }
  return {
    name: '訂單／查詢／修改',
    example: '品項 數量（每行一筆）｜查詢 日期｜修改 品項 ±1｜老闆查詢 日期｜幫助｜清理（僅老闆）',
  };
}

export async function flowFallback(db, userId, text, replyToken, state, { reply }) {
  // 如果世界不是 active，但輸入格式可以被解析，應該先提示世界尚未啟用
  if (!state.isWorldActive && state.hasBinding) {
    const { parseMessage } = await import('./line.handler.js');
    const parsed = parseMessage(text);
    if (parsed) {
      // 格式正確，但世界尚未啟用
      const msg = state.isOwner
        ? '❌ 世界尚未完成設定，無法使用訂單功能\n\n請先完成世界設定：\n• 設定訂單格式（vendorMap）\n• 為世界取名\n\n輸入「重來」可重新開始設定'
        : '❌ 世界尚未完成設定，無法使用訂單功能\n\n請等待老闆完成世界設定\n\n輸入「重來」可重新選擇世界';
      await reply(replyToken, msg);
      return;
    }
  }
  
  // 先嘗試分析輸入錯誤
  if (state.isWorldActive) {
    const errorAnalysis = analyzeInputError(text);
    if (errorAnalysis) {
      await reply(replyToken, errorAnalysis.message);
      return;
    }
  }
  
  const stage = getFallbackStage(state);
  const { name, example, note, customSuffix } = stage;
  let msg = `❌ 訊息格式錯誤（當前階段：${name}）\n\n`;
  if (note) msg += `${note}\n\n`;
  if (customSuffix) {
    msg += customSuffix;
  } else {
    msg += `格式範例：${example}`;
    if (!state.hasBinding) msg += '\n\n輸入「重來」可重新選擇';
  }
  await reply(replyToken, msg);
}
