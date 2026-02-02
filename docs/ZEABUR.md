# Zeabur 部署說明

訂單系統在 Zeabur 上的部署步驟與注意事項。

---

## 一、前置準備

1. **Zeabur 帳號**：至 [zeabur.com](https://zeabur.com) 註冊。
2. **程式碼進 Git**：專案推送到 GitHub（勿把 `src/.env` 推上去，用 `.gitignore` 排除）。
3. **LINE 後台**：準備好 LINE Login 與 Messaging API 的 Channel，取得正式環境用的 ID / Secret / Token。

---

## 二、在 Zeabur 建立專案

1. 登入 Zeabur → **Create Project** → 選 **Deploy from GitHub**。
2. 選擇你的 repo，Zeabur 會自動辨識為 Node.js。
3. 建立後會得到一個對外網址，例如：`https://你的服務名.zeabur.app`。

---

## 三、環境變數（Variables）

在該服務的 **Variables** 分頁新增（或 **Edit as Raw** 整批貼）：

```env
PORT=8080
LINE_LOGIN_CHANNEL_ID=你的LINE_Login_Channel_ID
LINE_LOGIN_CHANNEL_SECRET=你的LINE_Login_Channel_Secret
LINE_LOGIN_REDIRECT_URI=https://你的服務名.zeabur.app/api/auth/line-login-callback
LINE_CHANNEL_ACCESS_TOKEN=你的Messaging_API_Channel_Access_Token
LINE_CHANNEL_SECRET=你的Messaging_API_Channel_Secret
DATA_DIR=/data
```

說明：

- **PORT**：Zeabur 會自動注入，通常為 `8080`，若已有則可不設。
- **LINE_***：全部改成「正式環境」的值，不要用 localhost。
- **LINE_LOGIN_REDIRECT_URI**：必須是 `https://你的Zeabur網域/api/auth/line-login-callback`，與 LINE Developers 後台完全一致。
- **DATA_DIR**：設為 `/data`，搭配底下 Volume 掛載，讓資料庫與上傳圖片持久化。

**上線建議**：不要設 `WEB_TEST_USER_ID`，或留空。

---

## 四、持久化（Volume）— 必做

否則重新部署後 **SQLite 與上傳圖片會清空**。

1. 進入該服務 → **Volumes** 分頁 → **Mount Volumes**。
2. 新增一筆：
   - **Volume ID**：例如 `data`。
   - **Mount Directory**：`/data`。
3. 儲存後重新部署。

這樣 `DATA_DIR=/data` 時：

- 資料庫路徑：`/data/orders.db`
- 上傳圖片：`/data/uploads/`

都會寫在 Volume 裡，重啟／重新部署後仍會保留。

**注意**：掛載 Volume 後，該目錄一開始是空的，首次啟動會自動建立新的 `orders.db`。

---

## 五、LINE 後台設定

1. **LINE Login**  
   - LINE Developers → 你的 LINE Login Channel → **LINE Login settings** → **Callback URL**  
   - 新增：`https://你的服務名.zeabur.app/api/auth/line-login-callback`  
   - 只保留正式網址，可刪除 localhost。

2. **Messaging API (Bot)**  
   - 同一個或另一個 Channel → **Messaging API** → **Webhook URL**  
   - 設為：`https://你的服務名.zeabur.app/webhook/line`  
   - **Use webhook** 開啟；**Verify** 成功即可。

---

## 六、建置與啟動

- Zeabur 會依 `package.json` 的 **start** 執行：`npm start` → `node src/index.js`。
- 會自動注入 **PORT**，程式已使用 `process.env.PORT || 3001`，無需改程式。
- 若建置失敗，可到 **Build** 分頁看日誌；常見為 Node 版本或依賴問題，必要時在 `package.json` 加 `"engines": { "node": ">=18" }`。

---

## 七、自訂網域（選用）

- 在 Zeabur 該服務的 **Networking / Domain** 綁定自己的網域（例如 `order.example.com`）。
- 綁好並有 HTTPS 後，把上述所有 `https://你的服務名.zeabur.app` 改成 `https://order.example.com`，並同步更新：
  - Zeabur 的 `LINE_LOGIN_REDIRECT_URI`
  - LINE 後台的 Callback URL 與 Webhook URL。

---

## 八、檢查表

- [ ] 專案已從 GitHub 部署，且 `npm start` 可正常啟動。
- [ ] 環境變數已設（含 `LINE_*`、`DATA_DIR=/data`），且無 localhost。
- [ ] Volume 已掛在 `/data`，`DATA_DIR=/data` 已設。
- [ ] LINE Login Callback URL 已改為 Zeabur 的 https 網址。
- [ ] Messaging API Webhook URL 已改為 Zeabur 的 https 網址。
- [ ] 瀏覽器開 `https://你的網域` 可進入首頁並用 LINE 登入。
- [ ] Bot 可收發訊息、下單後老闆會收到 LINE 通知。

---

## 九、常見問題

**Q：重新部署後訂單都不見了？**  
A：多半是沒掛 Volume 或沒設 `DATA_DIR=/data`。請依「四、持久化」設定並重啟。

**Q：LINE 登入後顯示錯誤？**  
A：檢查 `LINE_LOGIN_REDIRECT_URI` 與 LINE 後台 Callback URL 是否一字不差（含 https、無尾端斜線）。

**Q：Webhook 驗證失敗？**  
A：確認 `LINE_CHANNEL_SECRET` 是 Messaging API 的 Channel Secret，且 Webhook URL 為 `https://你的網域/webhook/line`。

**Q：上傳的品項圖片重啟後消失？**  
A：需設 `DATA_DIR=/data` 並掛載 Volume 到 `/data`，圖片會存於 `/data/uploads`。
