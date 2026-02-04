/**
 * order-web.js
 * 專門放 WEB 代碼的 JS 檔案
 * 
 * 職責：
 * - 狀態管理（未登入、已登入未加官方帳、已登入已加官方帳）
 * - LINE Login 整合
 * - 官方帳檢查
 * - 下單流程（選品項 → 選數量 → 確認 → 送出）
 * - UI 渲染（根據狀態渲染不同頁面）
 * - API 封裝
 * - 錯誤處理
 */

// ==================== 設定與常數 ====================

const API_BASE = '/api';

// ==================== 狀態管理 ====================

const state = {
  // 使用者狀態：'not_logged_in' | 'logged_in_no_official' | 'logged_in_with_official'
  userStatus: 'not_logged_in',
  
  // LINE Login 資訊
  lineProfile: null,
  userId: null,
  
  // 官方帳狀態
  isOfficialAccountJoined: false,
  
  // 當前世界資訊
  currentWorld: null,
  currentWorldName: '當前 世界名稱',
  currentWorldId: null, // 當前世界 ID
  currentWorldCode: null, // 當前世界代碼（8碼亂碼）
  menu: null,
  menuImageUrl: null,
  formatted: null, // 菜單文字（API formatted）
  orderFormat: null, // owner 設定的訂購格式 { requiredFields?, itemFormat? }
  itemImages: {}, // { [vendor]: { [itemName]: imageUrl } } 品項圖片
  itemAttributeOptions: {}, // Excel「下拉選項」欄位解析結果 { [itemName]: [{ name, options }] }
  
  // 下單流程狀態（無選擇分店頁，直接訂單頁）
  selectedItems: [], // [{ name: string, qty: number, attributes: string[] }]
  vendorItemMap: {}, // { itemName: vendor } 用於訂單建立時判斷廠商
  purchaserName: '', // 訂購人姓名（輸入）
  currentStep: 'select_items', // 'select_items' | 'select_attr'（手機整頁選屬性）| 'confirm' | 'complete'
  
  // 多世界／訂單 切換
  view: 'order', // 'worlds' | 'order' | 'create_or_join_world' | 'join_world' | 'create_world' | 'my_orders' | 'members' | 'menu_manage' | 'help'
  
  // Excel 上傳相關狀態
  excelUploadFile: null,
  excelPreview: null,
  excelDetectedMapping: null,
  excelNeedsMapping: false,
  excelMapping: { branchColumn: '', itemColumn: '', qtyColumn: '', attrColumn: '', dropdownOptionsColumn: '', hasHeader: true, startRow: 2 },
  worlds: [], // [{ id, name }] 我的世界列表
  
  // 我的訂單
  myOrders: null, // [{ orderId, branch, items, createdAt }]
  myOrdersDate: '今天', // 查詢日期
  myOrdersWorldFilter: 'all', // 'all' | worldId - 世界篩選
  myOrdersTab: 'my_orders', // 'my_orders' | 'received_orders' - 訂單頁面 tab
  myOrdersReceivedViewMode: 'cards', // 'cards' | 'table'
  receivedOrdersTableColumns: null, // [{ key, label, enabled }]
  receivedOrdersTableRows: null, // [{ orderId, branch, vendor, itemName, qty, user, userId, createdAt }]
  excelExportColumns: null, // Excel 匯出欄位設定 [{ key, label, enabled }]
  excelExportColumnsDialogOpen: false, // 是否顯示設定對話框
  excelExportColumnEditing: null, // 正在編輯的欄位 key（用於自訂欄位名稱）
  menuImageViewOpen: false, // 是否顯示全螢幕菜單圖片
  
  // 成員名單
  members: null, // [{ userId, role, created_at, displayName? }]
  
  // 加入/創造世界流程狀態
  createOrJoinStep: 'select', // 'select' | 'join_input' | 'create_input' | 'setup_format' | 'setup_boss'
  worldIdInput: '', // 加入世界時輸入的 ID
  worldNameInput: '', // 創建世界時輸入的名稱
  orderFormatItems: [], // [{ name: string, attributes: [{ name: string }] }] 客戶訂單格式
  bossFormatFields: ['廠商', '品項', '屬性', '訂購人'], // 老闆訂單分類格式欄位
  
  // UI 狀態
  isLoading: false,
  errorMessage: null,

  // 世界管理：刪除/退出世界模式（老闆=刪除世界，消費者=退出世界）
  leaveWorldMode: false,

  // 訂單詳情（編輯/取消/恢復）
  orderDetailOrderId: null,
  orderDetailOrder: null,   // 列表的訂單資料（用於已取消時顯示）
  orderDetailFetched: null, // null | { orderId, branch, items: [{id, item, qty}], created_at } | 'cancelled'
  orderDetailTab: null,     // 'my_orders' | 'received_orders'
  orderDetailSelectedMenuItem: '',  // 新增品項時選的菜單品項名稱，'' = 其他
  orderDetailNewItemAttrs: [],      // 新增品項時選的屬性值 [val1, val2, ...]
  orderDetailPendingQty: {},        // { [itemId]: qty } 暫存的數量變更
  orderDetailPendingDeletes: [],    // [itemId] 暫存的刪除
  orderDetailPendingAdds: [],       // [{ name, qty, tempId }] 暫存的新增
  orderDetailAddCounter: 0,         // 新增品項的遞增 id
  attrModalItemId: null             // 手機版：點品項彈出屬性時，該品項 id
};

// ==================== API 封裝 ====================

/**
 * 檢查使用者是否已加入官方帳
 */
async function checkOfficialAccountStatus(userId) {
  try {
    const response = await fetch(`${API_BASE}/auth/check-official-account?userId=${encodeURIComponent(userId)}`);
    if (!response.ok) {
      throw new Error('檢查官方帳狀態失敗');
    }
    const data = await response.json();
    return data.isJoined || false;
  } catch (error) {
    console.error('❌ 檢查官方帳狀態失敗:', error);
    return false;
  }
}

/**
 * 取得使用者資訊（透過 LINE Login）
 */
async function getLineProfile() {
  try {
    const response = await fetch(`${API_BASE}/auth/profile`);
    if (!response.ok) {
      throw new Error('取得使用者資訊失敗');
    }
    return await response.json();
  } catch (error) {
    console.error('❌ 取得使用者資訊失敗:', error);
    return null;
  }
}

/**
 * 取得世界列表
 */
async function fetchWorlds(userId) {
  if (!userId) return;
  
  try {
    const response = await fetch(`${API_BASE}/worlds?userId=${encodeURIComponent(userId)}`);
    if (!response.ok) {
      console.error('❌ 取得世界列表失敗');
      return;
    }
    const data = await response.json();
    if (data.success && Array.isArray(data.worlds)) {
      state.worlds = data.worlds;
      
      // 如果有當前世界，更新 worldCode
      if (state.currentWorldId) {
        const currentWorldInfo = data.worlds.find(w => w.id === state.currentWorldId);
        if (currentWorldInfo) {
          state.currentWorldCode = currentWorldInfo.worldCode || null;
        }
      }
    }
  } catch (error) {
    console.error('❌ 取得世界列表失敗:', error);
  }
}

/**
 * 取得菜單
 */
async function fetchMenu(userId) {
  try {
    const response = await fetch(`${API_BASE}/menu?userId=${encodeURIComponent(userId)}`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || '取得菜單失敗');
    }
    const data = await response.json();
    return {
      menu: data.menu,
      menuImageUrl: data.menuImageUrl,
      formatted: data.formatted,
      orderFormat: data.orderFormat || null,
      itemImages: data.itemImages || {},
      itemAttributeOptions: data.itemAttributeOptions || {},
      itemAttributes: data.itemAttributes
    };
  } catch (error) {
    console.error('❌ 取得菜單失敗:', error);
    throw error;
  }
}

/**
 * 建立訂單
 */
async function createOrder(userId, items, userName = null) {
  try {
    const response = await fetch(`${API_BASE}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        items,
        userId,
        user: userName || null
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || '建立訂單失敗');
    }
    
    return await response.json();
  } catch (error) {
    console.error('❌ 建立訂單失敗:', error);
    throw error;
  }
}

/**
 * 取得單筆訂單詳情（可編輯狀態）
 * @returns {Promise<{orderId, branch, items: [{id, item, qty}], created_at}|null>} 404 時回傳 null
 */
async function fetchOrderDetail(orderId) {
  if (!state.userId) return null;
  const response = await fetch(`${API_BASE}/orders/${orderId}?userId=${encodeURIComponent(state.userId)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || '查詢訂單失敗');
  }
  return await response.json();
}

// ==================== LINE Login 整合 ====================

/**
 * 初始化 LINE Login
 */
function initLineLogin() {
  const urlParams = new URLSearchParams(window.location.search);
  
  // 測試模式：?test=1 跳過 LINE 登入，使用 WEB_TEST_USER_ID
  if (urlParams.get('test') === '1') {
    runTestMode();
    return;
  }
  
  // 檢查是否有後端傳來的登入資料（從 LINE Login callback）
  const loginData = urlParams.get('login');
  if (loginData) {
    try {
      const decoded = JSON.parse(atob(decodeURIComponent(loginData)));
      handleLoginData(decoded);
      window.history.replaceState({}, document.title, window.location.pathname);
      return;
    } catch (error) {
      console.error('❌ 解析登入資料失敗:', error);
    }
  }
  
  const code = urlParams.get('code');
  const stateParam = urlParams.get('state');
  if (code) {
    handleLineLoginCallback(code, stateParam);
  } else {
    checkLoginStatus();
  }
}

/**
 * 測試模式：跳過 LINE 登入，使用 WEB_TEST_USER_ID 直接進入下單流程
 */
async function runTestMode() {
  try {
    const res = await fetch(`${API_BASE}/config`);
    const cfg = res.ok ? await res.json() : {};
    const testUserId = cfg.testUserId || null;
    
    if (!testUserId) {
      state.userStatus = 'not_logged_in';
      state.errorMessage = '測試模式請在 .env 設定 WEB_TEST_USER_ID（已有世界與菜單的 LINE userId）';
      render();
      return;
    }
    
    state.userId = testUserId;
    state.lineProfile = { userId: testUserId, displayName: '測試用戶', pictureUrl: null };
    state.isOfficialAccountJoined = true;
    state.userStatus = 'logged_in_with_official';
    state.currentStep = 'select_items';
    state.currentWorldName = '測試世界';
    
    await loadMenu(true); // 測試模式：API 失敗時用 mock 菜單
    render();
  } catch (e) {
    console.error('❌ 測試模式初始化失敗:', e);
    state.userStatus = 'not_logged_in';
    state.errorMessage = '測試模式初始化失敗';
    render();
  }
}

/**
 * 處理登入資料（從後端 callback 取得）
 */
function handleLoginData(data) {
  state.userId = data.userId;
  state.lineProfile = {
    userId: data.userId,
    displayName: data.displayName,
    pictureUrl: data.pictureUrl
  };
  state.isOfficialAccountJoined = data.isOfficialAccountJoined || false;
  
  if (state.isOfficialAccountJoined) {
    state.userStatus = 'logged_in_with_official';
    state.view = 'worlds'; // 登入後第一頁為主世界（依使用說明）
    loadMenu().then(() => render());
  } else {
    state.userStatus = 'logged_in_no_official';
    render();
  }
  
  // 儲存到 localStorage（供下次使用）
  localStorage.setItem('orderWeb_userId', data.userId);
  localStorage.setItem('orderWeb_profile', JSON.stringify(state.lineProfile));
}

/**
 * 處理 LINE Login callback（直接重導向到後端）
 */
function handleLineLoginCallback(code, stateParam) {
  // 重導向到後端 callback 端點，後端會處理並重導向回前端
  window.location.href = `${API_BASE}/auth/line-login-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateParam || '')}`;
}

/**
 * 檢查登入狀態
 */
async function checkLoginStatus() {
  // 先從 localStorage 檢查
  const savedUserId = localStorage.getItem('orderWeb_userId');
  const savedProfile = localStorage.getItem('orderWeb_profile');
  
  if (savedUserId && savedProfile) {
    try {
      state.userId = savedUserId;
      state.lineProfile = JSON.parse(savedProfile);
      state.userStatus = 'logged_in_no_official';
      
      // 檢查是否已加入官方帳
      await checkAndUpdateOfficialAccountStatus();
      render();
      return;
    } catch (error) {
      console.error('❌ 讀取儲存的登入資訊失敗:', error);
      localStorage.removeItem('orderWeb_userId');
      localStorage.removeItem('orderWeb_profile');
    }
  }
  
  // 如果沒有儲存的資訊，嘗試從 API 取得
  try {
    const profile = await getLineProfile();
    if (profile && profile.userId) {
      state.userId = profile.userId;
      state.lineProfile = profile;
      state.userStatus = 'logged_in_no_official';
      
      // 儲存到 localStorage
      localStorage.setItem('orderWeb_userId', profile.userId);
      localStorage.setItem('orderWeb_profile', JSON.stringify(profile));
      
      // 檢查是否已加入官方帳
      await checkAndUpdateOfficialAccountStatus();
    } else {
      state.userStatus = 'not_logged_in';
    }
    
    render();
  } catch (error) {
    console.error('❌ 檢查登入狀態失敗:', error);
    state.userStatus = 'not_logged_in';
    render();
  }
}

/**
 * 檢查並更新官方帳狀態
 */
async function checkAndUpdateOfficialAccountStatus() {
  if (!state.userId) return;
  
  try {
    const isJoined = await checkOfficialAccountStatus(state.userId);
    state.isOfficialAccountJoined = isJoined;
    
    if (isJoined) {
      state.userStatus = 'logged_in_with_official';
      state.view = 'worlds'; // 登入後第一頁為主世界（依使用說明）
      // 載入世界列表
      await fetchWorlds(state.userId);
      // 載入菜單（如果沒有當前世界，loadMenu 會失敗，這是正常的）
      try {
        await loadMenu();
      } catch (error) {
        // 如果沒有當前世界或世界尚未啟用，無法取得菜單是正常的
        console.log('無法載入菜單（可能是沒有當前世界）:', error);
        state.menu = null;
      }
    } else {
      state.userStatus = 'logged_in_no_official';
    }
  } catch (error) {
    console.error('❌ 檢查官方帳狀態失敗:', error);
    state.isOfficialAccountJoined = false;
    state.userStatus = 'logged_in_no_official';
  }
}

/**
 * 載入菜單
 * @param {boolean} useMockIfFail - 測試模式時若 API 失敗，改用 mock 菜單
 */
async function loadMenu(useMockIfFail = false) {
  if (!state.userId) return;
  
  // 如果沒有當前世界，清空菜單
  if (!state.currentWorldId) {
    state.menu = null;
    state.itemImages = {};
    state.vendorItemMap = {};
    state.baseItemToMenuMap = {};
    state.itemAttributeOptions = {};
    return;
  }
  
  try {
    setLoading(true);
    const menuData = await fetchMenu(state.userId);
    
    // 確保菜單是屬於當前世界的（後端應該已經過濾，但前端再確認一次）
    if (menuData.menu && Object.keys(menuData.menu).length > 0) {
      state.menu = menuData.menu;
      state.menuImageUrl = menuData.menuImageUrl;
      state.formatted = menuData.formatted || null;
      state.orderFormat = menuData.orderFormat || null;
      state.itemImages = menuData.itemImages || {};
      state.itemAttributes = menuData.itemAttributes || {};
      state.itemAttributeOptions = menuData.itemAttributeOptions || {};
      // 建立 vendorItemMap 供訂單建立時使用
      state.vendorItemMap = {};
      // 建立 menuItemAttributes：從 menu 或 itemAttributes 提取品項對應的屬性
      state.menuItemAttributes = {};
      for (const vendor of Object.keys(state.menu)) {
        for (const itemName of Object.keys(state.menu[vendor])) {
          if (!state.vendorItemMap[itemName]) {
            state.vendorItemMap[itemName] = vendor;
          }
          const val = state.menu[vendor][itemName];
          if (typeof val === 'object' && val !== null && Array.isArray(val.attributes) && val.attributes.length > 0) {
            state.menuItemAttributes[itemName] = val.attributes;
          } else if (state.itemAttributes[vendor] && state.itemAttributes[vendor][itemName]) {
            state.menuItemAttributes[itemName] = state.itemAttributes[vendor][itemName];
          }
        }
      }
    } else {
      // 如果菜單為空，清空相關狀態
      state.menu = null;
      state.itemImages = {};
      state.vendorItemMap = {};
      state.menuItemAttributes = {};
      state.baseItemToMenuMap = {};
      state.itemAttributeOptions = {};
    }
    // 建立 orderFormat 品項名稱到菜單實際品項名稱的映射
    if (state.menu && state.orderFormat && state.orderFormat.items && Array.isArray(state.orderFormat.items)) {
      state.formatItemToMenuMap = {};
      for (const vendor of Object.keys(state.menu)) {
        for (const menuItemName of Object.keys(state.menu[vendor])) {
          for (const formatItem of state.orderFormat.items) {
            const formatItemName = formatItem.name;
            if (menuItemName === formatItemName || menuItemName.startsWith(formatItemName + ' ')) {
              // 如果還沒有映射，或當前匹配更精確（完全匹配優先於前綴匹配）
              if (!state.formatItemToMenuMap[formatItemName] || menuItemName === formatItemName) {
                state.formatItemToMenuMap[formatItemName] = menuItemName;
              }
            }
          }
        }
      }
    } else {
      state.formatItemToMenuMap = {};
    }
    // 如果沒有 orderFormat，建立基礎名稱到完整名稱的映射
    if (state.menu && (!state.orderFormat || !state.orderFormat.items || state.orderFormat.items.length === 0)) {
      state.baseItemToMenuMap = {};
      const allFullNames = [];
      
      // 收集所有完整名稱
      for (const vendor of Object.keys(state.menu)) {
        for (const itemName of Object.keys(state.menu[vendor])) {
          allFullNames.push(itemName);
        }
      }
      
      // 智能提取基礎名稱
      const itemGroups = {};
      const processedNames = new Set();
      
      for (const fullName of allFullNames) {
        if (processedNames.has(fullName)) continue;
        
        let baseName = fullName;
        const spaceIndex = fullName.indexOf(' ');
        if (spaceIndex > 0) {
          baseName = fullName.substring(0, spaceIndex);
        }
        
        // 找出所有使用這個基礎名稱的品項
        const matchingItems = allFullNames.filter(name => 
          name === baseName || name.startsWith(baseName + ' ')
        );
        
        if (matchingItems.length > 1) {
          // 有多個品項使用這個基礎名稱
          if (!itemGroups[baseName]) {
            itemGroups[baseName] = [];
          }
          matchingItems.forEach(name => {
            if (!itemGroups[baseName].includes(name)) {
              itemGroups[baseName].push(name);
              processedNames.add(name);
            }
          });
        } else {
          // 只有一個品項，整個名稱就是基礎名稱
          if (!itemGroups[fullName]) {
            itemGroups[fullName] = [];
          }
          itemGroups[fullName].push(fullName);
          processedNames.add(fullName);
        }
      }
      
      // 建立映射
      for (const baseName of Object.keys(itemGroups)) {
        const fullNames = itemGroups[baseName];
        state.baseItemToMenuMap[baseName] = fullNames.length > 0 ? fullNames[0] : baseName;
      }
    } else {
      state.baseItemToMenuMap = {};
    }
    
    setLoading(false);
  } catch (error) {
    // 如果載入菜單失敗（例如世界尚未設定菜單），清空菜單狀態
    console.log('載入菜單失敗:', error);
    state.menu = null;
      state.itemImages = {};
      state.vendorItemMap = {};
      state.menuItemAttributes = {};
      state.baseItemToMenuMap = {};
      state.itemAttributeOptions = {};
      state.formatItemToMenuMap = {};
    setLoading(false);
    
    if (useMockIfFail) {
      state.menu = {
        '台北店': { '大杯紙杯': 0, '小杯紙杯': 0, '紅茶茶包': 0 },
        '台中店': { '珍珠奶茶': 0, '綠茶': 0 }
      };
      state.menuImageUrl = null;
      state.formatted = null;
      state.orderFormat = null;
    } else {
      // 不顯示錯誤，因為沒有菜單是正常的（新創建的世界）
      // showError('無法載入菜單，請稍後再試');
    }
  }
}

/**
 * 觸發 LINE Login
 */
function triggerLineLogin() {
  // 重導向到後端的 LINE Login 端點
  window.location.href = `${API_BASE}/auth/line-login`;
}

/**
 * 重新檢查官方帳狀態（使用者點擊「我已加入」按鈕後）
 */
async function recheckOfficialAccount() {
  if (!state.userId) return;
  
  setLoading(true);
  await checkAndUpdateOfficialAccountStatus();
  setLoading(false);
  render();
}

// ==================== UI 渲染 ====================

/**
 * 主渲染函數（根據狀態渲染不同頁面）
 */
function render() {
  const container = document.getElementById('app');
  if (!container) return;
  
  // 僅在「切換 view」時清除錯誤，同頁重繪（如 goToConfirm 驗證失敗）保留錯誤，避免禁止彈出視窗時無提示
  const canClearError = state.userStatus !== 'not_logged_in' &&
    !['join_world', 'create_world'].includes(state.view);
  if (canClearError && state._lastRenderedView !== undefined && state._lastRenderedView !== state.view) {
    state.errorMessage = null;
  }
  state._lastRenderedView = state.view;

  switch (state.userStatus) {
    case 'not_logged_in':
      renderLoginPage(container);
      break;
    case 'logged_in_no_official':
      renderOfficialAccountRequiredPage(container);
      break;
    case 'logged_in_with_official':
      if (state.view === 'worlds') {
        renderWorldsPage(container);
      } else if (state.view === 'my_orders') {
        renderMyOrdersPage(container);
      } else if (state.view === 'members') {
        renderMembersPage(container);
      } else if (state.view === 'menu_manage') {
        renderMenuManagePage(container);
      } else if (state.view === 'help') {
        renderHelpPage(container);
      } else if (state.view === 'create_or_join_world' || state.view === 'join_world' || state.view === 'create_world') {
        renderCreateOrJoinWorldPage(container);
      } else {
        renderOrderPage(container);
      }
      break;
    default:
      renderLoginPage(container);
  }
  
  // 處理全螢幕菜單圖片顯示
  const existingOverlay = document.getElementById('menu-image-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }
  if (state.menuImageViewOpen) {
    const menuOverlay = renderMenuImageView();
    container.insertAdjacentHTML('beforeend', menuOverlay);
  }
  
  // Excel 匯出欄位對話框開啟時，每次 render 後重新綁定拖曳（改完欄位名稱後即可調整順序）
  if (state.excelExportColumnsDialogOpen && state.view === 'my_orders') {
    setTimeout(() => setupExcelExportColumnsDragAndDrop(), 0);
  }
}

/**
 * 渲染主世界頁（登入後第一頁：當前世界、我的世界網格、加入/創造世界、底部導覽）
 */
function renderWorldsPage(container) {
  const currentWorldName = state.currentWorldName || '當前 世界名稱';
  const hasWorlds = (state.worlds && state.worlds.length > 0) || state.menu;
  const worlds = (state.worlds && state.worlds.length > 0)
    ? state.worlds
    : (state.menu ? [{ id: 1, name: '我的 世界' }] : []);
  
  container.innerHTML = `
    <div class="page-worlds">
      <div class="world-header">
        <div class="label-block">主世界</div>
      </div>
      ${!hasWorlds
        ? `
        <p class="world-empty">尚未加入世界</p>
        <p class="description">請創建世界或加入既有世界後再使用訂單功能。</p>
        <div class="world-grid">
          <div class="world-card world-card-action" onclick="orderWeb.goCreateOrJoinWorld()">加入/創造世界</div>
        </div>
        `
        : `
        <div class="world-grid">
          ${worlds.map(w => {
            const id = escapeJsAttr(String(w.id));
            const name = escapeJsAttr(w.name);
            const label = escapeHtml(w.name);
            const isOwner = w.role === 'owner';
            if (state.leaveWorldMode) {
              const actionLabel = isOwner ? '刪除' : '退出';
              const actionFn = isOwner ? 'deleteWorld' : 'leaveWorld';
              return `
                <div class="world-card world-card-leave" style="position: relative; padding-left: 2.5rem;">
                  <button type="button"
                          class="world-card-leave-btn"
                          style="position:absolute; left:0.5rem; top:50%; transform:translateY(-50%); background:#f44336; color:#fff; border:none; border-radius:999px; width:1.75rem; height:1.75rem; cursor:pointer;"
                          onclick="orderWeb.${actionFn}('${id}', '${name}')" title="${isOwner ? '刪除世界（永久刪除所有內容）' : '退出世界'}">×</button>
                  <span>${label}${isOwner ? ' <small>(老闆)</small>' : ''}</span>
                </div>
              `;
            }
            return `
              <div class="world-card" onclick="orderWeb.selectWorld('${id}', '${name}')">${label}</div>
            `;
          }).join('')}
          <div class="world-card world-card-action" onclick="orderWeb.goCreateOrJoinWorld()">加入/創造世界</div>
          ${hasWorlds ? `
          <div class="world-card world-card-action" onclick="orderWeb.toggleLeaveWorldMode()">
            ${state.leaveWorldMode ? '完成' : '刪除/退出世界'}
          </div>
          ` : ''}
        </div>
        `
      }
    </div>
    ${navBottom()}
  `;
}

async function selectWorld(id, name) {
  if (!state.userId) {
    showError('使用者未登入');
    return;
  }
  
  const worldId = parseInt(id, 10);
  if (isNaN(worldId)) {
    showError('世界 ID 格式錯誤');
    return;
  }
  
  setLoading(true);
  
  try {
    // 設定為當前世界
    const response = await fetch(`${API_BASE}/worlds/current`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.userId,
        worldId: worldId
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || '設定當前世界失敗');
    }
    
    // 更新狀態
    state.currentWorldId = worldId;
    state.currentWorldName = name;
    
    // 確保世界列表已載入（用於判斷是否為擁有者）
    if (!state.worlds || state.worlds.length === 0) {
      await fetchWorlds(state.userId);
    }
    
    // 從世界列表中取得 worldCode（如果 fetchWorlds 失敗，worlds 可能仍為空，需要重新查詢）
    let currentWorldInfo = state.worlds && state.worlds.find(w => w.id === worldId);
    if (!currentWorldInfo) {
      // 如果找不到，重新載入世界列表
      await fetchWorlds(state.userId);
      currentWorldInfo = state.worlds && state.worlds.find(w => w.id === worldId);
    }
    state.currentWorldCode = currentWorldInfo ? currentWorldInfo.worldCode : null;
    
    // 重新載入菜單（如果世界是 active 狀態）
    try {
      await loadMenu();
    } catch (error) {
      // 如果世界尚未啟用（vendorMap_setup），無法取得菜單是正常的
      console.log('世界尚未啟用，無法取得菜單（這是正常的）');
      state.menu = null;
    }
    
    // 載入 Excel 匯出欄位設定（如果有的話）
    const savedColumns = loadExcelExportColumns();
    if (savedColumns) {
      state.excelExportColumns = savedColumns;
    }
    
    // 切換到訂單頁面
    state.view = 'order';
    state.currentStep = 'select_items';
    state.selectedItems = [];
    // 建立 vendorItemMap 供訂單建立時使用
    if (state.menu) {
      state.vendorItemMap = {};
      for (const vendor of Object.keys(state.menu)) {
        for (const itemName of Object.keys(state.menu[vendor])) {
          if (!state.vendorItemMap[itemName]) {
            state.vendorItemMap[itemName] = vendor;
          }
        }
      }
    }
    
    setLoading(false);
    render();
  } catch (error) {
    setLoading(false);
    showError(error.message || '切換世界失敗，請稍後再試');
    render();
  }
}

function toggleLeaveWorldMode() {
  state.leaveWorldMode = !state.leaveWorldMode;
  state.errorMessage = null;
  render();
}

async function leaveWorld(id, name) {
  if (!state.userId) {
    showError('使用者未登入');
    return;
  }

  const worldId = parseInt(id, 10);
  if (isNaN(worldId)) {
    showError('世界 ID 格式錯誤');
    return;
  }

  if (!confirm(`確定要退出世界「${name}」嗎？`)) {
    return;
  }

  setLoading(true);
  state.errorMessage = null;

  try {
    const response = await fetch(`${API_BASE}/worlds/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.userId,
        worldId
      })
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.success) {
      const msg = (data && data.error) || '退出世界失敗，請稍後再試';
      throw new Error(msg);
    }

    // 重新載入世界列表
    await fetchWorlds(state.userId);

    // 如果退出的是當前世界，重置當前世界資訊
    if (state.currentWorldId === worldId) {
      state.currentWorldId = null;
      state.currentWorldName = '當前 世界名稱';
      state.currentWorldCode = null;
      state.menu = null;
      state.menuImageUrl = null;
      state.formatted = null;
      state.orderFormat = null;
      state.selectedItems = [];
      state.vendorItemMap = {};
      state.view = 'worlds'; // 切換回世界列表頁
    }

    // 若已無世界，自動關閉退出模式
    const hasWorlds = state.worlds && state.worlds.length > 0;
    if (!hasWorlds) {
      state.leaveWorldMode = false;
    }

    setLoading(false);
    render();
  } catch (error) {
    console.error('❌ 退出世界失敗:', error);
    setLoading(false);
    showError(error.message || '退出世界失敗，請稍後再試');
    render();
  }
}

/**
 * 老闆刪除世界（永久刪除該世界所有內容，需二次確認）
 */
async function deleteWorld(id, name) {
  if (!state.userId) {
    showError('使用者未登入');
    return;
  }
  const worldId = parseInt(id, 10);
  if (isNaN(worldId)) {
    showError('世界 ID 格式錯誤');
    return;
  }
  const msg = '刪除後該世界所有內容將永久刪除，無法復原。\n包含：訂單、訂單歷史、菜單、成員、設定等。\n\n確定要刪除世界「' + name + '」嗎？';
  if (!confirm(msg)) {
    return;
  }
  setLoading(true);
  state.errorMessage = null;
  try {
    const response = await fetch(`${API_BASE}/worlds/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.userId,
        worldId,
        confirm: 'DELETE'
      })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.success) {
      const errMsg = (data && data.error) || '刪除世界失敗，請稍後再試';
      throw new Error(errMsg);
    }
    await fetchWorlds(state.userId);
    if (state.currentWorldId === worldId) {
      state.currentWorldId = null;
      state.currentWorldName = '當前 世界名稱';
      state.currentWorldCode = null;
      state.menu = null;
      state.menuImageUrl = null;
      state.formatted = null;
      state.orderFormat = null;
      state.selectedItems = [];
      state.vendorItemMap = {};
      state.view = 'worlds';
    }
    const hasWorlds = state.worlds && state.worlds.length > 0;
    if (!hasWorlds) state.leaveWorldMode = false;
    setLoading(false);
    render();
  } catch (error) {
    console.error('❌ 刪除世界失敗:', error);
    setLoading(false);
    showError(error.message || '刪除世界失敗，請稍後再試');
    render();
  }
}

