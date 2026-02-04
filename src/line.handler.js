/**
 * line.handler：只做 5 件事
 * 1. 接收 LINE 傳來的文字
 * 2. 取得 user 當前狀態（有沒有世界、世界狀態）
 * 3. 判斷「現在在哪個階段」
 * 4. 呼叫對應流程（不是 service）
 * 5. 接不到任何流程 → fallback
 *
 * ❌ 不直接寫 world.service.createWorld / joinWorld / setupVendorMap
 * ❌ 不直接解析 vendorMap
 * ❌ 不寫「請輸入 1 或 2」這種文案（在 line.flows）
 */

import crypto from 'crypto';
import dotenv from 'dotenv';
import { getBindings, getCurrentWorld, getAllWorldsForUser, getWorldByCode } from './world.service.js';
import * as flows from './line.flows.js';

dotenv.config();

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

export function verifyLineSignature(body, signature) {
  if (!LINE_CHANNEL_SECRET) {
    console.warn('⚠️ LINE_CHANNEL_SECRET 未設定，跳過簽章驗證');
    return true;
  }
  if (!signature) return false;
  const hash = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(body).digest('base64');
  return hash === signature;
}

export async function replyLineMessage(replyToken, message) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.warn('⚠️ LINE_CHANNEL_ACCESS_TOKEN 未設定，無法回覆訊息');
    return;
  }
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: message }] }),
    });
    if (!res.ok) console.error('❌ LINE 回覆失敗:', await res.text());
  } catch (err) {
    console.error('❌ 回覆 LINE 訊息時發生錯誤:', err);
  }
}

/**
 * 回覆 LINE 訊息（支援文字和圖片）
 * @param {string} replyToken
 * @param {string|Array} messages - 文字訊息或訊息陣列（可包含圖片）
 */
export async function replyLineMessages(replyToken, messages) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.warn('⚠️ LINE_CHANNEL_ACCESS_TOKEN 未設定，無法回覆訊息');
    return;
  }
  try {
    const messageArray = Array.isArray(messages) ? messages : [{ type: 'text', text: messages }];
    const res = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ replyToken, messages: messageArray }),
    });
    if (!res.ok) console.error('❌ LINE 回覆失敗:', await res.text());
  } catch (err) {
    console.error('❌ 回覆 LINE 訊息時發生錯誤:', err);
  }
}

/**
 * 推送 LINE 訊息給指定使用者（Push Message API）
 * @param {string} userId - 目標使用者的 LINE User ID
 * @param {string|Array} messages - 文字訊息或訊息陣列
 */
export async function pushLineMessage(userId, messages) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.warn('⚠️ LINE_CHANNEL_ACCESS_TOKEN 未設定，無法推送訊息');
    return false;
  }
  if (!userId) {
    console.warn('⚠️ userId 未提供，無法推送訊息');
    return false;
  }
  try {
    const messageArray = Array.isArray(messages) ? messages : [{ type: 'text', text: messages }];
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ to: userId, messages: messageArray }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error('❌ LINE 推送訊息失敗:', errorText);
      // 如果是因為使用者未加 Bot 為好友，記錄但不拋出錯誤
      if (res.status === 400) {
        console.warn(`⚠️ 無法推送訊息給 ${userId}，可能未加 Bot 為好友`);
      }
      return false;
    }
    return true;
  } catch (err) {
    console.error('❌ 推送 LINE 訊息時發生錯誤:', err);
    return false;
  }
}

// --- 僅供「判斷階段」用的分類，不包含文案、不呼叫 service ---

export function isClearCommand(text) {
  const list = ['清理訂單', '清除訂單', '清空訂單', '刪除訂單', '清理', '清除', '清空'];
  return list.includes(text.trim());
}

// 驗證數量是否為有效的正整數
function validateQty(qty) {
  if (typeof qty !== 'number' || isNaN(qty)) return false;
  if (qty <= 0) return false;
  if (qty > 999999) return false; // 防止超大數字
  if (!Number.isInteger(qty)) return false; // 必須是整數
  return true;
}

// 驗證品項名稱
function validateItemName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > 100) return false; // 限制長度
  return true;
}

