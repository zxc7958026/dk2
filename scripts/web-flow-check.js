/**
 * 快速檢查 Web 流程所需 API 是否正常
 * 執行：node scripts/web-flow-check.js
 */
const BASE = 'http://localhost:3000';

async function get(url) {
  const r = await fetch(url);
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, json, text };
}

async function main() {
  console.log('1. GET /api/config');
  const config = await get(`${BASE}/api/config`);
  console.log('   status:', config.status, 'body:', config.json || config.text.slice(0, 80));

  const uid = config.json?.testUserId || 'U7f8d01a4bf99169912075e6e4d38b3f2';
  console.log('\n2. GET /api/menu?userId=' + uid);
  const menu = await get(`${BASE}/api/menu?userId=${encodeURIComponent(uid)}`);
  console.log('   status:', menu.status);
  if (menu.json?.menu) {
    console.log('   branches:', Object.keys(menu.json.menu).join(', '));
  } else {
    console.log('   (無菜單或未加入世界，測試模式會用 mock 菜單)');
  }

  console.log('\n3. GET / (首頁)');
  const home = await get(`${BASE}/`);
  console.log('   status:', home.status, 'length:', home.text?.length);

  console.log('\n4. GET /?test=1');
  const test = await get(`${BASE}/?test=1`);
  console.log('   status:', test.status, 'length:', test.text?.length);

  console.log('\n✅ API 檢查完成。請在瀏覽器開啟 http://localhost:3000/?test=1 手動操作測試。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