/** 底部導覽 HTML（操作流程指南 / 世界 / 我） */
function navBottom() {
  const isCreatingWorld = ['create_world', 'setup_order_format', 'setup_boss_format'].includes(state.view);
  
  return `
    <nav class="nav-bottom">
      <button type="button" class="btn-block" onclick="orderWeb.goHelp()">操作流程指南</button>
      <button type="button" class="btn-block" onclick="orderWeb.goWorldsWithConfirm()">世界</button>
      <button type="button" class="btn-block" onclick="orderWeb.goMeWithConfirm()">我</button>
    </nav>
  `;
}

/**
 * 渲染登入頁（設計1：歡迎使用、阿荃訂單系統、使用LINE登入）
 */
function renderLoginPage(container) {
  const err = state.errorMessage ? `<p class="error-message">${escapeHtml(state.errorMessage)}</p>` : '';
  container.innerHTML = `
    <div class="page-login">
      <div class="login-box">
        <p class="title-line">歡迎使用</p>
        <p class="subtitle">阿荃訂單系統</p>
        ${err}
        <button type="button" class="btn-block line-login" onclick="orderWeb.triggerLineLogin()">使用LINE登入</button>
      </div>
    </div>
  `;
}

/**
 * 渲染官方帳要求頁（簡潔區塊＋底部導覽）
 */
function renderOfficialAccountRequiredPage(container) {
  container.innerHTML = `
    <div class="page-order">
      <div class="login-box" style="max-width:var(--max-width); margin:0 auto;">
        <p class="title-line">請加入官方帳號</p>
        <p class="description">為了接收訂單通知，請先加入我們的 LINE 官方帳號。</p>
        <div class="official-account-info">
          <ul class="info-list">
            <li>接收訂單確認通知</li>
            <li>即時了解訂單狀態</li>
          </ul>
        </div>
        <div class="action-buttons">
          <a href="https://lin.ee/MHgOOIDP" target="_blank" class="btn-block">加入官方帳號</a>
          <button type="button" class="btn-block" onclick="orderWeb.recheckOfficialAccount()" ${state.isLoading ? 'disabled' : ''}>${state.isLoading ? '檢查中...' : '我已加入'}</button>
        </div>
      </div>
    </div>
    ${navBottom()}
  `;
}

/**
 * 渲染下單頁（根據步驟渲染不同內容）
 */
function renderOrderPage(container) {
  // 檢查菜單是否為空
  const hasMenu = state.menu && typeof state.menu === 'object' && Object.keys(state.menu).length > 0;
  
  if (!hasMenu) {
    // 檢查是否為世界擁有者
    const currentWorld = state.worlds && state.worlds.find(w => w.id === state.currentWorldId);
    const isOwner = currentWorld && currentWorld.role === 'owner';
    
    container.innerHTML = `
      <div class="page-order">
        <div class="order-header">
          <span class="order-title">訂單頁面</span>
          ${orderHeaderLinks()}
        </div>
        <div style="padding: var(--spacing-lg); text-align: center;">
          <p class="empty-message">菜單尚未設定</p>
          ${isOwner ? '<p style="margin-top: var(--spacing-md); color: var(--color-text-light); font-size: 0.875rem;">請先設定菜單後才能下訂單<br>（可透過 LINE 官方帳號設定）</p>' : '<p style="margin-top: var(--spacing-md); color: var(--color-text-light); font-size: 0.875rem;">請聯繫管理員設定菜單</p>'}
          ${state.menuImageUrl ? `<p style="margin-top: var(--spacing-md);"><a href="${escapeHtml(state.menuImageUrl)}" target="_blank" rel="noopener" style="color: var(--color-primary);">查看菜單圖片</a></p>` : ''}
        </div>
      </div>
      ${navBottom()}
    `;
    return;
  }
  
  switch (state.currentStep) {
    case 'select_items':
      renderItemSelection(container);
      break;
    case 'select_attr':
      if (isMobileView() && state.attrModalItemId) {
        renderOrderAttrFullPage(container);
      } else {
        state.currentStep = 'select_items';
        state.attrModalItemId = null;
        renderItemSelection(container);
      }
      break;
    case 'confirm':
      renderConfirmOrder(container);
      break;
    case 'complete':
      renderOrderComplete(container);
      break;
    default:
      renderItemSelection(container);
  }
}

/**
 * 取得品項的屬性維度名稱與各維度選項（供下拉選單用）
 * @param {string} itemName - 品項基礎名稱
 * @returns {{ dimensionNames: string[], optionsPerDimension: string[][] }}
 */
/** 從 state.itemAttributeOptions 取得該品項的定義（支援 trim 比對 key） */
function getItemAttributeOptions(itemName) {
  if (!state.itemAttributeOptions || typeof state.itemAttributeOptions !== 'object') return null;
  const key = (itemName || '').trim();
  if (state.itemAttributeOptions[key] && Array.isArray(state.itemAttributeOptions[key])) return state.itemAttributeOptions[key];
  const matchedKey = Object.keys(state.itemAttributeOptions).find(k => (k || '').trim() === key);
  return matchedKey && Array.isArray(state.itemAttributeOptions[matchedKey]) ? state.itemAttributeOptions[matchedKey] : null;
}

function getAttributeDimensionsAndOptions(itemName) {
  const dimensionNames = [];
  const optionsByIndex = {}; // index -> Set of option strings

  // 維度名稱與選項：來自 orderFormat.items 中該品項的 attributes（支援「名稱,選項1,選項2」存的 options）
  const formatOptionsByIndex = []; // 從 orderFormat 來的選項，優先使用
  if (state.orderFormat && state.orderFormat.items && Array.isArray(state.orderFormat.items)) {
    const formatItem = state.orderFormat.items.find(item => (item.name || '').trim() === (itemName || '').trim());
    if (formatItem && formatItem.attributes && Array.isArray(formatItem.attributes)) {
      formatItem.attributes.forEach(a => {
        const name = (typeof a === 'object' && a && a.name) ? a.name : String(a || '');
        dimensionNames.push(name);
        const opts = (typeof a === 'object' && a && Array.isArray(a.options)) ? a.options : [];
        formatOptionsByIndex.push(opts.length ? opts : null); // null = 從 menu 推
      });
    }
  }

  // 從 menu 收集各維度的選項：品項名為 "baseName 屬性1 屬性2 ..."（僅當該維度沒有 format 選項時用）
  const menuItemName = (state.baseItemToMenuMap && state.baseItemToMenuMap[itemName]) || itemName;
  if (state.menu) {
    for (const vendor of Object.keys(state.menu)) {
      for (const fullName of Object.keys(state.menu[vendor])) {
        if (fullName === itemName || fullName === menuItemName) continue;
        const prefix = itemName + ' ';
        const prefixMenu = menuItemName + ' ';
        if (!fullName.startsWith(prefix) && !fullName.startsWith(prefixMenu)) continue;
        const suffix = fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName.slice(prefixMenu.length);
        const parts = suffix.split(/\s+/).filter(Boolean);
        parts.forEach((p, i) => {
          if (!optionsByIndex[i]) optionsByIndex[i] = new Set();
          optionsByIndex[i].add(p);
        });
      }
    }
  }

  // 若沒有 orderFormat 維度，改用 Excel「下拉選項」欄位（itemAttributeOptions）
  const excelAttrs = getItemAttributeOptions(itemName);
  if (dimensionNames.length === 0 && excelAttrs && excelAttrs.length > 0) {
    excelAttrs.forEach(a => {
      dimensionNames.push(a.name || '');
      formatOptionsByIndex.push((a.options && a.options.length) ? a.options : null);
    });
  }
  // 若仍無維度，用索引當維度（屬性1、屬性2…）並依 menu 推斷維度數
  const maxIndex = Math.max(-1, ...Object.keys(optionsByIndex).map(Number));
  if (dimensionNames.length === 0 && maxIndex >= 0) {
    for (let i = 0; i <= maxIndex; i++) dimensionNames.push('屬性' + (i + 1));
  }
  // Excel「下拉選項」可補齊：orderFormat 有維度名稱但沒選項時，用 itemAttributeOptions 同名稱的 options
  const excelOpts = getItemAttributeOptions(itemName);
  if (excelOpts && Array.isArray(excelOpts) && excelOpts.length > 0) {
    dimensionNames.forEach((dimName, i) => {
      if (formatOptionsByIndex[i] && formatOptionsByIndex[i].length > 0) return;
      const match = excelOpts.find(a => (a.name || '').trim() === (dimName || '').trim());
      if (match && match.options && match.options.length > 0) {
        formatOptionsByIndex[i] = match.options;
      }
    });
  }
  const optionsPerDimension = dimensionNames.map((_, i) => {
    if (formatOptionsByIndex[i] && formatOptionsByIndex[i].length > 0) return formatOptionsByIndex[i];
    return optionsByIndex[i] ? Array.from(optionsByIndex[i]).sort() : [];
  });
  return { dimensionNames, optionsPerDimension };
}

/** 手機版判定：與 CSS 斷點一致，僅手機版時屬性收進品項、點擊彈出 */
function isMobileView() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches;
}

/** 依 owner 設定的 orderFormat 顯示屬性（requiredFields） */
function formatAttributeLabel() {
  const of = state.orderFormat;
  if (!of || !Array.isArray(of.requiredFields) || of.requiredFields.length === 0) {
    return '－';
  }
  return of.requiredFields.join('、');
}

/** 訂單頁 header 中間撐開：當前世界名稱；右上角：菜單 | 成員名單 */
function orderHeaderLinks() {
  const name = state.currentWorldName || '當前 世界名稱';
  const worldCode = state.currentWorldCode;
  
  // 顯示格式：世界名稱 (代碼: ABC12345)
  let worldInfo = name;
  if (worldCode) {
    worldInfo = `${name} (${worldCode})`;
  }
  
  return `<span class="order-header-world">${escapeHtml(worldInfo)}</span><a href="javascript:orderWeb.goMenu()" class="order-header-link">菜單</a><a href="javascript:orderWeb.goMembers()" class="order-header-link">成員名單</a>`;
}

/**
 * 渲染訂單頁（品項選擇）：無分店 UI。訂購人輸入、屬性依 format、數量可輸入。
 */
function renderItemSelection(container) {
  if (!state.menu || typeof state.menu !== 'object') {
    container.innerHTML = `
      <div class="page-order">
        <div class="order-header">
          <span class="order-title">訂單頁面</span>
          ${orderHeaderLinks()}
        </div>
        <p class="empty-message">菜單尚未設定，請聯繫管理員</p>
      </div>
      ${navBottom()}
    `;
    return;
  }
  
  // 簡化流程：直接從菜單讀取品項，不依賴 orderFormat
  // 確保 vendorItemMap 已建立（如果還沒有）
  if (!state.vendorItemMap || Object.keys(state.vendorItemMap).length === 0) {
    state.vendorItemMap = {};
    if (state.menu) {
      for (const vendor of Object.keys(state.menu)) {
        for (const itemName of Object.keys(state.menu[vendor])) {
          if (!state.vendorItemMap[itemName]) {
            state.vendorItemMap[itemName] = vendor;
          }
        }
      }
    }
  }
  
  // 直接從菜單中提取所有品項（簡化流程）
  let items = [];
  const allFullNames = [];
  
  if (state.menu) {
    // 收集所有完整名稱
    for (const vendor of Object.keys(state.menu).sort()) {
      for (const itemName of Object.keys(state.menu[vendor])) {
        allFullNames.push(itemName);
      }
    }
    
    // 智能提取基礎名稱（相同基礎名稱的品項會分組）
    const itemGroups = {};
    const processedNames = new Set();
    
    for (const fullName of allFullNames) {
      if (processedNames.has(fullName)) continue;
      
      let baseName = fullName;
      const spaceIndex = fullName.indexOf(' ');
      if (spaceIndex > 0) {
        baseName = fullName.substring(0, spaceIndex);
      }
      
      const matchingItems = allFullNames.filter(name => 
        name === baseName || name.startsWith(baseName + ' ')
      );
      
      if (matchingItems.length > 1) {
        if (!itemGroups[baseName]) {
          itemGroups[baseName] = [];
        }
        matchingItems.forEach(name => {
          if (!itemGroups[baseName].includes(name)) {
            itemGroups[baseName].push(name);
            processedNames.add(name);
          }
        });
      } else {
        if (!itemGroups[fullName]) {
          itemGroups[fullName] = [];
        }
        itemGroups[fullName].push(fullName);
        processedNames.add(fullName);
      }
    }
    
    // 提取基礎名稱列表
    items = Object.keys(itemGroups).sort();
    
    // 建立基礎名稱到完整名稱的映射
    state.baseItemToMenuMap = {};
    for (const baseName of Object.keys(itemGroups)) {
      const fullNames = itemGroups[baseName];
      state.baseItemToMenuMap[baseName] = fullNames.length > 0 ? fullNames[0] : baseName;
    }
  }
  
  // 舊的 orderFormat 邏輯已移除（簡化流程）
  
  if (items.length === 0) {
    container.innerHTML = `
      <div class="page-order">
        <div class="order-header">
          <span class="order-title">訂單頁面</span>
          ${orderHeaderLinks()}
        </div>
        <p class="empty-message">菜單尚未設定，請聯繫管理員</p>
      </div>
      ${navBottom()}
    `;
    return;
  }
  // 為 selectedItems 中的項目添加唯一 ID（如果還沒有）
  state.selectedItems.forEach((item, index) => {
    if (!item.id) {
      item.id = `item_${Date.now()}_${index}_${Math.random().toString(36).substr(2, 9)}`;
    }
  });
  
  // 建立 selectedItemsMap，但現在使用 id 作為 key（如果有的話）
  // 同時也保留按名稱查找的功能
  const selectedItemsMap = new Map();
  const selectedItemsById = new Map();
  state.selectedItems.forEach(item => {
    if (item.id) {
      selectedItemsById.set(item.id, item);
    }
    // 為了向後相容，也保留按名稱的映射（取第一個匹配的）
    const key = item.name;
    if (!selectedItemsMap.has(key)) {
      selectedItemsMap.set(key, item);
    }
  });
  
  container.innerHTML = `
    <div class="page-order">
      <div class="order-header">
        <span class="order-title">訂單頁面</span>
        ${orderHeaderLinks()}
      </div>
      <div class="order-top-row">
        <div class="label-block" style="flex:0 0 auto;">訂購人</div>
        <input type="text" class="order-purchaser-input" placeholder="訂購人姓名" value="${escapeHtml(state.purchaserName)}" oninput="orderWeb.setPurchaserName(this.value)">
      </div>
      <div class="step-header">
        <button type="button" class="btn-back" onclick="orderWeb.goBack()">← 返回</button>
        <div class="label-block">訂購品項</div>
      </div>
      <div id="order-page-error" class="order-page-error" role="alert" style="${state.errorMessage ? '' : 'display:none'}">${state.errorMessage ? escapeHtml(state.errorMessage) : ''}</div>
      <!-- 簡化流程：直接顯示品項列表，不依賴 orderFormat -->
      <div class="order-rows ${(state.menuItemAttributes && Object.keys(state.menuItemAttributes).length > 0) || (state.itemAttributeOptions && Object.keys(state.itemAttributeOptions).length > 0) ? 'order-rows-with-attr' : ''}">
        <div class="order-row order-rows-head">
          <div class="label-block">品項</div>
          ${(state.menuItemAttributes && Object.keys(state.menuItemAttributes).length > 0) || (state.itemAttributeOptions && Object.keys(state.itemAttributeOptions).length > 0) ? '<div class="label-block order-rows-head-attr">屬性</div>' : ''}
          <div class="label-block">數量</div>
        </div>
        ${(() => {
          // 收集所有要顯示的項目
          const rowsToRender = [];
          
          items.forEach(itemName => {
            if (!itemName || itemName.trim() === '') {
              return;
            }
            
            // 找出所有匹配此商品名稱的 selectedItems
            const matchingItems = state.selectedItems.filter(item => item.name === itemName);
            
            if (matchingItems.length > 0) {
              // 如果有已選擇的項目，顯示它們
              matchingItems.forEach(item => {
                if (!item.id) {
                  item.id = `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                }
                rowsToRender.push({
                  itemName: itemName,
                  selectedItem: item
                });
              });
            } else {
              // 如果沒有已選擇的項目，創建一個空項目
              const newItem = {
                id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                name: itemName,
                qty: 0,
                attributes: []
              };
              
              state.selectedItems.push(newItem);
              rowsToRender.push({
                itemName: itemName,
                selectedItem: newItem
              });
            }
          });
          
          return rowsToRender.map(({ itemName, selectedItem }) => {
            if (!selectedItem.id) {
              selectedItem.id = `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            }
            
            const currentQty = selectedItem.qty || 0;
            const itemId = selectedItem.id;
            const safe = escapeJsAttr(itemName);
            const safeId = escapeJsAttr(itemId);
            
            // 從菜單中取得品項資訊
            let menuInfo = null;
            let menuItemName = itemName;
            if (state.baseItemToMenuMap && state.baseItemToMenuMap[itemName]) {
              menuItemName = state.baseItemToMenuMap[itemName];
            }
            if (state.menu) {
              // 先嘗試用完整名稱查找
              for (const vendor of Object.keys(state.menu)) {
                if (state.menu[vendor][menuItemName] !== undefined) {
                  const val = state.menu[vendor][menuItemName];
                  menuInfo = {
                    vendor: vendor,
                    stock: typeof val === 'object' && val && typeof val.qty === 'number' ? val.qty : (Number(val) || val)
                  };
                  break;
                }
              }
              // 如果找不到，嘗試用基礎名稱查找
              if (!menuInfo) {
                for (const vendor of Object.keys(state.menu)) {
                  for (const fullName of Object.keys(state.menu[vendor])) {
                    if (fullName === itemName || fullName.startsWith(itemName + ' ')) {
                      const val = state.menu[vendor][fullName];
                      menuInfo = {
                        vendor: vendor,
                        stock: typeof val === 'object' && val && typeof val.qty === 'number' ? val.qty : (Number(val) || val)
                      };
                      break;
                    }
                  }
                  if (menuInfo) break;
                }
              }
            }
            
            // 取得品項圖片
            let itemImageUrl = null;
            if (menuInfo && state.itemImages && state.itemImages[menuInfo.vendor] && state.itemImages[menuInfo.vendor][menuItemName]) {
              itemImageUrl = state.itemImages[menuInfo.vendor][menuItemName];
            }
            
            const hasAttr = (state.menuItemAttributes && state.menuItemAttributes[menuItemName] && state.menuItemAttributes[menuItemName].length > 0) || (getItemAttributeOptions(itemName) && getItemAttributeOptions(itemName).length > 0);
            const attrs = (selectedItem.attributes || []);
            const { dimensionNames, optionsPerDimension } = getAttributeDimensionsAndOptions(itemName);
            const useDropdowns = dimensionNames.length > 0 && optionsPerDimension.some(opts => opts.length > 0);
            const attrsFilled = dimensionNames.length > 0
              ? (attrs.length >= dimensionNames.length && dimensionNames.every((_, i) => (attrs[i] || '').trim() !== ''))
              : (attrs.length > 0 && (attrs[0] || '').trim() !== '');
            const mobile = isMobileView();
            const attrCellDesktop = hasAttr ? (useDropdowns ? `
                <div class="order-attr-cell order-attr-dropdowns">
                  ${dimensionNames.map((dimName, di) => {
                    const options = optionsPerDimension[di] || [];
                    const currentVal = attrs[di] || '';
                    return `<select class="order-attr-select" data-item-id="${safeId}" data-attr-index="${di}" data-attr-name="${escapeHtml(dimName)}" onchange="orderWeb.setItemAttributeFromSelect(this)" title="${escapeHtml(dimName)}">
                      <option value="">-- ${escapeHtml(dimName)} --</option>
                      ${options.map(v => `<option value="${escapeHtml(v)}" ${currentVal === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                    </select>`;
                  }).join('')}
                </div>
              ` : `
                <div class="order-attr-cell">
                  ${attrs.map((a, ai) => `<span class="attr-tag">${escapeHtml(a)}<button type="button" class="attr-tag-remove" onclick="orderWeb.removeItemAttributeById('${safeId}', ${ai})" aria-label="移除">×</button></span>`).join('')}
                  <button type="button" class="btn-attr-plus" onclick="orderWeb.addItemAttribute('${safeId}')" title="新增屬性">＋</button>
                </div>
              `) : (((state.menuItemAttributes && Object.keys(state.menuItemAttributes).length > 0) || (state.itemAttributeOptions && Object.keys(state.itemAttributeOptions).length > 0)) ? '<div class="order-attr-cell">－</div>' : '');
            const nameBlockInner = `
                  ${itemImageUrl ? `
                    <img src="${escapeHtml(itemImageUrl)}" alt="${escapeHtml(itemName)}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 4px; border: 1px solid var(--color-border); flex-shrink: 0;">
                  ` : ''}
                  <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 500;">${escapeHtml(itemName || '未命名品項')}</div>
                    ${attrsFilled && mobile && hasAttr ? `<div class="order-row-attr-subtitle">${attrs.map(a => escapeHtml(a)).join('、')}</div>` : ''}
                    ${menuInfo ? `
                      <div style="font-size: 0.75rem; color: var(--color-text-light); margin-top: 0.25rem;">
                        ${escapeHtml(menuInfo.vendor)} | 庫存: ${menuInfo.stock}
                      </div>
                    ` : ''}
                  </div>
            `;
            const variantBtn = `
                  <button type="button" class="btn-add-variant" onclick="${mobile && hasAttr ? 'event.stopPropagation(); ' : ''}orderWeb.duplicateItemWithAttributes('${safeId}', '${safe}')" style="width: 32px; height: 32px; border: 1px solid var(--color-primary); border-radius: 4px; background: var(--color-primary); color: white; font-size: 1.2rem; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;" title="新增相同商品但不同屬性">+</button>
            `;
            const qtyBlock = `
                <div class="btn-qty-wrap">
                  <button type="button" class="btn-qty" onclick="orderWeb.adjustItemQty('${safeId}', -1)" ${currentQty === 0 ? 'disabled' : ''}>−</button>
                  <input type="number" class="order-qty-input" min="0" value="${currentQty}" onchange="orderWeb.setItemQtyFromInput('${safeId}', this)">
                  <button type="button" class="btn-qty" onclick="orderWeb.adjustItemQty('${safeId}', 1)">＋</button>
                </div>
            `;
            if (mobile) {
              const nameBlockAttrs = mobile && hasAttr ? ` class="label-block order-row-name-tappable" style="flex:1; display:flex; align-items:center; gap:var(--spacing-sm); cursor:pointer;" onclick="orderWeb.openAttrModal('${safeId}')" role="button" tabindex="0"` : ` class="label-block" style="flex:1; display:flex; align-items:center; gap:var(--spacing-sm);"`;
              return `
              <div class="order-row ${mobile ? 'order-row-mobile' : ''}">
                <div${nameBlockAttrs}>
                  ${variantBtn}
                  ${nameBlockInner}
                </div>
                ${qtyBlock}
              </div>
            `;
            }
            return `
              <div class="order-row">
                <div class="label-block" style="flex:1; display:flex; align-items:center; gap:var(--spacing-sm);">
                  ${variantBtn}
                  ${nameBlockInner}
                </div>
                ${attrCellDesktop}
                ${qtyBlock}
              </div>
            `;
          }).join('');
        })()}
      </div>
      <div class="order-confirm-wrap">
        <button type="button" class="btn-block" onclick="orderWeb.goToConfirm()" ${state.selectedItems.filter(item => item.qty > 0).length === 0 ? 'disabled' : ''}>確認訂單</button>
      </div>
    </div>
    ${navBottom()}
  `;
}

/** 回傳品項的屬性表單欄位 HTML（供彈窗與手機整頁共用） */
function getOrderAttrFormRowsHtml(itemId) {
  const idx = state.selectedItems.findIndex(item => item.id === itemId);
  if (idx < 0) return { itemName: '', rowsHtml: '' };
  const item = state.selectedItems[idx];
  const itemName = item.name;
  const attrs = item.attributes || [];
  const { dimensionNames, optionsPerDimension } = getAttributeDimensionsAndOptions(itemName);
  const dims = dimensionNames.length > 0 ? dimensionNames : ['屬性'];
  const optsPerDim = dimensionNames.length > 0 ? optionsPerDimension : [attrs.length ? [attrs[0]] : []];
  const rows = dims.map((dimName, di) => {
    const options = optsPerDim[di] || [];
    const currentVal = attrs[di] || '';
    if (options.length > 0) {
      return `<label class="attr-modal-label">${escapeHtml(dimName)}</label>
        <select class="attr-modal-select" data-attr-index="${di}">
          <option value="">-- ${escapeHtml(dimName)} --</option>
          ${options.map(v => `<option value="${escapeHtml(v)}" ${currentVal === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
        </select>`;
    }
    return `<label class="attr-modal-label">${escapeHtml(dimName)}</label>
      <input type="text" class="attr-modal-input" data-attr-index="${di}" placeholder="${escapeHtml(dimName)}" value="${escapeHtml(currentVal)}">`;
  });
  return { itemName, rowsHtml: rows.join('') };
}