export function parseMessage(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const first = lines[0];
  if (first === '修改' || first === '改') {
    if (lines.length < 3) return null;
    const itemName = lines[1].trim();
    if (!validateItemName(itemName)) return null;
    const changeStr = lines[2];
    let change = 0;
    if (changeStr.startsWith('+')) {
      const num = Number(changeStr.slice(1));
      if (!validateQty(num)) return null;
      change = num;
    } else if (changeStr.startsWith('-')) {
      const num = Number(changeStr.slice(1));
      if (!validateQty(num)) return null;
      change = -num;
    } else if (changeStr.startsWith('=')) {
      const qty = Number(changeStr.slice(1));
      if (!validateQty(qty)) return null;
      return { type: 'MODIFY_SET', item: itemName, qty };
    } else {
      const num = Number(changeStr);
      if (!validateQty(num)) return null;
      change = num;
    }
    return { type: 'MODIFY', item: itemName, change };
  }
  if (first === '老闆查詢' || first === '老闆查') {
    if (lines.length < 2) return null;
    return { type: 'BOSS_QUERY', date: lines[1] };
  }
  // 查詢：查詢 + 日期（無分店，兩行即可）
  if (first === '查詢') {
    if (lines.length < 2) return null;
    return { type: 'QUERY', date: lines[1], branch: '' };
  }
  // 建立訂單：每行「品項名稱 數量」，最後一行可為日期（無分店，branch 存空字串）
  if (lines.length < 1) return null;
  const items = [];
  let timeStr = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const timeMatch = line.match(/^(\d{4}[-/]\d{1,2}[-/]\d{1,2})(?:\s|$)/);
    const isLastLine = i === lines.length - 1;
    if (timeMatch && isLastLine && items.length > 0) {
      timeStr = timeMatch[1];
      break;
    }
    const m = line.match(/^(.+?)\s+(\d+)$/);
    if (m) {
      const itemName = m[1].trim();
      const qty = Number(m[2]);
      if (validateItemName(itemName) && validateQty(qty)) {
        items.push({ name: itemName, qty });
      }
    }
  }
  if (items.length === 0) return null;
  return { type: 'CREATE', branch: '', items, time: timeStr };
}

