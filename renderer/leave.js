(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    monthLabel: $('monthLabel'),
    prevMonth: $('prevMonth'),
    nextMonth: $('nextMonth'),
    calendarGrid: $('calendarGrid'),
    leaveStart: $('leaveStart'),
    leaveEnd: $('leaveEnd'),
    leaveDuration: $('leaveDuration'),
    dateHint: $('dateHint'),
    effectiveHint: $('effectiveHint'),
    existingHint: $('existingHint'),
    sickRateText: $('sickRateText'),
    error: $('error'),
    saveBtn: $('saveBtn'),
    removeBtn: $('removeBtn'),
    cancelBtn: $('cancelBtn'),
    closeBtn: $('closeBtn'),
  };
  const LEAVE_LABEL = { paid: '有薪假/年假', sick: '病假', personal: '事假' };

  let cfg = null;
  let holidays = { holidays: {}, workdays: [], statutory: [] };
  let records = { leaves: {}, ot: {} };
  let errorTimer = null;
  let selectedDate = new Date();
  let viewMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function dateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function sameDay(a, b) {
    return dateKey(a) === dateKey(b);
  }

  function isWorkday(date) {
    const key = dateKey(date);
    const workdays = Array.isArray(holidays.workdays) ? holidays.workdays : [];
    if (workdays.includes(key)) return true;
    if (holidays.holidays && holidays.holidays[key]) return false;
    const selected = Array.isArray(cfg?.workdays) ? cfg.workdays : [1, 2, 3, 4, 5];
    return selected.includes(date.getDay());
  }

  function nextWorkday(date) {
    const next = new Date(date);
    for (let i = 0; i < 366; i += 1) {
      if (isWorkday(next)) return next;
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  function selectedType() {
    const checked = document.querySelector('input[name="leaveType"]:checked');
    return checked ? checked.value : 'paid';
  }

  function effectiveDate() {
    const type = selectedType();
    if (type === 'sick') return { date: selectedDate, skipped: false };
    const effective = isWorkday(selectedDate) ? selectedDate : nextWorkday(selectedDate);
    return { date: effective, skipped: !sameDay(effective, selectedDate) };
  }

  function formatDate(date) {
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 周${weekdays[date.getDay()]}`;
  }

  function timeMinutes(value) {
    const [h, m] = String(value || '').split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  }

  function durationLabel() {
    const start = timeMinutes(els.leaveStart.value);
    const end = timeMinutes(els.leaveEnd.value);
    const minutes = end - start;
    if (!els.leaveStart.value || !els.leaveEnd.value) return '请选择开始和结束时间。';
    if (minutes <= 0) return '结束时间需要晚于开始时间。';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `请假时长：${hours ? `${hours} 小时` : ''}${rest ? `${hours ? ' ' : ''}${rest} 分钟` : ''}`;
  }

  function showError(message) {
    els.error.textContent = message;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { els.error.textContent = ''; }, 4000);
  }

  function setSelectedDate(date, syncView = true) {
    selectedDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (syncView) viewMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    const leave = records.leaves ? records.leaves[dateKey(selectedDate)] : null;
    if (leave) {
      const input = document.querySelector(`input[name="leaveType"][value="${leave.type}"]`);
      if (input) input.checked = true;
      if (leave.start) els.leaveStart.value = leave.start;
      if (leave.end) els.leaveEnd.value = leave.end;
    }
    render();
  }

  function renderCalendar() {
    els.monthLabel.textContent = `${viewMonth.getFullYear()}年${viewMonth.getMonth() + 1}月`;
    els.calendarGrid.innerHTML = '';
    const year = viewMonth.getFullYear();
    const month = viewMonth.getMonth();
    const first = new Date(year, month, 1);
    const leading = (first.getDay() + 6) % 7;
    const days = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    const total = Math.ceil((leading + days) / 7) * 7;

    for (let index = 0; index < total; index += 1) {
      const dayNumber = index - leading + 1;
      if (dayNumber < 1 || dayNumber > days) {
        const blank = document.createElement('button');
        blank.className = 'calendar-day blank';
        blank.type = 'button';
        blank.disabled = true;
        els.calendarGrid.appendChild(blank);
        continue;
      }
      const date = new Date(year, month, dayNumber);
      const key = dateKey(date);
      const leave = records.leaves ? records.leaves[key] : null;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'calendar-day';
      button.textContent = String(dayNumber);
      if (!isWorkday(date)) button.classList.add('rest');
      if (sameDay(date, today)) button.classList.add('today');
      if (sameDay(date, selectedDate)) button.classList.add('selected');
      if (leave) {
        button.classList.add(`leave-${leave.type}`);
        const dot = document.createElement('span');
        dot.className = 'leave-dot';
        button.appendChild(dot);
        button.title = `${date.getMonth() + 1}月${date.getDate()}日 · ${LEAVE_LABEL[leave.type] || '请假'}`;
      }
      button.addEventListener('click', () => setSelectedDate(date, false));
      els.calendarGrid.appendChild(button);
    }
  }

  function render() {
    renderCalendar();
    const type = selectedType();
    const effective = effectiveDate();
    const key = dateKey(effective.date);
    const existing = records.leaves ? records.leaves[key] : null;
    const ratio = Number.isFinite(cfg?.sickLeaveRatio) ? cfg.sickLeaveRatio : 0.8;
    if (els.sickRateText) {
      els.sickRateText.textContent = `按正常工资的 ${Math.round(ratio * 100)}% 计算；不跳过周末和节假日，但这些天不计薪`;
    }

    if (type === 'sick') {
      els.dateHint.textContent = isWorkday(effective.date)
        ? `已选择 ${formatDate(effective.date)}，病假不跳过休息日，当天按 ${Math.round(ratio * 100)}% 计薪。`
        : `已选择 ${formatDate(effective.date)}，这一天是周末/节假日，病假仍记录，但当天不计薪。`;
    } else if (effective.skipped) {
      els.dateHint.textContent = `${formatDate(selectedDate)} 是休息日或节假日，${LEAVE_LABEL[type]}会跳过，顺延到下一个工作日。`;
    } else {
      els.dateHint.textContent = `已选择 ${formatDate(selectedDate)}，这一天是工作日，按所选类型生效。`;
    }

    const start = els.leaveStart.value;
    const end = els.leaveEnd.value;
    const duration = durationLabel();
    els.leaveDuration.textContent = duration;
    const timeText = start && end ? `${start}–${end}` : '未设置时间';
    els.effectiveHint.textContent = `将记录：${formatDate(effective.date)} · ${LEAVE_LABEL[type]} · ${timeText}`;
    if (existing) {
      els.existingHint.hidden = false;
      els.existingHint.textContent = `这一天已有「${LEAVE_LABEL[existing.type] || '请假'}」${existing.start && existing.end ? ` ${existing.start}–${existing.end}` : ''}，保存会覆盖。`;
      els.removeBtn.hidden = false;
    } else {
      els.existingHint.hidden = true;
      els.existingHint.textContent = '';
      els.removeBtn.hidden = true;
    }
  }

  async function save() {
    const type = selectedType();
    const effective = effectiveDate();
    const key = dateKey(effective.date);
    const start = els.leaveStart.value;
    const end = els.leaveEnd.value;
    if (!start || !end || timeMinutes(end) <= timeMinutes(start)) {
      showError('请选择有效的开始和结束时间');
      return;
    }
    els.saveBtn.disabled = true;
    try {
      const result = await window.api.setLeave(key, type, start, end);
      if (!result || !result.ok) {
        showError(result?.error || '保存失败');
        return;
      }
      window.api.closeLeaveDialog();
    } catch (err) {
      showError(err.message || '保存失败');
    } finally {
      els.saveBtn.disabled = false;
    }
  }

  async function remove() {
    const effective = effectiveDate();
    const key = dateKey(effective.date);
    els.removeBtn.disabled = true;
    try {
      const result = await window.api.removeLeave(key);
      if (!result || !result.ok) {
        showError(result?.error || '取消失败');
        return;
      }
      window.api.closeLeaveDialog();
    } catch (err) {
      showError(err.message || '取消失败');
    } finally {
      els.removeBtn.disabled = false;
    }
  }

  function changeMonth(delta) {
    viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + delta, 1);
    const day = Math.min(selectedDate.getDate(), new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate());
    selectedDate = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day);
    render();
  }

  function bind() {
    els.prevMonth.addEventListener('click', () => changeMonth(-1));
    els.nextMonth.addEventListener('click', () => changeMonth(1));
    els.leaveStart.addEventListener('input', render);
    els.leaveEnd.addEventListener('input', render);
    document.querySelectorAll('input[name="leaveType"]').forEach((input) => {
      input.addEventListener('change', render);
    });
    els.saveBtn.addEventListener('click', save);
    els.removeBtn.addEventListener('click', remove);
    els.cancelBtn.addEventListener('click', () => window.api.closeLeaveDialog());
    els.closeBtn.addEventListener('click', () => window.api.closeLeaveDialog());
  }

  async function init() {
    try {
      cfg = await window.api.getConfig();
      holidays = await window.api.getHolidays();
      records = await window.api.getRecords();
    } catch (err) {
      showError('加载数据失败');
    }
    if (cfg && cfg.accent) document.body.dataset.accent = cfg.accent;
    const today = new Date();
    selectedDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    viewMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    els.leaveStart.value = cfg?.workStart || '09:00';
    els.leaveEnd.value = cfg?.workEnd || '18:00';
    const existing = records.leaves ? records.leaves[dateKey(selectedDate)] : null;
    if (existing) {
      const input = document.querySelector(`input[name="leaveType"][value="${existing.type}"]`);
      if (input) input.checked = true;
      if (existing.start) els.leaveStart.value = existing.start;
      if (existing.end) els.leaveEnd.value = existing.end;
    }
    bind();
    render();
  }

  init();
})();