/** 手機版：產生「選擇屬性」彈窗 HTML（桌面用 portal） */
function renderOrderAttrModal(itemId) {
  const { itemName, rowsHtml } = getOrderAttrFormRowsHtml(itemId);
  if (!itemName && !rowsHtml) return '';
  const safeId = escapeHtml(itemId).replace(/'/g, '&#39;');
  return `<div class="dialog-overlay order-attr-modal-overlay" id="order-attr-modal" data-item-id="${safeId}" onclick="if(event.target===this) orderWeb.closeAttrModal()">
    <div class="dialog-content order-attr-modal-content" onclick="event.stopPropagation()">
      <div class="order-attr-modal-header">
        <span class="order-attr-modal-title">${escapeHtml(itemName)}</span>
        <button type="button" class="dialog-close order-attr-modal-close" onclick="orderWeb.closeAttrModal()" aria-label="關閉">×</button>
      </div>
      <div class="order-attr-modal-body">
        ${rowsHtml}
      </div>
      <div class="order-attr-modal-footer">
        <button type="button" class="btn-block btn-attr-modal-cancel" onclick="orderWeb.closeAttrModal()">取消</button>
        <button type="button" class="btn-block btn-attr-modal-confirm" onclick="orderWeb.confirmAttrModal()">確認</button>
      </div>
    </div>
  </div>`;
}

/** 手機版：整頁「選擇屬性」（避免禁止彈出視窗導致亂碼） */
function renderOrderAttrFullPage(container) {
  const itemId = state.attrModalItemId;
  if (!itemId) {
    state.currentStep = 'select_items';
    renderItemSelection(container);
    return;
  }
  const { itemName, rowsHtml } = getOrderAttrFormRowsHtml(itemId);
  if (!itemName && !rowsHtml) {
    state.currentStep = 'select_items';
    state.attrModalItemId = null;
    renderItemSelection(container);
    return;
  }
  container.innerHTML = `
    <div class="page-order">
      <div class="order-header">
        <span class="order-title">訂單頁面</span>
        ${orderHeaderLinks()}
      </div>
      <div class="step-header">
        <button type="button" class="btn-back" onclick="orderWeb.closeAttrModal()">← 返回</button>
        <div class="label-block">選擇屬性</div>
      </div>
      <div class="order-attr-fullpage">
        <div class="order-attr-fullpage-title">${escapeHtml(itemName)}</div>
        <div id="order-attr-form" class="order-attr-fullpage-body">
          ${rowsHtml}
        </div>
        <div class="order-attr-fullpage-footer">
          <button type="button" class="btn-block btn-attr-modal-cancel" onclick="orderWeb.closeAttrModal()">取消</button>
          <button type="button" class="btn-block btn-attr-modal-confirm" onclick="orderWeb.confirmAttrModal()">確認</button>
        </div>
      </div>
    </div>
    ${navBottom()}
  `;
}

/**
 * 渲染確認訂單
 */
function renderConfirmOrder(container) {
  const validItems = state.selectedItems.filter(item => item.qty > 0);
  
  if (validItems.length === 0) {
    state.currentStep = 'select_items';
    render();
    return;
  }
  
  const totalQty = validItems.reduce((sum, item) => sum + item.qty, 0);
  const purchaserName = state.purchaserName || '－';
  const hasAnyAttr = (state.menuItemAttributes && Object.keys(state.menuItemAttributes).length > 0) || (state.itemAttributeOptions && Object.keys(state.itemAttributeOptions).length > 0);
  
  container.innerHTML = `
    <div class="page-order">
      <div class="order-header">
        <span class="order-title">訂單頁面</span>
        ${orderHeaderLinks()}
      </div>
      <div class="order-top-row">
        <div class="label-block">訂購人</div>
        <div class="label-block" style="flex:1;">${escapeHtml(purchaserName)}</div>
      </div>
      <div class="step-header">
        <button type="button" class="btn-back" onclick="orderWeb.goBack()">← 返回</button>
        <div class="label-block">確認訂單</div>
      </div>
      <div class="order-rows ${hasAnyAttr ? 'order-rows-with-attr' : ''}">
        <div class="order-row order-rows-head">
          <div class="label-block">品項</div>
          ${hasAnyAttr ? '<div class="label-block">屬性</div>' : ''}
          <div class="label-block">數量</div>
        </div>
        ${validItems.map(item => {
          const validAttributes = item.attributes && Array.isArray(item.attributes)
            ? item.attributes.filter(attr => attr && typeof attr === 'string' && attr.trim() !== '')
            : [];
          const attrDisplay = validAttributes.length > 0 ? validAttributes.join(' ') : '－';
          return `
          <div class="order-row">
            <div class="label-block">${escapeHtml(item.name)}</div>
            ${hasAnyAttr ? `<div class="label-block">${escapeHtml(attrDisplay)}</div>` : ''}
            <div class="label-block">${item.qty}</div>
          </div>
        `;
        }).join('')}
        <div class="order-row">
          <div class="label-block">總數量</div>
          ${hasAnyAttr ? '<div class="label-block"></div>' : ''}
          <div class="label-block">${totalQty}</div>
        </div>
      </div>
      <div class="order-confirm-wrap">
        <button type="button" class="btn-block" onclick="orderWeb.submitOrder()" ${state.isLoading ? 'disabled' : ''}>${state.isLoading ? '送出中...' : '送出訂單'}</button>
      </div>
    </div>
    ${navBottom()}
  `;
}

/**
 * 渲染訂單完成頁
 */
function renderOrderComplete(container) {
  container.innerHTML = `
    <div class="page-order">
      <div class="order-header">
        <span class="order-title">訂單頁面</span>
        ${orderHeaderLinks()}
      </div>
      <div class="complete-icon">✅</div>
      <div class="label-block" style="margin-bottom:1rem;">訂單已送出</div>
      <p class="description">您的訂單已成功送出，將透過 LINE 通知您訂單狀態</p>
      <div class="order-confirm-wrap">
        <button type="button" class="btn-block" onclick="orderWeb.resetOrder()">繼續下單</button>
      </div>
    </div>
    ${navBottom()}
  `;
}

// ==================== 下單流程控制 ====================

function setPurchaserName(val) {
  state.purchaserName = (val || '').trim();
}

function setItemQty(itemIdOrName, qty) {
  const n = Math.max(0, Math.floor(Number(qty)) || 0);
  
  // 先嘗試用 ID 查找
  let idx = state.selectedItems.findIndex(item => item.id === itemIdOrName);
  
  // 如果找不到，嘗試用名稱查找（向後相容）
  if (idx < 0) {
    idx = state.selectedItems.findIndex(item => item.name === itemIdOrName);
  }
  
  if (n === 0) {
    if (idx >= 0) state.selectedItems.splice(idx, 1);
  } else {
    if (idx >= 0) {
      state.selectedItems[idx].qty = n;
      // 確保有 ID
      if (!state.selectedItems[idx].id) {
        state.selectedItems[idx].id = `item_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 9)}`;
      }
    } else {
      const newItem = { 
        id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: itemIdOrName, 
        qty: n, 
        attributes: [] 
      };
      state.selectedItems.push(newItem);
    }
  }
  
  // 局部更新：只更新對應的 input 和按鈕狀態，避免整頁閃爍
  updateQtyUI(itemIdOrName, n);
}

/**
 * 局部更新數量 UI（避免整頁重繪）
 */
function updateQtyUI(itemIdOrName, newQty) {
  // 更新該品項的所有數量 input
  const inputs = document.querySelectorAll('.order-qty-input');
  inputs.forEach(input => {
    const btnWrap = input.parentElement;
    if (!btnWrap) return;
    const minusBtn = btnWrap.querySelector('.btn-qty:first-child');
    if (!minusBtn) return;
    
    // 檢查 onclick 是否包含該 itemIdOrName
    const onclickAttr = minusBtn.getAttribute('onclick');
    if (onclickAttr && onclickAttr.includes(`'${itemIdOrName}'`)) {
      input.value = newQty;
      // 更新 - 按鈕狀態
      if (newQty === 0) {
        minusBtn.disabled = true;
      } else {
        minusBtn.disabled = false;
      }
    }
  });
  
  // 更新「確認訂單」按鈕狀態
  const confirmBtn = document.querySelector('.order-confirm-wrap .btn-block');
  if (confirmBtn) {
    const hasValidItems = state.selectedItems.filter(item => item.qty > 0).length > 0;
    confirmBtn.disabled = !hasValidItems;
  }
}

function setItemQtyFromInput(itemIdOrName, inputEl) {
  const v = parseInt(inputEl.value, 10);
  setItemQty(itemIdOrName, isNaN(v) ? 0 : v);
}

// selectBranch 函數已移除，不再需要選擇分店

/**
 * 調整品項數量（＋／－）
 */
function adjustItemQty(itemIdOrName, change) {
  // 先嘗試用 ID 查找
  let existingIndex = state.selectedItems.findIndex(item => item.id === itemIdOrName);
  
  // 如果找不到，嘗試用名稱查找（向後相容）
  if (existingIndex < 0) {
    existingIndex = state.selectedItems.findIndex(item => item.name === itemIdOrName);
  }
  
  const current = existingIndex >= 0 ? state.selectedItems[existingIndex].qty : 0;
  const newQty = Math.max(0, current + change);
  setItemQty(itemIdOrName, newQty);
}

/**
 * 返回上一步
 */
function goBack() {
  if (state.currentStep === 'select_attr') {
    state.currentStep = 'select_items';
    state.attrModalItemId = null;
    render();
  } else if (state.currentStep === 'select_items') {
    state.view = 'worlds';
    render();
  } else if (state.currentStep === 'confirm') {
    state.currentStep = 'select_items';
    render();
  }
}

/**
 * 前往確認頁（未填屬性時列出全部、只更新錯誤區塊不整頁重繪，避免閃爍與捲動到頂端）
 */
function goToConfirm() {
  const validItems = state.selectedItems.filter(item => item.qty > 0);
  if (validItems.length === 0) {
    state.errorMessage = '請至少選擇一個品項';
    updateOrderPageErrorOnly(state.errorMessage);
    return;
  }
  const missing = [];
  for (const item of validItems) {
    const { dimensionNames, optionsPerDimension } = getAttributeDimensionsAndOptions(item.name);
    const requiredCount = optionsPerDimension.filter(opts => opts && opts.length > 0).length;
    if (requiredCount === 0) continue;
    const attrs = item.attributes || [];
    const missingDims = [];
    for (let i = 0; i < requiredCount; i++) {
      const val = (attrs[i] != null ? String(attrs[i]) : '').trim();
      if (!val) missingDims.push(dimensionNames[i] || ('屬性' + (i + 1)));
    }
    if (missingDims.length > 0) missing.push({ name: item.name, dims: missingDims });
  }
  if (missing.length > 0) {
    const lines = missing.map(m => `• ${m.name}（${m.dims.join('、')}）`);
    state.errorMessage = '請先選擇屬性後再確認訂單：\n' + lines.join('\n');
    updateOrderPageErrorOnly(state.errorMessage);
    return;
  }
  state.errorMessage = null;
  state.currentStep = 'confirm';
  render();
}

/** 只更新訂單頁錯誤區塊，不整頁重繪（避免閃爍）；有錯誤時捲動到頂端 */
function updateOrderPageErrorOnly(message) {
  const el = document.getElementById('order-page-error');
  if (el) {
    el.innerHTML = message ? escapeHtml(message).replace(/\n/g, '<br>') : '';
    el.style.display = message ? 'block' : 'none';
    if (message) window.scrollTo(0, 0);
  } else {
    render();
  }
}

/**
 * 新增品項屬性
 */
function addItemAttribute(itemIdOrName) {
  // 先嘗試用 ID 查找
  let idx = state.selectedItems.findIndex(item => item.id === itemIdOrName);
  
  // 如果找不到，嘗試用名稱查找（向後相容）
  if (idx < 0) {
    idx = state.selectedItems.findIndex(item => item.name === itemIdOrName);
  }
  
  const itemName = idx >= 0 ? state.selectedItems[idx].name : itemIdOrName;
  
  // 取得該品項的屬性選項：優先從 menuItemAttributes（Excel 匯入），其次 orderFormat
  let availableAttributes = [];
  const menuItemName = (state.baseItemToMenuMap && state.baseItemToMenuMap[itemName]) || itemName;
  if (state.menuItemAttributes && state.menuItemAttributes[menuItemName]) {
    availableAttributes = state.menuItemAttributes[menuItemName];
  } else if (state.orderFormat && state.orderFormat.items && Array.isArray(state.orderFormat.items)) {
    const formatItem = state.orderFormat.items.find(item => item.name === itemName);
    if (formatItem && formatItem.attributes && Array.isArray(formatItem.attributes)) {
      availableAttributes = formatItem.attributes.map(a => (typeof a === 'object' && a && a.name) ? a.name : a);
    }
  } else if (state.menu) {
    // 如果沒有 orderFormat，從菜單中提取該基礎名稱的所有屬性組合
    const attributeSet = new Set();
    for (const vendor of Object.keys(state.menu)) {
      for (const menuItemName of Object.keys(state.menu[vendor])) {
        // 檢查是否以基礎名稱開頭
        if (menuItemName === itemName || menuItemName.startsWith(itemName + ' ')) {
          // 提取屬性部分（基礎名稱後面的部分）
          if (menuItemName.startsWith(itemName + ' ')) {
            const attributesPart = menuItemName.substring(itemName.length + 1);
            // 將屬性部分分割成多個屬性
            const attrs = attributesPart.split(/\s+/).filter(Boolean);
            attrs.forEach(attr => attributeSet.add(attr));
          }
        }
      }
    }
    availableAttributes = Array.from(attributeSet);
  }
  
  // 取得已選擇的屬性
  const selectedAttributes = idx >= 0 && state.selectedItems[idx].attributes 
    ? state.selectedItems[idx].attributes 
    : [];
  
  // 過濾掉已選擇的屬性
  const remainingAttributes = availableAttributes.filter(attr => 
    !selectedAttributes.includes(attr)
  );
  
  let attr = null;
  
  if (remainingAttributes.length > 0) {
    // 如果有可用的屬性選項，顯示選擇對話框
    const attrList = remainingAttributes.map((a, i) => `${i + 1}. ${a}`).join('\n');
    const input = prompt(`請選擇屬性（輸入數字）或輸入自訂屬性：\n${attrList}\n\n或直接輸入屬性名稱：`, '');
    if (input === null) return; // 用戶取消
    
    const trimmed = input.trim();
    if (!trimmed) return;
    
    // 檢查是否為數字選擇
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= remainingAttributes.length) {
      attr = remainingAttributes[num - 1];
    } else {
      // 直接輸入的屬性名稱
      attr = trimmed;
    }
  } else {
    // 沒有預設屬性選項，或所有屬性都已選擇，允許手動輸入
    attr = prompt('請輸入屬性名稱（例如：微冰、微糖）：', '');
    if (attr !== null) {
      attr = attr.trim();
    }
  }
  
  if (attr && attr.trim()) {
    const finalAttr = attr.trim();
    if (idx >= 0) {
      if (!state.selectedItems[idx].attributes) {
        state.selectedItems[idx].attributes = [];
      }
      // 避免重複
      if (!state.selectedItems[idx].attributes.includes(finalAttr)) {
        state.selectedItems[idx].attributes.push(finalAttr);
      }
      // 確保有 ID
      if (!state.selectedItems[idx].id) {
        state.selectedItems[idx].id = `item_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 9)}`;
      }
    } else {
      const newItem = { 
        id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: itemName, 
        qty: 0, 
        attributes: [finalAttr] 
      };
      state.selectedItems.push(newItem);
    }
    render();
  }
}

const ORDER_ATTR_MODAL_ROOT_ID = 'order-attr-modal-root';

