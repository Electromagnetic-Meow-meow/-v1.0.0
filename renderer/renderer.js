(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    card: $('card'),
    contentScale: $('contentScale'),
    topBar: document.querySelector('.top'),
    statusText: $('statusText'),
    dateText: $('dateText'),
    amount: $('amount'),
    bar: $('bar'),
    pct: $('pct'),
    target: $('target'),
    cdLabel: $('cdLabel'),
    countdown: $('countdown'),
    hourly: $('hourly'),
    otRate: $('otRate'),
    otRateLabel: $('otRateLabel'),
    rates: $('rates'),
    actionButtons: $('actionButtons'),
    offBtn: $('offBtn'),
    nowStartBtn: $('nowStartBtn'),
    backfillBtn: $('backfillBtn'),
    backfillPanel: $('backfillPanel'),
    backfillTime: $('backfillTime'),
    backfillConfirm: $('backfillConfirm'),
    backfillCancel: $('backfillCancel'),
    otBtn: $('otBtn'),
    finishToast: $('finishToast'),
    makeupNotice: $('makeupNotice'),
    edgeBar: $('edgeBar'),
    edgeBarFill: $('edgeBarFill'),
    edgeTicks: $('edgeTicks'),
    weekendPrompt: $('weekendPrompt'),
    weekendYes: $('weekendYes'),
    weekendNo: $('weekendNo'),
    resizeGrip: $('resizeGrip'),
    pinBtn: $('pinBtn'),
    settingsBtn: $('settingsBtn'),
    menuBtn: $('menuBtn'),
    closeBtn: $('closeBtn'),
  };

  const STATUS_LABEL = {
    working: '工作中',
    lunch: '午休中',
    evening: '晚休中',
    off: '已下班',
    before: '未上班',
    rest: '休息日',
    holiday: '法定节假日',
    overtime: '加班中',
  };

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const OT_STORAGE_KEY = 'salary-widget:overtime:v1';
  const WEEKEND_PLAN_KEY = 'salary-widget:weekend-plan:v1';
  const OFFWORK_CONFIRMED_KEY = 'salary-widget:offwork-confirmed:v1';
  const CELEBRATE_MS = 10000;
  const OT_PREVIEW_BEFORE_MS = 30 * 60 * 1000;
  const FINISH_PHRASES = [
    '今天的你也很棒，辛苦了！快去休息吧！',
    '辛苦啦，今天也顺利收工，好好休息一下吧！',
    '今天的你超棒，剩下的时间交给自己吧！',
    '又认真赚了一天，辛苦了，早点休息！',
    '今天也辛苦啦，下班后好好放松一下吧！',
    '收工！今天的努力已经到账，去休息吧！',
  ];

  let cfg = null;
  let overtime = null;
  let celebrateUntil = 0;
  let pendingCelebration = false;
  let windowHidden = false;
  let offConfirmedDate = '';
  let backfillOpen = false;
  let pendingMakeupNotice = false;
  let makeupNoticeUntil = 0;
  let lastFinishPhrase = '';
  let holidayInfo = { holidays: {}, workdays: [], statutory: [] };
  let holidaySet = new Set();
  let makeupSet = new Set();
  let statutorySet = new Set();
  let records = { leaves: {}, ot: {} };
  const LEAVE_LABEL = { paid: '有薪假/年假', sick: '病假', personal: '事假' };
  let dockCollapseTimer = null;
  let dockCollapsed = false;
  let dockDocked = false;
  let dockPointerDown = false;
  let dockIgnoreLeaveUntil = 0;
  let dockHoverCheckTimer = null;
  let dockTickHours = 0;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function parseHM(value) {
    const [h, m] = String(value || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  function atTime(base, hm) {
    const [h, m] = String(hm).split(':').map(Number);
    const d = new Date(base);
    d.setHours(h || 0, m || 0, 0, 0);
    return d;
  }

  function dateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function setHolidayInfo(info) {
    holidayInfo = info && typeof info === 'object'
      ? info
      : { holidays: {}, workdays: [], statutory: [] };
    holidaySet = new Set(Object.keys(holidayInfo.holidays || {}));
    makeupSet = new Set(Array.isArray(holidayInfo.workdays) ? holidayInfo.workdays : []);
    statutorySet = new Set(Array.isArray(holidayInfo.statutory) ? holidayInfo.statutory : []);
  }

  function dayKind(date) {
    const key = dateKey(date);
    if (makeupSet.has(key)) return 'makeup';
    if (holidaySet.has(key)) return 'holiday';
    const days = Array.isArray(cfg.workdays) && cfg.workdays.length
      ? cfg.workdays
      : [1, 2, 3, 4, 5];
    return days.includes(date.getDay()) ? 'workday' : 'rest';
  }

  function isWorkday(date) {
    const kind = dayKind(date);
    return kind === 'workday' || kind === 'makeup';
  }

  function countWorkdaysInMonth(date) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const days = new Date(year, month + 1, 0).getDate();
    let count = 0;
    for (let day = 1; day <= days; day += 1) {
      if (isWorkday(new Date(year, month, day))) count += 1;
    }
    return Math.max(1, count);
  }

  function holidayName(date) {
    const name = holidayInfo.holidays ? holidayInfo.holidays[dateKey(date)] : '';
    return String(name || '').split(/[、,，]/)[0] || '节假日';
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function isPromptDay(date) {
    const tomorrow = addDays(date, 1);
    if (isWorkday(tomorrow)) return false;
    if (!isWorkday(date)) return true;
    // 工作日只有在后面至少还有两个连续休息日时才开始询问，
    // 否则明天就是唯一休息日，没有“倒数第二天”。
    return !isWorkday(addDays(date, 2));
  }

  function loadWeekendPlans() {
    try {
      const raw = JSON.parse(localStorage.getItem(WEEKEND_PLAN_KEY));
      if (raw && raw.plans && typeof raw.plans === 'object') {
        const plans = {};
        for (const [date, answer] of Object.entries(raw.plans)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(date) && (answer === 'yes' || answer === 'no')) {
            plans[date] = answer;
          }
        }
        return plans;
      }
      // 兼容上一版“只保存第二天”的单个 target 格式。
      if (
        raw &&
        typeof raw.target === 'string' &&
        (raw.answer === 'yes' || raw.answer === 'no')
      ) {
        return { [raw.target]: raw.answer };
      }
    } catch {
      // ignore
    }
    return {};
  }

  function saveWeekendPlan(plan) {
    try {
      const plans = loadWeekendPlans();
      plans[plan.target] = plan.answer;
      localStorage.setItem(WEEKEND_PLAN_KEY, JSON.stringify({ plans }));
    } catch {
      // ignore
    }
  }

  function weekendPlanFor(date) {
    const answer = loadWeekendPlans()[dateKey(date)];
    return answer ? { target: dateKey(date), answer } : null;
  }

  function pickFinishPhrase() {
    let phrase = FINISH_PHRASES[0];
    do {
      phrase = FINISH_PHRASES[Math.floor(Math.random() * FINISH_PHRASES.length)];
    } while (FINISH_PHRASES.length > 1 && phrase === lastFinishPhrase);
    lastFinishPhrase = phrase;
    return phrase;
  }

  function formatMoney(value) {
    const safe = Number.isFinite(value) ? value : 0;
    return safe.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  function formatCountdown(ms, withDays) {
    if (!withDays) return formatClock(ms);
    const total = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(total / 86400);
    if (days <= 0) return formatClock(ms);
    const rest = total % 86400;
    const h = Math.floor(rest / 3600);
    const m = Math.floor((rest % 3600) / 60);
    const s = rest % 60;
    return `${days}天 ${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  function paidMsBetween(fromMs, toMs, breaks) {
    if (!(toMs > fromMs)) return 0;
    let total = toMs - fromMs;
    for (const item of breaks) {
      const overlap = Math.min(toMs, item.end) - Math.max(fromMs, item.start);
      if (overlap > 0) total -= overlap;
    }
    return Math.max(0, total);
  }

  function nextWorkStart(now) {
    for (let i = 0; i < 31; i += 1) {
      const day = new Date(now);
      day.setDate(now.getDate() + i);
      if (!isWorkday(day)) continue;
      const start = atTime(day, cfg.workStart);
      if (start.getTime() > now.getTime()) return start;
    }
    return new Date(now.getTime() + 86400000);
  }

  function mergeBreaks(breaks) {
    const sorted = breaks
      .filter((item) => item.end > item.start)
      .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const item of sorted) {
      const last = merged[merged.length - 1];
      if (last && item.start <= last.end) {
        last.end = Math.max(last.end, item.end);
      } else {
        merged.push({ start: item.start, end: item.end });
      }
    }
    return merged;
  }

  function getSchedule(now) {
    const start = atTime(now, cfg.workStart);
    const end = atTime(now, cfg.workEnd);
    const lunchStart = atTime(now, cfg.lunchStart);
    const lunchEnd = atTime(now, cfg.lunchEnd);

    const startMin = parseHM(cfg.workStart);
    const endMin = parseHM(cfg.workEnd);
    const lunchStartMin = parseHM(cfg.lunchStart);
    const lunchEndMin = parseHM(cfg.lunchEnd);
    const lunchValid =
      lunchEndMin > lunchStartMin &&
      lunchStartMin >= startMin &&
      lunchEndMin <= endMin &&
      lunchEndMin - lunchStartMin < endMin - startMin;

    const eveningStartHM = cfg.eveningStart || cfg.workEnd;
    const eveningEndHM = cfg.eveningEnd || cfg.workEnd;
    const eveningStart = atTime(now, eveningStartHM);
    const eveningEnd = atTime(now, eveningEndHM);
    const eveningValid = parseHM(eveningEndHM) > parseHM(eveningStartHM);

    const breaks = [];
    if (lunchValid) {
      breaks.push({ start: lunchStart.getTime(), end: lunchEnd.getTime() });
    }
    if (eveningValid) {
      breaks.push({ start: eveningStart.getTime(), end: eveningEnd.getTime() });
    }

    const mergedBreaks = mergeBreaks(breaks);
    const dailyMs = paidMsBetween(start.getTime(), end.getTime(), mergedBreaks);
    return {
      start,
      end,
      lunchStart,
      lunchEnd,
      lunchValid,
      eveningStart,
      eveningEnd,
      eveningValid,
      breaks: mergedBreaks,
      dailyMs,
    };
  }

  function freshOvertime(now) {
    return {
      date: dateKey(now),
      active: false,
      start: 0,
      end: 0,
      finished: false,
      weekend: false,
    };
  }

  function loadOvertime(now) {
    try {
      const raw = JSON.parse(sessionStorage.getItem(OT_STORAGE_KEY));
      if (
        raw &&
        raw.date === dateKey(now) &&
        typeof raw.active === 'boolean' &&
        typeof raw.finished === 'boolean'
      ) {
        return {
          date: raw.date,
          active: Boolean(raw.active),
          start: Number(raw.start) || 0,
          end: Number(raw.end) || 0,
          finished: Boolean(raw.finished),
          weekend: Boolean(raw.weekend),
        };
      }
    } catch {
      // ignore
    }
    return freshOvertime(now);
  }

  function saveOvertime() {
    try {
      sessionStorage.setItem(OT_STORAGE_KEY, JSON.stringify(overtime));
    } catch {
      // ignore
    }
  }

  function ensureOvertime(now) {
    if (!overtime || overtime.date !== dateKey(now)) {
      overtime = freshOvertime(now);
      celebrateUntil = 0;
      pendingCelebration = false;
      saveOvertime();
    }
  }

  function maybeStartAutoOvertime(now) {
    if (!cfg || overtime.active || overtime.finished) return;
    const schedule = getSchedule(now);
    const restDay = !isWorkday(now);
    const autoEnabled = restDay
      ? Boolean(cfg.autoRestOt)
      : Boolean(cfg.autoWorkdayOt);
    if (!autoEnabled) return;

    // 工作日从下班时间开始；非工作日从上班时间开始自动计加班
    const start = restDay ? schedule.start.getTime() : schedule.end.getTime();
    if (now.getTime() < start) return;

    overtime = {
      date: dateKey(now),
      active: true,
      start,
      end: 0,
      finished: false,
      weekend: restDay,
    };
    saveOvertime();
  }

  function maybeFinalizePlannedRestDay(now) {
    if (!cfg || isWorkday(now)) return;
    if (overtime.active || overtime.finished) return;
    if (cfg.autoRestOt) return;

    const plan = weekendPlanFor(now);
    if (!plan || plan.answer !== 'yes') return;

    const schedule = getSchedule(now);
    if (now.getTime() < schedule.end.getTime()) return;

    // 前一天确认“明天加班”：默认按工作日的上班/下班时间结算一整天；
    // 如果中途手动点了「我要加班」，overtime.active 为 true，这里不会覆盖。
    overtime = {
      date: dateKey(now),
      active: false,
      start: schedule.start.getTime(),
      end: schedule.end.getTime(),
      finished: true,
      weekend: true,
    };
    saveOvertime();
    persistOvertimeRecord(overtime);
    els.finishToast.textContent = pickFinishPhrase();
    pendingCelebration = true;
    celebrateUntil = 0;
  }

  function compute(now) {
    const schedule = getSchedule(now);
    const nowMs = now.getTime();
    const kind = dayKind(now);
    const holiday = kind === 'holiday';
    const statutory = holiday && statutorySet.has(dateKey(now));
    const makeup = kind === 'makeup';
    const restDay = kind === 'rest' || holiday;
    const dailyMs = schedule.dailyMs;
    const monthlyWorkdays = countWorkdaysInMonth(now);

    const hourly = dailyMs > 0 ? cfg.monthlySalary / monthlyWorkdays / (dailyMs / 3600000) : 0;
    const perMs = dailyMs > 0 ? cfg.monthlySalary / monthlyWorkdays / dailyMs : 0;
    const restMultiplier = Number.isFinite(cfg.weekendOvertimeMultiplier)
      ? cfg.weekendOvertimeMultiplier
      : 2;
    const configuredHolidayMultiplier = Number.isFinite(cfg.holidayOvertimeMultiplier)
      ? cfg.holidayOvertimeMultiplier
      : 3;
    const effectiveHolidayMultiplier = statutory
      ? configuredHolidayMultiplier
      : restMultiplier;
    const otMultiplier = holiday
      ? effectiveHolidayMultiplier
      : restDay || overtime.weekend
        ? restMultiplier
        : cfg.overtimeMultiplier;
    const otHourly = cfg.overtimeBase > 0
      ? (cfg.overtimeBase / monthlyWorkdays / 8) * otMultiplier
      : 0;
    const otPerMs = otHourly / 3600000;

    const todayKey = dateKey(now);
    const leave = records.leaves ? records.leaves[todayKey] : null;
    const leaveType = leave?.type || '';
    const leaveSkip = Boolean(
      leave
      && (leaveType === 'paid' || leaveType === 'personal')
      && restDay,
    );
    const leaveActive = Boolean(leave && !leaveSkip);
    const sickLeaveRatio = Number.isFinite(cfg.sickLeaveRatio) ? cfg.sickLeaveRatio : 0.8;
    const leaveStart = leave ? atTime(now, leave.start || cfg.workStart) : null;
    const leaveEnd = leave ? atTime(now, leave.end || cfg.workEnd) : null;
    const leaveScheduledMs = leaveActive && leaveStart && leaveEnd
      ? paidMsBetween(
          Math.max(schedule.start.getTime(), leaveStart.getTime()),
          Math.min(schedule.end.getTime(), leaveEnd.getTime()),
          schedule.breaks,
        )
      : 0;
    const leaveElapsedMs = leaveActive && leaveStart && leaveEnd
      ? paidMsBetween(
          Math.max(schedule.start.getTime(), leaveStart.getTime()),
          Math.min(nowMs, schedule.end.getTime(), leaveEnd.getTime()),
          schedule.breaks,
        )
      : 0;
    const fullDayLeave = leaveScheduledMs >= dailyMs - 60000;
    const leavePaidMs = fullDayLeave ? leaveScheduledMs : leaveElapsedMs;
    const leavePayable = Boolean(
      leaveActive
      && (leaveType === 'paid' || leaveType === 'sick')
      && !restDay
      && leaveScheduledMs > 0,
    );
    const leaveHours = leaveActive && !restDay ? leaveScheduledMs / 3600000 : 0;
    const leavePay = leavePayable
      ? leavePaidMs * perMs * (leaveType === 'sick' ? sickLeaveRatio : 1)
      : 0;

    const scheduledElapsedMs = restDay
      ? 0
      : paidMsBetween(
          schedule.start.getTime(),
          Math.min(nowMs, schedule.end.getTime()),
          schedule.breaks,
        );
    const normalPaidMs = leaveActive
      ? Math.max(0, scheduledElapsedMs - (fullDayLeave ? 0 : leaveElapsedMs))
      : scheduledElapsedMs;
    const paidMs = normalPaidMs;

    const otActive = !leaveActive && Boolean(overtime.active);
    const otFinished = !leaveActive && Boolean(overtime.finished);
    let otMs = 0;
    if (!leaveActive && (otActive || otFinished)) {
      const from = Math.max(
        overtime.start,
        restDay ? overtime.start : schedule.end.getTime(),
      );
      const to = otFinished ? overtime.end : nowMs;
      if (to > from) {
        otMs = paidMsBetween(from, to, schedule.breaks);
      }
    }

    const earned = leaveActive
      ? normalPaidMs * perMs + leavePay
      : paidMs * perMs + otMs * otPerMs;
    const progress = leaveActive
      ? dailyMs > 0 ? Math.min(1, earned / (cfg.monthlySalary / monthlyWorkdays)) : 0
      : dailyMs > 0 ? Math.min(1, paidMs / dailyMs) : 0;
    const otPreviewStart = restDay ? 0 : schedule.end.getTime() - OT_PREVIEW_BEFORE_MS;
    const eligible = restDay ? true : nowMs >= otPreviewStart;
    const offConfirmed = offConfirmedDate === todayKey;
    const autoEnabled = restDay
      ? Boolean(cfg.autoRestOt)
      : Boolean(cfg.autoWorkdayOt);
    const canConfirmOff = !leaveActive
      && !restDay
      && nowMs >= schedule.end.getTime()
      && !autoEnabled
      && !otActive
      && !otFinished
      && !offConfirmed;
    const canStart = !leaveActive
      && eligible
      && !autoEnabled
      && !otActive
      && !otFinished
      && !offConfirmed;
    const waitingStart = otActive && nowMs < overtime.start;

    const eveningInWork =
      schedule.eveningValid &&
      schedule.eveningStart.getTime() < schedule.end.getTime() &&
      schedule.eveningEnd.getTime() > schedule.start.getTime();
    const inLunch =
      schedule.lunchValid &&
      nowMs >= schedule.lunchStart.getTime() &&
      nowMs < schedule.lunchEnd.getTime();
    const inEvening =
      schedule.eveningValid &&
      nowMs >= schedule.eveningStart.getTime() &&
      nowMs < schedule.eveningEnd.getTime();

    let status;
    let cdMs;
    let cdLabel;
    let withDays = false;

    if (leaveActive) {
      status = 'leave';
      cdLabel = LEAVE_LABEL[leaveType] || '请假';
      cdMs = 0;
    } else if (restDay) {
      if (otActive) {
        status = 'overtime';
        if (waitingStart) {
          cdLabel = '距加班开始';
          cdMs = overtime.start - nowMs;
        } else {
          cdLabel = '已加班';
          cdMs = otMs;
        }
      } else if (otFinished) {
        status = 'off';
        cdLabel = '已收工';
        cdMs = otMs;
      } else {
        status = holiday ? 'holiday' : 'rest';
        cdLabel = '距上班';
        cdMs = nextWorkStart(now).getTime() - nowMs;
        withDays = true;
      }
    } else if (nowMs < schedule.start.getTime()) {
      status = 'before';
      cdLabel = '距上班';
      cdMs = schedule.start.getTime() - nowMs;
    } else if (inLunch) {
      status = 'lunch';
      cdLabel = '午休中 · 距下班';
      cdMs = schedule.end.getTime() - nowMs;
    } else if (inEvening && eveningInWork) {
      status = 'evening';
      cdLabel = '晚休中 · 距下班';
      cdMs = schedule.end.getTime() - nowMs;
    } else if (nowMs >= schedule.end.getTime()) {
      if (otActive) {
        status = 'overtime';
        cdLabel = '已加班';
        cdMs = otMs;
      } else if (otFinished) {
        status = 'off';
        cdLabel = '已收工';
        cdMs = otMs;
      } else if (offConfirmed) {
        status = 'off';
        cdLabel = '已收工';
        cdMs = 0;
      } else {
        status = 'off';
        cdLabel = '已下班';
        cdMs = nowMs - schedule.end.getTime();
      }
    } else {
      status = 'working';
      cdLabel = '距下班';
      cdMs = schedule.end.getTime() - nowMs;
    }

    return {
      status,
      cdMs,
      cdLabel,
      withDays,
      earned,
      progress,
      dailyHours: dailyMs / 3600000,
      hourly,
      otHourly,
      dailyPay: cfg.monthlySalary / monthlyWorkdays,
      monthlyWorkdays,
      otMs,
      kind,
      restDay,
      holiday,
      statutory,
      makeup,
      holidayName: holiday ? holidayName(now) : '',
      holidayMultiplier: effectiveHolidayMultiplier,
      autoEnabled,
      otActive,
      otFinished,
      otWaiting: waitingStart,
      offConfirmed,
      canConfirmOff,
      canStart,
      leaveActive,
      leaveType,
      leaveHours,
      leavePay,
      sickLeaveRatio,
    };
  }

  function shouldShowWeekendPrompt(now) {
    if (cfg.autoRestOt) return false;
    if (!isPromptDay(now)) return false;
    const tomorrow = addDays(now, 1);
    if (weekendPlanFor(tomorrow)) return false;
    return true;
  }

  function answerWeekendPlan(yes) {
    const now = new Date();
    const tomorrow = addDays(now, 1);
    if (isWorkday(tomorrow) || !isPromptDay(now) || weekendPlanFor(tomorrow)) {
      els.weekendPrompt.hidden = true;
      return;
    }
    saveWeekendPlan({
      target: dateKey(tomorrow),
      answer: yes ? 'yes' : 'no',
    });
    els.weekendPrompt.hidden = true;
    render();
  }

  function drawDockTicks() {
    const canvas = els.edgeTicks;
    if (!canvas) return;
    const total = Number(dockTickHours) || 0;
    const count = total > 0 ? Math.max(0, Math.floor(total - 0.001)) : 0;
    const width = els.edgeBar.clientWidth;
    const height = els.edgeBar.clientHeight;
    if (count <= 0 || width <= 0 || height <= 0 || !document.body.classList.contains('dock-collapsed')) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.68)';
    const thickness = Math.max(1, Math.round(dpr));
    const edge = document.body.dataset.dockEdge;
    const vertical = edge === 'left' || edge === 'right';
    for (let index = 1; index <= count; index += 1) {
      const ratio = index / total;
      if (ratio >= 1) continue;
      if (vertical) {
        const y = Math.min(pixelHeight - thickness, Math.max(0, Math.round((1 - ratio) * pixelHeight)));
        ctx.fillRect(0, y, pixelWidth, thickness);
      } else {
        const x = Math.min(pixelWidth - thickness, Math.max(0, Math.round(ratio * pixelWidth)));
        ctx.fillRect(x, 0, thickness, pixelHeight);
      }
    }
  }

  function renderDockTicks(hours) {
    dockTickHours = Number(hours) || 0;
    drawDockTicks();
  }

  function render() {
    if (!cfg) return;
    const now = new Date();
    ensureOvertime(now);
    maybeStartAutoOvertime(now);
    maybeFinalizePlannedRestDay(now);
    const data = compute(now);
    const nowMs = now.getTime();

    updateCelebration(nowMs);
    updateMakeupNotice(nowMs);
    const celebrating = pendingCelebration && nowMs < celebrateUntil;
    const showingMakeupNotice = pendingMakeupNotice || nowMs < makeupNoticeUntil;

    els.card.dataset.status = data.status;

    let statusLabel = STATUS_LABEL[data.status] || '';
    if (data.leaveActive) {
      statusLabel = LEAVE_LABEL[data.leaveType] || '请假';
    } else if (data.status === 'holiday') {
      statusLabel = data.statutory ? '法定节假日' : '节假日';
    } else if (data.status === 'overtime') {
      statusLabel = data.holiday
        ? data.statutory ? '法定节假日加班' : '节假日加班'
        : data.restDay ? '周末加班' : '加班中';
    } else if (data.status === 'off' && (data.otFinished || data.offConfirmed)) {
      statusLabel = '已收工';
    }
    els.statusText.textContent = statusLabel;

    const dateSuffix = data.holiday
      ? ` · ${data.holidayName}`
      : data.makeup
        ? ' · 调休上班'
        : '';
    els.dateText.textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAYS[now.getDay()]}${dateSuffix}`;

    const moneyText = formatMoney(data.earned);
    els.amount.textContent = moneyText;
    els.amount.parentElement.classList.toggle('long', moneyText.length > 9);
    els.bar.style.width = `${(data.progress * 100).toFixed(2)}%`;

    if (data.restDay) {
      if (data.otWaiting) {
        els.pct.textContent = '待开始';
      } else if (data.otActive) {
        els.pct.textContent = data.holiday ? '节假日加班' : '加班中';
      } else if (data.otFinished) {
        els.pct.textContent = '已收工';
      } else {
        els.pct.textContent = data.holiday
          ? data.statutory ? '法定节假日' : '节假日'
          : '休息日';
      }
      if (data.holiday) {
        els.target.textContent =
          data.otActive || data.otFinished
            ? `${data.statutory ? '法定节假日' : '节假日'}加班按 ${data.holidayMultiplier} 倍累计`
            : data.statutory ? '法定节假日' : '节假日';
      } else {
        const restMultiplier = Number.isFinite(cfg.weekendOvertimeMultiplier)
          ? cfg.weekendOvertimeMultiplier
          : 2;
        els.target.textContent =
          data.otActive || data.otFinished
            ? `周末加班按 ${restMultiplier} 倍累计`
            : '今天不计薪';
      }
    } else {
      els.pct.textContent = `${Math.round(data.progress * 100)}%`;
      els.target.textContent = `今日满勤 ¥${formatMoney(data.dailyPay)}`;
    }

    if (data.leaveActive) {
      const leaveLabel = LEAVE_LABEL[data.leaveType] || '请假';
      els.pct.textContent = leaveLabel;
      if (data.leaveType === 'paid') {
        els.target.textContent = `按请假时段计薪（${data.leaveHours.toFixed(1)} 小时）`;
      } else if (data.leaveType === 'sick') {
        els.target.textContent = data.restDay ? '病假 · 当天不计薪' : `按正常工资 ${Math.round(data.sickLeaveRatio * 100)}% 计薪`;
      } else {
        els.target.textContent = '事假 · 当天不计薪';
      }
    }

    let cdText = formatCountdown(data.cdMs, data.withDays);
    if (data.leaveActive) cdText = '—';
    const showOtCountdown =
      (data.status === 'overtime' && !data.otWaiting) ||
      (data.status === 'off' && data.otFinished && data.otMs > 0);
    if (showOtCountdown) cdText = `+${cdText}`;
    els.countdown.textContent = cdText;
    els.countdown.classList.toggle('overtime', showOtCountdown);
    els.countdown.classList.toggle('day-count', cdText.includes('天'));
    els.cdLabel.textContent = data.cdLabel;

    els.hourly.textContent = `¥${formatMoney(data.hourly)}`;
    els.otRateLabel.textContent = data.holiday ? '节假日' : data.restDay ? '周末' : '加班';
    els.otRate.textContent = data.otHourly > 0
      ? `¥${formatMoney(data.otHourly)}/时`
      : '未设置';

    const showStop = Boolean(data.otActive);
    const schedule = getSchedule(now);
    const plannedToday = Boolean(
      data.restDay
      && !data.leaveActive
      && !cfg.autoRestOt
      && weekendPlanFor(now)?.answer === 'yes',
    );
    const plannedAction = plannedToday
      && !data.otActive
      && !data.otFinished
      && nowMs < schedule.end.getTime();
    if (!plannedAction) backfillOpen = false;
    const showPlanned = plannedAction && !celebrating && !backfillOpen;
    const showOff = Boolean(data.canConfirmOff) && !celebrating;
    const showStart = Boolean(data.canStart) && !celebrating && !showPlanned && !backfillOpen;
    const deciding = showOff && showStart && !showStop;
    els.offBtn.hidden = !showOff;
    els.nowStartBtn.hidden = !showPlanned;
    els.backfillBtn.hidden = !showPlanned || nowMs < schedule.start.getTime();
    els.backfillPanel.hidden = !backfillOpen;
    els.otBtn.hidden = !(showStop || showStart);
    els.otBtn.classList.toggle('stop', showStop);
    els.otBtn.classList.toggle('cancel', showStop && Boolean(data.otWaiting));
    els.otBtn.textContent = showStop
      ? data.otWaiting ? '取消预约' : '我下班啦！'
      : '我要加班';
    els.actionButtons.hidden = !(showOff || showPlanned || showStop || showStart);
    els.rates.hidden = !(showStop || showStart);
    els.card.classList.toggle('deciding', deciding);
    els.card.classList.toggle('planned', showPlanned);
    els.card.classList.toggle('backfilling', backfillOpen);

    els.card.classList.toggle('celebrating', celebrating);
    els.finishToast.hidden = !celebrating;
    els.makeupNotice.hidden = !showingMakeupNotice;

    els.weekendPrompt.hidden = !shouldShowWeekendPrompt(now);

    els.pinBtn.classList.toggle('active', Boolean(cfg.alwaysOnTop));
    els.pinBtn.title = cfg.alwaysOnTop ? '取消窗口置顶' : '窗口置顶';

    const dockProgress = Math.max(0, Math.min(1, data.progress)) * 100;
    document.body.style.setProperty('--dock-progress', `${dockProgress}%`);
    renderDockTicks(data.dailyHours);
  }

  function startOvertime() {
    const now = new Date();
    ensureOvertime(now);
    if (overtime.active || overtime.finished) return;
    if (offConfirmedDate === dateKey(now)) return;

    const schedule = getSchedule(now);
    const restDay = !isWorkday(now);
    const autoEnabled = restDay
      ? Boolean(cfg.autoRestOt)
      : Boolean(cfg.autoWorkdayOt);
    if (autoEnabled) return;
    if (!restDay && now.getTime() < schedule.end.getTime() - OT_PREVIEW_BEFORE_MS) return;

    let start = now.getTime();
    if (restDay) {
      const slot = 30 * 60 * 1000;
      start = Math.floor(start / slot) * slot + slot;
    } else {
      // 工作日/调休上班：从当天下班时间开始补算，避免下班后有事耽误。
      start = schedule.end.getTime();
    }

    overtime = {
      date: dateKey(now),
      active: true,
      start,
      end: 0,
      finished: false,
      weekend: restDay,
    };
    saveOvertime();
    celebrateUntil = 0;
    pendingCelebration = false;
    backfillOpen = false;
    render();
  }

  function openBackfill() {
    const now = new Date();
    ensureOvertime(now);
    if (overtime.active || overtime.finished) return;
    if (cfg.autoRestOt || isWorkday(now)) return;
    if (weekendPlanFor(now)?.answer !== 'yes') return;

    const schedule = getSchedule(now);
    if (now.getTime() < schedule.start.getTime() || now.getTime() >= schedule.end.getTime()) {
      return;
    }

    const startText = `${pad2(schedule.start.getHours())}:${pad2(schedule.start.getMinutes())}`;
    const nowText = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    els.backfillTime.min = startText;
    els.backfillTime.max = nowText;
    els.backfillTime.value = startText;
    backfillOpen = true;
    render();
  }

  function confirmBackfill() {
    const now = new Date();
    ensureOvertime(now);
    if (overtime.active || overtime.finished) return;
    if (cfg.autoRestOt || isWorkday(now)) return;
    if (weekendPlanFor(now)?.answer !== 'yes') return;

    const schedule = getSchedule(now);
    const [h, m] = String(els.backfillTime.value || '').split(':').map(Number);
    const chosen = new Date(now);
    chosen.setHours(Number.isFinite(h) ? h : schedule.start.getHours(), Number.isFinite(m) ? m : schedule.start.getMinutes(), 0, 0);
    const start = Math.max(
      schedule.start.getTime(),
      Math.min(now.getTime(), chosen.getTime()),
    );

    overtime = {
      date: dateKey(now),
      active: true,
      start,
      end: 0,
      finished: false,
      weekend: true,
    };
    saveOvertime();
    backfillOpen = false;
    pendingCelebration = false;
    celebrateUntil = 0;
    render();
  }

  function cancelBackfill() {
    backfillOpen = false;
    render();
  }

  function confirmOffWork() {
    const now = new Date();
    ensureOvertime(now);
    if (overtime.active || overtime.finished) return;
    if (cfg.autoWorkdayOt) return;
    if (offConfirmedDate === dateKey(now)) return;

    const kind = dayKind(now);
    if (kind === 'rest' || kind === 'holiday') return;
    const schedule = getSchedule(now);
    if (now.getTime() < schedule.end.getTime()) return;

    saveOffConfirmed(dateKey(now));
    queueMakeupNotice(now);
    els.finishToast.textContent = pickFinishPhrase();
    pendingCelebration = true;
    celebrateUntil = 0;
    render();
  }

  function persistOvertimeRecord(record) {
    if (!record || !record.end || !record.start) return;
    try {
      const endDate = new Date(record.end);
      const schedule = getSchedule(endDate);
      const from = record.weekend
        ? record.start
        : Math.max(record.start, schedule.end.getTime());
      const ms = paidMsBetween(from, record.end, schedule.breaks);
      if (ms > 0) {
        window.api.addOtRecord(dateKey(endDate), ms).catch(() => {});
      }
    } catch {
      // 统计记录失败不影响主流程
    }
  }

  function stopOvertime() {
    if (!overtime.active) return;

    // 下班前提前点了「我要加班」，此时只是预约；点「取消预约」直接取消，
    // 不产生加班费，也不显示结束高亮。
    if (Date.now() < overtime.start) {
      overtime = freshOvertime(new Date());
      saveOvertime();
      pendingCelebration = false;
      celebrateUntil = 0;
      render();
      return;
    }

    overtime.active = false;
    overtime.finished = true;
    overtime.end = Date.now();
    saveOvertime();
    persistOvertimeRecord(overtime);
    queueMakeupNotice(new Date(overtime.end));
    els.finishToast.textContent = pickFinishPhrase();
    pendingCelebration = true;
    celebrateUntil = 0;
    render();
  }

  function updateCelebration(nowMs) {
    if (!pendingCelebration) {
      celebrateUntil = 0;
      return;
    }
    const hidden = windowHidden || document.visibilityState === 'hidden';
    if (hidden) {
      celebrateUntil = 0;
      return;
    }
    if (!celebrateUntil) {
      celebrateUntil = nowMs + CELEBRATE_MS;
    }
    if (nowMs >= celebrateUntil) {
      pendingCelebration = false;
      celebrateUntil = 0;
    }
  }

  function queueMakeupNotice(now) {
    const tomorrow = addDays(now, 1);
    if (makeupSet.has(dateKey(tomorrow))) {
      pendingMakeupNotice = true;
      makeupNoticeUntil = 0;
    }
  }

  function updateMakeupNotice(nowMs) {
    if (!pendingMakeupNotice && !makeupNoticeUntil) return;
    const hidden = windowHidden || document.visibilityState === 'hidden';
    if (hidden) {
      makeupNoticeUntil = 0;
      return;
    }
    if (!makeupNoticeUntil) makeupNoticeUntil = nowMs + CELEBRATE_MS;
    if (nowMs >= makeupNoticeUntil) {
      pendingMakeupNotice = false;
      makeupNoticeUntil = 0;
    }
  }

  function applyDockState(state) {
    if (!state) return;
    dockDocked = Boolean(state.docked);
    dockCollapsed = Boolean(state.collapsed);
    document.body.dataset.dockEdge = state.edge || 'bottom';
    document.body.classList.toggle('dock-collapsed', dockCollapsed);
    requestAnimationFrame(drawDockTicks);
    if (dockCollapsed) {
      dockIgnoreLeaveUntil = 0;
    } else if (dockDocked) {
      dockIgnoreLeaveUntil = Date.now() + 300;
      clearTimeout(dockHoverCheckTimer);
    }
  }

  function scheduleDockCollapse() {
    clearTimeout(dockCollapseTimer);
    if (!dockDocked || dockCollapsed || dockPointerDown) return;
    dockCollapseTimer = setTimeout(() => {
      if (dockDocked && !dockCollapsed && !dockPointerDown) {
        window.api.dockCollapse();
      }
    }, 280);
  }

  function saveOffConfirmed(date) {
    offConfirmedDate = date;
    try {
      localStorage.setItem(OFFWORK_CONFIRMED_KEY, date);
    } catch {
      // ignore
    }
  }

  function loadOffConfirmed() {
    try {
      const value = localStorage.getItem(OFFWORK_CONFIRMED_KEY);
      if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) offConfirmedDate = value;
    } catch {
      // ignore
    }
  }

  function apply() {
    document.body.dataset.accent = cfg.accent;
  }

  function updateContentScale() {
    if (!els.contentScale || !els.topBar) return;
    const compact = window.innerWidth < 300 || window.innerHeight < 195;
    els.card.dataset.compact = compact ? 'true' : 'false';

    const style = getComputedStyle(els.card);
    const padLeft = parseFloat(style.paddingLeft) || 18;
    const padRight = parseFloat(style.paddingRight) || 18;
    const padTop = parseFloat(style.paddingTop) || 15;
    const padBottom = parseFloat(style.paddingBottom) || 13;
    const topHeight = els.topBar.getBoundingClientRect().height || 24;
    const areaWidth = Math.max(1, window.innerWidth - padLeft - padRight);
    const areaHeight = Math.max(1, window.innerHeight - padTop - topHeight - padBottom);

    if (compact) {
      els.contentScale.style.left = `${padLeft}px`;
      els.contentScale.style.top = `${padTop + topHeight}px`;
      els.contentScale.style.width = `${areaWidth}px`;
      els.contentScale.style.height = `${areaHeight}px`;
      els.contentScale.style.transform = 'none';
      return;
    }

    const baseWidth = 320;
    const baseHeight = 188;
    const scale = Math.max(0.4, Math.min(1, areaWidth / baseWidth, areaHeight / baseHeight));
    els.contentScale.style.left = `${padLeft}px`;
    els.contentScale.style.top = `${padTop + topHeight}px`;
    els.contentScale.style.width = `${areaWidth / scale}px`;
    els.contentScale.style.height = `${areaHeight / scale}px`;
    els.contentScale.style.transform = `scale(${scale})`;
  }

  async function updatePin() {
    await window.api.setAlwaysOnTop(!cfg.alwaysOnTop);
  }

  function clearButtonHover() {
    document.querySelectorAll('.icon-btn.hover').forEach((btn) => btn.classList.remove('hover'));
  }

  function beginResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const pointerId = event.pointerId;
    const startX = event.screenX;
    const startY = event.screenY;
    const startWidth = window.innerWidth;
    const startHeight = window.innerHeight;
    let pending = null;
    let frame = 0;
    let finished = false;
    let watchdog = 0;

    const flush = () => {
      frame = 0;
      if (pending) {
        window.api.resizeWidget(pending.width, pending.height);
      }
    };

    const onMove = (moveEvent) => {
      if (moveEvent.buttons === 0) {
        onUp();
        return;
      }
      pending = {
        width: startWidth + (moveEvent.screenX - startX),
        height: startHeight + (moveEvent.screenY - startY),
      };
      if (!frame) frame = requestAnimationFrame(flush);
      clearTimeout(watchdog);
      watchdog = setTimeout(onUp, 1800);
    };

    const onUp = () => {
      if (finished) return;
      finished = true;
      if (frame) cancelAnimationFrame(frame);
      document.body.classList.remove('resizing');
      clearTimeout(watchdog);
      try {
        els.resizeGrip.releasePointerCapture(pointerId);
      } catch {
        // ignore
      }
      if (pending) window.api.resizeWidget(pending.width, pending.height);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('blur', onUp);
      document.removeEventListener('pointerup', onUp, true);
      els.resizeGrip.removeEventListener('lostpointercapture', onUp);
    };

    try {
      els.resizeGrip.setPointerCapture(pointerId);
    } catch {
      // ignore
    }
    els.resizeGrip.addEventListener('lostpointercapture', onUp);
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('blur', onUp);
    document.addEventListener('pointerup', onUp, true);
    // 防止窗口缩到最小后 pointerup 丢失，导致系统级鼠标捕获卡住
    watchdog = setTimeout(onUp, 1800);
  }
  function refreshWindowState() {
    updateContentScale();
    render();
  }

  function bind() {
    document.querySelectorAll('.icon-btn').forEach((btn) => {
      btn.addEventListener('mouseenter', () => btn.classList.add('hover'));
      btn.addEventListener('mouseleave', () => btn.classList.remove('hover'));
    });

    window.addEventListener('blur', clearButtonHover);
    window.addEventListener('focus', clearButtonHover);

    els.settingsBtn.addEventListener('click', () => window.api.openSettings());
    els.menuBtn.addEventListener('click', () => window.api.showContextMenu());
    els.closeBtn.addEventListener('click', () => {
      clearButtonHover();
      window.api.closeWidget();
    });
    els.card.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      window.api.showContextMenu();
    });
    els.pinBtn.addEventListener('click', updatePin);
    els.otBtn.addEventListener('click', () => {
      if (overtime && overtime.active) stopOvertime();
      else startOvertime();
    });
    els.offBtn.addEventListener('click', confirmOffWork);
    els.makeupNotice.addEventListener('click', () => {
      pendingMakeupNotice = false;
      makeupNoticeUntil = 0;
      els.makeupNotice.hidden = true;
    });
    document.addEventListener('pointerdown', () => {
      dockPointerDown = true;
    });
    const releaseDockDrag = () => {
      dockPointerDown = false;
      if (dockDocked && !dockCollapsed) window.api.dockRelease();
    };
    document.addEventListener('pointerup', releaseDockDrag);
    window.addEventListener('mouseup', releaseDockDrag);
    document.body.addEventListener('mouseenter', () => {
      clearTimeout(dockCollapseTimer);
      if (dockCollapsed) window.api.dockExpand();
    });
    if (window.api.onDockMenuClosed) {
      window.api.onDockMenuClosed(() => {
        clearTimeout(dockCollapseTimer);
        dockIgnoreLeaveUntil = Date.now() + 400;
      });
    }
    els.edgeBar.addEventListener('click', () => {
      if (dockCollapsed) window.api.dockExpand();
    });
    els.nowStartBtn.addEventListener('click', startOvertime);
    els.backfillBtn.addEventListener('click', openBackfill);
    els.backfillConfirm.addEventListener('click', confirmBackfill);
    els.backfillCancel.addEventListener('click', cancelBackfill);
    els.backfillTime.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') confirmBackfill();
    });
    els.weekendYes.addEventListener('click', () => answerWeekendPlan(true));
    els.weekendNo.addEventListener('click', () => answerWeekendPlan(false));
    els.resizeGrip.addEventListener('pointerdown', beginResize);
    window.addEventListener('resize', () => {
      updateContentScale();
      drawDockTicks();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        windowHidden = true;
        if (pendingCelebration) celebrateUntil = 0;
        if (pendingMakeupNotice || makeupNoticeUntil) {
          pendingMakeupNotice = true;
          makeupNoticeUntil = 0;
        }
      } else {
        windowHidden = false;
        refreshWindowState();
      }
    });
    els.card.addEventListener('dblclick', (event) => {
      if (event.target.closest('button') || event.target.closest('.resize-grip')) return;
      window.api.openSettings();
    });
  }

  async function init() {
    cfg = await window.api.getConfig();
    try {
      setHolidayInfo(await window.api.getHolidays());
    } catch {
      setHolidayInfo(null);
    }
    try {
      records = await window.api.getRecords();
    } catch {
      records = { leaves: {}, ot: {} };
    }
    overtime = loadOvertime(new Date());
    loadOffConfirmed();
    try {
      applyDockState(await window.api.getDockState());
    } catch {
      // ignore
    }
    apply();
    bind();
    requestAnimationFrame(updateContentScale);
    render();
    setInterval(render, 100);
    window.api.onWidgetRefresh(() => refreshWindowState());
    window.api.onWidgetVisibility((hidden) => {
      windowHidden = Boolean(hidden);
      if (windowHidden) {
        if (pendingCelebration) celebrateUntil = 0;
        if (pendingMakeupNotice || makeupNoticeUntil) {
          pendingMakeupNotice = true;
          makeupNoticeUntil = 0;
        }
      } else {
        refreshWindowState();
      }
    });
    window.api.onConfigChanged((next) => {
      cfg = next;
      apply();
      render();
    });
    window.api.onRecordsChanged((next) => {
      records = next && typeof next === 'object'
        ? { leaves: next.leaves || {}, ot: next.ot || {} }
        : { leaves: {}, ot: {} };
      const now = new Date();
      if (records.leaves[dateKey(now)] && overtime?.active) {
        overtime = freshOvertime(now);
        saveOvertime();
        pendingCelebration = false;
        celebrateUntil = 0;
      }
      render();
    });
    window.api.onDockState(applyDockState);
    window.api.onHolidaysChanged((next) => {
      if (next && typeof next === 'object') {
        setHolidayInfo(next);
        render();
      } else {
        window.api.getHolidays().then((data) => {
          setHolidayInfo(data);
          render();
        }).catch(() => {});
      }
    });
  }

  init();
})();