export function parseUserIntent(text) {
  const t = text.trim();
  if (t === '重來') return { type: 'RESTART' };
  if (['1', '1️⃣', '加入既有世界', '加入世界'].includes(t) || t.includes('加入')) return { type: 'JOIN_WORLD' };
  if (['2', '2️⃣', '建立新世界'].includes(t) || t.includes('建立')) return { type: 'CREATE_WORLD' };
  if (t === '1️⃣ 重新輸入世界 ID') return { type: 'INPUT_WORLD_ID' };
  const num = t.match(/^#?(\d+)$/);
  if (num) {
    const id = parseInt(num[1], 10);
    if (id > 0) return { type: 'INPUT_WORLD_ID', worldId: id };
  }
  return null;
}

// 解析世界管理指令
export function parseWorldCommand(text) {
  const t = text.trim();
  
  // 切換世界
  if (t === '切換世界' || t === '切換店家' || t.startsWith('切換世界') || t.startsWith('切換店家')) {
    return { type: 'SWITCH_WORLD_PROMPT' };
  }
  
  // 查看所有世界
  if (t === '我的店家' || t === '所有店家' || t === '查看店家' || t === '店家列表' || t.startsWith('我的店家') || t.startsWith('所有店家')) {
    return { type: 'VIEW_ALL_WORLDS' };
  }
  
  // 查看當前世界
  if (t === '當前店家' || t === '目前店家' || t === '當前世界' || t === '目前世界' || t.startsWith('當前店家') || t.startsWith('目前店家')) {
    return { type: 'VIEW_CURRENT_WORLD' };
  }
  
  // 刪除/退出世界（老闆=刪除世界，消費者=退出世界）
  if (t === '退出世界' || t === '離開世界' || t === '退出店家' || t === '離開店家' ||
      t === '刪除世界' || t.startsWith('退出世界') || t.startsWith('離開世界') || t.startsWith('刪除世界')) {
    return { type: 'LEAVE_WORLD_PROMPT' };
  }
  
  // 確認刪除世界 [ID 或代碼]（僅老闆，二次確認用）
  const confirmDeleteMatch = t.match(/^確認刪除世界[\s:：]+(.+)$/);
  if (confirmDeleteMatch) {
    const arg = confirmDeleteMatch[1].trim();
    const num = arg.match(/^#?\s*(\d+)\s*[.\s]*$/);
    if (num) {
      const id = parseInt(num[1], 10);
      if (id > 0) return { type: 'CONFIRM_DELETE_WORLD', worldId: id };
    }
    if (arg.length >= 6) return { type: 'CONFIRM_DELETE_WORLD', worldCode: arg.toUpperCase() };
  }
  
  // 切換世界的世界 ID 輸入
  const switchMatch = t.match(/^(?:切換世界|切換店家)[\s:：]*(.+)$/);
  if (switchMatch) {
    const worldIdStr = switchMatch[1].trim();
    const num = worldIdStr.match(/^#?(\d+)$/);
    if (num) {
      const id = parseInt(num[1], 10);
      if (id > 0) return { type: 'SWITCH_WORLD', worldId: id };
    }
    // 嘗試作為 worldCode 處理
    if (worldIdStr.length >= 6) {
      return { type: 'SWITCH_WORLD', worldCode: worldIdStr.toUpperCase() };
    }
  }
  
  // 刪除世界/退出世界的世界 ID 輸入
  const leaveMatch = t.match(/^(?:退出世界|離開世界|退出店家|離開店家|刪除世界)[\s:：]*(.+)$/);
  if (leaveMatch) {
    const worldIdStr = leaveMatch[1].trim();
    const num = worldIdStr.match(/^#?(\d+)$/);
    if (num) {
      const id = parseInt(num[1], 10);
      if (id > 0) return { type: 'LEAVE_WORLD', worldId: id };
    }
    // 嘗試作為 worldCode 處理
    if (worldIdStr.length >= 6) {
      return { type: 'LEAVE_WORLD', worldCode: worldIdStr.toUpperCase() };
    }
  }
  
  // 直接輸入世界 ID 或 worldCode（在已有綁定的情況下，視為切換世界）
  // 接受純數字、#數字、或數字後帶 . / 空格（例如 1. 或 1 ）
  const directNum = t.match(/^#?\s*(\d+)\s*[.\s]*$/);
  if (directNum) {
    const id = parseInt(directNum[1], 10);
    if (id > 0) return { type: 'SWITCH_WORLD', worldId: id };
  }
  // 8 位字母數字組合，視為 worldCode（接受大小寫，尾端允許空白）
  const codeMatch = t.trim().match(/^([A-Z0-9]{8})\s*$/i);
  if (codeMatch) {
    return { type: 'SWITCH_WORLD', worldCode: codeMatch[1].toUpperCase() };
  }
  
  return null;
}

// 解析設定格式相關指令
export function parseFormatCommand(text) {
  const t = text.trim();
  if (t === '設定訂購格式' || t === '設定下單格式' || t.startsWith('設定訂購格式') || t.startsWith('設定下單格式')) {
    return { type: 'SET_ORDER_FORMAT' };
  }
  if (t === '設定顯示格式' || t === '設定查詢格式' || t.startsWith('設定顯示格式') || t.startsWith('設定查詢格式')) {
    return { type: 'SET_DISPLAY_FORMAT' };
  }
  return null;
}

// 解析設定菜單圖片指令
export function parseMenuImageCommand(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  
  const first = lines[0].trim();
  
  // 清除菜單圖片
  if (first === '清除菜單圖片' || first === '刪除菜單圖片' || first === '移除菜單圖片') {
    return { type: 'CLEAR_MENU_IMAGE' };
  }
  
  // 設定菜單圖片
  if (first === '設定菜單圖片' || first === '設定圖片' || first.startsWith('設定菜單圖片') || first.startsWith('設定圖片')) {
    // 如果只有指令沒有 URL，返回提示指令
    if (lines.length < 2) {
      return { type: 'SET_MENU_IMAGE_PROMPT' };
    }
    const url = lines[1].trim();
    // 簡單的 URL 驗證
    if (!url || url.length === 0) {
      return { type: 'SET_MENU_IMAGE_PROMPT' };
    }
    // 檢查是否為有效 URL 格式
    try {
      new URL(url);
      return { type: 'SET_MENU_IMAGE', url };
    } catch {
      // URL 格式錯誤，但還是返回提示讓 flow 處理錯誤訊息
      return { type: 'SET_MENU_IMAGE', url, invalid: true };
    }
  }
  
  return null;
}

// 解析菜單管理指令
export function parseMenuCommand(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  
  const first = lines[0].trim();
  // 菜單格式說明（僅第一行為指令時）
  if (first === '菜單格式' || first === '菜單格式說明') {
    return { type: 'MENU_FORMAT_HELP' };
  }

  // 設定菜單（整份貼上）：第一行為「設定菜單」或「更新菜單」，後方可帶整份菜單
  if (first === '設定菜單' || first === '更新菜單') {
    const content = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    return { type: 'SET_MENU_FULL', content };
  }
  
  // 查看菜單
  if (first === '查看菜單' || first === '菜單' || first === '查看' || first === '看菜單') {
    return { type: 'VIEW_MENU' };
  }
  
  // 新增品項
  if (first === '新增品項' || first === '加入品項' || first.startsWith('新增品項') || first.startsWith('加入品項')) {
    if (lines.length < 3) return null;
    const branch = lines[1].trim();
    const itemLine = lines[2];
    const m = itemLine.match(/^(.+?)(?:\s+(\d+))?$/);
    if (!m) return null;
    const itemName = m[1].trim();
    const qty = m[2] ? parseInt(m[2]) : 0;
    if (!validateItemName(itemName)) return null;
    if (isNaN(qty) || qty < 0 || qty > 999999 || !Number.isInteger(qty)) return null;
    return { type: 'ADD_MENU_ITEM', branch, itemName, qty };
  }
  
  // 刪除品項
  if (first === '刪除品項' || first === '移除品項' || first.startsWith('刪除品項') || first.startsWith('移除品項')) {
    if (lines.length < 3) return null;
    const branch = lines[1].trim();
    const itemName = lines[2].trim();
    if (!validateItemName(itemName)) return null;
    return { type: 'REMOVE_MENU_ITEM', branch, itemName };
  }
  
  // 修改品項
  if (first === '修改品項' || first === '更新品項' || first.startsWith('修改品項') || first.startsWith('更新品項')) {
    if (lines.length < 4) return null;
    const branch = lines[1].trim();
    const oldItemName = lines[2].trim();
    const changeLine = lines[3].trim();
    
    // 格式：修改品項\n分店\n舊品項名稱\n新品項名稱 數量（可選）
    const m = changeLine.match(/^(.+?)(?:\s+(\d+))?$/);
    if (!m) return null;
    const newItemName = m[1].trim();
    const qty = m[2] ? parseInt(m[2]) : null;
    if (!validateItemName(oldItemName) || !validateItemName(newItemName)) return null;
    if (qty !== null && (isNaN(qty) || qty < 0 || qty > 999999 || !Number.isInteger(qty))) return null;
    return { type: 'UPDATE_MENU_ITEM', branch, oldItemName, newItemName, qty };
  }
  
  return null;
}

// 解析成員管理指令
export function parseMemberCommand(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  
  const first = lines[0].trim();
  
  // 查看成員
  if (first === '查看成員' || first === '成員名單' || first === '成員列表' || first === '查看成員名單') {
    return { type: 'VIEW_MEMBERS' };
  }
  
  // 剔除成員
  if (first === '剔除成員' || first === '移除成員' || first === '刪除成員' || first.startsWith('剔除成員') || first.startsWith('移除成員') || first.startsWith('刪除成員')) {
    if (lines.length < 2) {
      return { type: 'REMOVE_MEMBER_PROMPT' };
    }
    const targetUserId = lines[1].trim();
    if (!targetUserId) {
      return { type: 'REMOVE_MEMBER_PROMPT' };
    }
    return { type: 'REMOVE_MEMBER', targetUserId };
  }
  
  return null;
}

/**
 * 2. 取得 user 當前狀態（使用當前世界）
 */
async function getState(db, userId) {
  const bindings = await getBindings(db, userId);
  const currentWorldId = await getCurrentWorld(db, userId);
  
  // 如果沒有當前世界，但有 active 的世界，自動設定第一個 active 世界為當前世界
  if (!currentWorldId && bindings.length > 0) {
    const activeBinding = bindings.find((b) => b.status === 'active');
    if (activeBinding) {
      const { setCurrentWorld } = await import('./world.service.js');
      await setCurrentWorld(db, userId, activeBinding.worldId);
      return getState(db, userId); // 遞迴重新取得狀態
    }
  }
  
  // 取得當前世界的狀態
  let currentWorldStatus = null;
  let isCurrentWorldActive = false;
  let isCurrentWorldOwner = false;
  if (currentWorldId) {
    const currentBinding = bindings.find((b) => b.worldId === currentWorldId);
    if (currentBinding) {
      currentWorldStatus = currentBinding.status;
      isCurrentWorldActive = currentBinding.status === 'active';
      isCurrentWorldOwner = currentBinding.role === 'owner';
    }
  }
  
  return {
    hasBinding: bindings.length > 0,
    currentWorldId,
    currentWorldStatus,
    inVendorMapSetup: currentWorldStatus === 'vendorMap_setup' && isCurrentWorldOwner,
    inWorldNaming: currentWorldStatus === 'world_naming' && isCurrentWorldOwner,
    isWorldActive: isCurrentWorldActive,
    isOwner: isCurrentWorldOwner,
    allBindings: bindings, // 保留所有綁定資訊供 flows 使用
  };
}

const reply = (token, msg) => replyLineMessage(token, msg);

/**
 * 處理 LINE 單一事件：5 步
 * 1. 接收文字（或 follow 時略過）
 * 2. getState
 * 3. 判斷階段
 * 4. 呼叫對應 flow
 * 5. 否則 fallback
 */
export async function handleLineEvent(db, event) {
  if (event?.type === 'follow') {
    const userId = event.source.userId;
    const replyToken = event.replyToken;
    console.log(`👤 使用者加入: ${userId}`);
    const state = await getState(db, userId);
    await flows.flowFollow(db, userId, replyToken, state, { reply });
    return;
  }

  if (!event || event.type !== 'message' || event.message?.type !== 'text') return;

  const text = event.message.text;
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  console.log(`📝 收到訊息: ${text}`);

  const state = await getState(db, userId);

  // 3. 判斷階段 → 4. 呼叫對應流程
  if (!state.hasBinding) {
    const intent = parseUserIntent(text);
    if (intent) {
      await flows.flowPreWorld(db, userId, text, replyToken, state, intent, { reply });
      return;
    }
    await flows.flowFallback(db, userId, text, replyToken, state, { reply });
    return;
  }

  if ((state.inVendorMapSetup || !state.isWorldActive) && text.trim() === '重來') {
    await flows.flowRestartInWorldSetup(db, userId, replyToken, state, { reply });
    return;
  }
  if (state.inVendorMapSetup) {
    await flows.flowVendorMapSetup(db, userId, text, replyToken, state, { reply });
    return;
  }
  if (state.inWorldNaming) {
    await flows.flowWorldNaming(db, userId, text, replyToken, state, { reply });
    return;
  }

  if (text.trim() === '幫助') {
    await flows.flowHelp(db, userId, replyToken, state, { reply });
    return;
  }

  // 檢查是否為世界管理指令（所有使用者）
  if (state.hasBinding) {
    const worldCmd = parseWorldCommand(text);
    if (worldCmd) {
      if (worldCmd.type === 'VIEW_ALL_WORLDS') {
        await flows.flowViewAllWorlds(db, userId, replyToken, state, { reply });
        return;
      }
      if (worldCmd.type === 'VIEW_CURRENT_WORLD') {
        await flows.flowViewCurrentWorld(db, userId, replyToken, state, { reply });
        return;
      }
      if (worldCmd.type === 'SWITCH_WORLD_PROMPT') {
        await flows.flowSwitchWorldPrompt(db, userId, replyToken, state, { reply });
        return;
      }
      if (worldCmd.type === 'SWITCH_WORLD') {
        await flows.flowSwitchWorld(db, userId, worldCmd, replyToken, state, { reply });
        return;
      }
      if (worldCmd.type === 'LEAVE_WORLD_PROMPT') {
        await flows.flowLeaveWorldPrompt(db, userId, replyToken, state, { reply });
        return;
      }
      if (worldCmd.type === 'LEAVE_WORLD') {
        await flows.flowLeaveWorld(db, userId, worldCmd, replyToken, state, { reply });
        return;
      }
      if (worldCmd.type === 'CONFIRM_DELETE_WORLD') {
        await flows.flowConfirmDeleteWorld(db, userId, worldCmd, replyToken, state, { reply });
        return;
      }
    }
  }

  // 菜單格式說明（所有使用者，方便老闆與消費者查看）
  const menuCmdForHelp = parseMenuCommand(text);
  if (menuCmdForHelp && menuCmdForHelp.type === 'MENU_FORMAT_HELP') {
    await flows.flowMenuFormatHelp(db, userId, replyToken, state, { reply });
    return;
  }

  // 檢查是否為查看菜單指令（所有使用者）
  if (state.isWorldActive) {
    const menuCmd = parseMenuCommand(text);
    if (menuCmd && menuCmd.type === 'VIEW_MENU') {
      await flows.flowViewMenu(db, userId, replyToken, state, { reply });
      return;
    }
    if (menuCmd && menuCmd.type === 'SET_MENU_FULL') {
      await flows.flowSetMenuFull(db, userId, menuCmd.content, replyToken, state, { reply });
      return;
    }
  }

  // 檢查是否為菜單管理指令（僅 owner）
  if (state.isOwner && state.isWorldActive) {
    const menuCmd = parseMenuCommand(text);
    if (menuCmd) {
      if (menuCmd.type === 'ADD_MENU_ITEM') {
        await flows.flowAddMenuItem(db, userId, menuCmd, replyToken, state, { reply });
        return;
      }
      if (menuCmd.type === 'REMOVE_MENU_ITEM') {
        await flows.flowRemoveMenuItem(db, userId, menuCmd, replyToken, state, { reply });
        return;
      }
      if (menuCmd.type === 'UPDATE_MENU_ITEM') {
        await flows.flowUpdateMenuItem(db, userId, menuCmd, replyToken, state, { reply });
        return;
      }
    }
  }

  // 檢查是否為設定菜單圖片指令（僅 owner）
  if (state.isOwner && state.isWorldActive) {
    const menuImageCmd = parseMenuImageCommand(text);
    if (menuImageCmd) {
      await flows.flowSetMenuImage(db, userId, menuImageCmd, replyToken, state, { reply });
      return;
    }
  }

  // 檢查是否為成員管理指令（僅 owner）
  if (state.isOwner && state.isWorldActive) {
    const memberCmd = parseMemberCommand(text);
    if (memberCmd) {
      if (memberCmd.type === 'VIEW_MEMBERS') {
        await flows.flowViewMembers(db, userId, replyToken, state, { reply });
        return;
      }
      if (memberCmd.type === 'REMOVE_MEMBER' || memberCmd.type === 'REMOVE_MEMBER_PROMPT') {
        await flows.flowRemoveMember(db, userId, memberCmd, replyToken, state, { reply });
        return;
      }
    }
  }

  // 檢查是否為設定格式指令（僅 owner）
  if (state.isOwner && state.isWorldActive) {
    const formatCmd = parseFormatCommand(text);
    if (formatCmd) {
      if (formatCmd.type === 'SET_ORDER_FORMAT') {
        await flows.flowSetOrderFormat(db, userId, text, replyToken, state, { reply });
        return;
      }
      if (formatCmd.type === 'SET_DISPLAY_FORMAT') {
        await flows.flowSetDisplayFormat(db, userId, text, replyToken, state, { reply });
        return;
      }
    }
    
    // 檢查是否正在設定格式（收到 JSON 格式且是 owner）
    // 使用簡單的啟發式：如果輸入是 JSON 且與現有格式不同，可能是要設定格式
    if (text.trim().startsWith('{') && text.trim().endsWith('}')) {
      try {
        JSON.parse(text); // 驗證是否為有效 JSON
        // 如果是有效 JSON，可能是要設定格式，交給 flow 處理
        const bindings = await getBindings(db, userId);
        const ob = bindings.find((b) => b.role === 'owner' && b.status === 'active');
        if (ob) {
          const { getWorldById } = await import('./world.service.js');
          const world = await getWorldById(db, ob.worldId);
          // 如果輸入的 JSON 與現有格式不同，可能是要更新
          if (text !== world.orderFormat && text !== world.displayFormat) {
            // 嘗試作為訂購格式設定
            await flows.flowSetOrderFormat(db, userId, text, replyToken, state, { reply });
            return;
          }
        }
      } catch {
        // 不是有效的 JSON，繼續正常流程
      }
    }
  }

  if (isClearCommand(text)) {
    await flows.flowClear(db, userId, replyToken, state, { reply });
    return;
  }

  const parsed = parseMessage(text);
  if (parsed && state.isWorldActive) {
    await flows.flowOrder(db, userId, parsed, replyToken, state, { reply });
    return;
  }

  await flows.flowFallback(db, userId, text, replyToken, state, { reply });
}