function getOrderAttrModalRoot() {
  let root = document.getElementById(ORDER_ATTR_MODAL_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ORDER_ATTR_MODAL_ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
}

/** 手機版：開啟屬性（手機用整頁、桌面用 portal） */
function openAttrModal(itemId) {
  state.errorMessage = null;
  updateOrderPageErrorOnly(null);
  state.attrModalItemId = itemId;
  if (isMobileView()) {
    state.currentStep = 'select_attr';
    render();
    return;
  }
  const root = getOrderAttrModalRoot();
  root.innerHTML = renderOrderAttrModal(itemId);
}

/** 手機版：關閉屬性（整頁返回列表 or 關閉 portal） */
function closeAttrModal() {
  if (state.currentStep === 'select_attr') {
    state.currentStep = 'select_items';
    state.attrModalItemId = null;
    render();
    return;
  }
  state.attrModalItemId = null;
  const root = document.getElementById(ORDER_ATTR_MODAL_ROOT_ID);
  if (root) root.innerHTML = '';
}

/** 手機版：確認屬性並寫回品項（表單可能在 portal #order-attr-modal 或整頁 #order-attr-form） */
function confirmAttrModal() {
  const itemId = state.attrModalItemId;
  if (!itemId) return;
  const idx = state.selectedItems.findIndex(item => item.id === itemId);
  if (idx < 0) return;
  const container = document.getElementById('order-attr-modal') || document.getElementById('order-attr-form');
  if (!container) return;
  const selects = container.querySelectorAll('.attr-modal-select');
  const inputs = container.querySelectorAll('.attr-modal-input');
  const maxIndex = Math.max(
    ...Array.from(selects).map(el => parseInt(el.getAttribute('data-attr-index'), 10)),
    ...Array.from(inputs).map(el => parseInt(el.getAttribute('data-attr-index'), 10)),
    -1
  );
  const attributes = [];
  for (let i = 0; i <= maxIndex; i++) {
    const sel = container.querySelector(`.attr-modal-select[data-attr-index="${i}"]`);
    const inp = container.querySelector(`.attr-modal-input[data-attr-index="${i}"]`);
    if (sel) attributes.push((sel.value || '').trim());
    else if (inp) attributes.push((inp.value || '').trim());
    else attributes.push('');
  }
  state.selectedItems[idx].attributes = attributes;
  state.attrModalItemId = null;
  state.currentStep = 'select_items';
  const root = document.getElementById(ORDER_ATTR_MODAL_ROOT_ID);
  if (root) root.innerHTML = '';
  render();
}

/**
 * 從下拉選單設定品項屬性（用於訂購品項的屬性 <select>）
 */
function setItemAttributeFromSelect(selectEl) {
  const itemId = selectEl.getAttribute('data-item-id');
  const attrIndex = parseInt(selectEl.getAttribute('data-attr-index'), 10);
  const attrValue = (selectEl.value || '').trim();
  if (itemId == null || isNaN(attrIndex) || attrIndex < 0) return;
  let idx = state.selectedItems.findIndex(item => item.id === itemId);
  if (idx < 0) idx = state.selectedItems.findIndex(item => item.name === itemId);
  const orderFormat = state.orderFormat;
  const formatAttributes = orderFormat && orderFormat.items && orderFormat.items.length > 0
    ? (orderFormat.items[0].attributes || [])
    : [];
  if (idx >= 0) {
    if (!state.selectedItems[idx].attributes) state.selectedItems[idx].attributes = [];
    while (state.selectedItems[idx].attributes.length <= attrIndex) {
      state.selectedItems[idx].attributes.push('');
    }
    state.selectedItems[idx].attributes[attrIndex] = attrValue;
    if (!state.selectedItems[idx].id) {
      state.selectedItems[idx].id = `item_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 9)}`;
    }
  } else {
    let itemName = itemId;
    const existingItem = state.selectedItems.find(item => item.id === itemId);
    if (existingItem) itemName = existingItem.name;
    const attributes = new Array(Math.max(formatAttributes.length, attrIndex + 1)).fill('');
    attributes[attrIndex] = attrValue;
    state.selectedItems.push({
      id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: itemName,
      qty: 0,
      attributes
    });
  }
  render();
}

/**
 * 切換品項屬性（用於格式設定中的屬性按鈕）
 */
/**
 * 設定品項屬性的值（用於輸入框）
 */
function setItemAttributeValue(itemId, attrName, attrValue) {
  // 先嘗試用 ID 查找
  let idx = state.selectedItems.findIndex(item => item.id === itemId);
  
  // 如果找不到，嘗試用 itemName 查找（向後相容）
  if (idx < 0) {
    // itemId 可能是 itemName（舊的調用方式）
    idx = state.selectedItems.findIndex(item => item.name === itemId);
  }
  
  const trimmedValue = (attrValue || '').trim();
  
  // 取得 orderFormat 中的屬性順序
  const orderFormat = state.orderFormat;
  const formatAttributes = orderFormat && orderFormat.items && orderFormat.items.length > 0
    ? (orderFormat.items[0].attributes || [])
    : [];
  
  // 找出該屬性在 formatAttributes 中的索引
  const attrIndex = formatAttributes.indexOf(attrName);
  
  if (idx >= 0) {
    if (!state.selectedItems[idx].attributes) {
      state.selectedItems[idx].attributes = [];
    }
    
    // 確保 attributes 陣列有足夠的長度
    while (state.selectedItems[idx].attributes.length <= attrIndex) {
      state.selectedItems[idx].attributes.push('');
    }
    
    // 設定對應索引的值
    state.selectedItems[idx].attributes[attrIndex] = trimmedValue;
    
    // 確保有 ID
    if (!state.selectedItems[idx].id) {
      state.selectedItems[idx].id = `item_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 9)}`;
    }
  } else {
    // 品項不存在，新增品項並設定屬性
    // 如果 itemId 是 ID 格式，嘗試從現有項目中取得名稱
    let itemName = itemId;
    const existingItem = state.selectedItems.find(item => item.id === itemId);
    if (existingItem) {
      itemName = existingItem.name;
    } else {
      // 如果 itemId 看起來像 ID，嘗試用名稱查找
      const nameMatch = state.selectedItems.find(item => item.name === itemId);
      if (nameMatch) {
        itemName = nameMatch.name;
      }
    }
    
    const attributes = new Array(formatAttributes.length).fill('');
    if (attrIndex >= 0) {
      attributes[attrIndex] = trimmedValue;
    }
    const newItem = { 
      id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: itemName,
      qty: 0, 
      attributes: attributes 
    };
    state.selectedItems.push(newItem);
  }
  render();
}

/**
 * 複製項目並創建新的變體（相同商品但不同屬性）
 */
function duplicateItemWithAttributes(itemId, itemName) {
  // 找到原始項目
  let originalItem = state.selectedItems.find(item => item.id === itemId);
  
  // 如果找不到，嘗試用 itemName 查找
  if (!originalItem) {
    originalItem = state.selectedItems.find(item => item.name === itemName);
  }
  
  if (originalItem) {
    // 複製項目，但清空屬性（讓用戶可以設置新的屬性）
    const orderFormat = state.orderFormat;
    const formatAttributes = orderFormat && orderFormat.items && orderFormat.items.length > 0
      ? (orderFormat.items[0].attributes || [])
      : [];
    
    const newAttributes = new Array(formatAttributes.length).fill('');
    
    const newItem = {
      id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: originalItem.name,
      qty: 0,
      attributes: newAttributes
    };
    
    state.selectedItems.push(newItem);
    render();
  } else {
    // 如果找不到原始項目，創建一個新的
    const orderFormat = state.orderFormat;
    const formatAttributes = orderFormat && orderFormat.items && orderFormat.items.length > 0
      ? (orderFormat.items[0].attributes || [])
      : [];
    
    const newAttributes = new Array(formatAttributes.length).fill('');
    
    const newItem = {
      id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: itemName,
      qty: 0,
      attributes: newAttributes
    };
    
    state.selectedItems.push(newItem);
    render();
  }
}

function toggleItemAttribute(itemName, attrName) {
  const idx = state.selectedItems.findIndex(item => item.name === itemName);
  const selectedAttributes = idx >= 0 && state.selectedItems[idx].attributes 
    ? state.selectedItems[idx].attributes 
    : [];
  
  const attrIndex = selectedAttributes.indexOf(attrName);
  
  if (idx >= 0) {
    if (!state.selectedItems[idx].attributes) {
      state.selectedItems[idx].attributes = [];
    }
    if (attrIndex >= 0) {
      // 已選擇，移除
      state.selectedItems[idx].attributes.splice(attrIndex, 1);
    } else {
      // 未選擇，新增
      state.selectedItems[idx].attributes.push(attrName);
    }
  } else {
    // 品項不存在，新增品項並設定屬性
    state.selectedItems.push({ name: itemName, qty: 0, attributes: [attrName] });
  }
  render();
}

/**
 * 移除品項屬性
 */
function removeItemAttribute(itemName, attrIndex) {
  const idx = state.selectedItems.findIndex(item => item.name === itemName);
  if (idx >= 0 && state.selectedItems[idx].attributes) {
    state.selectedItems[idx].attributes.splice(attrIndex, 1);
    render();
  }
}

/**
 * 根據 ID 移除品項屬性
 */
function removeItemAttributeById(itemId, attrIndex) {
  const idx = state.selectedItems.findIndex(item => item.id === itemId);
  if (idx >= 0 && state.selectedItems[idx].attributes) {
    if (Array.isArray(state.selectedItems[idx].attributes)) {
      state.selectedItems[idx].attributes.splice(attrIndex, 1);
    }
    render();
  }
}

/**
 * 送出訂單
 */
async function submitOrder() {
  if (state.isLoading) return;
  
  const validItems = state.selectedItems.filter(item => item.qty > 0);
  if (validItems.length === 0) {
    showError('請至少選擇一個品項');
    return;
  }
  
  if (!state.userId) {
    showError('使用者未登入');
    return;
  }
  
  if (!state.vendorItemMap || Object.keys(state.vendorItemMap).length === 0) {
    showError('無法判斷品項廠商，請重新載入頁面');
    return;
  }
  
  try {
    setLoading(true);
    const userName = (state.purchaserName || state.lineProfile?.displayName || '').trim() || null;
    
    // 將屬性合併到品項名稱中，並根據原始品項名稱（不含屬性）判斷廠商
    const itemsToSubmit = validItems.map(item => {
      // 先嘗試從 formatItemToMenuMap 或 baseItemToMenuMap 取得菜單中的實際品項名稱
      let menuItemName = item.name;
      if (state.formatItemToMenuMap && state.formatItemToMenuMap[item.name]) {
        menuItemName = state.formatItemToMenuMap[item.name];
      } else if (state.baseItemToMenuMap && state.baseItemToMenuMap[item.name]) {
        menuItemName = state.baseItemToMenuMap[item.name];
      }
      
      // 將屬性合併到品項名稱中
      // item.attributes 現在是按照 formatAttributes 順序的陣列
      let fullName;
      if (item.attributes && Array.isArray(item.attributes) && item.attributes.length > 0) {
        // 過濾掉空值，只保留有值的屬性
        const validAttributes = item.attributes.filter(attr => attr && typeof attr === 'string' && attr.trim() !== '');
        if (validAttributes.length > 0) {
          const attributesStr = validAttributes.join(' ');
          // 提取基礎名稱
          let baseName = menuItemName;
          const spaceIndex = menuItemName.indexOf(' ');
          if (spaceIndex > 0) {
            baseName = menuItemName.substring(0, spaceIndex);
          }
          fullName = `${baseName} ${attributesStr}`;
        } else {
          fullName = menuItemName;
        }
      } else {
        // 沒有屬性，使用菜單中的完整名稱（如果有的話）
        fullName = menuItemName;
      }
      
      // 根據菜單中的實際品項名稱判斷廠商
      // 先嘗試用完整名稱查找，如果找不到則用基礎名稱
      let vendor = state.vendorItemMap[fullName];
      if (!vendor && state.menu) {
        // 如果完整名稱找不到，嘗試在菜單中查找匹配的品項
        for (const v of Object.keys(state.menu)) {
          if (state.menu[v][fullName] !== undefined) {
            vendor = v;
            break;
          }
        }
      }
      // 如果還是找不到，使用基礎名稱或第一個廠商
      if (!vendor) {
        vendor = state.vendorItemMap[item.name] || state.vendorItemMap[menuItemName] || Object.keys(state.menu || {})[0] || '未分類';
      }
      
      return {
        name: fullName,
        qty: item.qty,
        vendor: vendor
      };
    });
    
    // 單一訂單提交（不再依廠商拆成多張）
    const orderItems = itemsToSubmit.map(item => ({
      name: item.name,
      qty: item.qty
    }));

    const result = await createOrder(
      state.userId,
      orderItems,
      userName
    );
    if (!result || result.error) {
      throw new Error(result?.message || '建立訂單失敗');
    }
    
    state.currentStep = 'complete';
    setLoading(false);
    render();
  } catch (error) {
    setLoading(false);
    showError(error.message || '送出訂單失敗，請稍後再試');
    render();
  }
}

/**
 * 重置訂單（繼續下單）
 */
function resetOrder() {
  state.selectedItems = [];
  state.currentStep = 'select_items';
  state.errorMessage = null;
  render();
}

// ==================== 工具函數 ====================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** 用於 onclick 屬性內的 JS 字串，跳脫單引號 */
function escapeJsAttr(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * 設定載入狀態
 */
function setLoading(loading) {
  state.isLoading = loading;
}

/**
 * 顯示錯誤訊息
 */
function showError(message) {
  state.errorMessage = message;
  // 不依賴 alert，改為頁面顯示錯誤，避免「禁止彈出視窗」時完全無提示
}

// ==================== 初始化 ====================

/**
 * 初始化應用程式
 */
function init() {
  // 初始化 LINE Login
  initLineLogin();
  
  // 監聽視窗大小變化（RWD）
  window.addEventListener('resize', () => {
    // 可以加入響應式處理
  });
  
  // 監聽頁面離開事件（創建世界流程中）
  window.addEventListener('beforeunload', (e) => {
    const isCreatingWorld = state.view === 'create_world';
    if (isCreatingWorld) {
      e.preventDefault();
      e.returnValue = '創建世界中離開頁面將重新設定';
      return e.returnValue;
    }
  });
}

// ==================== 公開 API ====================

// 將主要函數暴露到全域，供 HTML 呼叫
function goHelp() {
  const isCreatingWorld = ['create_world', 'setup_order_format', 'setup_boss_format'].includes(state.view);
  if (isCreatingWorld) {
    if (!confirm('創建世界中離開頁面將重新設定，確定要離開嗎？')) {
      return;
    }
  }
  state.view = 'help';
  render();
}

/**
 * 檢查是否在創建世界流程中，如果是則詢問確認
 */
function checkCreatingWorldBeforeLeave() {
  const isCreatingWorld = state.view === 'create_world';
  if (isCreatingWorld) {
    return confirm('創建世界中離開頁面將重新設定，確定要離開嗎？');
  }
  return true;
}

async function goWorlds() {
  if (state.userStatus !== 'logged_in_with_official') return;
  // 重新載入世界列表
  if (state.userId) {
    await fetchWorlds(state.userId);
  }
  state.view = 'worlds';
  render();
}

/**
 * 前往世界頁面（帶確認）
 */
async function goWorldsWithConfirm() {
  if (!checkCreatingWorldBeforeLeave()) {
    return;
  }
  await goWorlds();
}

/**
 * 前往我的頁面（帶確認）
 */
function goMeWithConfirm() {
  if (!checkCreatingWorldBeforeLeave()) {
    return;
  }
  goMe();
}

async function goMe() {
  state.view = 'my_orders';
  state.myOrdersDate = '今天';
  state.myOrdersWorldFilter = 'all';
  state.myOrdersTab = 'my_orders';
  state.myOrders = null;
  
  // 確保世界列表已載入（用於世界篩選下拉選單）
  if (!state.worlds || state.worlds.length === 0) {
    await fetchWorlds(state.userId);
  }
  
  render();
  fetchMyOrders();
}

function goMenu() {
  // 檢查是否為 owner
  const currentWorld = state.worlds && state.worlds.find(w => w.id === state.currentWorldId);
  const isOwner = currentWorld && currentWorld.role === 'owner';
  
  if (isOwner) {
    // Owner 進入菜單管理頁面
    state.view = 'menu_manage';
    state.excelUploadFile = null;
    state.excelPreview = null;
    state.excelDetectedMapping = null;
    state.excelNeedsMapping = false;
    state.menuImageViewOpen = false;
    render();
  } else {
    // 非 owner 顯示菜單（全螢幕顯示）
    if (state.menuImageUrl) {
      // 顯示全螢幕圖片
      state.menuImageViewOpen = true;
      render();
    } else if (state.formatted) {
      // 顯示文字格式菜單（也改成頁面內顯示）
      state.menuImageViewOpen = true;
      render();
    } else {
      alert('尚無菜單，請聯絡管理員');
    }
  }
}

/**
 * 關閉全螢幕菜單顯示
 */
function closeMenuImageView() {
  state.menuImageViewOpen = false;
  render();
}

function goMembers() {
  state.view = 'members';
  state.members = null;
  render();
  fetchMembers();
}

/**
 * 渲染我的訂單頁面
 */
function renderMyOrdersPage(container) {
  if (state.orderDetailOrderId != null) {
    container.innerHTML = `
    <div class="page-order">
      ${renderOrderDetailView()}
    </div>
    ${navBottom()}
    `;
    return;
  }

  const orders = state.myOrders || [];
  const dateStr = state.myOrdersDate || '今天';
  const currentTab = state.myOrdersTab || 'my_orders';
  const receivedViewMode = state.myOrdersReceivedViewMode || 'cards';
  
  // 依 tab 決定排序方式：
  // - 我收到的訂單（卡片模式）：優先以訂購人排序，其次依時間新→舊
  // - 其他情況維持後端排序
  let displayOrders = orders;
  if (currentTab === 'received_orders' && receivedViewMode === 'cards' && orders.length > 0) {
    displayOrders = [...orders].sort((a, b) => {
      const ua = (a.user || '');
      const ub = (b.user || '');
      if (ua !== ub) {
        return ua.localeCompare(ub, 'zh-Hant');
      }
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  }
  
  // 判斷是否為 owner（任一世界為 owner 即顯示「我收到的訂單」tab）
  const isOwner = (state.worlds || []).some(w => w.role === 'owner');
  
  // 判斷是否為日期格式（YYYY-MM-DD）
  const isDateFormat = /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
  const selectedDate = isDateFormat ? dateStr : '';
  
  container.innerHTML = `
    <div class="page-order">
      <div class="order-header">
        <span class="order-title">我的訂單</span>
        <div class="order-header-actions">
          <select class="world-select" id="my-orders-world-filter" onchange="orderWeb.setMyOrdersWorld(this.value)">
            <option value="all" ${state.myOrdersWorldFilter === 'all' ? 'selected' : ''}>所有世界</option>
            ${(currentTab === 'received_orders'
              ? (state.worlds || []).filter(w => w.role === 'owner')
              : (state.worlds || [])
            ).map(w => `
              <option value="${w.id}" ${state.myOrdersWorldFilter === String(w.id) ? 'selected' : ''}>${escapeHtml(w.name || `世界 #${String(w.id).padStart(6, '0')}`)}</option>
            `).join('')}
          </select>
          <select class="date-select" id="my-orders-date-type" onchange="orderWeb.handleDateTypeChange(this.value)">
            <option value="今天" ${!isDateFormat && dateStr === '今天' ? 'selected' : ''}>今天</option>
            <option value="全部" ${!isDateFormat && dateStr === '全部' ? 'selected' : ''}>全部</option>
            <option value="選擇日期" ${isDateFormat ? 'selected' : ''}>選擇日期</option>
          </select>
          ${isDateFormat ? `
            <input type="date" class="date-picker-input" id="my-orders-date-picker" value="${selectedDate}" onchange="orderWeb.setMyOrdersDate(this.value)">
          ` : ''}
        </div>
      </div>
      ${isOwner ? `
        <div class="my-orders-tabs">
          <button type="button" 
                  class="tab-button ${currentTab === 'my_orders' ? 'tab-active' : ''}"
                  onclick="orderWeb.switchMyOrdersTab('my_orders')">
            我下訂的訂單
          </button>
          <button type="button" 
                  class="tab-button ${currentTab === 'received_orders' ? 'tab-active' : ''}"
                  onclick="orderWeb.switchMyOrdersTab('received_orders')">
            我收到的訂單
          </button>
        </div>
        ${currentTab === 'received_orders' ? `
          <div class="excel-export-buttons">
            <button type="button" class="btn-excel-setup" onclick="orderWeb.openExcelExportColumnsDialog()">
              設定欄位
            </button>
            <button type="button" class="btn-excel-export" onclick="orderWeb.exportReceivedOrdersToExcel()" ${state.isLoading ? 'disabled' : ''}>
              ${state.isLoading ? '匯出中...' : '匯出 Excel'}
            </button>
          </div>
          <div class="view-mode-buttons">
            <button type="button" class="view-mode-btn ${receivedViewMode === 'cards' ? 'view-mode-active' : ''}" onclick="orderWeb.setReceivedViewMode('cards')">
              卡片檢視
            </button>
            <button type="button" class="view-mode-btn ${receivedViewMode === 'table' ? 'view-mode-active' : ''}" onclick="orderWeb.setReceivedViewMode('table')">
              欄位檢視
            </button>
          </div>
        ` : ''}
      ` : ''}
      <div class="order-content">
        ${state.isLoading ? '<div class="loading">載入中...</div>' : ''}
        ${state.errorMessage ? `<div class="error-message">${escapeHtml(state.errorMessage)}</div>` : ''}
        ${!state.isLoading && !state.errorMessage && currentTab === 'received_orders' && receivedViewMode === 'table'
          ? renderReceivedOrdersTable()
          : ''}
        ${!state.isLoading && !state.errorMessage && (currentTab !== 'received_orders' || receivedViewMode === 'cards') ? `
          ${displayOrders.length === 0 ? '<div class="empty-message">尚無訂單</div>' : `
            <div class="orders-list">
              ${displayOrders.map(order => `
                <div class="order-card">
                  <div class="order-card-header">
                    <span class="order-id">訂單 #${order.orderId}</span>
                    <span class="order-date">${formatDateTime(order.createdAt)}</span>
                  </div>
                  ${order.worldName ? `
                    <div class="order-card-world">🌍 ${escapeHtml(order.worldName)}${order.worldCode ? ` (${escapeHtml(order.worldCode)})` : ''}</div>
                  ` : ''}
                  ${currentTab === 'received_orders' && order.user ? `
                    <div class="order-card-user">下單者：${escapeHtml(order.user)}</div>
                  ` : ''}
                  <div class="order-card-items">
                    ${(order.items || []).map(item => {
                      const itemName = item.name || item.item || '';
                      const itemQty = item.qty || 0;
                      return `
                      <div class="order-item-row">
                        <span class="item-name">${escapeHtml(itemName)}</span>
                        <span class="item-qty">x${itemQty}</span>
                      </div>
                    `;
                    }).join('')}
                  </div>
                  <div class="order-card-actions">
                    <button type="button" class="btn-order-edit" onclick="orderWeb.openOrderDetailByOrderId(${order.orderId})">${currentTab === 'received_orders' ? '查看' : '查看／編輯'}</button>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        ` : ''}
      </div>
      ${state.excelExportColumnsDialogOpen && currentTab === 'received_orders' && isOwner ? renderExcelExportColumnsDialog() : ''}
    </div>
    ${navBottom()}
  `;
}

/**
 * 渲染全螢幕菜單圖片/文字顯示
 */
function renderMenuImageView() {
  if (state.menuImageUrl) {
    // 顯示圖片
    return `
      <div id="menu-image-overlay" 
           onclick="orderWeb.closeMenuImageView()" 
           style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.9); z-index: 10000; display: flex; align-items: center; justify-content: center; padding: var(--spacing-lg); cursor: pointer;">
        <div onclick="event.stopPropagation()" style="position: relative; max-width: 100%; max-height: 100%; display: flex; align-items: center; justify-content: center;">
          <img src="${escapeHtml(state.menuImageUrl)}" 
               alt="菜單" 
               style="max-width: 100%; max-height: 100vh; object-fit: contain; border-radius: 8px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);">
          <button type="button" 
                  onclick="orderWeb.closeMenuImageView()" 
                  style="position: absolute; top: -40px; right: 0; background: rgba(255, 255, 255, 0.9); border: none; border-radius: 50%; width: 36px; height: 36px; font-size: 24px; line-height: 1; cursor: pointer; color: #333; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);"
                  onmouseover="this.style.background='white'"
                  onmouseout="this.style.background='rgba(255, 255, 255, 0.9)'">&times;</button>
        </div>
      </div>
    `;
  } else if (state.formatted) {
    // 顯示文字格式
    return `
      <div id="menu-image-overlay" 
           onclick="orderWeb.closeMenuImageView()" 
           style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.85); z-index: 10000; display: flex; align-items: center; justify-content: center; padding: var(--spacing-lg); cursor: pointer;">
        <div onclick="event.stopPropagation()" 
             style="position: relative; max-width: 90%; max-height: 90vh; background: white; border-radius: 12px; padding: var(--spacing-lg); overflow-y: auto; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);">
          <button type="button" 
                  onclick="orderWeb.closeMenuImageView()" 
                  style="position: absolute; top: 12px; right: 12px; background: rgba(0, 0, 0, 0.1); border: none; border-radius: 50%; width: 32px; height: 32px; font-size: 20px; line-height: 1; cursor: pointer; color: #333; display: flex; align-items: center; justify-content: center;"
                  onmouseover="this.style.background='rgba(0, 0, 0, 0.2)'"
                  onmouseout="this.style.background='rgba(0, 0, 0, 0.1)'">&times;</button>
          <pre style="margin: 0; padding: var(--spacing-md) 0; font-family: 'Courier New', monospace; font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; color: #333;">${escapeHtml(state.formatted)}</pre>
        </div>
      </div>
    `;
  }
  return '';
}

/**
 * 渲染 Excel 匯出欄位設定對話框
 */
function renderExcelExportColumnsDialog() {
  // 取得或初始化欄位設定
  const defaultColumns = [
    { key: 'user', label: '訂購人', enabled: true },
    { key: 'vendor', label: '廠商', enabled: true },
    { key: 'itemName', label: '品項名稱', enabled: true },
    { key: 'qty', label: '數量', enabled: true },
    { key: 'orderId', label: '訂單ID', enabled: true },
    { key: 'createdAt', label: '建立時間', enabled: true },
    { key: 'userId', label: '訂購人ID', enabled: false }
  ];
  
  const columns = state.excelExportColumns || defaultColumns;
  
  return `
    <div class="dialog-overlay" onclick="if(event.target===this)orderWeb.closeExcelExportColumnsDialog()">
      <div class="dialog-content excel-export-dialog">
        <div class="dialog-header">
          <div class="label-block">設定 Excel 匯出欄位</div>
          <button type="button" class="dialog-close" onclick="orderWeb.closeExcelExportColumnsDialog()">&times;</button>
        </div>
        <p class="dialog-hint">拖曳調整順序，勾選顯示欄位，點擊欄位名稱可自訂</p>
        <div id="excel-export-columns-list" class="excel-columns-list">
          ${columns.map((col, idx) => {
            const isEditing = state.excelExportColumnEditing === col.key;
            return `
            <div class="excel-column-item" draggable="true" data-index="${idx}">
              <span class="excel-column-drag">≡</span>
              <input type="checkbox" 
                     id="col-${col.key}" 
                     ${col.enabled !== false ? 'checked' : ''} 
                     onchange="orderWeb.toggleExcelColumn('${col.key}')"
                     style="margin-right: var(--spacing-sm); cursor: pointer;">
              ${isEditing ? `
                <input type="text" class="excel-column-input" id="col-label-${col.key}"
                       value="${escapeHtml(col.label)}"
                       onblur="orderWeb.saveExcelColumnLabel('${col.key}')"
                       onkeydown="if(event.key==='Enter'){orderWeb.saveExcelColumnLabel('${col.key}')}"
                       autofocus>
              ` : `
                <label for="col-${col.key}" class="excel-column-label"
                       onclick="event.stopPropagation(); orderWeb.startEditExcelColumnLabel('${col.key}')"
                       title="點擊編輯欄位名稱">${escapeHtml(col.label)}</label>
              `}
            </div>
          `;
          }).join('')}
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn-block btn-dialog-cancel" onclick="orderWeb.closeExcelExportColumnsDialog()">取消</button>
          <button type="button" class="btn-block btn-dialog-save" onclick="orderWeb.saveExcelExportColumns()">儲存設定</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * 查詢我的訂單
 */
async function fetchMyOrders() {
  if (!state.userId) {
    state.errorMessage = '使用者未登入';
    render();
    return;
  }
  
  setLoading(true);
  state.errorMessage = null;
  
  try {
    // 處理日期參數：全部 -> 空字串，今天 -> '今天'，日期格式 -> YYYY-MM-DD
    let dateParam = state.myOrdersDate;
    if (dateParam === '全部') {
      dateParam = '';
    } else if (dateParam === '今天' || dateParam === '今日') {
      dateParam = '今天';
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      // 已經是 YYYY-MM-DD 格式，直接使用
      dateParam = dateParam;
    } else {
      // 其他情況，預設為今天
      dateParam = '今天';
    }
    
    // 處理世界篩選參數：'all' -> 不傳，否則傳 worldId
    let url = `${API_BASE}/orders/my?userId=${encodeURIComponent(state.userId)}&date=${encodeURIComponent(dateParam)}`;
    if (state.myOrdersWorldFilter && state.myOrdersWorldFilter !== 'all') {
      url += `&worldId=${encodeURIComponent(state.myOrdersWorldFilter)}`;
    }
    
    const response = await fetch(url);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: '查詢訂單失敗' }));
      throw new Error(errorData.error || '查詢訂單失敗');
    }
    
    const data = await response.json();
    state.myOrders = data.orders || [];
  } catch (error) {
    state.errorMessage = error.message || '查詢訂單時發生錯誤，請稍後再試';
    state.myOrders = [];
  } finally {
    setLoading(false);
    render();
  }
}

/**
 * 處理日期類型變更（今天/全部/選擇日期）
 */
function handleDateTypeChange(type) {
  if (type === '選擇日期') {
    // 切換到日期選擇器模式，預設為今天
    const today = new Date().toISOString().split('T')[0];
    state.myOrdersDate = today;
    render();
    // 等待 DOM 更新後自動觸發日期選擇器的 change 事件並查詢
    setTimeout(() => {
      const datePicker = document.getElementById('my-orders-date-picker');
      if (datePicker) {
        datePicker.focus();
        // 自動觸發查詢
        if (state.myOrdersTab === 'received_orders') {
          fetchReceivedOrders();
        } else {
          fetchMyOrders();
        }
      }
    }, 100);
  } else {
    // 今天或全部
    state.myOrdersDate = type;
    
    // 根據當前 tab 決定查詢哪個 API
    if (state.myOrdersTab === 'received_orders') {
      fetchReceivedOrders();
    } else {
      fetchMyOrders();
    }
  }
}

/**
 * 切換我的訂單 tab
 */
function switchMyOrdersTab(tab) {
  state.myOrdersTab = tab;
  state.myOrders = null;
  state.errorMessage = null;
  state.excelExportColumnsDialogOpen = false;
  
  // 切換到「我收到的訂單」時，若當前世界篩選不是 owner 世界則改為「所有世界」
  if (tab === 'received_orders') {
    const ownerWorlds = (state.worlds || []).filter(w => w.role === 'owner');
    if (state.myOrdersWorldFilter && state.myOrdersWorldFilter !== 'all') {
      const wid = parseInt(state.myOrdersWorldFilter, 10);
      if (!ownerWorlds.some(w => w.id === wid)) {
        state.myOrdersWorldFilter = 'all';
      }
    }
    const savedColumns = loadExcelExportColumns();
    if (savedColumns) state.excelExportColumns = savedColumns;
  }
  
  render();
  
  if (tab === 'my_orders') {
    fetchMyOrders();
  } else if (tab === 'received_orders') {
    fetchReceivedOrders();
  }
}

/**
 * 載入 Excel 匯出欄位設定（從 localStorage）
 * 我收到的訂單用 'received'，其他用 currentWorldId
 */
function loadExcelExportColumns() {
  const key = state.myOrdersTab === 'received_orders' ? 'received' : state.currentWorldId;
  if (!key) return null;
  try {
    const saved = localStorage.getItem(`excelExportColumns_${key}`);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error('載入 Excel 匯出欄位設定失敗:', e);
  }
  return null;
}

/**
 * 儲存 Excel 匯出欄位設定（到 localStorage）
 */
function saveExcelExportColumns() {
  const key = state.myOrdersTab === 'received_orders' ? 'received' : state.currentWorldId;
  if (!key) {
    showError('無法儲存設定');
    return;
  }
  
  try {
    if (state.excelExportColumnEditing) {
      saveExcelColumnLabel(state.excelExportColumnEditing);
    }
    
    const columns = [];
    const items = document.querySelectorAll('#excel-export-columns-list .excel-column-item');
    items.forEach(item => {
      const checkbox = item.querySelector('input[type="checkbox"]');
      if (checkbox) {
        const key = checkbox.id.replace('col-', '');
        // 嘗試從 input 或 label 取得文字
        const labelInput = item.querySelector(`#col-label-${key}`);
        const label = item.querySelector(`label[for="col-${key}"]`);
        let labelText = '';
        if (labelInput) {
          labelText = labelInput.value.trim();
        } else if (label) {
          labelText = label.textContent.trim();
        } else {
          // 如果找不到，從 state 中取得
          const col = state.excelExportColumns?.find(c => c.key === key);
          labelText = col?.label || key;
        }
        
        columns.push({
          key: key,
          label: labelText || key,
          enabled: checkbox.checked
        });
      }
    });
    
    localStorage.setItem(`excelExportColumns_${key}`, JSON.stringify(columns));
    state.excelExportColumns = columns;
    state.excelExportColumnsDialogOpen = false;
    state.excelExportColumnEditing = null;
    render();
  } catch (e) {
    console.error('儲存 Excel 匯出欄位設定失敗:', e);
    showError('儲存設定失敗');
  }
}

/**
 * 開啟 Excel 匯出欄位設定對話框
 */
function openExcelExportColumnsDialog() {
  const saved = loadExcelExportColumns();
  if (saved) {
    state.excelExportColumns = saved;
  } else {
    state.excelExportColumns = [
      { key: 'orderId', label: '訂單ID', enabled: true },
      { key: 'itemName', label: '品項名稱', enabled: true },
      { key: 'qty', label: '數量', enabled: true },
      { key: 'user', label: '下單者', enabled: true },
      { key: 'userId', label: '下單者ID', enabled: false },
      { key: 'createdAt', label: '建立時間', enabled: true }
    ];
  }
  state.excelExportColumnsDialogOpen = true;
  render();
  setTimeout(() => {
    setupExcelExportColumnsDragAndDrop();
  }, 100);
}

/**
 * 關閉 Excel 匯出欄位設定對話框
 */
function closeExcelExportColumnsDialog() {
  state.excelExportColumnsDialogOpen = false;
  state.excelExportColumnEditing = null;
  render();
}

/**
 * 切換 Excel 欄位的啟用狀態
 */
function toggleExcelColumn(key) {
  if (!state.excelExportColumns) return;
  const col = state.excelExportColumns.find(c => c.key === key);
  if (col) {
    col.enabled = !col.enabled;
  }
}

/**
 * 開始編輯欄位名稱
 */
function startEditExcelColumnLabel(key) {
  state.excelExportColumnEditing = key;
  render();
}

/**
 * 儲存欄位名稱
 */
function saveExcelColumnLabel(key) {
  if (!state.excelExportColumns) return;
  const col = state.excelExportColumns.find(c => c.key === key);
  if (col) {
    const input = document.getElementById(`col-label-${key}`);
    if (input) {
      const newLabel = input.value.trim();
      if (newLabel) {
        col.label = newLabel;
      }
    }
  }
  state.excelExportColumnEditing = null;
  render();
}

/**
 * 設定 Excel 匯出欄位的拖曳功能（中間撐開 + 插入記號）
 */
function setupExcelExportColumnsDragAndDrop() {
  const container = document.getElementById('excel-export-columns-list');
  if (!container) return;

  // 避免重複綁定：先移除舊的 listeners 與殘留的 placeholder
  if (container._excelDragAbortController) {
    container._excelDragAbortController.abort();
  }
  container.querySelectorAll('.excel-column-insert-placeholder').forEach((el) => el.remove());
  const signal = (container._excelDragAbortController = new AbortController()).signal;

  let draggedElement = null;
  let draggedIndex = null;
  let insertIndex = null;
  let placeholder = null;

  function removeAllPlaceholders() {
    container.querySelectorAll('.excel-column-insert-placeholder').forEach((el) => el.remove());
    placeholder = null;
  }

  function ensurePlaceholder() {
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.className = 'excel-column-insert-placeholder';
      placeholder.innerHTML = '<span class="excel-column-insert-line"></span><span class="excel-column-insert-text">↓ 放這裡</span>';
    }
    return placeholder;
  }

  function removePlaceholder() {
    removeAllPlaceholders();
  }

  function updatePlaceholderPosition(idx) {
    const items = container.querySelectorAll('.excel-column-item');
    if (idx < 0 || idx > items.length) return;
    insertIndex = idx;
    const ph = ensurePlaceholder();
    if (idx >= items.length) {
      container.appendChild(ph);
    } else {
      container.insertBefore(ph, items[idx]);
    }
  }

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.excel-column-item');
    if (item) {
      draggedElement = item;
      draggedIndex = parseInt(item.dataset.index, 10);
      item.style.opacity = '0.5';
    }
  }, { signal });

  container.addEventListener('dragend', () => {
    if (draggedElement) {
      draggedElement.style.opacity = '1';
      draggedElement = null;
    }
    removePlaceholder();
    insertIndex = null;
  }, { signal });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!draggedElement) return;
    const items = Array.from(container.querySelectorAll('.excel-column-item'));
    const y = e.clientY;
    let newInsertIndex = 0;

    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect();
      if (y < rect.top) {
        newInsertIndex = i;
        break;
      }
      if (y <= rect.bottom) {
        const mid = rect.top + rect.height / 2;
        newInsertIndex = y < mid ? i : i + 1;
        break;
      }
      newInsertIndex = i + 1;
    }

    if (newInsertIndex !== insertIndex) {
      removePlaceholder();
      updatePlaceholderPosition(newInsertIndex);
    }
  }, { signal });

  container.addEventListener('dragleave', (e) => {
    if (!container.contains(e.relatedTarget)) {
      removePlaceholder();
      insertIndex = null;
    }
  }, { signal });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    const savedInsertIndex = insertIndex;
    removePlaceholder();
    insertIndex = null;
    if (!draggedElement || savedInsertIndex == null) return;

    const columns = [...state.excelExportColumns];
    const [removed] = columns.splice(draggedIndex, 1);
    const insertAt = draggedIndex < savedInsertIndex ? savedInsertIndex - 1 : savedInsertIndex;
    columns.splice(insertAt, 0, removed);
    state.excelExportColumns = columns;

    const items = container.querySelectorAll('.excel-column-item');
    const ref = items[savedInsertIndex] || null;
    container.insertBefore(draggedElement, ref);

    container.querySelectorAll('.excel-column-item').forEach((el, i) => {
      el.dataset.index = String(i);
    });
  }, { signal });
}

