/**
 * Excel 處理服務
 * - 智能偵測 Excel 欄位
 * - 解析 Excel 並轉換成 vendorMap 格式
 */

import XLSX from 'xlsx';

/**
 * 智能偵測 Excel 欄位對應
 * @param {Object} workbook - XLSX workbook 物件
 * @param {string} sheetName - 工作表名稱（預設第一個）
 * @returns {Object|null} { branchColumn, itemColumn, qtyColumn, hasHeader, startRow } 或 null
 */
export function detectExcelMapping(workbook, sheetName = null) {
  try {
    const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return null;

    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    if (range.e.c < 0 || range.e.r < 0) return null;

    // 讀取前 10 行來偵測
    const maxRows = Math.min(10, range.e.r + 1);
    const data = [];
    for (let r = 0; r < maxRows; r++) {
      const row = [];
      for (let c = 0; c <= range.e.c; c++) {
        const cellAddress = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[cellAddress];
        row.push(cell ? (cell.v !== undefined ? String(cell.v).trim() : '') : '');
      }
      data.push(row);
    }

    if (data.length === 0) return null;

    // 關鍵字匹配（繁體中文、簡體中文、英文）
    // 注意：branchColumn 實際上是「廠商欄位」，但變數名稱保持 branchColumn 以保持向後相容
    const branchKeywords = ['分店', '店家', '廠商', '店名', '店舖', '商店', 'branch', 'vendor', 'store', 'shop'];
    const itemKeywords = ['品項', '商品', '名稱', '項目', 'item', 'product', 'name', '商品名稱', '品項名稱'];
    const qtyKeywords = ['數量', 'qty', 'quantity'];
    const attrKeywords = ['屬性', '規格', '選項', 'attribute', 'attr', 'option', 'spec'];
    const dropdownOptionsKeywords = ['下拉選項', '屬性格式', '屬性下拉', 'dropdown', 'options', '選項格式'];
    let dropdownOptionsColumn = null;

    // 檢查第一行是否為標題
    let hasHeader = false;
    let branchColumn = null;
    let itemColumn = null;
    let qtyColumn = null;
    let attrColumn = null;
    let startRow = 1;

    // 先檢查第一行是否包含關鍵字
    const firstRow = data[0];
    let headerMatchCount = 0;
    for (let c = 0; c < firstRow.length; c++) {
      const cellValue = firstRow[c].toLowerCase();
      if (!branchColumn && branchKeywords.some(kw => cellValue.includes(kw.toLowerCase()))) {
        branchColumn = XLSX.utils.encode_col(c);
        headerMatchCount++;
      }
      if (!itemColumn && itemKeywords.some(kw => cellValue.includes(kw.toLowerCase()))) {
        itemColumn = XLSX.utils.encode_col(c);
        headerMatchCount++;
      }
      if (!qtyColumn && qtyKeywords.some(kw => cellValue.includes(kw.toLowerCase()))) {
        qtyColumn = XLSX.utils.encode_col(c);
        headerMatchCount++;
      }
      // 「屬性格式」「下拉選項」等欄位只當下拉選項用，不當成該列的屬性值；避免「屬性格式」被當成 attrColumn
      if (!attrColumn && attrKeywords.some(kw => cellValue.includes(kw.toLowerCase())) && !dropdownOptionsKeywords.some(kw => cellValue.includes(kw.toLowerCase()))) {
        attrColumn = XLSX.utils.encode_col(c);
      }
      if (!dropdownOptionsColumn && dropdownOptionsKeywords.some(kw => cellValue.includes(kw.toLowerCase()))) {
        dropdownOptionsColumn = XLSX.utils.encode_col(c);
      }
    }

    // 如果第一行匹配到至少 2 個關鍵字，視為標題行
    if (headerMatchCount >= 2) {
      hasHeader = true;
      startRow = 2; // 資料從第 2 行開始（Excel 第 2 行，索引 1）
    } else if (headerMatchCount === 1) {
      // 只匹配到 1 個關鍵字，可能是標題行，但需要補充其他欄位
      hasHeader = true;
      startRow = 2;
      // 嘗試推測缺少的欄位
      if (!itemColumn && !qtyColumn) {
        // 如果只找到分店欄，假設後面是品項和數量
        if (branchColumn) {
          const branchColIndex = XLSX.utils.decode_col(branchColumn);
          if (data[0].length > branchColIndex + 1) {
            itemColumn = XLSX.utils.encode_col(branchColIndex + 1);
          }
          if (data[0].length > branchColIndex + 2) {
            qtyColumn = XLSX.utils.encode_col(branchColIndex + 2);
          }
        }
      } else if (!itemColumn) {
        // 如果找到數量欄但沒有品項欄，假設數量欄前面是品項欄
        if (qtyColumn) {
          const qtyColIndex = XLSX.utils.decode_col(qtyColumn);
          if (qtyColIndex > 0) {
            itemColumn = XLSX.utils.encode_col(qtyColIndex - 1);
          }
        }
      } else if (!qtyColumn) {
        // 如果找到品項欄但沒有數量欄，假設品項欄後面是數量欄
        if (itemColumn) {
          const itemColIndex = XLSX.utils.decode_col(itemColumn);
          if (data[0].length > itemColIndex + 1) {
            qtyColumn = XLSX.utils.encode_col(itemColIndex + 1);
          }
        }
      }
    } else {
      // 沒有標題行，從第一行開始，嘗試智能推測欄位
      // 假設：第一欄是分店，第二欄是品項，第三欄是數量
      if (data[0].length >= 3) {
        branchColumn = branchColumn || 'A';
        itemColumn = itemColumn || 'B';
        qtyColumn = qtyColumn || 'C';
        startRow = 1;
      } else if (data[0].length >= 2) {
        // 只有兩欄：假設第一欄是品項，第二欄是數量（沒有分店）
        itemColumn = itemColumn || 'A';
        qtyColumn = qtyColumn || 'B';
        startRow = 1;
      }
    }

    // 如果還是沒找到品項或數量欄，嘗試從資料內容推測
    if (!itemColumn || !qtyColumn) {
      // 檢查每一欄的資料類型
      const columnTypes = [];
      for (let c = 0; c < Math.min(5, data[0].length); c++) {
        let hasNumber = false;
        let hasText = false;
        for (let r = hasHeader ? 1 : 0; r < Math.min(hasHeader ? 6 : 5, data.length); r++) {
          const value = data[r][c];
          if (value && !isNaN(value) && value !== '') {
            hasNumber = true;
          } else if (value && value.trim() !== '') {
            hasText = true;
          }
        }
        if (hasNumber && !hasText) {
          columnTypes[c] = 'number';
        } else if (hasText) {
          columnTypes[c] = 'text';
        }
      }

      // 推測：最後一個數字欄是數量，文字欄是品項或分店
      if (!qtyColumn) {
        let foundQty = false;
        for (let c = columnTypes.length - 1; c >= 0; c--) {
          if (columnTypes[c] === 'number' && !foundQty) {
            qtyColumn = XLSX.utils.encode_col(c);
            foundQty = true;
            break;
          }
        }
      }

      // 品項欄：倒數第二個文字欄（如果數量欄存在）
      if (!itemColumn && qtyColumn) {
        const qtyColIndex = XLSX.utils.decode_col(qtyColumn);
        for (let c = qtyColIndex - 1; c >= 0; c--) {
          if (columnTypes[c] === 'text') {
            itemColumn = XLSX.utils.encode_col(c);
            break;
          }
        }
      }

      // 分店欄：第一個文字欄（如果還有其他文字欄）
      if (!branchColumn && itemColumn) {
        const itemColIndex = XLSX.utils.decode_col(itemColumn);
        for (let c = 0; c < itemColIndex; c++) {
          if (columnTypes[c] === 'text') {
            branchColumn = XLSX.utils.encode_col(c);
            break;
          }
        }
      }
    }

    // 驗證：至少要有品項和數量欄
    if (!itemColumn || !qtyColumn) {
      return null;
    }

    return {
      branchColumn: branchColumn || null,
      itemColumn,
      qtyColumn,
      attrColumn: attrColumn || null,
      dropdownOptionsColumn: dropdownOptionsColumn || null,
      hasHeader,
      startRow: hasHeader ? 2 : 1
    };
  } catch (err) {
    console.error('❌ 智能偵測 Excel 欄位失敗:', err);
    return null;
  }
}

