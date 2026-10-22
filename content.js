(() => {
  let isRunning = false;
  let followCount = 0;
  let timerInterval = null;
  let startTime = 0;
  let followTimestamps = [];
  let processedButtons = new WeakSet();

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const getRandomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  function formatDuration(seconds) {
    const hrs = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const secs = String(seconds % 60).padStart(2, "0");
    return `${hrs}:${mins}:${secs}`;
  }

  // 1. 获取当前登录账号 Handle
  function getCurrentUserHandle() {
    const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (profileLink) {
      const href = profileLink.getAttribute("href") || "";
      const handle = href.replace(/^\/+/, "").split("/")[0].split("?")[0];
      if (handle) return handle.toLowerCase();
    }

    const accountSwitcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (accountSwitcher) {
      const text = accountSwitcher.innerText || "";
      const m = text.match(/@([a-zA-Z0-9_]+)/);
      if (m && m[1]) return m[1].toLowerCase();
    }

    return null;
  }

  // 2. 严格校验：仅允许本人粉丝页面
  function isSelfFollowersPage() {
    const pathname = window.location.pathname.toLowerCase();
    const routeMatch = pathname.match(/^\/([^\/]+)\/(verified_followers|followers)\/?$/);
    if (!routeMatch) return false;

    const pageUsername = routeMatch[1];
    const myHandle = getCurrentUserHandle();

    if (myHandle) {
      return pageUsername === myHandle;
    }
    return true;
  }

  // 3. 构建/复用控制面板
  function createUI() {
    let panel = document.getElementById("x-auto-follow-panel");
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = "x-auto-follow-panel";
    panel.classList.add("x-hidden");
    panel.innerHTML = `
      <div class="x-af-header">
        <h3>自动互关助手</h3>
        <span id="x-af-state-badge" class="x-af-badge">待机</span>
      </div>
      <div class="x-af-user-row">
        <span>当前用户:</span>
        <span id="x-af-user-display" class="x-af-user-handle">检测中...</span>
      </div>
      <div class="x-af-grid">
        <div class="x-af-card">
          <div class="x-af-card-head">
            <span class="x-af-card-title">已回关</span>
            <button id="x-af-reset-count" class="x-af-reset-btn" type="button">清零</button>
          </div>
          <div id="x-af-count" class="x-af-card-val">0</div>
        </div>
        <div class="x-af-card">
          <div class="x-af-card-head">
            <span class="x-af-card-title">运行时间</span>
          </div>
          <div id="x-af-timer" class="x-af-card-val">00:00:00</div>
        </div>
      </div>
      <div id="x-af-status-text" class="x-af-status-bar">就绪</div>
      <div class="x-af-actions">
        <button id="x-af-start" class="x-af-btn" type="button">开始运行</button>
        <button id="x-af-stop" class="x-af-btn" type="button" disabled>停止</button>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById("x-af-start").addEventListener("click", startAutomation);
    document.getElementById("x-af-stop").addEventListener("click", stopAutomation);
    document.getElementById("x-af-reset-count").addEventListener("click", () => {
      followCount = 0;
      document.getElementById("x-af-count").innerText = "0";
    });

    return panel;
  }

  function updateStatus(text, badgeText = null, badgeClass = "") {
    const statusTextEl = document.getElementById("x-af-status-text");
    const badgeEl = document.getElementById("x-af-state-badge");
    if (statusTextEl) statusTextEl.innerText = text;
    if (badgeEl && badgeText) {
      badgeEl.innerText = badgeText;
      badgeEl.className = "x-af-badge " + badgeClass;
    }
  }

  function startAutomation() {
    isRunning = true;
    followTimestamps = [];
    processedButtons = new WeakSet();

    document.getElementById("x-af-start").disabled = true;
    document.getElementById("x-af-stop").disabled = false;

    startTime = Date.now();
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      document.getElementById("x-af-timer").innerText = formatDuration(elapsed);
    }, 1000);

    updateStatus("正在检测待回关粉丝...", "运行中", "active");
    runLoop();
  }

  function stopAutomation() {
    isRunning = false;
    clearInterval(timerInterval);

    const timerDisplay = document.getElementById("x-af-timer");
    if (timerDisplay) timerDisplay.innerText = "00:00:00";

    const startBtn = document.getElementById("x-af-start");
    const stopBtn = document.getElementById("x-af-stop");
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;

    updateStatus("就绪", "已暂停", "");
  }

  // 4. 双滑动窗口限流 + 随机抖动（Jitter）
  async function enforceRateLimits() {
    while (isRunning) {
      const now = Date.now();
      followTimestamps = followTimestamps.filter((ts) => now - ts < 60000);

      const countLast20s = followTimestamps.filter((ts) => now - ts < 20000).length;
      const countLast60s = followTimestamps.length;

      let waitTime = 0;

      if (countLast20s >= 3) {
        const oldestIn20s = followTimestamps.filter((ts) => now - ts < 20000)[0];
        const wait20s = 20000 - (now - oldestIn20s) + 400;
        waitTime = Math.max(waitTime, wait20s);
      }

      if (countLast60s >= 10) {
        const oldestIn60s = followTimestamps[0];
        const wait60s = 60000 - (now - oldestIn60s) + 400;
        waitTime = Math.max(waitTime, wait60s);
      }

      if (waitTime > 0) {
        const waitSeconds = Math.ceil(waitTime / 1000);
        updateStatus(`安全限流冷却中 (${waitSeconds}秒)...`, "限流中", "cooling");
        await delay(1000);
      } else {
        const jitterDelay = getRandomBetween(500, 2000);
        updateStatus(`随机延时中 (${jitterDelay}ms)...`, "等待中", "active");
        await delay(jitterDelay);
        break;
      }
    }
  }

  // 5. 判定是否属于任何“推荐关注”或“侧边栏”区域
  function isInRecommendationModule(el) {
    // 坚决排除右侧边栏
    if (el.closest('[data-testid="sidebarColumn"]') || el.closest('aside')) {
      return true;
    }

    // 排除主时间线中偶尔穿插的横向轮播/推荐组件
    const carousel = el.closest('[data-testid="Carousel"], [aria-label*="Carousel"]');
    if (carousel) return true;

    // 检查父级容器中是否带有“推荐”相关标题
    const cell = el.closest('[data-testid="UserCell"]');
    if (cell) {
      let parent = cell.parentElement;
      while (parent && parent !== document.body && parent.getAttribute("data-testid") !== "primaryColumn") {
        const header = parent.querySelector('h2, [role="heading"]');
        if (header) {
          const title = (header.innerText || "").toLowerCase();
          if (
            title.includes("推荐") ||
            title.includes("who to follow") ||
            title.includes("connect") ||
            title.includes("相关推荐")
          ) {
            return true;
          }
        }
        parent = parent.parentElement;
      }
    }

    return false;
  }

  // 6. 按钮状态精准校验
  function isValidFollowButton(btn) {
    if (!btn || !document.body.contains(btn)) return false;
    if (isInRecommendationModule(btn)) return false;

    const testId = (btn.getAttribute("data-testid") || "").toLowerCase();
    const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
    const text = (btn.innerText || "").trim().toLowerCase();

    // 强黑名单过滤
    const blacklistWords = [
      "following", "正在关注", "已关注",
      "requested", "pending", "已申请", "已请求",
      "blocked", "已屏蔽", "unblock", "解除屏蔽",
      "unfollow", "取消关注"
    ];

    for (const word of blacklistWords) {
      if (testId.includes(word) || aria.includes(word) || text.includes(word)) {
        return false;
      }
    }

    // 白名单核对：必须是纯粹的 Follow / 关注
    const hasFollowId = testId.includes("-follow");
    const isFollowText =
      text === "follow" ||
      text === "关注" ||
      aria.startsWith("follow @") ||
      aria.startsWith("关注 @");

    return hasFollowId || isFollowText;
  }

  // 7. 严格在主时间线（primaryColumn）内提取待回关粉丝按钮
  function getPendingFollowButtons() {
    const primaryCol = document.querySelector('[data-testid="primaryColumn"]');
    if (!primaryCol) return [];

    // 仅在主时间线中的粉丝单元内抓取按钮
    const candidates = Array.from(
      primaryCol.querySelectorAll(
        '[data-testid="UserCell"] button, [data-testid="UserCell"] [role="button"]'
      )
    );

    const uniqueCandidates = Array.from(new Set(candidates));

    return uniqueCandidates.filter((btn) => {
      if (processedButtons.has(btn)) return false;
      return isValidFollowButton(btn);
    });
  }

  // 8. 主执行循环
  async function runLoop() {
    let emptyCount = 0;

    while (isRunning) {
      if (!isSelfFollowersPage()) {
        stopAutomation();
        updateStatus("就绪", "已退出", "cooling");
        break;
      }

      const buttons = getPendingFollowButtons();

      if (buttons.length > 0) {
        emptyCount = 0;

        for (const btn of buttons) {
          if (!isRunning) break;
          if (processedButtons.has(btn)) continue;

          btn.scrollIntoView({ behavior: "smooth", block: "center" });
          await delay(500);

          if (isValidFollowButton(btn)) {
            await enforceRateLimits();
            if (!isRunning) break;

            processedButtons.add(btn);
            btn.click();

            const now = Date.now();
            followTimestamps.push(now);
            followCount++;

            const countEl = document.getElementById("x-af-count");
            if (countEl) countEl.innerText = followCount;
            updateStatus(`已回关第 ${followCount} 位粉丝`, "运行中", "active");

            await delay(getRandomBetween(1200, 2000));
          } else {
            processedButtons.add(btn);
          }
        }
      } else {
        emptyCount++;
        updateStatus("正在向下寻找未回关粉丝...", "扫描中", "active");

        // 仅对主视口进行平滑翻页
        window.scrollBy({ top: 650, behavior: "smooth" });
        await delay(2200);

        if (emptyCount >= 20) {
          updateStatus("已到达底部或无更多粉丝", "已完成", "");
          stopAutomation();
          break;
        }
      }
    }
  }

  // 9. 页面路由与面板巡检
  function checkRoute() {
    const panel = createUI();
    const handle = getCurrentUserHandle();
    const userDisplay = document.getElementById("x-af-user-display");

    if (userDisplay && handle) {
      userDisplay.innerText = `@${handle}`;
    }

    const isTarget = isSelfFollowersPage();
    if (isTarget) {
      panel.classList.remove("x-hidden");
    } else {
      panel.classList.add("x-hidden");
      if (isRunning) {
        stopAutomation();
      }
    }
  }

  setInterval(checkRoute, 600);
})();