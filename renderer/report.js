(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    closeBtn: $('closeBtn'),
    monthSelect: $('monthSelect'),
    refreshBtn: $('refreshBtn'),
    monthSubtitle: $('monthSubtitle'),
    workedDays: $('workedDays'),
    leaveDays: $('leaveDays'),
    leaveBreakdown: $('leaveBreakdown'),
    totalHours: $('totalHours'),
    totalBase: $('totalBase'),
    totalSalary: $('totalSalary'),
    salaryBreakdown: $('salaryBreakdown'),
    body: $('reportBody'),
    empty: $('empty'),
    error: $('error'),
  };

  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  const LEAVE_LABEL = { paid: '有薪假/年假', sick: '病假', personal: '事假' };

  let cfg = null;
  let holidays = { holidays: {}, workdays: [], statutory: [] };
  let records = { leaves: {}, ot: {} };

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function dateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function monthKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
  }

  function parseHM(value) {
    const [h, m] = String(value || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  function atTime(base, hm) {
    const [h, m] = String(hm).split(':').map(Number);
    const date = new Date(base);
    date.setHours(h || 0, m || 0, 0, 0);
    return date;
  }

  function formatMoney(value) {
    const safe = Number.isFinite(value) ? value : 0;
    return safe.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function kindOf(date) {
    const key = dateKey(date);
    const makeup = Array.isArray(holidays.workdays) ? holidays.workdays : [];
    if (makeup.includes(key)) return 'makeup';
    if (holidays.holidays && holidays.holidays[key]) return 'holiday';
    const days = Array.isArray(cfg.workdays) ? cfg.workdays : [1, 2, 3, 4, 5];
    return days.includes(date.getDay()) ? 'workday' : 'rest';
  }

  function holidayName(date) {
    const key = dateKey(date);
    const name = holidays.holidays ? holidays.holidays[key] : '';
    return String(name || '').split(/[、,，]/)[0] || '节假日';
  }

  function scheduleFor(date) {
    const start = atTime(date, cfg.workStart);
    const end = atTime(date, cfg.workEnd);
    if (end.getTime() <= start.getTime()) end.setDate(end.getDate() + 1);
    const breaks = [];
    const lunchStart = atTime(date, cfg.lunchStart);
    const lunchEnd = atTime(date, cfg.lunchEnd);
    if (lunchEnd > lunchStart) breaks.push({ start: lunchStart, end: lunchEnd });
    const eveningStart = atTime(date, cfg.eveningStart);
    const eveningEnd = atTime(date, cfg.eveningEnd);
    if (eveningEnd > eveningStart) breaks.push({ start: eveningStart, end: eveningEnd });
    return { start, end, breaks };
  }

  function paidMsBetween(startMs, endMs, breaks) {
    if (endMs <= startMs) return 0;
    let ms = endMs - startMs;
    for (const item of breaks || []) {
      const from = Math.max(startMs, item.start.getTime());
      const to = Math.min(endMs, item.end.getTime());
      if (to > from) ms -= to - from;
    }
    return Math.max(0, ms);
  }

  function dailyMsFor(date) {
    const schedule = scheduleFor(date);
    return paidMsBetween(schedule.start.getTime(), schedule.end.getTime(), schedule.breaks);
  }

  function countWorkdaysInMonth(year, month) {
    const days = new Date(year, month, 0).getDate();
    let count = 0;
    for (let day = 1; day <= days; day += 1) {
      const kind = kindOf(new Date(year, month - 1, day));
      if (kind === 'workday' || kind === 'makeup') count += 1;
    }
    return Math.max(1, count);
  }

  function hourlyFor(date, monthlyWorkdays) {
    const dailyMs = dailyMsFor(date);
    if (dailyMs <= 0) return 0;
    return cfg.monthlySalary / monthlyWorkdays / (dailyMs / 3600000);
  }

  function otHourlyFor(date, kind, monthlyWorkdays) {
    if (!(cfg.overtimeBase > 0)) return 0;
    const restMultiplier = Number.isFinite(cfg.weekendOvertimeMultiplier)
      ? cfg.weekendOvertimeMultiplier : 2;
    const holidayMultiplier = Number.isFinite(cfg.holidayOvertimeMultiplier)
      ? cfg.holidayOvertimeMultiplier : 3;
    let multiplier = cfg.overtimeMultiplier;
    if (kind === 'holiday') {
      const statutory = Array.isArray(holidays.statutory) && holidays.statutory.includes(dateKey(date));
      multiplier = statutory ? holidayMultiplier : restMultiplier;
    } else if (kind === 'rest') {
      multiplier = restMultiplier;
    }
    return (cfg.overtimeBase / monthlyWorkdays / 8) * multiplier;
  }

  function leaveFor(date, kind) {
    const leave = records.leaves ? records.leaves[dateKey(date)] : null;
    if (!leave) return null;
    const rest = kind === 'rest' || kind === 'holiday';
    if (rest && (leave.type === 'paid' || leave.type === 'personal')) return null;
    return leave;
  }

  function buildDay(date, opts) {
    const key = dateKey(date);
    const kind = kindOf(date);
    const rest = kind === 'rest' || kind === 'holiday';
    const future = key > opts.todayKey;
    const today = key === opts.todayKey;
    const leave = future ? null : leaveFor(date, kind);
    const schedule = scheduleFor(date);
    const dailyHours = dailyMsFor(date) / 3600000;
    const hourly = hourlyFor(date, opts.monthlyWorkdays);
    let leaveHours = 0;
    let leavePay = 0;
    let hours = 0;
    let base = 0;
    let status = '';
    let workStart = '—';
    let workEnd = '—';
    let otMs = 0;
    let otPay = 0;

    if (leave) {
      status = LEAVE_LABEL[leave.type] || '请假';
      const leaveStart = atTime(date, leave.start || cfg.workStart);
      const leaveEnd = atTime(date, leave.end || cfg.workEnd);
      const leaveScheduledMs = paidMsBetween(
        Math.max(schedule.start.getTime(), leaveStart.getTime()),
        Math.min(schedule.end.getTime(), leaveEnd.getTime()),
        schedule.breaks,
      );
      const leaveElapsedMs = key < opts.todayKey
        ? leaveScheduledMs
        : today
          ? paidMsBetween(
              Math.max(schedule.start.getTime(), leaveStart.getTime()),
              Math.min(opts.nowMs, schedule.end.getTime(), leaveEnd.getTime()),
              schedule.breaks,
            )
          : 0;
      const fullDayLeave = leaveScheduledMs >= dailyMsFor(date) - 60000;
      const leavePaidMs = fullDayLeave ? leaveScheduledMs : leaveElapsedMs;
      leaveHours = rest ? 0 : leaveScheduledMs / 3600000;
      const leavePaidHours = leavePaidMs / 3600000;
      const normalScheduledMs = key < opts.todayKey
        ? dailyMsFor(date)
        : today
          ? paidMsBetween(schedule.start.getTime(), Math.min(opts.nowMs, schedule.end.getTime()), schedule.breaks)
          : 0;
      const normalLeaveOverlap = fullDayLeave
        ? normalScheduledMs
        : key < opts.todayKey
          ? leaveScheduledMs
          : leaveElapsedMs;
      const normalMs = Math.max(0, normalScheduledMs - normalLeaveOverlap);
      hours = normalMs / 3600000;
      base = hourly * hours;
      if (leave.type === 'paid' || leave.type === 'sick') {
        hours += leaveHours;
        const ratio = leave.type === 'sick'
          ? (Number.isFinite(cfg.sickLeaveRatio) ? cfg.sickLeaveRatio : 0.8)
          : 1;
        leavePay = rest ? 0 : leavePaidHours * hourly * ratio;
      }
      if (leave.type !== 'personal' && !rest) {
        workStart = cfg.workStart;
        workEnd = cfg.workEnd;
      }
    } else if (rest) {
      status = kind === 'holiday' ? holidayName(date) : '休息';
    } else if (future) {
      status = '未到';
    } else {
      status = kind === 'makeup' ? '调休上班' : '上班';
      workStart = cfg.workStart;
      workEnd = cfg.workEnd;
      if (key < opts.todayKey) {
        hours = dailyHours;
      } else if (today) {
        const from = Math.max(schedule.start.getTime(), 0);
        const to = Math.min(opts.nowMs, schedule.end.getTime());
        hours = paidMsBetween(from, to, schedule.breaks) / 3600000;
      }
      base = hourly * hours;
    }

    if (!leave) {
      const record = records.ot ? records.ot[key] : null;
      otMs = Number(record?.ms) || 0;
      if (otMs > 0 && !future && !leave) {
        otPay = (otMs / 3600000) * otHourlyFor(date, kind, opts.monthlyWorkdays);
        hours += otMs / 3600000;
      }
    }

    return {
      key,
      date,
      kind,
      rest,
      future,
      today,
      leave,
      status,
      workStart,
      workEnd,
      hours,
      base,
      leavePay,
      otMs,
      otPay,
      total: base + leavePay + otPay,
    };
  }

  function monthLabel(date) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  }

  function render() {
    if (!cfg) return;
    const now = new Date();
    const todayKey = dateKey(now);
    const [year, month] = String(els.monthSelect.value || monthKey(now)).split('-').map(Number);
    const first = new Date(year, month - 1, 1);
    const days = new Date(year, month, 0).getDate();
    const rows = [];
    let workedDays = 0;
    let leaveDays = 0;
    let paidLeave = 0;
    let sickLeave = 0;
    let personalLeave = 0;
    let totalHours = 0;
    let totalBase = 0;
    let totalLeave = 0;
    let totalOt = 0;

    const monthlyWorkdays = countWorkdaysInMonth(year, month);
    for (let day = 1; day <= days; day += 1) {
      const date = new Date(year, month - 1, day);
      const row = buildDay(date, { nowMs: now.getTime(), todayKey, monthlyWorkdays });
      rows.push(row);
      if (row.leave) {
        leaveDays += 1;
        if (row.leave.type === 'paid') paidLeave += 1;
        else if (row.leave.type === 'sick') sickLeave += 1;
        else personalLeave += 1;
      } else if (!row.rest && !row.future) {
        const schedule = scheduleFor(date);
        if (row.key < todayKey || now.getTime() >= schedule.start.getTime()) {
          workedDays += 1;
        }
      }
      totalHours += row.hours;
      totalBase += row.base;
      totalLeave += row.leavePay;
      totalOt += row.otPay;
    }

    const totalSalary = totalBase + totalLeave + totalOt;
    els.monthSubtitle.textContent = `${monthLabel(first)} · ${monthlyWorkdays} 个工作日 · 工资按实际已发生天数统计`;
    els.workedDays.textContent = `${workedDays} 天`;
    els.leaveDays.textContent = `${leaveDays} 天`;
    const breakdown = [];
    if (paidLeave) breakdown.push(`有薪假/年假 ${paidLeave}`);
    if (sickLeave) breakdown.push(`病假 ${sickLeave}`);
    if (personalLeave) breakdown.push(`事假 ${personalLeave}`);
    els.leaveBreakdown.textContent = breakdown.length ? breakdown.join(' · ') : '无请假';
    els.totalHours.textContent = `${totalHours.toFixed(1)} 小时`;
    els.totalBase.textContent = `¥${formatMoney(totalBase)}`;
    els.totalSalary.textContent = `¥${formatMoney(totalSalary)}`;
    els.salaryBreakdown.textContent = `基础 ¥${formatMoney(totalBase)} · 请假 ¥${formatMoney(totalLeave)} · 加班 ¥${formatMoney(totalOt)}`;

    els.body.innerHTML = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      if (row.rest) tr.classList.add('weekend');
      if (row.leave) tr.classList.add('leave-row');
      if (row.today) tr.classList.add('today-row');
      if (row.future) tr.classList.add('future-row');
      const cells = [
        `${row.date.getMonth() + 1}/${row.date.getDate()}`,
        WEEKDAYS[row.date.getDay()],
        row.status,
        row.workStart,
        row.workEnd,
        row.hours > 0 ? row.hours.toFixed(1) : '—',
        row.base > 0 ? `¥${formatMoney(row.base)}` : '—',
        row.leavePay > 0 ? `¥${formatMoney(row.leavePay)}` : '—',
        row.otPay > 0 ? `¥${formatMoney(row.otPay)}` : '—',
        row.total > 0 ? `¥${formatMoney(row.total)}` : '—',
      ];
      cells.forEach((text, index) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (index === 2) {
          const span = document.createElement('span');
          span.className = 'report-status';
          if (row.leave) span.classList.add('leave');
          span.textContent = text;
          td.textContent = '';
          td.appendChild(span);
        }
        if (index >= 6) td.classList.add('money');
        if (text === '—') td.classList.add('muted');
        tr.appendChild(td);
      });
      els.body.appendChild(tr);
    }
    els.empty.hidden = rows.length > 0;
    els.error.textContent = '';
  }

  function fillMonths() {
    const now = new Date();
    const current = new Date(now.getFullYear(), now.getMonth(), 1);
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    els.monthSelect.innerHTML = '';
    for (const date of [current, previous]) {
      const option = document.createElement('option');
      option.value = monthKey(date);
      option.textContent = monthLabel(date);
      if (date.getTime() === current.getTime()) option.selected = true;
      els.monthSelect.appendChild(option);
    }
  }

  async function refresh() {
    try {
      cfg = await window.api.getConfig();
      holidays = await window.api.getHolidays();
      records = await window.api.getRecords();
      if (cfg && cfg.accent) document.body.dataset.accent = cfg.accent;
      if (!els.monthSelect.options.length) fillMonths();
      render();
    } catch (err) {
      els.error.textContent = err.message || '加载失败';
    }
  }

  function bind() {
    els.closeBtn.addEventListener('click', () => window.api.closeSalaryReport());
    els.monthSelect.addEventListener('change', render);
    els.refreshBtn.addEventListener('click', refresh);
    window.api.onReportRefresh(refresh);
    window.api.onRecordsChanged(() => refresh());
  }

  async function init() {
    fillMonths();
    bind();
    await refresh();
  }

  init();
})();