/**
 * 匯出我收到的訂單為 Excel
 */
async function exportReceivedOrdersToExcel() {
  if (!state.userId) {
    showError('使用者未登入');
    return;
  }
  
  if (!state.currentWorldId) {
    showError('沒有當前世界');
    return;
  }
  
  setLoading(true);
  state.errorMessage = null;
  render();
  
  try {
    let dateParam = state.myOrdersDate;
    if (dateParam === '全部') dateParam = '';
    else if (dateParam === '今天' || dateParam === '今日') dateParam = '今天';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) dateParam = '今天';
    
    let worldParam = state.myOrdersWorldFilter;
    if (worldParam === 'all' || !worldParam) worldParam = '';
    
    // 取得欄位設定
    const columns = state.excelExportColumns || loadExcelExportColumns() || [
      { key: 'user', label: '訂購人', enabled: true },
      { key: 'vendor', label: '廠商', enabled: true },
      { key: 'itemName', label: '品項名稱', enabled: true },
      { key: 'qty', label: '數量', enabled: true },
      { key: 'orderId', label: '訂單ID', enabled: true },
      { key: 'createdAt', label: '建立時間', enabled: true },
      { key: 'branch', label: '分店', enabled: false },
      { key: 'userId', label: '訂購人ID', enabled: false }
    ];
    
    const columnsParam = encodeURIComponent(JSON.stringify(columns));
    
    const url = `${API_BASE}/orders/received/export?userId=${encodeURIComponent(state.userId)}&date=${encodeURIComponent(dateParam)}&columns=${columnsParam}${worldParam ? '&worldId=' + encodeURIComponent(worldParam) : ''}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: '匯出失敗' }));
      throw new Error(errorData.error || '匯出 Excel 失敗');
    }
    
    // 取得檔名
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = '訂單.xlsx';
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match) {
        filename = decodeURIComponent(match[1]);
      }
    }
    
    // 下載檔案
    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(downloadUrl);
    
    setLoading(false);
    render();
  } catch (error) {
    console.error('❌ 匯出 Excel 失敗:', error);
    setLoading(false);
    showError(error.message || '匯出 Excel 時發生錯誤，請稍後再試');
    render();
  }
}

/**
 * 查詢我收到的訂單（可選世界與日期，僅 owner）
 * 單一來源：使用 /api/orders/received/preview，並同時建立卡片用的 myOrders 與欄位用的 rows
 */
async function fetchReceivedOrders() {
  if (!state.userId) {
    state.errorMessage = '使用者未登入';
    render();
    return;
  }
  
  setLoading(true);
  state.errorMessage = null;
  
  try {
    let dateParam = state.myOrdersDate;
    if (dateParam === '全部') dateParam = '';
    else if (dateParam === '今天' || dateParam === '今日') dateParam = '今天';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) dateParam = '今天';
    
    let worldParam = state.myOrdersWorldFilter;
    if (worldParam === 'all' || !worldParam) worldParam = '';
    
    const url = `${API_BASE}/orders/received/preview?userId=${encodeURIComponent(state.userId)}&date=${encodeURIComponent(dateParam)}${worldParam ? '&worldId=' + encodeURIComponent(worldParam) : ''}`;
    const response = await fetch(url);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: '查詢訂單失敗' }));
      throw new Error(errorData.error || '查詢訂單失敗');
    }
    
    const data = await response.json();
    const columns = data.columns || null;
    const rows = data.rows || [];
    state.receivedOrdersTableColumns = columns;
    state.receivedOrdersTableRows = rows;
    
    // 將 rows 依 orderId 聚合成 myOrders，供卡片檢視使用
    const orderMap = {};
    for (const r of rows) {
      const orderId = r.orderId;
      if (!orderMap[orderId]) {
        orderMap[orderId] = {
          orderId,
          branch: r.branch || '',
          items: [],
          createdAt: r.createdAt,
          user: r.user || '',
          userId: r.userId || '',
          worldName: r.worldName || null,
          worldCode: r.worldCode || null
        };
      }
      orderMap[orderId].items.push({ name: r.itemName, qty: r.qty });
      if (r.createdAt && new Date(r.createdAt) > new Date(orderMap[orderId].createdAt)) {
        orderMap[orderId].createdAt = r.createdAt;
      }
    }
    
    state.myOrders = Object.values(orderMap);
  } catch (error) {
    state.errorMessage = error.message || '查詢訂單時發生錯誤，請稍後再試';
    state.myOrders = [];
    state.receivedOrdersTableColumns = null;
    state.receivedOrdersTableRows = null;
  } finally {
    setLoading(false);
    render();
  }
}

/**
 * 設定「我收到的訂單」檢視模式
 */
function setReceivedViewMode(mode) {
  if (mode !== 'cards' && mode !== 'table') return;
  state.myOrdersReceivedViewMode = mode;

  // rows 與 myOrders 都由 fetchReceivedOrders 維護，這裡只需要重新 render
  render();
}

/**
 * 渲染「我收到的訂單」欄位模式表格
 */
function renderReceivedOrdersTable() {
  const columns = state.receivedOrdersTableColumns;
  const rows = state.receivedOrdersTableRows;

  if (!columns || !rows) {
    return '<div class="empty-message">尚無資料，請先查詢或稍後再試</div>';
  }

  if (rows.length === 0) {
    return '<div class="empty-message">尚無訂單</div>';
  }

  const headerHtml = columns.map(col => `<th>${escapeHtml(col.label)}</th>`).join('') + '<th>操作</th>';
  const orderIdSeen = {};
  const bodyHtml = rows.map(row => {
    const isFirstOfOrder = !orderIdSeen[row.orderId];
    if (isFirstOfOrder) orderIdSeen[row.orderId] = true;
    const tds = columns.map(col => {
      const key = col.key;
      let value = row[key];
      if (key === 'createdAt' && value) {
        value = formatDateTime(value);
      }
      if (value === null || value === undefined) value = '';
      return `<td>${escapeHtml(String(value))}</td>`;
    }).join('');
    const actionTd = isFirstOfOrder
      ? `<td><button type="button" class="btn-order-edit-inline" onclick="orderWeb.openOrderDetailByOrderId(${row.orderId})">查看</button></td>`
      : '<td></td>';
    return `<tr>${tds}${actionTd}</tr>`;
  }).join('');

  return `
    <div class="received-orders-table-wrap">
      <div class="received-orders-table-scroll">
        <table class="received-orders-table">
          <thead><tr>${headerHtml}</tr></thead>
          <tbody>${bodyHtml}</tbody>
        </table>
      </div>
    </div>
  `;
}

/**
 * 設定我的訂單查詢日期
 */
function setMyOrdersDate(date) {
  if (!date) return;
  state.myOrdersDate = date;
  
  // 根據當前 tab 決定查詢哪個 API
  if (state.myOrdersTab === 'received_orders') {
    fetchReceivedOrders();
  } else {
    fetchMyOrders();
  }
}

/**
 * 設定我的訂單世界篩選
 */
function setMyOrdersWorld(worldId) {
  if (!worldId) return;
  state.myOrdersWorldFilter = worldId;
  
  // 根據當前 tab 決定查詢哪個 API
  if (state.myOrdersTab === 'received_orders') {
    fetchReceivedOrders();
  } else {
    fetchMyOrders();
  }
}

/**
 * 從「我收到的訂單」表格依 orderId 組成一筆訂單（供開啟詳情用）
 */
function buildOrderFromTableRows(orderId) {
  const rows = state.receivedOrdersTableRows || [];
  const same = rows.filter(r => r.orderId === orderId);
  if (same.length === 0) return null;
  const first = same[0];
  return {
    orderId: first.orderId,
    user: first.user,
    createdAt: first.createdAt,
    items: same.map(r => ({ name: r.itemName, qty: r.qty }))
  };
}

/**
 * 開啟訂單詳情（從卡片傳入完整 order）
 */
async function openOrderDetail(order, tab) {
  if (!order || !order.orderId) return;
  state.orderDetailOrderId = order.orderId;
  state.orderDetailOrder = order;
  state.orderDetailTab = tab || state.myOrdersTab;
  state.orderDetailFetched = null;
  state.orderDetailPendingQty = {};
  state.orderDetailPendingDeletes = [];
  state.orderDetailPendingAdds = [];
  state.orderDetailAddCounter = 0;
  state.errorMessage = null;
  setLoading(true);
  render();
  try {
    const [orderData, _] = await Promise.all([
      fetchOrderDetail(order.orderId).then(d => d || 'cancelled'),
      (!state.menu && state.userId) ? fetchMenu(state.userId).then(d => {
        state.menu = d.menu;
        state.orderFormat = d.orderFormat || null;
        state.itemAttributeOptions = d.itemAttributeOptions || {};
        state.itemAttributes = d.itemAttributes || {};
        state.menuItemAttributes = {};
        if (state.menu && typeof state.menu === 'object') {
          for (const vendor of Object.keys(state.menu)) {
            for (const itemName of Object.keys(state.menu[vendor])) {
              const val = state.menu[vendor][itemName];
              if (typeof val === 'object' && val !== null && Array.isArray(val.attributes) && val.attributes.length > 0) {
                state.menuItemAttributes[itemName] = val.attributes;
              } else if (state.itemAttributes[vendor] && state.itemAttributes[vendor][itemName]) {
                state.menuItemAttributes[itemName] = state.itemAttributes[vendor][itemName];
              }
            }
          }
        }
      }).catch(() => {}) : Promise.resolve()
    ]);
    state.orderDetailFetched = orderData;
  } catch (e) {
    state.errorMessage = e.message || '無法載入訂單';
    state.orderDetailFetched = 'error';
  } finally {
    setLoading(false);
    render();
  }
}

/**
 * 開啟訂單詳情（從表格或卡片只傳 orderId）
 */
async function openOrderDetailByOrderId(orderId, tab) {
  const tabName = tab || state.myOrdersTab;
  const isTable = tabName === 'received_orders' && state.myOrdersReceivedViewMode === 'table' && state.receivedOrdersTableRows;
  const order = isTable
    ? buildOrderFromTableRows(orderId)
    : (state.myOrders || []).find(o => o.orderId === orderId);
  const fallback = { orderId, items: [], createdAt: '', user: '' };
  await openOrderDetail(order || fallback, tabName);
}

/**
 * 訂單詳情：變更「新增品項」的菜單選擇（選菜單品項 or 其他）
 */
function setOrderDetailSelectedMenuItem(value) {
  state.orderDetailSelectedMenuItem = (value || '').trim();
  state.orderDetailNewItemAttrs = [];
  render();
}

/**
 * 訂單詳情：設定新增品項的某個屬性值
 */
function setOrderDetailNewItemAttr(dimIndex, value) {
  if (!Array.isArray(state.orderDetailNewItemAttrs)) state.orderDetailNewItemAttrs = [];
  state.orderDetailNewItemAttrs[dimIndex] = value || '';
  render();
}

/**
 * 取得當前世界菜單的品項列表（供訂單詳情「新增品項」下拉用）
 * @returns {{ value: string, label: string }[]}
 */
function getOrderDetailMenuOptions() {
  const menu = state.menu;
  if (!menu || typeof menu !== 'object') return [];
  const options = [];
  for (const vendor of Object.keys(menu)) {
    const items = menu[vendor];
    if (!items || typeof items !== 'object') continue;
    for (const itemName of Object.keys(items)) {
      options.push({ value: itemName, label: `${vendor} － ${itemName}` });
    }
  }
  return options.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant'));
}

/**
 * 關閉訂單詳情
 */
function closeOrderDetail() {
  state.orderDetailOrderId = null;
  state.orderDetailOrder = null;
  state.orderDetailFetched = null;
  state.orderDetailTab = null;
  state.orderDetailSelectedMenuItem = '';
  state.orderDetailNewItemAttrs = [];
  state.orderDetailPendingQty = {};
  state.orderDetailPendingDeletes = [];
  state.orderDetailPendingAdds = [];
  state.orderDetailAddCounter = 0;
  state.errorMessage = null;
  render();
  // 重新載入列表以反映修改
  if (state.myOrdersTab === 'my_orders') fetchMyOrders();
  else fetchReceivedOrders();
}

/**
 * 渲染訂單詳情區塊（可編輯 / 已取消+恢復）
 */
function renderOrderDetailView() {
  const id = state.orderDetailOrderId;
  const order = state.orderDetailOrder;
  const fetched = state.orderDetailFetched;
  const tab = state.orderDetailTab;

  if (!id || fetched === null) {
    return '<div class="order-detail-loading">載入中...</div>';
  }
  if (fetched === 'error') {
    return `
      <div class="order-detail-panel">
        <div class="order-detail-header">
          <button type="button" class="btn-back" onclick="orderWeb.closeOrderDetail()">← 返回</button>
          <span class="order-detail-title">訂單 #${id}</span>
        </div>
        <div class="order-detail-body">
          <p class="error-message">${escapeHtml(state.errorMessage || '載入失敗')}</p>
        </div>
      </div>
    `;
  }

  const isCancelled = fetched === 'cancelled';
  const displayName = state.lineProfile?.displayName || state.userId || '';

  if (isCancelled) {
    const items = (order && order.items) || [];
    const canRestore = tab === 'my_orders';
    return `
      <div class="order-detail-panel">
        <div class="order-detail-header">
          <button type="button" class="btn-back" onclick="orderWeb.closeOrderDetail()">← 返回</button>
          <span class="order-detail-title">訂單 #${id}</span>
        </div>
        <div class="order-detail-body">
          <p class="order-detail-badge order-detail-badge-cancelled">已取消</p>
          ${order && order.createdAt ? `<p class="order-detail-meta">建立時間：${formatDateTime(order.createdAt)}</p>` : ''}
          ${order && order.user ? `<p class="order-detail-meta">下單者：${escapeHtml(order.user)}</p>` : ''}
          <div class="order-detail-items">
            ${items.map(item => `
              <div class="order-detail-item-row">
                <span class="item-name">${escapeHtml(item.name || item.item || '')}</span>
                <span class="item-qty">x${item.qty || 0}</span>
              </div>
            `).join('')}
          </div>
          ${canRestore ? `<button type="button" class="btn-block btn-primary" onclick="orderWeb.restoreOrder()" ${state.isLoading ? 'disabled' : ''}>
            ${state.isLoading ? '處理中...' : '恢復訂單'}
          </button>` : '<button type="button" class="btn-block btn-primary" onclick="orderWeb.closeOrderDetail()">返回</button>'}
        </div>
      </div>
    `;
  }

  const baseItems = fetched.items || [];
  const pendingQty = state.orderDetailPendingQty || {};
  const pendingDeletes = state.orderDetailPendingDeletes || [];
  const pendingAdds = state.orderDetailPendingAdds || [];
  const canEdit = tab === 'my_orders';

  const effectiveItems = baseItems
    .filter(it => !pendingDeletes.includes(it.id))
    .map(it => ({
      ...it,
      qty: pendingQty[it.id] !== undefined ? pendingQty[it.id] : it.qty,
      isPending: false
    }))
    .concat(pendingAdds.map(a => ({ id: a.tempId, item: a.name, qty: a.qty, tempId: a.tempId, isPending: true })));

  const itemsHtml = effectiveItems.map(it => {
    const idArg = typeof it.id === 'number' ? it.id : JSON.stringify(it.tempId || it.id);
    const qty = it.qty || 1;
    return canEdit
      ? `<div class="order-detail-item-row order-detail-item-editable" data-item-id="${it.id}">
          <span class="item-name">${escapeHtml(it.item || '')}</span>
          <div class="btn-qty-wrap order-detail-qty-wrap">
            <button type="button" class="btn-qty" onclick="orderWeb.adjustOrderItemQtyLocal(${idArg}, -1)" ${qty <= 1 ? 'disabled' : ''}>−</button>
            <input type="number" min="1" max="999999" value="${qty}" 
                   onchange="orderWeb.updateOrderItemQtyLocal(${idArg}, Math.max(1, parseInt(this.value, 10) || 1))"
                   class="order-detail-qty-input">
            <button type="button" class="btn-qty" onclick="orderWeb.adjustOrderItemQtyLocal(${idArg}, 1)">＋</button>
          </div>
          <button type="button" class="btn-order-item-delete" onclick="orderWeb.deleteOrderItemLocal(${idArg})" title="刪除此品項">刪除</button>
        </div>`
      : `<div class="order-detail-item-row">
          <span class="item-name">${escapeHtml(it.item || '')}</span>
          <span class="item-qty">x${it.qty || 0}</span>
        </div>`;
  }).join('');

  const addItemSection = canEdit ? `
        <div class="order-detail-add-item">
          <label>新增品項（從該世界菜單選擇）</label>
          ${(function() {
            const menuOpts = getOrderDetailMenuOptions();
            if (menuOpts.length > 0) {
              return `
                <select id="order-detail-menu-select" class="order-detail-menu-select" onchange="orderWeb.setOrderDetailSelectedMenuItem(this.value)">
                  <option value="" ${state.orderDetailSelectedMenuItem === '' ? 'selected' : ''}>請選擇品項</option>
                  ${menuOpts.map(o => `<option value="${escapeHtml(o.value)}" ${state.orderDetailSelectedMenuItem === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
                </select>
              `;
            }
            return '';
          })()}
          ${(function() {
            const menuOpts = getOrderDetailMenuOptions();
            if (menuOpts.length > 0 && state.orderDetailSelectedMenuItem) {
              const itemName = state.orderDetailSelectedMenuItem;
              const { dimensionNames, optionsPerDimension } = getAttributeDimensionsAndOptions(itemName);
              const hasAttr = dimensionNames.length > 0 && optionsPerDimension.some(opts => opts && opts.length > 0);
              if (hasAttr) {
                const attrs = state.orderDetailNewItemAttrs || [];
                return `
                  <div class="order-detail-attr-row">
                    <span class="order-detail-attr-label">屬性：</span>
                    ${dimensionNames.map((dimName, di) => {
                      const options = optionsPerDimension[di] || [];
                      const currentVal = attrs[di] || '';
                      return `<select class="order-detail-attr-select" data-attr-index="${di}" onchange="orderWeb.setOrderDetailNewItemAttr(${di}, this.value)">
                        <option value="">-- ${escapeHtml(dimName)} --</option>
                        ${options.map(v => `<option value="${escapeHtml(v)}" ${currentVal === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                      </select>`;
                    }).join('')}
                  </div>
                `;
              }
            }
            return '';
          })()}
          <div class="btn-qty-wrap order-detail-new-qty-wrap">
            <button type="button" class="btn-qty" onclick="orderWeb.adjustOrderDetailNewItemQty(-1)" id="order-detail-new-qty-minus">−</button>
            <input type="number" min="1" max="999999" id="order-detail-new-item-qty" value="1" class="order-detail-new-qty" onchange="orderWeb.setOrderDetailNewItemQty(parseInt(this.value, 10) || 1)">
            <button type="button" class="btn-qty" onclick="orderWeb.adjustOrderDetailNewItemQty(1)">＋</button>
          </div>
          <button type="button" class="btn-add-item" onclick="orderWeb.addOrderItemLocal()">＋ 新增</button>
        </div>
        <button type="button" class="btn-block btn-primary" onclick="orderWeb.confirmOrderEdit()" style="margin-bottom: 0.5rem;">
          確定編輯
        </button>
        <button type="button" class="btn-block btn-danger-outline" onclick="orderWeb.cancelOrderConfirm()" ${state.isLoading ? 'disabled' : ''}>
          取消此訂單
        </button>`
  : `<button type="button" class="btn-block btn-primary" onclick="orderWeb.closeOrderDetail()">返回</button>`;

  return `
    <div class="order-detail-panel">
      <div class="order-detail-header">
        <button type="button" class="btn-back" onclick="orderWeb.closeOrderDetail()">← 返回</button>
        <span class="order-detail-title">訂單 #${id}</span>
      </div>
      <div class="order-detail-body">
        <p class="order-detail-meta">建立時間：${formatDateTime(fetched.created_at)}</p>
        ${tab === 'received_orders' && order && order.user ? `<p class="order-detail-meta">下單者：${escapeHtml(order.user)}</p>` : ''}
        <div class="order-detail-items">${itemsHtml}</div>
        ${addItemSection}
      </div>
    </div>
  `;
}

/**
 * 暫存數量變更（確定編輯時才送出）
 */
function updateOrderItemQtyLocal(itemIdOrTempId, qty) {
  const id = typeof itemIdOrTempId === 'string' && itemIdOrTempId.startsWith('add-') ? itemIdOrTempId : Number(itemIdOrTempId);
  if (typeof id === 'number' && !isNaN(id)) {
    state.orderDetailPendingQty = state.orderDetailPendingQty || {};
    state.orderDetailPendingQty[id] = qty;
  } else if (typeof id === 'string') {
    const adds = state.orderDetailPendingAdds || [];
    const found = adds.find(a => (a.tempId || '').toString() === id);
    if (found) found.qty = qty;
  }
  render();
}

function getOrderDetailItemQty(itemIdOrTempId) {
  const baseItems = (state.orderDetailFetched?.items) || [];
  const pendingQty = state.orderDetailPendingQty || {};
  const pendingAdds = state.orderDetailPendingAdds || [];
  const id = typeof itemIdOrTempId === 'string' && itemIdOrTempId.startsWith('add-') ? itemIdOrTempId : Number(itemIdOrTempId);
  if (typeof id === 'number' && !isNaN(id)) {
    if (pendingQty[id] !== undefined) return pendingQty[id];
    const base = baseItems.find(it => it.id === id);
    return base ? base.qty : 1;
  }
  const add = pendingAdds.find(a => (a.tempId || '').toString() === String(itemIdOrTempId));
  return add ? add.qty : 1;
}

function adjustOrderItemQtyLocal(itemIdOrTempId, delta) {
  const current = getOrderDetailItemQty(itemIdOrTempId);
  updateOrderItemQtyLocal(itemIdOrTempId, Math.max(1, Math.min(999999, current + delta)));
}

function adjustOrderDetailNewItemQty(delta) {
  const input = document.getElementById('order-detail-new-item-qty');
  const current = input ? (parseInt(input.value, 10) || 1) : 1;
  const next = Math.max(1, Math.min(999999, current + delta));
  if (input) input.value = next;
}

function setOrderDetailNewItemQty(qty) {
  const input = document.getElementById('order-detail-new-item-qty');
  if (input) input.value = Math.max(1, Math.min(999999, qty || 1));
}

/**
 * 暫存刪除（確定編輯時才送出）
 */
function deleteOrderItemLocal(itemIdOrTempId) {
  const id = itemIdOrTempId;
  if (typeof id === 'string' && id.startsWith('add-')) {
    state.orderDetailPendingAdds = (state.orderDetailPendingAdds || []).filter(a => (a.tempId || '').toString() !== id);
  } else {
    const numId = Number(id);
    if (!isNaN(numId)) {
      state.orderDetailPendingDeletes = state.orderDetailPendingDeletes || [];
      if (!state.orderDetailPendingDeletes.includes(numId)) {
        state.orderDetailPendingDeletes.push(numId);
      }
    }
  }
  render();
}

/**
 * 暫存新增品項（確定編輯時才送出）
 */
function addOrderItemLocal() {
  const selectEl = document.getElementById('order-detail-menu-select');
  const qtyEl = document.getElementById('order-detail-new-item-qty');
  if (!qtyEl || !state.userId || !state.orderDetailOrderId) return;

  const baseName = (state.orderDetailSelectedMenuItem || '').trim();
  if (!baseName) {
    showError('請從菜單選擇品項');
    return;
  }

  // 有屬性的品項必須完整填寫每個維度
  const { dimensionNames, optionsPerDimension } = getAttributeDimensionsAndOptions(baseName);
  const requiredDims = optionsPerDimension
    .map((opts, i) => ({ index: i, name: dimensionNames[i] || ('屬性' + (i + 1)), options: opts || [] }))
    .filter(d => d.options.length > 0);
  const attrs = state.orderDetailNewItemAttrs || [];
  for (const dim of requiredDims) {
    const val = (attrs[dim.index] || '').trim();
    if (!val || !dim.options.includes(val)) {
      showError(`請選擇完整的屬性：${requiredDims.map(d => d.name).join('、')}`);
      return;
    }
  }
  const attrsFiltered = requiredDims.map(d => attrs[d.index]);
  const name = attrsFiltered.length > 0 ? `${baseName} ${attrsFiltered.join(' ')}` : baseName;

  const qty = parseInt(qtyEl.value, 10) || 1;

  state.orderDetailPendingAdds = state.orderDetailPendingAdds || [];
  state.orderDetailAddCounter = (state.orderDetailAddCounter || 0) + 1;
  state.orderDetailPendingAdds.push({ name, qty, tempId: 'add-' + state.orderDetailAddCounter });
  state.orderDetailSelectedMenuItem = '';
  state.orderDetailNewItemAttrs = [];
  if (selectEl) selectEl.value = '';
  qtyEl.value = '1';
  render();
}

/**
 * 確定編輯：送出所有暫存變更，完成後發送通知
 */
async function confirmOrderEdit() {
  if (!state.userId || !state.orderDetailOrderId) return;
  const pendingQty = state.orderDetailPendingQty || {};
  const pendingDeletes = state.orderDetailPendingDeletes || [];
  const pendingAdds = state.orderDetailPendingAdds || [];
  const baseItems = (state.orderDetailFetched && state.orderDetailFetched !== 'cancelled' && state.orderDetailFetched.items) || [];

  const hasChanges = Object.keys(pendingQty).length > 0 || pendingDeletes.length > 0 || pendingAdds.length > 0;
  if (!hasChanges) {
    closeOrderDetail();
    return;
  }

  const qtyUpdates = [];
  for (const [k, v] of Object.entries(pendingQty)) {
    const id = parseInt(k, 10);
    if (!isNaN(id) && baseItems.some(it => it.id === id)) {
      qtyUpdates.push({ itemId: id, qty: v });
    }
  }

  const adds = pendingAdds.map(a => ({ name: a.name, qty: a.qty }));

  setLoading(true);
  try {
    const res = await fetch(`${API_BASE}/orders/${state.orderDetailOrderId}/batch-edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.userId,
        user: state.lineProfile?.displayName || null,
        qtyUpdates,
        adds,
        deletes: pendingDeletes
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '編輯失敗');
    }
    closeOrderDetail();
  } catch (e) {
    showError(e.message || '編輯失敗');
    render();
  } finally {
    setLoading(false);
    render();
  }
}

/**
 * 取消訂單（先確認）
 */
function cancelOrderConfirm() {
  if (!confirm('確定要取消此訂單？取消後可再恢復。')) return;
  cancelOrder();
}

async function cancelOrder() {
  if (!state.userId || !state.orderDetailOrderId) return;
  setLoading(true);
  try {
    const res = await fetch(`${API_BASE}/orders/${state.orderDetailOrderId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.userId,
        user: state.lineProfile?.displayName || null
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '取消訂單失敗');
    }
    const prevItems = (state.orderDetailFetched && state.orderDetailFetched !== 'cancelled' && state.orderDetailFetched.items)
      ? state.orderDetailFetched.items.map(i => ({ name: i.item, qty: i.qty }))
      : (state.orderDetailOrder && state.orderDetailOrder.items) || [];
    state.orderDetailFetched = 'cancelled';
    state.orderDetailOrder = { ...state.orderDetailOrder, orderId: state.orderDetailOrderId, items: prevItems };
    render();
  } catch (e) {
    showError(e.message || '取消訂單失敗');
  } finally {
    setLoading(false);
    render();
  }
}

/**
 * 恢復已取消的訂單
 */
async function restoreOrder() {
  if (!state.userId || !state.orderDetailOrderId) return;
  setLoading(true);
  try {
    const res = await fetch(`${API_BASE}/orders/${state.orderDetailOrderId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.userId,
        user: state.lineProfile?.displayName || null
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '恢復訂單失敗');
    }
    state.orderDetailFetched = await fetchOrderDetail(state.orderDetailOrderId);
    if (state.orderDetailFetched) {
      state.orderDetailOrder = { ...state.orderDetailOrder, orderId: state.orderDetailOrderId, items: state.orderDetailFetched.items };
    }
    render();
  } catch (e) {
    showError(e.message || '恢復訂單失敗');
  } finally {
  setLoading(false);
    render();
  }
}

/**
 * 渲染菜單管理頁面（僅 owner）
 */
function renderMenuManagePage(container) {
  const currentWorld = state.worlds && state.worlds.find(w => w.id === state.currentWorldId);
  const isOwner = currentWorld && currentWorld.role === 'owner';
  
  if (!isOwner) {
    state.view = 'order';
    render();
    return;
  }
  
  container.innerHTML = `
    <div class="page-order">
      <div class="order-header">
        <button type="button" class="btn-back" onclick="orderWeb.backFromMenuManage()">← 返回</button>
        <span class="order-title">菜單管理</span>
      </div>
      <div class="order-content" style="padding: var(--spacing-lg);">
        ${state.errorMessage ? `<div class="error-message" style="margin-bottom: var(--spacing-md); padding: var(--spacing-md); background: #ffebee; border-left: 4px solid #f44336; border-radius: 4px; color: #c62828; white-space: pre-wrap;">${state.errorMessage.includes('<br>') ? state.errorMessage.split('<br>').map(line => escapeHtml(line)).join('<br>') : escapeHtml(state.errorMessage)}</div>` : ''}
        
        <div style="display: flex; gap: var(--spacing-lg); flex-wrap: wrap;">
          <div class="menu-section" style="flex: 1; min-width: 300px;">
            <div class="label-block" style="margin-bottom: var(--spacing-md);">目前菜單</div>
            ${state.formatted ? `
              <div style="background: var(--color-bg-light); padding: var(--spacing-md); border-radius: 8px; white-space: pre-wrap; font-family: monospace; font-size: 0.875rem; max-height: 300px; overflow-y: auto;">
                ${escapeHtml(state.formatted)}
              </div>
            ` : '<p style="color: var(--color-text-light);">尚無菜單</p>'}
          </div>
          
          <div class="menu-section" style="flex: 1; min-width: 300px;">
            <div class="label-block" style="margin-bottom: var(--spacing-md);">上傳菜單圖片</div>
            ${state.menuImageUrl ? `
              <div style="margin-bottom: var(--spacing-md);">
                <img src="${escapeHtml(state.menuImageUrl)}" 
                     alt="菜單圖片" 
                     style="width: 100%; max-width: 400px; height: auto; border-radius: 8px; border: 1px solid var(--color-border); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);">
              </div>
              <div style="display: flex; gap: var(--spacing-sm);">
                <input type="file" id="menu-image-input" accept="image/*" style="display: none;" onchange="orderWeb.handleMenuImageUpload(this.files[0])">
                <button type="button" class="btn-block" onclick="document.getElementById('menu-image-input').click()" ${state.isLoading ? 'disabled' : ''} style="flex: 1;">
                  ${state.isLoading ? '上傳中...' : '更換圖片'}
                </button>
                <button type="button" onclick="orderWeb.deleteMenuImage()" ${state.isLoading ? 'disabled' : ''} style="padding: 0.5rem 1rem; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.875rem;">
                  刪除
                </button>
              </div>
            ` : `
              <p style="color: var(--color-text-light); font-size: 0.875rem; margin-bottom: var(--spacing-md);">上傳一張完整的菜單圖片，方便使用者查看</p>
              <input type="file" id="menu-image-input" accept="image/*" style="display: none;" onchange="orderWeb.handleMenuImageUpload(this.files[0])">
              <button type="button" class="btn-block" onclick="document.getElementById('menu-image-input').click()" ${state.isLoading ? 'disabled' : ''}>
                ${state.isLoading ? '上傳中...' : '選擇圖片'}
              </button>
            `}
          </div>
        </div>
        
        ${state.menu && Object.keys(state.menu).length > 0 ? `
          <div class="menu-section" style="margin-top: var(--spacing-lg);">
            <div class="label-block" style="margin-bottom: var(--spacing-md);">品項圖片管理</div>
            <p style="color: var(--color-text-light); font-size: 0.875rem; margin-bottom: var(--spacing-md);">為每個品項上傳圖片，方便使用者下訂單時參考</p>
            <div style="max-height: 400px; overflow-y: auto;">
              ${Object.keys(state.menu).map(vendor => {
                const items = state.menu[vendor];
                return Object.keys(items).map(itemName => {
                  const imageUrl = state.itemImages?.[vendor]?.[itemName];
                  const inputId = `item-image-${vendor}-${itemName}`.replace(/[^a-zA-Z0-9-]/g, '_');
                  return `
                    <div style="display: flex; align-items: center; padding: var(--spacing-sm); margin-bottom: var(--spacing-xs); background: var(--color-bg-light); border-radius: 4px;">
                      <div style="flex: 1; min-width: 0;">
                        <div style="font-weight: 600; color: var(--color-text);">${escapeHtml(itemName)}</div>
                        <div style="font-size: 0.75rem; color: var(--color-text-light);">${escapeHtml(vendor)}</div>
                      </div>
                      <div style="margin: 0 var(--spacing-sm);">
                        ${imageUrl ? `
                          <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(itemName)}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 4px; border: 1px solid var(--color-border);">
                        ` : `
                          <div style="width: 60px; height: 60px; background: var(--color-border); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: var(--color-text-light); font-size: 0.75rem;">無圖片</div>
                        `}
                      </div>
                      <div style="display: flex; gap: var(--spacing-xs);">
                        <input type="file" id="${inputId}" accept="image/*" style="display: none;" onchange="orderWeb.handleItemImageUpload('${escapeJsAttr(vendor)}', '${escapeJsAttr(itemName)}', this.files[0])">
                        <button type="button" onclick="document.getElementById('${inputId}').click()" style="padding: 0.5rem 1rem; background: var(--color-primary); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.875rem;">
                          ${imageUrl ? '更換' : '上傳'}
                        </button>
                        ${imageUrl ? `
                          <button type="button" onclick="orderWeb.deleteItemImage('${escapeJsAttr(vendor)}', '${escapeJsAttr(itemName)}')" style="padding: 0.5rem 1rem; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.875rem;">
                            刪除
                          </button>
                        ` : ''}
                      </div>
                    </div>
                  `;
                }).join('');
              }).join('')}
            </div>
          </div>
        ` : ''}
        
        <div class="menu-section" style="margin-top: var(--spacing-lg);">
          <details class="excel-format-guide" style="background: var(--color-bg-light); border-radius: 8px; border: 1px solid var(--color-border); overflow: hidden;">
            <summary style="padding: var(--spacing-md); cursor: pointer; font-weight: 600; list-style: none; display: flex; align-items: center; gap: 0.5rem;">
              <span style="font-size: 1rem;">📋</span> Excel 菜單格式說明（點擊展開）
            </summary>
            <div style="padding: 0 var(--spacing-md) var(--spacing-md); font-size: 0.875rem; color: var(--color-text);">
              <p style="margin-bottom: var(--spacing-md);">上傳菜單 Excel 時，只要照下面格式填，系統就會自動辨識。</p>
              <div style="margin-bottom: var(--spacing-md);">
                <div style="font-weight: 600; margin-bottom: 0.35rem;">一、最少要有的三欄</div>
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 0.5rem; font-size: 0.8rem;">
                  <thead><tr style="background: var(--color-primary-light);"><th style="padding: 0.35rem 0.5rem; border: 1px solid var(--color-border); text-align: left;">廠商/店家</th><th style="padding: 0.35rem 0.5rem; border: 1px solid var(--color-border); text-align: left;">品項</th><th style="padding: 0.35rem 0.5rem; border: 1px solid var(--color-border); text-align: left;">數量</th></tr></thead>
                  <tbody>
                    <tr><td style="padding: 0.35rem 0.5rem; border: 1px solid var(--color-border);">飲料店</td><td style="padding: 0.35rem 0.5rem; border: 1px solid var(--color-border);">珍珠奶茶</td><td style="padding: 0.35rem 0.5rem; border: 1px solid var(--color-border);">10</td></tr>
                    <tr><td style="padding: 0.35rem 0.5rem; border: 1px solid var(--color-border);">飲料店</td><td style="padding: 0.35rem 0.5rem; border: 1px solid var(--color-border);">大杯紅茶</td><td style="padding: 0.35rem 0.5rem; border: 1px solid var(--color-border);">5</td></tr>
                    <tr><td style="padding: 0.35rem 0.5rem; border: 1px solid var(--color-border);">便當廠</td><td style="padding: 0.35rem 0.5rem; border: 1px solid var(--color-border);">雞腿便當</td><td style="padding: 0.35rem 0.5rem; border: 1px solid var(--color-border);">20</td></tr>
                  </tbody>
                </table>
                <p style="margin: 0; color: var(--color-text-light);">第一列一定要是標題，第二列開始才是資料。</p>
              </div>
              <div style="margin-bottom: var(--spacing-md);">
                <div style="font-weight: 600; margin-bottom: 0.35rem;">二、下拉選單（選填）</div>
                <p style="margin-bottom: 0.35rem;">多加一欄「下拉選項」，格式：<code style="background: rgba(0,0,0,0.06); padding: 0.1rem 0.25rem; border-radius: 4px;">屬性名稱,選項1,選項2</code>；多個屬性用<strong>分號 ;</strong>隔開。</p>
                <p style="margin: 0; color: var(--color-text-light);">例：<code style="background: rgba(0,0,0,0.06); padding: 0.1rem 0.25rem; border-radius: 4px;">甜度,正常甜,半糖,微糖,無糖;冰塊,去冰,微冰,少冰,正常冰</code></p>
              </div>
              <div style="margin-bottom: var(--spacing-md);">
                <div style="font-weight: 600; margin-bottom: 0.35rem;">三、完整範例</div>
                <pre style="margin: 0; padding: var(--spacing-sm); background: rgba(0,0,0,0.05); border-radius: 4px; overflow-x: auto; font-size: 0.75rem; white-space: pre;">廠商    品項      數量  下拉選項
飲料店  珍珠奶茶  10    甜度,正常甜,半糖,微糖,無糖;冰塊,去冰,微冰,少冰,正常冰
飲料店  大杯紅茶  5     冰塊,去冰,微冰,正常冰
便當廠  雞腿便當  20    </pre>
              </div>
              <div style="margin-bottom: var(--spacing-md);">
                <div style="font-weight: 600; margin-bottom: 0.35rem;">常見問題</div>
                <ul style="margin: 0; padding-left: 1.25rem; color: var(--color-text-light);">
                  <li>標題可寫英文（Vendor、Item、Qty、Dropdown 都會認）</li>
                  <li>「下拉選項」不必每列都填，需要時再加即可</li>
                  <li>逗號、分號請用<strong>半形</strong> , ;</li>
                </ul>
              </div>
              <p style="margin: 0; font-weight: 600;">總結：第一列標題「廠商 / 品項 / 數量」，第二列起填資料；要下拉選單就多加一欄「下拉選項」。</p>
            </div>
          </details>
        </div>
        
        <div class="menu-section" style="margin-top: var(--spacing-md);">
          <div class="label-block" style="margin-bottom: var(--spacing-md);">上傳 Excel 菜單</div>
          <input type="file" id="excel-file-input" accept=".xlsx,.xls,.xlsm" style="display: none;" onchange="orderWeb.handleExcelFileSelect(event)">
          <button type="button" class="btn-block" onclick="document.getElementById('excel-file-input').click()" ${state.isLoading ? 'disabled' : ''}>
            ${state.isLoading ? '處理中...' : '選擇 Excel 檔案'}
          </button>
          ${state.excelUploadFile ? `<p style="margin-top: var(--spacing-sm); color: var(--color-text-light); font-size: 0.875rem;">已選擇：${escapeHtml(state.excelUploadFile.name)}</p>` : ''}
        </div>
        
        ${state.excelNeedsMapping || (state.excelUploadFile && state.excelPreview && state.excelPreview.length > 0) ? `
          <div class="menu-section" style="margin-top: var(--spacing-lg);">
            <div class="label-block" style="margin-bottom: var(--spacing-md);">${state.excelNeedsMapping ? '設定欄位對應' : '確認欄位對應'}</div>
            ${state.excelPreview && Array.isArray(state.excelPreview) && state.excelPreview.length > 0 ? `
              <div style="margin-bottom: var(--spacing-md);">
                <div class="label-block" style="margin-bottom: var(--spacing-xs); font-size: 0.8rem;">Excel 預覽（前 10 行）</div>
                <div style="background: var(--color-bg-light); padding: 0.35rem; border-radius: 6px; overflow-x: auto; max-height: 180px; font-family: monospace; font-size: 0.7rem;">
                  <table style="width: 100%; border-collapse: collapse; table-layout: fixed;">
                    ${state.excelPreview.map((row, idx) => `
                      <tr style="${idx === 0 && state.excelMapping?.hasHeader ? 'background: var(--color-primary-light); font-weight: bold;' : ''}">
                        ${row.map(cell => `<td style="padding: 0.15rem 0.25rem; border: 1px solid var(--color-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(cell || '')}</td>`).join('')}
                      </tr>
                    `).join('')}
                  </table>
                </div>
              </div>
            ` : ''}
            <div style="background: var(--color-bg-light); padding: var(--spacing-md); border-radius: 8px; margin-bottom: var(--spacing-md);">
              <div style="margin-bottom: var(--spacing-sm);">
                <label style="display: block; margin-bottom: 0.25rem; font-size: 0.875rem;">廠商欄位（選填）</label>
                <input type="text" id="mapping-branch" placeholder="例如：D（廠商/店名）" value="${escapeHtml(state.excelMapping?.branchColumn || '')}" style="width: 100%; padding: 0.5rem; border: 1px solid var(--color-border); border-radius: 4px;">
              </div>
              <div style="margin-bottom: var(--spacing-sm);">
                <label style="display: block; margin-bottom: 0.25rem; font-size: 0.875rem;">品項欄位 *</label>
                <input type="text" id="mapping-item" placeholder="例如：A" value="${escapeHtml(state.excelMapping?.itemColumn || '')}" required style="width: 100%; padding: 0.5rem; border: 1px solid var(--color-border); border-radius: 4px;">
              </div>
              <div style="margin-bottom: var(--spacing-sm);">
                <label style="display: block; margin-bottom: 0.25rem; font-size: 0.875rem;">數量欄位 *</label>
                <input type="text" id="mapping-qty" placeholder="例如：C" value="${escapeHtml(state.excelMapping?.qtyColumn || '')}" required style="width: 100%; padding: 0.5rem; border: 1px solid var(--color-border); border-radius: 4px;">
              </div>
              <div style="margin-bottom: var(--spacing-sm);">
                <label style="display: block; margin-bottom: 0.25rem; font-size: 0.875rem;">屬性欄位（選填）</label>
                <input type="text" id="mapping-attr" placeholder="例如：D（每列該格的屬性值，如 微冰,微糖）" value="${escapeHtml(state.excelMapping?.attrColumn || '')}" style="width: 100%; padding: 0.5rem; border: 1px solid var(--color-border); border-radius: 4px;">
                <span style="font-size: 0.75rem; color: var(--color-text-light);">→ 填此欄會變成「tag＋加號」選屬性，不會出現下拉選單</span>
              </div>
              <div style="margin-bottom: var(--spacing-sm);">
                <label style="display: block; margin-bottom: 0.25rem; font-size: 0.875rem;">下拉選項欄位（選填）</label>
                <input type="text" id="mapping-dropdown-options" placeholder="例如：B（格式：甜度,正常甜,半糖,微糖；多個屬性用分號分隔）" value="${escapeHtml(state.excelMapping?.dropdownOptionsColumn || '')}" style="width: 100%; padding: 0.5rem; border: 1px solid var(--color-border); border-radius: 4px;">
                <span style="font-size: 0.75rem; color: var(--color-text-light);">→ 填此欄才會出現「下拉選單」；若表頭是「屬性格式」請填這裡</span>
              </div>
              <div style="margin-bottom: var(--spacing-sm);">
                <label style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.875rem;">
                  <input type="checkbox" id="mapping-has-header" ${state.excelMapping?.hasHeader !== false ? 'checked' : ''} style="width: auto;">
                  第一行是標題
                </label>
              </div>
            </div>
            ${state.excelUploadFile ? `
              <button type="button" class="btn-block" onclick="orderWeb.submitExcelMapping()" ${state.isLoading ? 'disabled' : ''}>
                ${state.isLoading ? '匯入中...' : '確認並匯入'}
              </button>
            ` : `
              <p style="color: var(--color-text-light); font-size: 0.875rem; margin-bottom: var(--spacing-md);">請重新選擇 Excel 檔案</p>
            `}
          </div>
        ` : ''}
      </div>
    </div>
    ${navBottom()}
  `;
}

