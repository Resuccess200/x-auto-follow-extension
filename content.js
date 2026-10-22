(() => {
  let isRunning = false;
  let followCount = 0;
  let sessionFollowCount = 0;
  let nextMicroBreakTarget = 0;
  let consecutiveHoverFails = 0;

  let timerInterval = null;
  let startTime = 0;
  let followTimestamps = [];
  let hoverTimestamps = [];
  let processedButtons = new WeakSet();
  let audioCtx = null;
  let originalDocumentTitle = "";
  
  // 读取本地存储的配置
  let maxAllowedDiff = Number(localStorage.getItem("x_af_max_diff")) || 150;
  let maxFollow20s = Number(localStorage.getItem("x_af_max_20s")) || 3;
  let maxFollow60s = Number(localStorage.getItem("x_af_max_60s")) || 8;

  const SESSION_MAX_FOLLOWS = 40; 
  const MICRO_BREAK_MIN = 8;
  const MICRO_BREAK_MAX = 12;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const getRandomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  function formatDuration(seconds) {
    const hrs = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const secs = String(seconds % 60).padStart(2, "0");
    return `${hrs}:${mins}:${secs}`;
  }

  function enableBackgroundKeepAlive() {
    try {
      if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          audioCtx = new AudioContextClass();
          const osc = audioCtx.createOscillator();
          const gainNode = audioCtx.createGain();
          gainNode.gain.value = 0.00001;
          osc.connect(gainNode);
          gainNode.connect(audioCtx.destination);
          osc.start();
        }
      }
      if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume();
      }
    } catch (e) {}
  }

  function disableBackgroundKeepAlive() {
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
  }

  function updateTabTitle(count) {
    if (!originalDocumentTitle) originalDocumentTitle = document.title;
    const cleanBase = originalDocumentTitle.replace(/^\[.*?\]\s*/, "");
    document.title = `[已关注 ${count}] ${cleanBase}`;
  }

  function restoreTabTitle() {
    if (originalDocumentTitle) {
      document.title = originalDocumentTitle.replace(/^\[.*?\]\s*/, "");
    }
  }

  function parseSocialCount(rawStr) {
    if (!rawStr) return 0;
    const match = rawStr.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kmb万]?)/i);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    if (isNaN(num)) return 0;
    const unit = (match[2] || "").toLowerCase();
    if (unit === "k") return Math.round(num * 1000);
    if (unit === "m") return Math.round(num * 1000000);
    if (unit === "b") return Math.round(num * 1000000000);
    if (unit === "万") return Math.round(num * 10000);
    return Math.round(num);
  }

  function getCurrentUserHandle() {
    const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (profileLink) {
      const href = profileLink.getAttribute("href") || "";
      const path = href.replace(/^https?:\/\/[^/]+/i, "");
      const handle = path.replace(/^\/+/, "").split("/")[0].split("?")[0].split("#")[0];
      if (handle && handle !== "home" && handle !== "explore") return handle.toLowerCase();
    }
    const accountSwitcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (accountSwitcher) {
      const img = accountSwitcher.querySelector('img');
      if (img && img.alt) {
        const imgMatch = img.alt.match(/@([a-zA-Z0-9_]+)/);
        if (imgMatch && imgMatch[1]) return imgMatch[1].toLowerCase();
      }
      const text = accountSwitcher.innerText || "";
      const m = text.match(/^([^\n]+)\n@([a-zA-Z0-9_]+)/) || text.match(/@([a-zA-Z0-9_]+)/);
      if (m && m[2]) return m[2].toLowerCase();
      if (m && m[1]) return m[1].toLowerCase();
    }
    return null;
  }

  function getPageContext() {
    const pathname = window.location.pathname.toLowerCase();
    const match = pathname.match(/^\/([^\/]+)\/(verified_followers|followers|following)\/?$/);
    if (!match) return { valid: false, mode: null, pageUser: null, reason: "NOT_LIST_PAGE" };

    const pageUser = match[1];
    const listType = match[2];
    const reserved = ["home", "explore", "notifications", "messages", "settings", "i", "search"];
    if (reserved.includes(pageUser)) return { valid: false, mode: null, pageUser: null, reason: "RESERVED" };

    const myHandle = getCurrentUserHandle();
    if (!myHandle) return { valid: false, mode: null, pageUser, myHandle: null, reason: "UNKNOWN_USER" };

    if (pageUser === myHandle) {
      if (listType === "followers" || listType === "verified_followers") {
        return { valid: true, mode: "SELF_FOLLOWBACK", pageUser, myHandle, reason: null };
      }
      return { valid: false, mode: null, pageUser, myHandle, reason: "SELF_OTHER_PAGE" };
    }

    return { valid: true, mode: "OTHER_FILTER", pageUser, myHandle, reason: null };
  }

  function createUI() {
    let panel = document.getElementById("x-auto-follow-panel");
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = "x-auto-follow-panel";
    panel.classList.add("x-hidden");
    panel.innerHTML = `
      <div class="x-af-header">
        <h3>全自动互关与拓客助手</h3>
        <span id="x-af-state-badge" class="x-af-badge">待机</span>
      </div>
      <div class="x-af-info-row">
        <div><span>当前登录:</span><span id="x-af-user-display" class="x-af-highlight">检测中...</span></div>
        <span id="x-af-mode-display" class="x-af-mode-tag">互关模式</span>
      </div>
      
      <div id="x-af-diff-row" class="x-af-setting-row">
        <span>蓝V粉关最大差值 (≤):</span>
        <input id="x-af-diff-input" class="x-af-diff-input" type="number" min="0" max="999999" value="${maxAllowedDiff}" />
      </div>

      <div id="x-af-speed-row" class="x-af-speed-row">
        <span>限速:</span>
        <span class="x-af-speed-label">20秒内</span>
        <input id="x-af-speed-20s" class="x-af-speed-input" type="number" min="1" max="20" value="${maxFollow20s}" />
        <span class="x-af-speed-label">人 / 60秒内</span>
        <input id="x-af-speed-60s" class="x-af-speed-input" type="number" min="1" max="60" value="${maxFollow60s}" />
        <span class="x-af-speed-label">人</span>
      </div>

      <div class="x-af-shield-box">
        <div class="x-af-shield-title">
          <span>🛡️ 安全防护状态</span>
          <span id="x-af-shield-stat" class="x-af-shield-val">未激活</span>
        </div>
        <div id="x-af-shield-detail" class="x-af-shield-detail">双滑窗限流 + 拟人微休眠就绪</div>
      </div>
      <div class="x-af-grid">
        <div class="x-af-card">
          <div class="x-af-card-head">
            <span id="x-af-count-label" class="x-af-card-title">已回关</span>
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
    document.getElementById("x-af-stop").addEventListener("click", () => stopAutomation("就绪", "已暂停", ""));
    document.getElementById("x-af-reset-count").addEventListener("click", () => {
      followCount = 0;
      sessionFollowCount = 0;
      document.getElementById("x-af-count").innerText = "0";
      updateShieldUI("安全运行中", "已清零计数");
      if (isRunning) updateTabTitle(0);
    });

    const diffInput = document.getElementById("x-af-diff-input");
    diffInput.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val >= 0) {
        maxAllowedDiff = val;
        localStorage.setItem("x_af_max_diff", String(val));
      }
    });

    const input20s = document.getElementById("x-af-speed-20s");
    input20s.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val > 0) {
        maxFollow20s = val;
        localStorage.setItem("x_af_max_20s", String(val));
      }
    });

    const input60s = document.getElementById("x-af-speed-60s");
    input60s.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val > 0) {
        maxFollow60s = val;
        localStorage.setItem("x_af_max_60s", String(val));
      }
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

  function updateShieldUI(statText, detailText) {
    const statEl = document.getElementById("x-af-shield-stat");
    const detailEl = document.getElementById("x-af-shield-detail");
    if (statEl) statEl.innerText = statText;
    if (detailEl) detailEl.innerText = detailText;
  }

  function startAutomation() {
    isRunning = true;
    sessionFollowCount = 0;
    consecutiveHoverFails = 0;
    nextMicroBreakTarget = getRandomBetween(MICRO_BREAK_MIN, MICRO_BREAK_MAX);
    followTimestamps = [];
    hoverTimestamps = [];
    processedButtons = new WeakSet();

    enableBackgroundKeepAlive();

    document.getElementById("x-af-start").disabled = true;
    document.getElementById("x-af-stop").disabled = false;

    startTime = Date.now();
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      document.getElementById("x-af-timer").innerText = formatDuration(elapsed);
    }, 1000);

    updateTabTitle(followCount);
    updateShieldUI(`保护中 (0/${SESSION_MAX_FOLLOWS})`, `距休息还剩 ${nextMicroBreakTarget} 人`);
    updateStatus("正在检测目标用户...", "运行中", "active");
    runLoop();
  }

  function stopAutomation(statusMsg = "就绪", badgeMsg = "已暂停", badgeCls = "") {
    isRunning = false;
    clearInterval(timerInterval);
    disableBackgroundKeepAlive();
    restoreTabTitle();

    const timerDisplay = document.getElementById("x-af-timer");
    if (timerDisplay) timerDisplay.innerText = "00:00:00";

    const startBtn = document.getElementById("x-af-start");
    const stopBtn = document.getElementById("x-af-stop");
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;

    updateShieldUI("已暂停", "防护已释放");
    updateStatus(statusMsg, badgeMsg, badgeCls);
  }

  // 风控侦测：极速熔断
  function detectPlatformWarning() {
    const alerts = Array.from(
      document.querySelectorAll('[data-testid="toast"], [role="alert"], [role="dialog"]')
    );
    
    const dangerKeywords = [
      "速度限制", "速率限制", "频率限制", "稍等片刻", "稍后再试", "再次尝试", 
      "已达上限", "无法关注", "操作过于频繁", "异常活动", "已被限制", "请求受限",
      "rate limit", "rate limited", "limit reached", "try again later", "unable to follow", 
      "automated", "wait a moment", "try again", "too many requests", "blocked", 
      "this request looks like it might be automated"
    ];

    for (const el of alerts) {
      const txt = (el.innerText || "").toLowerCase();
      for (const kw of dangerKeywords) {
        if (txt.includes(kw.toLowerCase())) return true;
      }
    }

    const bodyText = (document.body.innerText || "").toLowerCase();
    const toastSignatures = [
      "你受到速度限制", "你受到速率限制", "请稍等片刻", 
      "you are being rate limited", "please wait a moment"
    ];
    for (const sig of toastSignatures) {
      if (bodyText.includes(sig)) return true;
    }

    return false;
  }

  async function enforceFollowRateLimits() {
    if (sessionFollowCount >= SESSION_MAX_FOLLOWS) {
      stopAutomation(`已达单次安全上限(${SESSION_MAX_FOLLOWS}人)，自动停机保护`, "保护停机", "cooling");
      return false;
    }

    if (sessionFollowCount > 0 && sessionFollowCount >= nextMicroBreakTarget) {
      const breakSeconds = getRandomBetween(25, 45);
      for (let rem = breakSeconds; rem > 0 && isRunning; rem--) {
        if (detectPlatformWarning()) {
          stopAutomation("休息期间检测到平台警告，紧急停机", "风控熔断", "cooling");
          return false;
        }
        updateShieldUI("战术微休眠中", `已休息 ${breakSeconds - rem}/${breakSeconds} 秒`);
        updateStatus(`防风控战术休息 (${rem}秒)...`, "休息中", "cooling");
        await delay(1000);
      }
      nextMicroBreakTarget = sessionFollowCount + getRandomBetween(MICRO_BREAK_MIN, MICRO_BREAK_MAX);
      updateShieldUI(`保护中 (${sessionFollowCount}/${SESSION_MAX_FOLLOWS})`, `距下次休息还剩 ${nextMicroBreakTarget - sessionFollowCount} 人`);
    }

    while (isRunning) {
      if (detectPlatformWarning()) {
        stopAutomation("检测到平台风控提示，已紧急停机", "风控熔断", "cooling");
        return false;
      }

      const now = Date.now();
      followTimestamps = followTimestamps.filter((ts) => now - ts < 60000);

      const countLast20s = followTimestamps.filter((ts) => now - ts < 20000).length;
      const countLast60s = followTimestamps.length;

      let waitTime = 0;

      if (countLast20s >= maxFollow20s) {
        const oldestIn20s = followTimestamps.filter((ts) => now - ts < 20000)[0];
        waitTime = Math.max(waitTime, 20000 - (now - oldestIn20s) + 500);
      }

      if (countLast60s >= maxFollow60s) {
        const oldestIn60s = followTimestamps[0];
        waitTime = Math.max(waitTime, 60000 - (now - oldestIn60s) + 500);
      }

      if (waitTime > 0) {
        const waitSeconds = Math.ceil(waitTime / 1000);
        updateShieldUI("滑动窗口冷却", `等待速率恢复 (${waitSeconds}s)`);
        updateStatus(`关注频率冷却中 (${waitSeconds}秒)...`, "限流中", "cooling");
        await delay(1000);
      } else {
        const jitterDelay = getRandomBetween(600, 2000);
        updateShieldUI(`保护中 (${sessionFollowCount}/${SESSION_MAX_FOLLOWS})`, `随机延时 ${Math.round(jitterDelay/1000)}s`);
        await delay(jitterDelay);
        return true;
      }
    }
    return false;
  }

  async function enforceHoverRateLimits() {
    while (isRunning) {
      if (detectPlatformWarning()) {
        stopAutomation("透视期间检测到风控警告，已停机", "风控熔断", "cooling");
        return;
      }

      const now = Date.now();
      hoverTimestamps = hoverTimestamps.filter((ts) => now - ts < 60000);

      const hoverLast20s = hoverTimestamps.filter((ts) => now - ts < 20000).length;
      const hoverLast60s = hoverTimestamps.length;

      let waitTime = 0;

      if (hoverLast20s >= 3) {
        const oldestIn20s = hoverTimestamps.filter((ts) => now - ts < 20000)[0];
        waitTime = Math.max(waitTime, 20000 - (now - oldestIn20s) + 500);
      }

      if (hoverLast60s >= 8) {
        const oldestIn60s = hoverTimestamps[0];
        waitTime = Math.max(waitTime, 60000 - (now - oldestIn60s) + 500);
      }

      if (waitTime > 0) {
        const waitSeconds = Math.ceil(waitTime / 1000);
        updateShieldUI("GraphQL 接口保护", `透视冷却中 (${waitSeconds}s)`);
        updateStatus(`透视接口冷却中 (${waitSeconds}秒)...`, "接口冷却", "cooling");
        await delay(1000);
      } else {
        const hoverJitter = getRandomBetween(700, 1600);
        await delay(hoverJitter);
        break;
      }
    }
  }

  function isInRecommendationModule(el) {
    if (el.closest('[data-testid="sidebarColumn"]') || el.closest("aside")) return true;
    if (el.closest('[data-testid="Carousel"], [aria-label*="Carousel"]')) return true;

    const cell = el.closest('[data-testid="UserCell"]');
    if (cell) {
      let parent = cell.parentElement;
      while (parent && parent !== document.body && parent.getAttribute("data-testid") !== "primaryColumn") {
        const header = parent.querySelector('h2, [role="heading"]');
        if (header) {
          const title = (header.innerText || "").toLowerCase();
          if (title.includes("推荐") || title.includes("who to follow") || title.includes("connect") || title.includes("相关")) {
            return true;
          }
        }
        parent = parent.parentElement;
      }
    }
    return false;
  }

  function isValidFollowButton(btn) {
    if (!btn || !document.body.contains(btn)) return false;
    if (isInRecommendationModule(btn)) return false;

    const testId = (btn.getAttribute("data-testid") || "").toLowerCase();
    const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
    const text = (btn.innerText || "").trim().toLowerCase();

    const blacklistWords = [
      "following", "正在关注", "已关注",
      "requested", "pending", "已申请", "已请求",
      "blocked", "已屏蔽", "unblock", "解除屏蔽",
      "unfollow", "取消关注"
    ];

    for (const word of blacklistWords) {
      if (testId.includes(word) || aria.includes(word) || text.includes(word)) return false;
    }

    const hasFollowId = testId.includes("follow");
    const isFollowText = text === "follow" || text === "关注" || aria.startsWith("follow @") || aria.startsWith("关注 @");

    return hasFollowId || isFollowText;
  }

  function findFollowBtnInCell(cell) {
    const allBtns = Array.from(cell.querySelectorAll('button, [role="button"]'));
    return allBtns.find((b) => isValidFollowButton(b)) || null;
  }

  async function fetchUserHoverStats(userLink) {
    const existingCard = document.querySelector('[data-testid="HoverCard"]');
    if (existingCard) {
      document.body.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      await delay(250);
    }

    await enforceHoverRateLimits();
    if (!isRunning) return { following: 0, followers: 0, valid: false };

    hoverTimestamps.push(Date.now());

    const mouseOverEvents = ["pointerover", "mouseover", "mouseenter"];
    mouseOverEvents.forEach((type) => {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      userLink.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
    });

    let hoverCard = null;
    const pollStart = Date.now();
    while (Date.now() - pollStart < 2600) {
      hoverCard = document.querySelector('[data-testid="HoverCard"]');
      if (hoverCard) {
        const hasLinks = hoverCard.querySelector('a[href$="/following"]');
        if (hasLinks) break;
      }
      await delay(120);
    }

    let stats = { following: 0, followers: 0, valid: false };

    if (hoverCard) {
      const followingLink = hoverCard.querySelector('a[href$="/following"]');
      const followersLink = hoverCard.querySelector('a[href$="/verified_followers"], a[href$="/followers"]');

      if (followingLink && followersLink) {
        stats.following = parseSocialCount(followingLink.innerText);
        stats.followers = parseSocialCount(followersLink.innerText);
        stats.valid = true;
      }
    }

    const mouseOutEvents = ["mouseleave", "mouseout", "pointerout"];
    mouseOutEvents.forEach((type) => {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      userLink.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
    });
    await delay(getRandomBetween(400, 800)); 

    return stats;
  }

  async function runLoop() {
    try {
      let emptyCount = 0;

      while (isRunning) {
        const ctx = getPageContext();

        if (!ctx.valid) {
          if (ctx.reason === "UNKNOWN_USER") {
            updateStatus("正在识别当前登录账号...", "识别中", "cooling");
            await delay(1000);
            continue;
          }
          stopAutomation("就绪", "已退出", "cooling");
          break;
        }

        if (detectPlatformWarning()) {
          stopAutomation("检测到平台风控提示（如速度限制），已紧急熔断", "风控熔断", "cooling");
          break;
        }

        const primaryCol = document.querySelector('[data-testid="primaryColumn"]');
        const cells = primaryCol ? Array.from(primaryCol.querySelectorAll('[data-testid="UserCell"]')) : [];

        let actionTakenInBatch = false;

        for (const cell of cells) {
          if (!isRunning) break;
          if (isInRecommendationModule(cell)) continue;

          const btn = findFollowBtnInCell(cell);
          if (!btn || processedButtons.has(btn)) continue;

          if (ctx.mode === "SELF_FOLLOWBACK") {
            btn.scrollIntoView({ behavior: "auto", block: "center" });
            await delay(getRandomBetween(450, 850));

            if (isValidFollowButton(btn)) {
              const canProceed = await enforceFollowRateLimits();
              if (!canProceed || !isRunning) break;

              if (detectPlatformWarning()) {
                stopAutomation("操作前检测到限制，已紧急停机", "风控熔断", "cooling");
                break;
              }

              processedButtons.add(btn);
              btn.click();

              await delay(1500);
              if (detectPlatformWarning()) {
                stopAutomation("点击后立即触发限制提示，已停机", "风控熔断", "cooling");
                break;
              }

              followTimestamps.push(Date.now());
              followCount++;
              sessionFollowCount++;

              document.getElementById("x-af-count").innerText = followCount;
              updateTabTitle(followCount);
              updateShieldUI(`保护中 (${sessionFollowCount}/${SESSION_MAX_FOLLOWS})`, `距休息还剩 ${Math.max(0, nextMicroBreakTarget - sessionFollowCount)} 人`);
              updateStatus(`已回关第 ${followCount} 位粉丝`, "运行中", "active");

              actionTakenInBatch = true;
              await delay(getRandomBetween(1300, 2300)); 
            } else {
              processedButtons.add(btn);
            }
          } else if (ctx.mode === "OTHER_FILTER") {
            const verifiedBadge = cell.querySelector('svg[data-testid="icon-verified"]');
            if (!verifiedBadge) {
              processedButtons.add(btn);
              continue;
            }

            const userLink = cell.querySelector('a[role="link"][href^="/"]');
            if (!userLink) {
              processedButtons.add(btn);
              continue;
            }

            btn.scrollIntoView({ behavior: "auto", block: "center" });
            await delay(getRandomBetween(450, 800));

            updateStatus("正在安全透视蓝V数据...", "透视中", "active");
            const stats = await fetchUserHoverStats(userLink);
            if (!isRunning) break;

            if (!stats.valid) {
              consecutiveHoverFails++;
              processedButtons.add(btn);

              if (consecutiveHoverFails >= 4) {
                updateShieldUI("透视熔断保护", "接口受限，60s深度休眠");
                for (let c = 60; c > 0 && isRunning; c--) {
                  if (detectPlatformWarning()) {
                    stopAutomation("深度休眠中检测到风控，已停机", "风控熔断", "cooling");
                    return;
                  }
                  updateStatus(`透视接口响应受限，深度冷却中 (${c}秒)...`, "接口保护", "cooling");
                  await delay(1000);
                }
                consecutiveHoverFails = 0;
              } else {
                updateStatus(`数据未加载，跳过 (${consecutiveHoverFails}/4)`, "运行中", "active");
                await delay(600);
              }
              continue;
            }

            consecutiveHoverFails = 0;
            actionTakenInBatch = true;

            const diff = Math.abs(stats.followers - stats.following);

            if (diff <= maxAllowedDiff) {
              const canProceed = await enforceFollowRateLimits();
              if (!canProceed || !isRunning) break;

              if (detectPlatformWarning()) {
                stopAutomation("点击前检测到限制，已紧急停机", "风控熔断", "cooling");
                break;
              }

              processedButtons.add(btn);
              btn.click();

              await delay(1500);
              if (detectPlatformWarning()) {
                stopAutomation("点击后立即触发限制提示，已停机", "风控熔断", "cooling");
                break;
              }

              followTimestamps.push(Date.now());
              followCount++;
              sessionFollowCount++;

              document.getElementById("x-af-count").innerText = followCount;
              updateTabTitle(followCount);
              updateShieldUI(`保护中 (${sessionFollowCount}/${SESSION_MAX_FOLLOWS})`, `距休息还剩 ${Math.max(0, nextMicroBreakTarget - sessionFollowCount)} 人`);
              updateStatus(`已关注 (粉:${stats.followers} 关:${stats.following} 差:${diff})`, "运行中", "active");

              await delay(getRandomBetween(1500, 2600)); 
            } else {
              processedButtons.add(btn);
              updateStatus(`跳过 (差:${diff} > ${maxAllowedDiff})`, "运行中", "active");
              await delay(getRandomBetween(600, 1200));
            }
          }
        }

        if (!isRunning) break;

        if (!actionTakenInBatch) {
          emptyCount++;
          updateStatus(`向下扫描列表中 (${emptyCount}/25)...`, "扫描中", "active");

          const randomScroll = getRandomBetween(550, 820);
          window.scrollBy({ top: randomScroll, left: 0, behavior: "auto" });
          window.dispatchEvent(new Event("scroll", { bubbles: true }));
          await delay(getRandomBetween(2200, 3300)); 

          if (emptyCount >= 25) {
            stopAutomation("已到达列表底部或无更多目标", "已完成", "");
            break;
          }
        } else {
          emptyCount = 0;
          window.scrollBy({ top: getRandomBetween(300, 500), left: 0, behavior: "auto" });
          window.dispatchEvent(new Event("scroll", { bubbles: true }));
          await delay(getRandomBetween(1200, 1800));
        }
      }
    } catch (e) {
      console.error("[x-auto-follow] runLoop error:", e);
      stopAutomation("运行异常，已停止", "异常", "cooling");
    }
  }

  function checkRoute() {
    const panel = createUI();
    const ctx = getPageContext();

    const userDisplay = document.getElementById("x-af-user-display");
    if (userDisplay && ctx.myHandle) {
      userDisplay.innerText = `@${ctx.myHandle}`;
    }

    if (ctx.valid) {
      panel.classList.remove("x-hidden");

      const modeDisplay = document.getElementById("x-af-mode-display");
      const diffRow = document.getElementById("x-af-diff-row");
      const countLabel = document.getElementById("x-af-count-label");

      if (ctx.mode === "SELF_FOLLOWBACK") {
        if (modeDisplay) modeDisplay.innerText = "本人互关模式";
        if (diffRow) diffRow.classList.add("x-hidden");
        if (countLabel) countLabel.innerText = "已回关";
      } else {
        if (modeDisplay) modeDisplay.innerText = `拓客 (@${ctx.pageUser})`;
        if (diffRow) diffRow.classList.remove("x-hidden");
        if (countLabel) countLabel.innerText = "已关注";
      }
    } else {
      panel.classList.add("x-hidden");
      if (isRunning && ctx.reason !== "UNKNOWN_USER") {
        stopAutomation("就绪", "已暂停", "");
      }
    }
  }

  setInterval(checkRoute, 700);
})();