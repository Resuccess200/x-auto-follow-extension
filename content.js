(() => {
  let isRunning = false;
  let followCount = 0;
  let timerInterval = null;
  let startTime = 0;
  let followTimestamps = [];
  const processedButtons = new WeakSet();

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 随机延时工具函数
  const getRandomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  function formatDuration(seconds) {
    const hrs = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const secs = String(seconds % 60).padStart(2, "0");
    return `${hrs}:${mins}:${secs}`;
  }

  // 1. 动态获取当前登录账号 Handle
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

  // 2. 校验是否为本人粉丝页
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

    const timerDisplay = document.getElementById("x-af-timer");
    if (timerDisplay) timerDisplay.innerText = "00:00:00";

    const startBtn = document.getElementById("x-af-start");
    const stopBtn = document.getElementById("x-af-stop");
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;

    updateStatus("已停止任务", "已暂停", "");
  }

  // 4. 双滑动窗口限流 + 随机抖动（Jitter）
  async function enforceRateLimits() {
    while (isRunning) {
      const now = Date.now();
      followTimestamps = followTimestamps.filter((ts) => now - ts < 60000);

      const countLast20s = followTimestamps.filter((ts) => now - ts < 20000).length;
      const countLast60s = followTimestamps.length;

      let waitTime = 0;

      // 20秒内不超过3个
      if (countLast20s >= 3) {
        const oldestIn20s = followTimestamps.filter((ts) => now - ts < 20000)[0];
        const wait20s = 20000 - (now - oldestIn20s) + 400;
        waitTime = Math.max(waitTime, wait20s);
      }

      // 60秒内不超过10个
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
        // 核心机制：随机抖动延时（Jitter）500ms - 2000ms
        const jitterDelay = getRandomBetween(500, 2000);
        updateStatus(`随机抖动延时中 (${jitterDelay}ms)...`, "等待中", "active");
        await delay(jitterDelay);
        break;
      }
    }
  }

  // 5. 严格过滤：排除 Following/Requested/Pending/Blocked，仅允许纯粹的 Follow
  function isStrictFollowButton(btn) {
    if (!btn || processedButtons.has(btn)) return false;

    const testId = (btn.getAttribute("data-testid") || "").toLowerCase();
    const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
    const btnText = (btn.innerText || "").trim().toLowerCase();

    // 强排除项关键词黑名单
    const blacklistWords = [
      "following", "正在关注", "已关注",
      "requested", "pending", "已申请", "已请求",
      "blocked", "已屏蔽", "unblock", "解除屏蔽",
      "unfollow", "取消关注"
    ];

    for (const word of blacklistWords) {
      if (testId.includes(word) || ariaLabel.includes(word) || btnText.includes(word)) {
        return false;
      }
    }

    // 白名单严格核对
    const isPureFollowText =
      btnText === "follow" ||
      btnText === "关注" ||
      ariaLabel.startsWith("follow @") ||
      ariaLabel.startsWith("关注 @");

    const hasFollowTestId = testId.endsWith("-follow") && !testId.includes("unfollow");

    return isPureFollowText || hasFollowTestId;
  }

  // 提取用户卡片中的可操作按钮
  function getFollowBackButton(cell) {
    const cellText = cell.innerText || "";
    const isFollower = cellText.includes("Follows you") || cellText.includes("关注了你");
    if (!isFollower) return null;

    const btn = cell.querySelector('button[data-testid*="-follow"], button[role="button"]');
    if (!btn) return null;

    return isStrictFollowButton(btn) ? btn : null;
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

  // 6. 自动化主循环（集成 DOM 滚动防呆与懒加载）
  async function runLoop() {
    let emptyRounds = 0;

    while (isRunning) {
      if (!isSelfFollowersPage()) {
        stopAutomation();
        updateStatus("已离开本人粉丝页，已自动暂停", "已退出", "cooling");
        break;
      }

      const buttons = findButtons();

      if (buttons.length > 0) {
        emptyRounds = 0; // 重置无目标计数
        for (const btn of buttons) {
          if (!isRunning) break;

          processedButtons.add(btn);

          // 模拟平滑滚动至元素，避免瞬间位移
          btn.scrollIntoView({ behavior: "smooth", block: "center" });
          await delay(600);

          // 二次校验 DOM 存在性及文本状态（防止由于并发或滚动变化改变状态）
          if (document.body.contains(btn) && isStrictFollowButton(btn)) {
            await enforceRateLimits();
            if (!isRunning) break;

            btn.click();
            const now = Date.now();
            followTimestamps.push(now);
            followCount++;

            document.getElementById("x-af-count").innerText = followCount;
            updateStatus(`已回关第 ${followCount} 位粉丝`, "运行中", "active");

            // 单次点击后的基础行为停顿（1000ms - 2000ms）
            await delay(getRandomBetween(1000, 2000));
          }
        }
      } else {
        emptyRounds++;
        updateStatus(`平滑滚动以拉取粉丝 (${emptyRounds})...`, "加载中", "active");

        // 视口平滑滚动（每次递增 600 - 900 像素，防呆触底检测并触发无限列表 lazy load）
        const scrollDistance = getRandomBetween(600, 900);
        window.scrollBy({ top: scrollDistance, behavior: "smooth" });

        // 等待推特数据包返回与 DOM 挂载
        await delay(getRandomBetween(2200, 3200));

        // 若连续 15 次滚动未拉取到任何未回关账号，推测已翻至粉丝列表末尾
        if (emptyRounds >= 15) {
          updateStatus("未发现更多待回关粉丝，已自动完成", "已完成", "");
          stopAutomation();
          break;
        }
      }
    }
  }

  // 7. 路由监听与状态巡检
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