/**
 * 解析屬性字串為陣列（支援逗號、分號、空白分隔）
 * @param {string} str - 屬性字串，如 "冰塊,糖度" 或 "冰塊；糖度"
 * @returns {string[]} 屬性陣列
 */
function parseAttributes(str) {
  if (!str || typeof str !== 'string') return [];
  return str
    .split(/[,，;；\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * 解析「下拉選項」儲存格：格式「名稱,選項1,選項2,...」；多個屬性用分號分隔「甜度,正常甜,半糖;冰塊,去冰,微冰」
 * @param {string} str - 儲存格內容
 * @returns {Array<{ name: string, options: string[] }>} 屬性與選項陣列
 */
function parseDropdownOptionsCell(str) {
  if (!str || typeof str !== 'string') return [];
  const parts = str.split(/[;；]/).map(s => s.trim()).filter(Boolean);
  const result = [];
  for (const part of parts) {
    const tokens = part.split(',').map(s => s.trim()).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens.length === 1) {
      result.push({ name: tokens[0], options: [] });
    } else {
      result.push({ name: tokens[0], options: tokens.slice(1) });
    }
  }
  return result;
}

/**
 * 從 Excel 解析「品項 → 下拉選項定義」（依「下拉選項」欄位）
 * 每個品項取第一筆非空的「下拉選項」作為該品項的屬性與選項。
 * @param {Object} workbook - XLSX workbook
 * @param {Object} mapping - { branchColumn?, itemColumn, qtyColumn, attrColumn?, dropdownOptionsColumn?, hasHeader, startRow }
 * @param {string} sheetName - 工作表名稱（預設第一個）
 * @returns {Object} { [itemName]: Array<{ name: string, options: string[] }> }
 */
export function parseExcelToItemAttributeOptions(workbook, mapping, sheetName = null) {
  try {
    const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return {};

    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    if (range.e.c < 0 || range.e.r < 0) return {};

    const dropdownColIndex = mapping.dropdownOptionsColumn !== undefined && mapping.dropdownOptionsColumn !== null
      ? XLSX.utils.decode_col(mapping.dropdownOptionsColumn) : null;
    if (dropdownColIndex === null) return {};

    const startRow = mapping.startRow || (mapping.hasHeader ? 2 : 1);
    const itemColIndex = XLSX.utils.decode_col(mapping.itemColumn);
    const result = {};

    for (let r = startRow - 1; r <= range.e.r; r++) {
      const itemCell = sheet[XLSX.utils.encode_cell({ r, c: itemColIndex })];
      const dropdownCell = sheet[XLSX.utils.encode_cell({ r, c: dropdownColIndex })];
      const itemName = itemCell && itemCell.v !== undefined ? String(itemCell.v).trim() : '';
      const dropdownStr = dropdownCell && dropdownCell.v !== undefined ? String(dropdownCell.v).trim() : '';
      if (!itemName || !dropdownStr) continue;
      if (result[itemName]) continue; // 每個品項只取第一筆非空
      const parsed = parseDropdownOptionsCell(dropdownStr);
      if (parsed.length > 0) result[itemName] = parsed;
    }
    return result;
  } catch (err) {
    console.error('❌ 解析 Excel 下拉選項失敗:', err);
    return {};
  }
}

/**
 * 使用指定的欄位對應解析 Excel 並轉換成 vendorMap 格式
 * @param {Object} workbook - XLSX workbook 物件
 * @param {Object} mapping - { branchColumn?, itemColumn, qtyColumn, attrColumn?, hasHeader, startRow }（branchColumn 實際上是廠商欄位）
 * @param {string} sheetName - 工作表名稱（預設第一個）
 * @returns {Object|null} { [vendor]: { [itemName]: number|{qty,attributes} } } 或 null（vendor 即廠商）
 */
export function parseExcelToVendorMap(workbook, mapping, sheetName = null) {
  try {
    const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) {
      const err = new Error('格式錯誤：找不到工作表');
      err.details = sheetName ? `工作表「${sheetName}」不存在` : 'Excel 檔案中沒有工作表';
      err.code = 'EXCEL_NO_SHEET';
      throw err;
    }

    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    if (range.e.c < 0 || range.e.r < 0) {
      const err = new Error('格式錯誤：工作表為空或無有效範圍');
      err.details = '請確認 Excel 中有資料';
      err.code = 'EXCEL_EMPTY_RANGE';
      throw err;
    }

    const vendorMap = {};
    const startRow = mapping.startRow || (mapping.hasHeader ? 2 : 1);
    const branchColIndex = mapping.branchColumn ? XLSX.utils.decode_col(mapping.branchColumn) : null;
    const itemColIndex = XLSX.utils.decode_col(mapping.itemColumn);
    const qtyColIndex = XLSX.utils.decode_col(mapping.qtyColumn);
    const attrColIndex = mapping.attrColumn !== undefined && mapping.attrColumn !== null
      ? XLSX.utils.decode_col(mapping.attrColumn) : null;

    // 從 startRow 開始讀取資料（Excel 行號從 1 開始，但 XLSX 索引從 0 開始）
    for (let r = startRow - 1; r <= range.e.r; r++) {
      let branchCell, itemCell, qtyCell, attrCell;
      
      try {
        branchCell = branchColIndex !== null ? sheet[XLSX.utils.encode_cell({ r, c: branchColIndex })] : null;
        itemCell = sheet[XLSX.utils.encode_cell({ r, c: itemColIndex })];
        qtyCell = sheet[XLSX.utils.encode_cell({ r, c: qtyColIndex })];
        attrCell = attrColIndex !== null ? sheet[XLSX.utils.encode_cell({ r, c: attrColIndex })] : null;
      } catch (err) {
        console.warn(`⚠️ 讀取第 ${r + 1} 行時發生錯誤:`, err);
        continue;
      }

      if (!itemCell || !qtyCell) continue;

      const branch = branchCell && branchCell.v !== undefined ? String(branchCell.v).trim() : '未分類'; // branch 實際上是 vendor（廠商）
      const itemName = itemCell.v !== undefined ? String(itemCell.v).trim() : '';
      let qty = 0;
      
      if (qtyCell.v !== undefined) {
        if (typeof qtyCell.v === 'number') {
          qty = qtyCell.v;
        } else {
          const parsed = parseFloat(String(qtyCell.v).replace(/[^\d.-]/g, ''));
          qty = isNaN(parsed) ? 0 : parsed;
        }
      }

      const attrStr = attrCell && attrCell.v !== undefined ? String(attrCell.v).trim() : '';
      const attributes = attrColIndex !== null ? parseAttributes(attrStr) : [];

      // 跳過空行或無效資料
      if (!itemName || isNaN(qty) || qty <= 0) continue;

      if (!vendorMap[branch]) {
        vendorMap[branch] = {};
      }

      // 如果品項已存在，累加數量；屬性取首筆非空
      if (vendorMap[branch][itemName]) {
        const existing = vendorMap[branch][itemName];
        const existingQty = typeof existing === 'number' ? existing : existing.qty;
        const existingAttrs = typeof existing === 'object' && existing.attributes ? existing.attributes : null;
        const newQty = existingQty + qty;
        const newAttrs = attributes.length > 0 ? attributes : existingAttrs;
        vendorMap[branch][itemName] = newAttrs && newAttrs.length > 0 ? { qty: newQty, attributes: newAttrs } : newQty;
      } else {
        vendorMap[branch][itemName] = attributes.length > 0 ? { qty, attributes } : qty;
      }
    }

    if (Object.keys(vendorMap).length === 0) {
      const itemCol = mapping.itemColumn ? `欄位 ${mapping.itemColumn}` : '品項欄位';
      const qtyCol = mapping.qtyColumn ? `欄位 ${mapping.qtyColumn}` : '數量欄位';
      const details = [
        `• 資料起始行：第 ${startRow} 行`,
        `• 品項欄位：${itemCol}`,
        `• 數量欄位：${qtyCol}`,
        '• 可能原因：品項或數量欄位設定錯誤、起始行錯誤、數量為 0 或負數、品項名稱為空'
      ].join('\n');
      const err = new Error('格式錯誤：未讀取到任何有效資料');
      err.details = details;
      err.code = 'EXCEL_PARSE_EMPTY';
      throw err;
    }

    for (const branch of Object.keys(vendorMap)) {
      if (Object.keys(vendorMap[branch]).length === 0) {
        delete vendorMap[branch];
      }
    }

    if (Object.keys(vendorMap).length === 0) {
      const err = new Error('格式錯誤：所有品項因數量無效被過濾');
      err.details = '請確認數量欄位中沒有 0 或負數';
      err.code = 'EXCEL_PARSE_FILTERED';
      throw err;
    }

    return vendorMap;
  } catch (err) {
    if (err.code === 'EXCEL_PARSE_EMPTY' || err.code === 'EXCEL_PARSE_FILTERED') throw err;
    console.error('❌ 解析 Excel 失敗:', err);
    const wrap = new Error('格式錯誤：讀取 Excel 時發生錯誤');
    wrap.details = err.message || '請檢查檔案是否為有效 Excel 格式';
    wrap.code = 'EXCEL_PARSE_ERROR';
    throw wrap;
  }
}

/**
 * 取得 Excel 預覽資料（前 10 行）
 * @param {Object} workbook - XLSX workbook 物件
 * @param {string} sheetName - 工作表名稱（預設第一個）
 * @returns {Array<Array<string>>} 二維陣列，每行是一個陣列
 */
export function getExcelPreview(workbook, sheetName = null) {
  try {
    const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return [];

    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    if (range.e.c < 0 || range.e.r < 0) return [];

    const preview = [];
    const maxRows = Math.min(10, range.e.r + 1);

    for (let r = 0; r < maxRows; r++) {
      const row = [];
      for (let c = 0; c <= range.e.c; c++) {
        const cellAddress = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[cellAddress];
        const value = cell && cell.v !== undefined ? String(cell.v).trim() : '';
        row.push(value);
      }
      preview.push(row);
    }

    return preview;
  } catch (err) {
    console.error('❌ 取得 Excel 預覽失敗:', err);
    return [];
  }
}
