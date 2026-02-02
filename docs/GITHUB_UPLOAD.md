# 上傳專案到 GitHub 操作流程

---

## 一、建立 .gitignore（已完成）

專案根目錄已有 `.gitignore`，會排除：

- `node_modules/`（套件）
- `.env`、`src/.env`（密鑰）
- `*.db`、`orders.db`（資料庫）
- `public/uploads/`（上傳圖片）

**這些不會被推送到 GitHub。**

---

## 二、在 GitHub 建立 Repo

1. 開啟 [github.com](https://github.com)，登入
2. 右上角 **+** → **New repository**
3. 填寫：
   - **Repository name**：例如 `dk2` 或 `order-system`
   - **Description**：選填
   - **Public** 或 **Private**：自選
   - **不要**勾選 "Add a README file"
4. 點 **Create repository**

---

## 三、在本機專案執行 Git 指令

在終端機（PowerShell 或 CMD）依序執行：

```powershell
# 1. 進入專案目錄
cd C:\Users\user\Desktop\dk2

# 2. 初始化 Git（若尚未初始化）
git init

# 3. 加入所有檔案（.gitignore 會自動排除不需追蹤的）
git add .

# 4. 第一次提交
git commit -m "Initial commit: 訂單系統"

# 5. 設定遠端 repo（把 YOUR_USERNAME 和 YOUR_REPO 換成你的）
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git

# 6. 推送到 GitHub（分支名稱可能是 main 或 master）
git branch -M main
git push -u origin main
```

**把 `YOUR_USERNAME` 換成你的 GitHub 帳號**  
**把 `YOUR_REPO` 換成剛建立的 repo 名稱**

---

## 四、若專案已經有 Git（已有 .git）

若 `git init` 顯示 "Reinitialized" 或已有 commit，則只需要：

```powershell
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

若 `origin` 已存在，可先刪除再設：

```powershell
git remote remove origin
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

---

## 五、之後修改程式要更新 GitHub

每次改完程式後：

```powershell
cd C:\Users\user\Desktop\dk2
git add .
git commit -m "描述這次修改內容"
git push
```

---

## 六、常見問題

**Q：push 時要求輸入帳號密碼？**  
A：GitHub 已不支援密碼，需用 **Personal Access Token** 或 **SSH Key**。  
- Token：GitHub → Settings → Developer settings → Personal access tokens → 建立 token（需 repo 權限）  
- 輸入密碼時改用 token 當作密碼

**Q：如何確認 .env 沒被上傳？**  
A：在 GitHub repo 頁面搜尋 `.env`，若找不到就沒被上傳。或先 `git status` 看 `.env` 是否在 untracked。

**Q：orders.db 可以上傳嗎？**  
A：不建議。會包含訂單資料，且本機資料與雲端不應共用。Zeabur 會用 Volume 持久化，從空資料庫開始即可。
