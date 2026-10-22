(() => {
  let isRunning = false;
  let followCount = 0;
  let timerInterval = null;
  let startTime = 0;
  let followTimestamps = [];
  const processedButtons = new WeakSet();

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function formatDuration(seconds) {
    const hrs = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const secs = String(seconds % 60).padStart(2, "0");
    return `${hrs}:${mins}:${secs}`;
  }

  // 1. 获取当前登录账号的 Handle
  function getCurrentUserHandle() {
    const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (profileLink) {
      const href = profileLink.getAttribute("href") || "";
      const handle = href.replace(/^\/+/, "").split("/")[0];
      if (handle) return handle.toLowerCase();
    }

    const accountSwitcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (accountSwitcher) {
      const text = accountSwitcher.innerText || "";
      const match = text.match(/@([a-zA-Z0-9_]+)/);
      if (match && match[1]) return match[1].toLowerCase();
    }

    return null;
  }

  // 2. 判定是否为本人粉丝页
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

    document.getElementById("x-af-start").disabled = true;
    document.getElementById("x-af-stop").disabled = false;

    startTime = Date.now();
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      document.getElementById("x-af-timer").innerText = formatDuration(elapsed);
    }, 1000);

    updateStatus("正在检测待回关用户...", "运行中", "active");
    runLoop();
  }

  function stopAutomation() {
    isRunning = false;
    clearInterval(timerInterval);

    // 运行时间自动清零
    const timerDisplay = document.getElementById("x-af-timer");
    if (timerDisplay) timerDisplay.innerText = "00:00:00";

    const startBtn = document.getElementById("x-af-start");
    const stopBtn = document.getElementById("x-af-stop");
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;

    updateStatus("已停止任务", "已暂停", "");
  }

  // 双滑动窗口限流：20秒不超过3个，60秒不超过10个
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
        updateStatus(`触发安全限流，冷却中 (${waitSeconds}秒)...`, "限流中", "cooling");
        await delay(1000);
      } else {
        const naturalPause = Math.floor(Math.random() * 1500) + 2000;
        await delay(naturalPause);
        break;
      }
    }
  }

  function getFollowBackButton(cell) {
    const cellText = cell.innerText || "";
    const isFollower = cellText.includes("Follows you") || cellText.includes("关注了你");
    if (!isFollower) return null;

    const btn = cell.querySelector('button[data-testid*="-follow"], button[role="button"]');
    if (!btn || processedButtons.has(btn)) return null;

    const testId = btn.getAttribute("data-testid") || "";
    const ariaLabel = btn.getAttribute("aria-label") || "";
    const btnText = btn.innerText || "";

    const isAlreadyFollowing =
      testId.includes("-unfollow") ||
      ariaLabel.includes("Following") ||
      ariaLabel.includes("正在关注") ||
      btnText.includes("Following") ||
      btnText.includes("正在关注");

    if (isAlreadyFollowing) return null;

    const isFollowAction =
      testId.includes("-follow") ||
      btnText.trim() === "Follow" ||
      btnText.trim() === "关注" ||
      ariaLabel.startsWith("Follow @") ||
      ariaLabel.startsWith("关注 @");

    return isFollowAction ? btn : null;
  }

  function findButtons() {
    const userCells = Array.from(document.querySelectorAll('[data-testid="UserCell"]'));
    const buttons = [];
    for (const cell of userCells) {
      const btn = getFollowBackButton(cell);
      if (btn) buttons.push(btn);
    }
    return buttons;
  }

  async function runLoop() {
    while (isRunning) {
      if (!isSelfFollowersPage()) {
        stopAutomation();
        updateStatus("已离开本人粉丝页，已自动暂停", "已退出", "cooling");
        break;
      }

      const buttons = findButtons();

      if (buttons.length > 0) {
        for (const btn of buttons) {
          if (!isRunning) break;

          processedButtons.add(btn);
          btn.scrollIntoView({ behavior: "smooth", block: "center" });
          await delay(600);

          if (document.body.contains(btn)) {
            await enforceRateLimits();
            if (!isRunning) break;

            btn.click();
            const now = Date.now();
            followTimestamps.push(now);
            followCount++;

            document.getElementById("x-af-count").innerText = followCount;
            updateStatus(`已回关第 ${followCount} 位粉丝`, "运行中", "active");
          }
        }
      } else {
        updateStatus("滚动加载更多粉丝...", "加载中", "active");
        window.scrollBy({ top: 900, behavior: "smooth" });
        await delay(2500);
      }
    }
  }

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