function backFromMenuManage() {
  state.view = 'order';
  state.excelUploadFile = null;
  state.excelPreview = null;
  state.excelDetectedMapping = null;
  state.excelNeedsMapping = false;
  state.errorMessage = null;
  render();
}

/**
 * 渲染幫助頁面
 */
function renderHelpPage(container) {
  container.innerHTML = `
    <div class="page-order">
      <div class="order-header">
        <button type="button" class="btn-back" onclick="orderWeb.goWorldsWithConfirm()">← 返回</button>
        <span class="order-title">操作指南</span>
      </div>
      <div class="order-content help-page">
        <div class="help-intro">
          <h2>📖 訂單系統操作流程指南</h2>
          <p>這是一個簡單易用的訂單管理系統，讓您可以輕鬆管理訂單</p>
        </div>

        <div class="help-section">
          <h3>🎯 快速了解</h3>
          <ul>
            <li><strong>一般使用者</strong>：輕鬆下訂單、查看自己的訂單</li>
            <li><strong>老闆</strong>：管理菜單、查看所有訂單、匯出報表</li>
          </ul>
        </div>

        <div class="help-section">
          <h3 class="help-section-title">👤 一般使用者操作流程</h3>
          
          <div class="help-card help-card-primary">
            <h4>第一步：登入系統</h4>
            <ol>
              <li>使用 LINE 登入</li>
              <li>加入 LINE 官方帳號（用於接收通知）</li>
              <li>進入系統主頁面</li>
            </ol>
          </div>

          <div class="help-card help-card-primary">
            <h4>第二步：選擇或加入世界（店家）</h4>
            <p><strong>方式 A：加入既有世界</strong></p>
            <div class="help-code">主頁面 → 點擊「加入/創造世界」 → 選擇「加入既有世界」<br>→ 輸入世界 ID 或世界代碼 → 完成加入</div>
            <p><strong>方式 B：選擇已加入的世界</strong></p>
            <div class="help-code">主頁面 → 點擊世界卡片 → 直接進入該世界的訂單頁面</div>
          </div>

          <div class="help-card help-card-primary">
            <h4>第三步：下訂單</h4>
            <div class="help-code">訂單頁面 → 選擇品項 → 設定數量 → 填寫訂購人 → 確認訂單 → 送出</div>
            <ol>
              <li><strong>選擇品項</strong>：在品項列表中點擊品項，可以查看品項圖片（如果有上傳）</li>
              <li><strong>設定數量</strong>：使用 ➕ ➖ 按鈕調整數量，或直接輸入數字</li>
              <li><strong>填寫訂購人</strong>（如果需要）：在「訂購人」欄位輸入姓名</li>
              <li><strong>確認訂單</strong>：點擊「確認訂單」按鈕，檢查訂單內容是否正確</li>
              <li><strong>送出訂單</strong>：點擊「送出訂單」，系統會自動將訂單發送給老闆</li>
            </ol>
          </div>

          <div class="help-card help-card-primary">
            <h4>第四步：查看我的訂單</h4>
            <div class="help-code">底部導覽 → 點擊「我」 → 選擇「我下訂的訂單」<br>→ 選擇日期（今天/全部/選擇日期） → 查看訂單列表</div>
          </div>
        </div>

        <div class="help-section">
          <h3 class="help-section-title">👔 老闆操作流程</h3>
          
          <div class="help-card help-card-boss">
            <h4>第一步：建立新世界（店家）</h4>
            <div class="help-code">主頁面 → 點擊「加入/創造世界」 → 選擇「創造新世界」<br>→ 輸入世界名稱 → 設定訂單格式 → 設定顯示格式 → 完成</div>
            <p class="help-note">系統會自動產生世界代碼（8 位字母數字），可以分享給員工加入</p>
          </div>

          <div class="help-card help-card-boss">
            <h4>第二步：設定菜單</h4>
            <p><strong>方式 A：上傳 Excel 菜單</strong></p>
            <div class="help-code">底部導覽 → 點擊「菜單」 → 菜單管理<br>→ 點擊「選擇 Excel 檔案」 → 選擇檔案 → 設定欄位對應 → 匯入</div>
            <p class="help-note">Excel 支援欄位：廠商、品項、數量（必填）、屬性（選填，如 冰塊,糖度）</p>
            <p><strong>上傳品項圖片：</strong></p>
            <div class="help-code">菜單管理 → 品項圖片管理 → 找到品項 → 點擊「上傳」<br>→ 選擇圖片 → 自動上傳完成</div>
          </div>

          <div class="help-card help-card-boss">
            <h4>第三步：查看收到的訂單</h4>
            <div class="help-code">底部導覽 → 點擊「我」 → 選擇「我收到的訂單」<br>→ 選擇日期 → 查看所有訂單</div>
          </div>

          <div class="help-card help-card-boss">
            <h4>第四步：匯出訂單報表</h4>
            <div class="help-code">我收到的訂單 → 點擊「設定欄位」 → 選擇要匯出的欄位<br>→ 調整欄位順序 → 儲存設定 → 點擊「匯出 Excel」</div>
            <p class="help-note">可以自訂匯出欄位、欄位名稱和順序</p>
          </div>
        </div>

        <div class="help-section help-faq">
          <h3>💡 常見問題</h3>
          <div class="help-faq-list">
            <p><strong>Q1：如何加入別人的世界？</strong><br><span>A：請向老闆索取世界 ID 或世界代碼，然後在主頁面點擊「加入/創造世界」→「加入既有世界」，輸入 ID 或代碼即可。</span></p>
            <p><strong>Q2：可以同時加入多個世界嗎？</strong><br><span>A：可以！您可以加入多個世界，並在主頁面切換使用。</span></p>
            <p><strong>Q3：如何查看我下過的訂單？</strong><br><span>A：點擊底部導覽的「我」→「我下訂的訂單」，可以選擇日期查看。</span></p>
            <p><strong>Q4：老闆如何匯出訂單報表？</strong><br><span>A：點擊「我」→「我收到的訂單」→「設定欄位」→ 選擇要匯出的欄位 →「匯出 Excel」。</span></p>
            <p><strong>Q5：如何上傳品項圖片？</strong><br><span>A：只有老闆可以上傳。進入「菜單管理」→「品項圖片管理」→ 找到品項 → 點擊「上傳」選擇圖片。</span></p>
          </div>
        </div>

        <div class="help-footer">
          <p>需要更多幫助？請聯繫系統管理員</p>
          <p>最後更新：2026-01-27</p>
        </div>
      </div>
    </div>
    ${navBottom()}
  `;
}

/**
 * 處理品項圖片上傳
 */
async function handleItemImageUpload(vendor, itemName, file) {
  if (!file) return;
  
  if (!file.type.startsWith('image/')) {
    showError('請選擇圖片檔案');
    render();
    return;
  }
  
  setLoading(true);
  state.errorMessage = null;
  render();
  
  try {
    const formData = new FormData();
    formData.append('image', file);
    
    const response = await fetch(`${API_BASE}/menu/items/image?userId=${encodeURIComponent(state.userId)}&vendor=${encodeURIComponent(vendor)}&itemName=${encodeURIComponent(itemName)}`, {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || '上傳圖片失敗');
    }
    
    const data = await response.json();
    
    // 更新 state.itemImages
    if (!state.itemImages) state.itemImages = {};
    if (!state.itemImages[vendor]) state.itemImages[vendor] = {};
    state.itemImages[vendor][itemName] = data.imageUrl;
    
    setLoading(false);
    render();
  } catch (error) {
    console.error('❌ 上傳圖片失敗:', error);
    setLoading(false);
    showError(error.message || '上傳圖片時發生錯誤，請稍後再試');
    render();
  }
}

/**
 * 刪除品項圖片
 */
async function deleteItemImage(vendor, itemName) {
  if (!confirm(`確定要刪除「${itemName}」的圖片嗎？`)) {
    return;
  }
  
  setLoading(true);
  state.errorMessage = null;
  render();
  
  try {
    const response = await fetch(`${API_BASE}/menu/items/image?userId=${encodeURIComponent(state.userId)}&vendor=${encodeURIComponent(vendor)}&itemName=${encodeURIComponent(itemName)}`, {
      method: 'DELETE'
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || '刪除圖片失敗');
    }
    
    // 更新 state.itemImages
    if (state.itemImages && state.itemImages[vendor] && state.itemImages[vendor][itemName]) {
      delete state.itemImages[vendor][itemName];
    }
    
    setLoading(false);
    render();
  } catch (error) {
    console.error('❌ 刪除圖片失敗:', error);
    setLoading(false);
    showError(error.message || '刪除圖片時發生錯誤，請稍後再試');
    render();
  }
}

/**
 * 處理菜單圖片上傳
 */
async function handleMenuImageUpload(file) {
  if (!file) return;
  
  if (!file.type.startsWith('image/')) {
    showError('請選擇圖片檔案');
    render();
    return;
  }
  
  setLoading(true);
  state.errorMessage = null;
  render();
  
  try {
    const formData = new FormData();
    formData.append('image', file);
    
    const response = await fetch(`${API_BASE}/menu/image?userId=${encodeURIComponent(state.userId)}`, {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || '上傳菜單圖片失敗');
    }
    
    const data = await response.json();
    
    // 更新 state.menuImageUrl
    state.menuImageUrl = data.imageUrl;
    
    setLoading(false);
    render();
  } catch (error) {
    console.error('❌ 上傳菜單圖片失敗:', error);
    setLoading(false);
    showError(error.message || '上傳菜單圖片時發生錯誤，請稍後再試');
    render();
  }
}

/**
 * 刪除菜單圖片
 */
async function deleteMenuImage() {
  if (!confirm('確定要刪除菜單圖片嗎？')) {
    return;
  }
  
  setLoading(true);
  state.errorMessage = null;
  render();
  
  try {
    const response = await fetch(`${API_BASE}/menu/image?userId=${encodeURIComponent(state.userId)}`, {
      method: 'DELETE'
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || '刪除菜單圖片失敗');
    }
    
    // 更新 state.menuImageUrl
    state.menuImageUrl = null;
    
    setLoading(false);
    render();
  } catch (error) {
    console.error('❌ 刪除菜單圖片失敗:', error);
    setLoading(false);
    showError(error.message || '刪除菜單圖片時發生錯誤，請稍後再試');
    render();
  }
}

async function handleExcelFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  if (!file.name.match(/\.(xlsx|xls|xlsm)$/i)) {
    state.errorMessage = '請選擇 Excel 檔案 (.xlsx, .xls, .xlsm)';
    render();
    return;
  }
  
  state.excelUploadFile = file;
  state.errorMessage = null;
  setLoading(true);
  
  try {
    // 先預覽 Excel
    const formData = new FormData();
    formData.append('file', file);
    
    const response = await fetch(`${API_BASE}/menu/preview-excel?userId=${encodeURIComponent(state.userId)}`, {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const err = new Error(errorData.error || '預覽 Excel 失敗');
      err.errorData = errorData;
      throw err;
    }
    
    const data = await response.json();
    
    // 確保預覽資料存在
    state.excelPreview = data.preview || [];
    state.excelDetectedMapping = data.detectedMapping;
    
    // 檢查預覽資料是否有效
    if (!state.excelPreview || !Array.isArray(state.excelPreview) || state.excelPreview.length === 0) {
      state.errorMessage = '無法讀取 Excel 檔案內容，請確認檔案格式是否正確';
      state.excelNeedsMapping = true;
      alert('❌ Excel 格式錯誤\n\n無法讀取檔案內容。請確認：\n• 檔案為有效 Excel 格式 (.xlsx, .xls, .xlsm)\n• 工作表中有資料\n• 檔案未損壞');
      state.excelMapping = { itemColumn: 'B', qtyColumn: 'C', attrColumn: '', hasHeader: true, startRow: 2 };
      setLoading(false);
      render();
      return;
    }
    
    // 如果有已儲存的對應或偵測結果，顯示預覽讓用戶確認
    if (data.savedMapping) {
      state.excelMapping = data.savedMapping;
      // 顯示預覽和欄位設定 UI，讓用戶確認後再匯入
      state.excelNeedsMapping = true;
    } else if (data.detectedMapping) {
      state.excelMapping = data.detectedMapping;
      // 顯示預覽和欄位設定 UI，讓用戶確認後再匯入
      state.excelNeedsMapping = true;
    } else {
      // 需要手動設定
      state.excelNeedsMapping = true;
      state.excelMapping = { itemColumn: 'B', qtyColumn: 'C', attrColumn: '', hasHeader: true, startRow: 2 };
      if (data.detectedMapping) {
        // 即使偵測失敗，也嘗試使用偵測結果作為預設值
        state.excelMapping = {
          itemColumn: data.detectedMapping.itemColumn || 'B',
          qtyColumn: data.detectedMapping.qtyColumn || 'C',
          attrColumn: data.detectedMapping.attrColumn || '',
          hasHeader: data.detectedMapping.hasHeader !== false,
          startRow: data.detectedMapping.startRow || 2
        };
      }
    }
  } catch (error) {
    console.error('處理 Excel 檔案失敗:', error);
    let errorMsg = error.message || '處理 Excel 檔案時發生錯誤';
    const errorData = error.errorData || {};
    if (errorData.details) {
      errorMsg = `${errorData.error || errorMsg}\n\n📌 出錯位置／原因：\n${errorData.details}`;
    } else if (errorData.hint) {
      errorMsg += '\n\n' + errorData.hint;
    }
    if (errorData.preview && Array.isArray(errorData.preview) && errorData.preview.length > 0) {
      state.excelPreview = errorData.preview;
    }
    state.errorMessage = errorMsg;
    alert('❌ Excel 格式錯誤\n\n' + errorMsg);
    state.excelNeedsMapping = true;
    // 設定預設值
    if (!state.excelMapping) {
      state.excelMapping = { itemColumn: 'B', qtyColumn: 'C', attrColumn: '', hasHeader: true, startRow: 2 };
    }
    // 如果預覽資料不存在，設為空陣列
    if (!state.excelPreview || !Array.isArray(state.excelPreview)) {
      state.excelPreview = [];
    }
  } finally {
    setLoading(false);
    render();
  }
}

async function uploadExcelWithMapping(mapping, file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('mapping', JSON.stringify(mapping));
  
  const response = await fetch(`${API_BASE}/menu/parse-excel?userId=${encodeURIComponent(state.userId)}`, {
    method: 'POST',
    body: formData
  });
  
  if (!response.ok) {
    let errorData;
    try {
      errorData = await response.json();
    } catch (e) {
      errorData = { error: `匯入失敗 (HTTP ${response.status})` };
    }
    // 建立包含詳細訊息的錯誤物件
    const error = new Error(errorData.error || '匯入 Excel 失敗');
    error.response = response;
    error.errorData = errorData;
    throw error;
  }
  
  const data = await response.json();
  
  // 重新載入菜單
  await loadMenu();
  
  state.excelUploadFile = null;
  state.excelPreview = null;
  state.excelDetectedMapping = null;
  state.excelNeedsMapping = false;
  state.errorMessage = null;
  
  alert('Excel 菜單匯入成功！');
  render();
}

async function submitExcelMapping() {
  console.log('submitExcelMapping 被調用');
  console.log('state.excelUploadFile:', state.excelUploadFile);
  console.log('state.excelMapping:', state.excelMapping);
  
  const branchColumnRaw = document.getElementById('mapping-branch')?.value.trim() || '';
  const branchColumn = branchColumnRaw ? branchColumnRaw.toUpperCase().split(/[,，\s]+/)[0] : null;
  const itemColumn = document.getElementById('mapping-item')?.value.trim().toUpperCase();
  const qtyColumn = document.getElementById('mapping-qty')?.value.trim().toUpperCase();
  const attrColumnRaw = document.getElementById('mapping-attr')?.value.trim() || '';
  const attrColumn = attrColumnRaw ? attrColumnRaw.toUpperCase().split(/[,，\s]+/)[0] : null;
  const dropdownOptionsColumnRaw = document.getElementById('mapping-dropdown-options')?.value.trim() || '';
  const dropdownOptionsColumn = dropdownOptionsColumnRaw ? dropdownOptionsColumnRaw.toUpperCase().split(/[,，\s]+/)[0] : null;
  const hasHeader = document.getElementById('mapping-has-header')?.checked || false;
  
  if (!itemColumn || !qtyColumn) {
    state.errorMessage = '請填寫品項欄位和數量欄位';
    render();
    return;
  }
  
  const mapping = {
    branchColumn: branchColumn || null,
    itemColumn,
    qtyColumn,
    attrColumn: attrColumn || null,
    dropdownOptionsColumn: dropdownOptionsColumn || null,
    hasHeader,
    startRow: hasHeader ? 2 : 1
  };
  
  if (!state.excelUploadFile) {
    state.errorMessage = '請先選擇 Excel 檔案';
    render();
    return;
  }
  
  setLoading(true);
  state.errorMessage = null;
  render(); // 立即更新 UI 顯示載入狀態
  
  try {
    console.log('開始上傳，mapping:', mapping);
    await uploadExcelWithMapping(mapping, state.excelUploadFile);
  } catch (error) {
    console.error('匯入失敗:', error);
    let errorMsg = error.message || '匯入 Excel 時發生錯誤';
    const ed = error.errorData || {};
    if (ed.details) {
      errorMsg = `${ed.error || errorMsg}\n\n📌 出錯位置／原因：\n${ed.details}`;
    } else if (ed.hint) {
      errorMsg = `${ed.error || errorMsg}\n\n${ed.hint}`;
    } else if (ed.error) {
      errorMsg = ed.error;
    }
    state.errorMessage = ed.details ? `${ed.error || '格式錯誤'}\n\n${ed.details}`.replace(/\n/g, '<br>') : errorMsg.replace(/\n/g, '<br>');
    alert('❌ Excel 格式錯誤\n\n' + errorMsg);
    // 確保顯示錯誤訊息和欄位設定 UI
    state.excelNeedsMapping = true;
    // 確保預覽仍然顯示
    if (!state.excelPreview || state.excelPreview.length === 0) {
      // 如果預覽丟失，嘗試重新獲取（但這通常不會發生）
      console.warn('預覽資料丟失，但檔案仍在');
    }
  } finally {
    setLoading(false);
    render();
  }
}

/**
 * 渲染成員名單頁面
 */
function renderMembersPage(container) {
  const members = state.members || [];
  const currentWorld = state.worlds && state.worlds.find(w => w.id === state.currentWorldId);
  const isOwner = currentWorld && currentWorld.role === 'owner';
  
  container.innerHTML = `
    <div class="page-order">
      <div class="order-header">
        <span class="order-title">成員名單</span>
      </div>
      <div class="order-content">
        ${state.isLoading ? '<div class="loading">載入中...</div>' : ''}
        ${state.errorMessage ? `<div class="error-message">${escapeHtml(state.errorMessage)}</div>` : ''}
        ${!state.isLoading && !state.errorMessage && members.length === 0 ? '<div class="empty-message">尚無成員</div>' : ''}
        ${!state.isLoading && !state.errorMessage && members.length > 0 ? `
          <div class="members-list">
            ${members.map(member => `
              <div class="member-card">
                <div class="member-info">
                  <span class="member-role">${member.role === 'owner' ? '👑 擁有者' : '👤 成員'}</span>
                  <div class="member-name-block">
                    <span class="member-name">${escapeHtml(member.displayName || member.userId)}</span>
                    <span class="member-id">LINE ID：${escapeHtml(member.userId)}</span>
                  </div>
                  ${isOwner && member.role !== 'owner' ? `
                    <button type="button" class="member-remove-btn" onclick="orderWeb.removeMember('${escapeJsAttr(member.userId)}')">剔除</button>
                  ` : ''}
                </div>
                <div class="member-date">加入時間：${formatDateTime(member.created_at)}</div>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    </div>
    ${navBottom()}
  `;
}

/**
 * 查詢成員名單
 */
async function fetchMembers() {
  if (!state.userId || !state.currentWorldId) {
    state.errorMessage = '無法取得世界資訊';
    render();
    return;
  }
  
  setLoading(true);
  state.errorMessage = null;
  
  try {
    const response = await fetch(`${API_BASE}/worlds/${state.currentWorldId}/members?userId=${encodeURIComponent(state.userId)}`);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: '查詢成員名單失敗' }));
      throw new Error(errorData.error || '查詢成員名單失敗');
    }
    
    const data = await response.json();
    state.members = data.members || [];
  } catch (error) {
    state.errorMessage = error.message || '查詢成員名單時發生錯誤，請稍後再試';
    state.members = [];
  } finally {
    setLoading(false);
    render();
  }
}

/**
 * 剔除成員（僅 owner 使用）
 */
async function removeMember(userId) {
  if (!userId) return;
  if (!state.userId || !state.currentWorldId) {
    showError('無法取得世界或使用者資訊');
    return;
  }

  if (!confirm('確定要剔除這位成員嗎？\n\n剔除後，該成員將無法再使用此世界的訂單功能。')) {
    return;
  }

  setLoading(true);
  state.errorMessage = null;
  try {
    const response = await fetch(`${API_BASE}/worlds/${state.currentWorldId}/remove-member`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        userId: state.userId,
        targetUserId: userId
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.success) {
      throw new Error(data.error || '剔除成員失敗');
    }

    // 重新載入成員名單
    await fetchMembers();
  } catch (error) {
    showError(error.message || '剔除成員時發生錯誤，請稍後再試');
  } finally {
    setLoading(false);
    render();
  }
}

/**
 * 格式化日期時間
 * SQLite CURRENT_TIMESTAMP 儲存為 UTC 時間，需加上 'Z' 讓瀏覽器正確解析為 UTC
 */
function formatDateTime(dateTimeStr) {
  if (!dateTimeStr) return '';
  try {
    // SQLite 格式：'YYYY-MM-DD HH:MM:SS'（UTC 時間，但沒有時區標記）
    // 加上 'Z' 讓瀏覽器知道這是 UTC 時間，會自動轉為本地時區
    let dateStr = dateTimeStr;
    if (dateStr && !dateStr.includes('Z') && !dateStr.includes('+') && !dateStr.includes('T')) {
      // 格式：'YYYY-MM-DD HH:MM:SS' -> 'YYYY-MM-DDTHH:MM:SSZ'
      dateStr = dateStr.replace(' ', 'T') + 'Z';
    }
    
    const date = new Date(dateStr);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  } catch (e) {
    return dateTimeStr;
  }
}

function goCreateOrJoinWorld() {
  state.view = 'create_or_join_world';
  state.createOrJoinStep = 'select';
  state.worldIdInput = '';
  state.worldNameInput = '';
  state.orderFormatItems = [];
  state.bossFormatFields = ['廠商', '品項', '屬性', '訂購人'];
  state.errorMessage = null;
  render();
}

function backCreateOrJoin() {
  if (state.view === 'join_world') {
    state.view = 'create_or_join_world';
  } else if (state.view === 'create_world') {
    // 從創建世界返回到選擇頁面，需要確認
    if (!confirm('創建世界中離開頁面將重新設定，確定要離開嗎？')) {
      return;
    }
    state.view = 'create_or_join_world';
  } else {
    state.view = 'worlds';
  }
  state.errorMessage = null;
  render();
}

/**
 * 渲染加入/創造世界流程頁面（設計4）
 */
function renderCreateOrJoinWorldPage(container) {
  switch (state.view) {
    case 'create_or_join_world':
      renderCreateOrJoinSelect(container);
      break;
    case 'join_world':
      renderJoinWorldInput(container);
      break;
    case 'create_world':
      renderCreateWorldInput(container);
      break;
    default:
      renderCreateOrJoinSelect(container);
  }
}

/**
 * 投影片1：選擇加入世界或創建世界
 */
function renderCreateOrJoinSelect(container) {
  container.innerHTML = `
    <div class="page-create-join" data-flow-step="1" data-flow-total="5">
      <div class="create-join-header">
        <button type="button" class="btn-back" onclick="orderWeb.backCreateOrJoin()">← 返回</button>
        <div class="label-block">加入/創造世界</div>
      </div>
      <div class="create-join-options">
        <button type="button" class="btn-create-join-option" onclick="orderWeb.goJoinWorld()">加入世界</button>
        <button type="button" class="btn-create-join-option" onclick="orderWeb.goCreateWorld()">創建世界</button>
      </div>
    </div>
    ${navBottom()}
  `;
}

/**
 * 投影片2：加入世界 - 輸入世界ID
 */
function renderJoinWorldInput(container) {
  container.innerHTML = `
    <div class="page-create-join" data-flow-step="2" data-flow-total="5">
      <div class="create-join-header">
        <button type="button" class="btn-back" onclick="orderWeb.backCreateOrJoin()">← 返回</button>
        <div class="label-block">加入世界</div>
      </div>
      <div class="create-join-content">
        <input type="text" class="input-world-id" placeholder="請輸入世界ID" value="${escapeHtml(state.worldIdInput)}" oninput="orderWeb.setWorldIdInput(this.value)">
        <button type="button" class="btn-block" onclick="orderWeb.submitJoinWorld()" ${state.isLoading ? 'disabled' : ''}>${state.isLoading ? '處理中...' : '確認'}</button>
        ${state.errorMessage ? `<p class="error-message">${escapeHtml(state.errorMessage)}</p>` : ''}
      </div>
    </div>
    ${navBottom()}
  `;
}

/**
 * 投影片3：創建世界 - 輸入世界名稱
 */
function renderCreateWorldInput(container) {
  container.innerHTML = `
    <div class="page-create-join" data-flow-step="3" data-flow-total="5">
      <div class="create-join-header">
        <button type="button" class="btn-back" onclick="orderWeb.backCreateOrJoin()">← 返回</button>
        <div class="label-block">創建世界</div>
      </div>
      <div class="create-join-content">
        <input type="text" class="input-world-name" placeholder="請為世界命名" value="${escapeHtml(state.worldNameInput)}" oninput="orderWeb.setWorldNameInput(this.value)">
        <button type="button" class="btn-block" onclick="orderWeb.submitCreateWorld()" ${state.isLoading ? 'disabled' : ''}>${state.isLoading ? '處理中...' : '確認'}</button>
        ${state.errorMessage ? `<p class="error-message">${escapeHtml(state.errorMessage)}</p>` : ''}
      </div>
    </div>
    ${navBottom()}
  `;
}

/**
 * 投影片4：客戶訂單格式設定
 */
function renderSetupOrderFormat(container) {
  const items = state.orderFormatItems.length > 0 ? state.orderFormatItems : [{ name: '', attributes: [] }];
  
  container.innerHTML = `
    <div class="page-create-join" data-flow-step="4" data-flow-total="5">
      <div class="create-join-header">
        <button type="button" class="btn-back" onclick="orderWeb.backCreateOrJoin()">← 返回</button>
        <div class="label-block">創建世界</div>
      </div>
      <div class="format-section">
        <div class="label-block format-title">客戶訂單格式</div>
        <div class="format-items">
          ${items.map((item, idx) => {
            const attributes = item.attributes || [];
            return `
            <div class="format-item-container">
              <div class="format-item-row">
                <button type="button" class="btn-format-item-name" onclick="orderWeb.editItemName(${idx})">${escapeHtml(item.name || '品項名稱')}</button>
                ${attributes.length === 0 ? `
                  <button type="button" class="btn-format-attr" onclick="orderWeb.editAttribute(${idx})">屬性</button>
                ` : ''}
                <button type="button" class="btn-format-attr-plus" onclick="orderWeb.addAttribute(${idx})">屬性+</button>
                <button type="button" class="btn-format-item-remove" onclick="orderWeb.removeFormatItem(${idx})" title="刪除品項">×</button>
              </div>
              ${attributes.length > 0 ? `
                <div class="format-attributes-list">
                  ${attributes.map((attr, attrIdx) => {
                    const label = attr.name || '屬性名稱';
                    const opts = (attr.options && Array.isArray(attr.options) && attr.options.length) ? attr.options.join('、') : '';
                    const display = opts ? `${label} (${opts})` : label;
                    return `
                    <div class="format-attribute-item">
                      <button type="button" class="btn-format-attr" onclick="orderWeb.editAttribute(${idx}, ${attrIdx})" title="${opts ? '格式：名稱,選項1,選項2,...' : ''}">${escapeHtml(display)}</button>
                      <button type="button" class="btn-format-attr-remove" onclick="orderWeb.removeAttribute(${idx}, ${attrIdx})" title="移除屬性">×</button>
                    </div>
                  `;
                  }).join('')}
                </div>
              ` : ''}
            </div>
          `;
          }).join('')}
          <button type="button" class="btn-format-add-row" onclick="orderWeb.addFormatItemRow()">＋ 新增品項</button>
        </div>
        <button type="button" class="btn-block" onclick="orderWeb.completeOrderFormat()" ${state.isLoading ? 'disabled' : ''}>完成</button>
        ${state.errorMessage ? `<p class="error-message">${escapeHtml(state.errorMessage)}</p>` : ''}
      </div>
    </div>
    ${navBottom()}
  `;
}

/**
 * 投影片5：老闆訂單分類格式設定
 */
function renderSetupBossFormat(container) {
  container.innerHTML = `
    <div class="page-create-join" data-flow-step="5" data-flow-total="5">
      <div class="create-join-header">
        <button type="button" class="btn-back" onclick="orderWeb.backCreateOrJoin()">← 返回</button>
        <div class="label-block">創建世界</div>
      </div>
      <div class="format-section">
        <div class="label-block format-title">老闆訂單分類格式</div>
        <p class="description" style="margin: var(--spacing-md) 0; color: var(--color-text-light); font-size: 0.875rem;">拖曳欄位可調整順序</p>
        <div class="boss-format-fields" id="boss-format-fields">
          ${state.bossFormatFields.map((field, idx) => `
            <div class="boss-field-item" draggable="true" data-index="${idx}">
              <button type="button" class="btn-boss-field">${escapeHtml(field)}</button>
            </div>
          `).join('')}
        </div>
        <button type="button" class="btn-block" onclick="orderWeb.completeBossFormat()" ${state.isLoading ? 'disabled' : ''}>完成</button>
        ${state.errorMessage ? `<p class="error-message">${escapeHtml(state.errorMessage)}</p>` : ''}
      </div>
    </div>
    ${navBottom()}
  `;
  
  // 設定拖曳事件
  setupBossFormatDragAndDrop();
}

/**
 * 設定老闆訂單分類格式的拖曳功能
 */
function setupBossFormatDragAndDrop() {
  const container = document.getElementById('boss-format-fields');
  if (!container) return;
  
  let draggedElement = null;
  let draggedIndex = null;
  
  // 拖曳開始
  container.addEventListener('dragstart', (e) => {
    if (e.target.classList.contains('boss-field-item')) {
      draggedElement = e.target;
      draggedIndex = parseInt(e.target.dataset.index);
      e.target.style.opacity = '0.5';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/html', e.target.innerHTML);
    }
  });
  
  // 拖曳結束
  container.addEventListener('dragend', (e) => {
    if (e.target.classList.contains('boss-field-item')) {
      e.target.style.opacity = '1';
      // 移除所有拖曳相關的樣式
      const items = container.querySelectorAll('.boss-field-item');
      items.forEach(item => {
        item.classList.remove('drag-over');
      });
    }
  });
  
  // 拖曳經過
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    const target = e.target.closest('.boss-field-item');
    if (target && target !== draggedElement) {
      target.classList.add('drag-over');
    }
  });
  
  // 拖曳離開
  container.addEventListener('dragleave', (e) => {
    const target = e.target.closest('.boss-field-item');
    if (target) {
      target.classList.remove('drag-over');
    }
  });
  
  // 放置
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    
    const target = e.target.closest('.boss-field-item');
    if (target && draggedElement && target !== draggedElement) {
      const targetIndex = parseInt(target.dataset.index);
      
      // 重新排序陣列
      const fields = [...state.bossFormatFields];
      const [removed] = fields.splice(draggedIndex, 1);
      fields.splice(targetIndex, 0, removed);
      
      state.bossFormatFields = fields;
      
      // 重新渲染並重新設定拖曳事件
      render();
    } else {
      // 即使沒有移動，也要清除樣式
      const items = container.querySelectorAll('.boss-field-item');
      items.forEach(item => {
        item.classList.remove('drag-over');
      });
    }
  });
}

function goJoinWorld() {
  state.view = 'join_world';
  state.worldIdInput = '';
  state.errorMessage = null;
  render();
}

function goCreateWorld() {
  state.view = 'create_world';
  state.worldNameInput = '';
  state.errorMessage = null;
  render();
}

function setWorldIdInput(val) {
  state.worldIdInput = (val || '').trim();
}

function setWorldNameInput(val) {
  state.worldNameInput = (val || '').trim();
}

async function submitJoinWorld() {
  if (!state.worldIdInput) {
    state.errorMessage = '請輸入世界ID或世界代碼';
    render();
    return;
  }
  
  setLoading(true);
  state.errorMessage = null;
  
  try {
    const input = state.worldIdInput.trim();
    
    // 判斷是 worldId 還是 worldCode
    // worldId: 數字或 #數字
    // worldCode: 8 位大寫字母數字組合
    let worldId = null;
    let worldCode = null;
    
    const numMatch = input.match(/^#?(\d+)$/);
    if (numMatch) {
      worldId = parseInt(numMatch[1], 10);
      if (isNaN(worldId) || worldId <= 0) {
        throw new Error('無效的世界 ID');
      }
    } else if (/^[A-Z0-9]{6,}$/.test(input.toUpperCase())) {
      worldCode = input.toUpperCase();
    } else {
      throw new Error('請輸入有效的世界 ID（數字）或世界代碼（6 位以上字母數字）');
    }
    
    const response = await fetch(`${API_BASE}/worlds/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.userId,
        worldId: worldId,
        worldCode: worldCode
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: '加入世界失敗' }));
      throw new Error(errorData.error || '加入世界失敗');
    }
    
    const data = await response.json();
    
    // 重新載入世界列表
    await fetchWorlds(state.userId);
    
    // 設定為當前世界
    if (data.world && data.world.id) {
      state.currentWorldId = data.world.id;
      state.currentWorldName = data.world.name || `世界 #${data.world.id}`;
      state.currentWorldCode = data.world.worldCode || null;
    }
    
    state.view = 'worlds';
    state.worldIdInput = '';
    render();
  } catch (error) {
    state.errorMessage = error.message || '加入世界失敗，請稍後再試';
    render();
  } finally {
    setLoading(false);
  }
}

async function submitCreateWorld() {
  if (!state.worldNameInput) {
    state.errorMessage = '請輸入世界名稱';
    render();
    return;
  }
  
  if (!state.userId) {
    state.errorMessage = '使用者未登入';
    render();
    return;
  }
  
  setLoading(true);
  state.errorMessage = null;
  
  try {
    const response = await fetch(`${API_BASE}/worlds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.userId,
        name: state.worldNameInput
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || '創建世界失敗');
    }
    
    const data = await response.json();
    state.currentWorldId = data.world.id;
    state.currentWorldName = data.world.name;
    state.currentWorldCode = data.world.worldCode || null;
    
    // 重新載入世界列表
    await fetchWorlds(state.userId);
    
    // 直接進入訂單頁面（簡化流程，移除格式設定步驟）
    state.view = 'order';
    state.currentStep = 'select_items';
    state.selectedItems = [];
    
    // 清空菜單（新創建的世界還沒有菜單）
    state.menu = null;
    state.itemImages = {};
    state.vendorItemMap = {};
    state.baseItemToMenuMap = {};
    
    // 嘗試載入菜單（如果有的話，但新創建的世界應該沒有）
    try {
      await loadMenu();
    } catch (error) {
      // 如果沒有菜單，這是正常的（需要先上傳 Excel）
      console.log('世界已創建，但尚未設定菜單（這是正常的）');
      state.menu = null;
    }
    
    render();
  } catch (error) {
    state.errorMessage = error.message || '創建世界失敗，請稍後再試';
    render();
  } finally {
    setLoading(false);
  }
}

function editItemName(idx) {
  const name = prompt('請輸入品項名稱：', state.orderFormatItems[idx]?.name || '');
  if (name !== null) {
    if (!state.orderFormatItems[idx]) state.orderFormatItems[idx] = { name: '', attributes: [] };
    state.orderFormatItems[idx].name = name.trim();
    render();
  }
}

/** 解析屬性輸入：「名稱,選項1,選項2,...」→ { name, options[] }；僅名稱 → { name } */
function parseAttributeInput(input) {
  const s = (input || '').trim();
  if (!s) return null;
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { name: parts[0] };
  return { name: parts[0], options: parts.slice(1) };
}

function editAttribute(itemIdx, attrIdx) {
  if (!state.orderFormatItems[itemIdx]) return;
  if (!state.orderFormatItems[itemIdx].attributes) {
    state.orderFormatItems[itemIdx].attributes = [];
  }
  if (attrIdx === undefined || attrIdx === null) {
    if (state.orderFormatItems[itemIdx].attributes.length === 0) {
      addAttribute(itemIdx);
      return;
    }
    attrIdx = 0;
  }
  const currentAttr = state.orderFormatItems[itemIdx].attributes[attrIdx];
  const currentDisplay = currentAttr
    ? (currentAttr.options && currentAttr.options.length
      ? [currentAttr.name, ...(currentAttr.options || [])].join(', ')
      : (currentAttr.name || ''))
    : '';
  const attrInput = prompt('格式：屬性名稱,選項1,選項2,...\n例如：甜度,正常甜,半糖,微糖,無糖\n（僅名稱則無下拉選項）', currentDisplay);
  const parsed = parseAttributeInput(attrInput);
  if (parsed) {
    if (!state.orderFormatItems[itemIdx].attributes[attrIdx]) {
      state.orderFormatItems[itemIdx].attributes[attrIdx] = { name: '' };
    }
    state.orderFormatItems[itemIdx].attributes[attrIdx].name = parsed.name;
    state.orderFormatItems[itemIdx].attributes[attrIdx].options = parsed.options || undefined;
    render();
  }
}

function addAttribute(itemIdx) {
  if (!state.orderFormatItems[itemIdx]) {
    state.orderFormatItems[itemIdx] = { name: '', attributes: [] };
  }
  if (!state.orderFormatItems[itemIdx].attributes) {
    state.orderFormatItems[itemIdx].attributes = [];
  }
  const attrInput = prompt('格式：屬性名稱,選項1,選項2,...\n例如：甜度,正常甜,半糖,微糖,無糖\n（僅名稱則無下拉選項）', '');
  const parsed = parseAttributeInput(attrInput);
  if (parsed) {
    state.orderFormatItems[itemIdx].attributes.push({ name: parsed.name, ...(parsed.options && parsed.options.length ? { options: parsed.options } : {}) });
    render();
  }
}

function removeAttribute(itemIdx, attrIdx) {
  if (!state.orderFormatItems[itemIdx] || !state.orderFormatItems[itemIdx].attributes) return;
  if (confirm('確定要移除這個屬性嗎？')) {
    state.orderFormatItems[itemIdx].attributes.splice(attrIdx, 1);
    render();
  }
}

function addFormatItemRow() {
  state.orderFormatItems.push({ name: '', attributes: [] });
  render();
}

function removeFormatItem(itemIdx) {
  if (state.orderFormatItems.length <= 1) {
    // 至少保留一個品項
    if (confirm('這是最後一個品項，刪除後將新增一個空白品項。確定要刪除嗎？')) {
      state.orderFormatItems[itemIdx] = { name: '', attributes: [] };
      render();
    }
  } else {
    if (confirm('確定要刪除此品項嗎？')) {
      state.orderFormatItems.splice(itemIdx, 1);
      render();
    }
  }
}

async function completeOrderFormat() {
  // 驗證至少有一個品項有名稱
  const hasValidItem = state.orderFormatItems.some(item => item.name && item.name.trim());
  if (!hasValidItem) {
    state.errorMessage = '請至少設定一個品項名稱';
    render();
    return;
  }
  
  if (!state.userId || !state.currentWorldId) {
    state.errorMessage = '世界資訊不完整，請重新創建世界';
    render();
    return;
  }
  
  setLoading(true);
  state.errorMessage = null;
  
  try {
    // 將 orderFormatItems 轉換為 orderFormat JSON（支援 attr.options）
    const orderFormat = {
      items: state.orderFormatItems.map(item => ({
        name: item.name,
        attributes: (item.attributes || []).map(attr => {
          const name = (typeof attr === 'object' && attr && attr.name) ? attr.name : String(attr || '');
          const options = (typeof attr === 'object' && attr && Array.isArray(attr.options)) ? attr.options : undefined;
          return options && options.length ? { name, options } : { name };
        })
      }))
    };
    
    const response = await fetch(`${API_BASE}/worlds/order-format?userId=${encodeURIComponent(state.userId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderFormat: JSON.stringify(orderFormat)
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || '設定客戶訂單格式失敗');
    }
    
    state.view = 'setup_boss_format';
    render();
  } catch (error) {
    state.errorMessage = error.message || '設定失敗，請稍後再試';
    render();
  } finally {
    setLoading(false);
  }
}

function addBossField() {
  const field = prompt('請輸入欄位名稱：', '');
  if (field !== null && field.trim()) {
    state.bossFormatFields.push(field.trim());
    render();
  }
}

async function completeBossFormat() {
  if (!state.userId || !state.currentWorldId) {
    state.errorMessage = '世界資訊不完整，請重新創建世界';
    render();
    return;
  }
  
  setLoading(true);
  state.errorMessage = null;
  
  try {
    // 將 bossFormatFields 轉換為 displayFormat JSON
    const displayFormat = {
      template: state.bossFormatFields.map((field, idx) => {
        const vars = {
          '廠商': '{vendor}',
          '品項': '{item}',
          '屬性': '{attributes}',
          '訂購人': '{users}'
        };
        return vars[field] || `{${field}}`;
      }).join(' '),
      showUsers: state.bossFormatFields.includes('訂購人'),
      fields: state.bossFormatFields
    };
    
    const response = await fetch(`${API_BASE}/worlds/display-format?userId=${encodeURIComponent(state.userId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayFormat: JSON.stringify(displayFormat)
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || '設定老闆訂單分類格式失敗');
    }
    
    // 重新載入世界列表（世界狀態已在後端自動更新為 active）
    await fetchWorlds(state.userId);
    
    // 清除創建世界的相關狀態
    state.worldNameInput = '';
    state.orderFormatItems = [];
    state.bossFormatFields = ['廠商', '品項', '屬性', '訂購人'];
    state.currentWorldId = null;
    state.currentWorldName = '當前 世界名稱';
    
    state.view = 'worlds';
    render();
  } catch (error) {
    state.errorMessage = error.message || '設定失敗，請稍後再試';
    render();
  } finally {
    setLoading(false);
  }
}

window.orderWeb = {
  triggerLineLogin,
  recheckOfficialAccount,
  adjustItemQty,
  setPurchaserName,
  setItemQtyFromInput,
  addItemAttribute,
  removeItemAttribute,
  removeItemAttributeById,
  toggleItemAttribute,
  setItemAttributeValue,
  setItemAttributeFromSelect,
  openAttrModal,
  closeAttrModal,
  confirmAttrModal,
  duplicateItemWithAttributes,
  goBack,
  goToConfirm,
  submitOrder,
  resetOrder,
  goHelp,
  goWorlds,
  goWorldsWithConfirm,
  goMe,
  goMeWithConfirm,
  goMenu,
  closeMenuImageView,
  goMembers,
  goCreateOrJoinWorld,
  fetchWorlds,
  backCreateOrJoin,
  goJoinWorld,
  goCreateWorld,
  setWorldIdInput,
  setWorldNameInput,
  submitJoinWorld,
  submitCreateWorld,
  editItemName,
  editAttribute,
  addAttribute,
  removeAttribute,
  completeOrderFormat,
  addFormatItemRow,
  removeFormatItem,
  addBossField,
  completeBossFormat,
  selectWorld,
  toggleLeaveWorldMode,
  leaveWorld,
  deleteWorld,
  setMyOrdersDate,
  setMyOrdersWorld,
  handleDateTypeChange,
  switchMyOrdersTab,
  fetchReceivedOrders,
  setReceivedViewMode,
  openExcelExportColumnsDialog,
  closeExcelExportColumnsDialog,
  saveExcelExportColumns,
  toggleExcelColumn,
  startEditExcelColumnLabel,
  saveExcelColumnLabel,
  exportReceivedOrdersToExcel,
  backFromMenuManage,
  handleExcelFileSelect,
  submitExcelMapping,
  handleItemImageUpload,
  deleteItemImage,
  handleMenuImageUpload,
  deleteMenuImage,
  removeMember,
  openOrderDetail,
  openOrderDetailByOrderId,
  closeOrderDetail,
  setOrderDetailSelectedMenuItem,
  setOrderDetailNewItemAttr,
  updateOrderItemQtyLocal,
  adjustOrderItemQtyLocal,
  adjustOrderDetailNewItemQty,
  setOrderDetailNewItemQty,
  deleteOrderItemLocal,
  addOrderItemLocal,
  confirmOrderEdit,
  cancelOrderConfirm,
  restoreOrder,
  render
};

// DOM 載入完成後初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// 手機版：僅在「跨過 639px 斷點」時重繪，避免手機位址列/鍵盤/捲動觸發 resize 造成閃爍
let _resizeTimer = null;
let _lastMobile = isMobileView();
window.addEventListener('resize', () => {
  if (_resizeTimer) clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    const nowMobile = isMobileView();
    if (nowMobile !== _lastMobile) {
      _lastMobile = nowMobile;
      if (state.view === 'order' && state.currentStep === 'select_items') render();
    }
  }, 200);
});
