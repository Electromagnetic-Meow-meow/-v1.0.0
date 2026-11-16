(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    monthlySalary: $('monthlySalary'),
    overtimeBase: $('overtimeBase'),
    overtimeMultiplier: $('overtimeMultiplier'),
    weekendOvertimeMultiplier: $('weekendOvertimeMultiplier'),
    holidayOvertimeMultiplier: $('holidayOvertimeMultiplier'),
    workStart: $('workStart'),
    workEnd: $('workEnd'),
    lunchStart: $('lunchStart'),
    lunchEnd: $('lunchEnd'),
    eveningStart: $('eveningStart'),
    eveningEnd: $('eveningEnd'),
    workdays: $('workdays'),
    autoWorkdayOt: $('autoWorkdayOt'),
    autoRestOt: $('autoRestOt'),
    holidayUrl: $('holidayUrl'),
    holidayStatus: $('holidayStatus'),
    holidayOpenUrl: $('holidayOpenUrl'),
    holidayImport: $('holidayImport'),
    holidayFolder: $('holidayFolder'),
    holidayClear: $('holidayClear'),
    holidayApiEnabled: $('holidayApiEnabled'),
    holidayApiKey: $('holidayApiKey'),
    holidayApiSync: $('holidayApiSync'),
    holidayApiClearKey: $('holidayApiClearKey'),
    holidayApiDocs: $('holidayApiDocs'),
    holidayApiStatus: $('holidayApiStatus'),
    holidayApiUsage: $('holidayApiUsage'),
    leaveBtn: $('leaveBtn'),
    sickLeaveRatio: $('sickLeaveRatio'),
    alwaysOnTop: $('alwaysOnTop'),
    autostart: $('autostart'),
    minimizeToTray: $('minimizeToTray'),
    dockEnabled: $('dockEnabled'),
    preview: $('preview'),
    error: $('error'),
    saveBtn: $('saveBtn'),
    cancelBtn: $('cancelBtn'),
    closeBtn: $('closeBtn'),
  };

  let cfg = null;
  let accent = 'sunset';
  let initialAutostart = false;
  let errorTimer = null;
  let holidayApiKeySet = false;
  let holidayApiKeyCleared = false;

  function toMinutes(value) {
    const [h, m] = String(value || '').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  function formatMoney(value) {
    return Number.isFinite(value)
      ? value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '0.00';
  }

  function getSchedule() {
    const start = toMinutes(els.workStart.value);
    const end = toMinutes(els.workEnd.value);
    const lunchStart = toMinutes(els.lunchStart.value);
    const lunchEnd = toMinutes(els.lunchEnd.value);
    const eveningStart = toMinutes(els.eveningStart.value);
    const eveningEnd = toMinutes(els.eveningEnd.value);

    let lunch = 0;
    if (lunchEnd > lunchStart && lunchStart >= start && lunchEnd <= end) {
      lunch = lunchEnd - lunchStart;
    }

    // 晚休允许放在下班后：只从它与工作时间的重叠部分里扣除
    let evening = 0;
    const eveningValid = eveningEnd > eveningStart;
    if (eveningValid) {
      const from = Math.max(eveningStart, start);
      const to = Math.min(eveningEnd, end);
      if (to > from) evening = to - from;
    }

    return {
      start,
      end,
      lunchStart,
      lunchEnd,
      eveningStart,
      eveningEnd,
      lunchValid: lunch > 0,
      eveningValid,
      daily: end - start - lunch - evening,
    };
  }

  function getWorkdays() {
    return [...els.workdays.querySelectorAll('input:checked')]
      .map((input) => Number(input.value))
      .sort((a, b) => a - b);
  }

  function updatePreview() {
    const salary = Number(els.monthlySalary.value);
    const { daily } = getSchedule();
    if (Number.isFinite(salary) && salary > 0 && daily > 0) {
      const hours = (daily / 60).toFixed(1).replace(/\.0$/, '');
      els.preview.textContent = `每日 ${hours} 小时 · 时薪按当月实际工作日折算`;
    } else {
      els.preview.textContent = '请检查收入与工作时间';
    }
  }

  function showError(message) {
    els.error.textContent = message;
    els.error.classList.remove('shake');
    // 强制重排以重新触发动画
    void els.error.offsetWidth;
    els.error.classList.add('shake');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      els.error.textContent = '';
    }, 4000);
  }

  function validate() {
    const salaryText = els.monthlySalary.value.trim();
    const baseText = els.overtimeBase.value.trim();
    const multiplierText = els.overtimeMultiplier.value.trim();
    const weekendMultiplierText = els.weekendOvertimeMultiplier.value.trim();
    const holidayMultiplierText = els.holidayOvertimeMultiplier.value.trim();

    if (!salaryText || !baseText || !multiplierText || !weekendMultiplierText || !holidayMultiplierText) {
      showError('请把收入信息填写完整');
      return false;
    }

    const salary = Number(salaryText);
    const base = Number(baseText);
    const multiplier = Number(multiplierText);
    const weekendMultiplier = Number(weekendMultiplierText);
    const holidayMultiplier = Number(holidayMultiplierText);

    if (!Number.isFinite(salary) || salary < 0) {
      showError('月薪需要是大于等于 0 的数字');
      return false;
    }
    if (!Number.isFinite(base) || base < 0) {
      showError('加班基数需要是大于等于 0 的数字');
      return false;
    }
    if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 10) {
      showError('工作日加班倍率需要在 0 到 10 之间');
      return false;
    }
    if (!Number.isFinite(weekendMultiplier) || weekendMultiplier < 0 || weekendMultiplier > 10) {
      showError('周末加班倍率需要在 0 到 10 之间');
      return false;
    }
    if (!Number.isFinite(holidayMultiplier) || holidayMultiplier < 0 || holidayMultiplier > 10) {
      showError('法定节假日加班倍率需要在 0 到 10 之间');
      return false;
    }
    if (getWorkdays().length === 0) {
      showError('请至少选择一个普通工作日');
      return false;
    }
    if (els.holidayApiEnabled.checked && !els.holidayApiKey.value.trim()
      && (!holidayApiKeySet || holidayApiKeyCleared)) {
      showError('启用在线节假日接口需要填写天聚数行 API Key');
      return false;
    }

    const { start, end, lunchStart, lunchEnd, eveningStart, eveningEnd, daily } = getSchedule();
    if (start >= end) {
      showError('下班时间需要晚于上班时间');
      return false;
    }
    if (lunchEnd !== lunchStart) {
      if (lunchEnd < lunchStart) {
        showError('午休结束时间需要晚于开始时间');
        return false;
      }
      if (lunchStart < start || lunchEnd > end) {
        showError('午休时间需要落在上班与下班之间');
        return false;
      }
    }
    if (eveningEnd !== eveningStart) {
      if (eveningEnd < eveningStart) {
        showError('晚休结束时间需要晚于开始时间');
        return false;
      }
      if (lunchEnd !== lunchStart && eveningStart < lunchEnd && lunchStart < eveningEnd) {
        showError('午休和晚休时间不能重叠');
        return false;
      }
    }
    if (daily <= 0) {
      showError('每日工时不能为 0，请检查时间设置');
      return false;
    }
    return true;
  }

  async function save() {
    if (!validate()) return;
    const payload = {
      monthlySalary: Number(els.monthlySalary.value),
      overtimeBase: Number(els.overtimeBase.value),
      overtimeMultiplier: Number(els.overtimeMultiplier.value),
      weekendOvertimeMultiplier: Number(els.weekendOvertimeMultiplier.value),
      holidayOvertimeMultiplier: Number(els.holidayOvertimeMultiplier.value),
      sickLeaveRatio: Math.min(100, Math.max(0, Number(els.sickLeaveRatio.value))) / 100,
      workStart: els.workStart.value,
      workEnd: els.workEnd.value,
      lunchStart: els.lunchStart.value,
      lunchEnd: els.lunchEnd.value,
      eveningStart: els.eveningStart.value,
      eveningEnd: els.eveningEnd.value,
      workdays: getWorkdays(),
      autoWorkdayOt: els.autoWorkdayOt.checked,
      autoRestOt: els.autoRestOt.checked,
      holidayApiEnabled: els.holidayApiEnabled.checked,
      holidayApiKey: els.holidayApiKey.value.trim(),
      alwaysOnTop: els.alwaysOnTop.checked,
      minimizeToTray: els.minimizeToTray.checked,
      dockEnabled: els.dockEnabled.checked,
      accent,
    };
    const apiKey = els.holidayApiKey.value.trim();
    if (apiKey) payload.holidayApiKey = apiKey;
    if (holidayApiKeyCleared) payload.holidayApiKeyClear = true;

    els.saveBtn.disabled = true;
    els.saveBtn.textContent = '保存中…';
    try {
      await window.api.saveConfig(payload);
      if (els.autostart.checked !== initialAutostart) {
        await window.api.setAutostart(els.autostart.checked);
        initialAutostart = els.autostart.checked;
      }
      window.api.closeSettings();
    } catch (err) {
      console.error(err);
      showError('保存失败，请稍后重试');
    } finally {
      els.saveBtn.disabled = false;
      els.saveBtn.textContent = '保存设置';
    }
  }

  function selectAccent(value) {
    accent = value;
    document.body.dataset.accent = value;
    document.querySelectorAll('.swatch').forEach((swatch) => {
      swatch.classList.toggle('active', swatch.dataset.accent === value);
    });
  }

  async function refreshHolidayStatus() {
    try {
      const status = await window.api.getHolidayStatus();
      if (status && Array.isArray(status.years) && status.years.length > 0) {
        els.holidayStatus.textContent =
          `已导入 ${status.years.join('、')} 年：放假 ${status.holidays} 天，补班 ${status.workdays} 天`;
        els.holidayStatus.classList.add('ok');
      } else {
        els.holidayStatus.textContent = '未导入节假日数据';
        els.holidayStatus.classList.remove('ok');
      }
    } catch (err) {
      els.holidayStatus.textContent = '读取节假日数据失败';
      els.holidayStatus.classList.remove('ok');
    }
    await refreshHolidayApiStatus();
  }

  async function refreshHolidayApiStatus() {
    try {
      const api = await window.api.getHolidayApiStatus();
      const usage = api && api.usage ? api.usage : { auto: 0, manual: 0, limit: 3 };
      els.holidayApiUsage.textContent =
        `今日自动 ${usage.auto}/${usage.limit} · 手动 ${usage.manual}/${usage.limit}（仅成功调用计数）`;
      els.holidayApiStatus.classList.remove('ok');
      if (!api || !api.enabled) {
        els.holidayApiStatus.textContent = '在线接口未启用';
        return;
      }
      if (!api.keySet) {
        els.holidayApiStatus.textContent = '已启用，但还没有填写 API Key';
        return;
      }
      if (api.syncing) {
        els.holidayApiStatus.textContent = '正在同步在线节假日数据…';
        return;
      }
      if (api.error) {
        els.holidayApiStatus.textContent = `同步失败：${api.error}`;
        return;
      }
      if (api.year) {
        const time = api.fetchedAt ? new Date(api.fetchedAt).toLocaleString('zh-CN') : '';
        const cacheText = api.cacheValid && api.cacheExpiresAt
          ? ` · 缓存有效至 ${new Date(api.cacheExpiresAt).toLocaleString('zh-CN')}`
          : ' · 缓存已过期，下次自动更新';
        els.holidayApiStatus.textContent =
          `在线数据：${api.year} 年 · 放假 ${api.holidays} 天 · 补班 ${api.workdays} 天${time ? ` · ${time}` : ''}${cacheText}`;
        els.holidayApiStatus.classList.add('ok');
      } else {
        els.holidayApiStatus.textContent = '已启用，等待同步';
      }
    } catch {
      els.holidayApiStatus.textContent = '读取在线接口状态失败';
    }
  }

  async function openHolidayUrl() {
    const url = els.holidayUrl.value.trim();
    const result = await window.api.openHolidayUrl(url);
    if (!result || !result.ok) showError(result?.error || '无法打开网址');
  }

  async function importHolidays() {
    try {
      const result = await window.api.importHolidays();
      if (!result || result.canceled) return;
      if (!result.ok) {
        showError(result.error || '导入失败，请检查文件格式');
        return;
      }
      await refreshHolidayStatus();
    } catch (err) {
      showError('导入失败，请检查文件格式');
    }
  }

  async function clearHolidays() {
    const ok = window.confirm('确定清除已导入的法定节假日数据吗？');
    if (!ok) return;
    await window.api.clearHolidays();
    await refreshHolidayStatus();
  }

  async function openHolidayFolder() {
    const result = await window.api.openHolidayFolder();
    if (!result || !result.ok) showError(result?.error || '无法打开节假日文件夹');
  }

  async function syncHolidayApi() {
    const result = await window.api.syncHolidayApi(true, 'manual');
    await refreshHolidayStatus();
    if (!result || !result.ok) showError(result?.error || '在线接口同步失败');
  }

  async function clearHolidayApiKey() {
    holidayApiKeyCleared = true;
    holidayApiKeySet = false;
    els.holidayApiKey.value = '';
    els.holidayApiKey.placeholder = '保存设置后清除 Key';
    els.holidayApiStatus.textContent = '已标记清除 Key，保存设置后生效';
  }

  async function openHolidayApiDocs() {
    const result = await window.api.openHolidayUrl('https://www.tianapi.com/apiview/139-1');
    if (!result || !result.ok) showError(result?.error || '无法打开接口文档');
  }

  function fillForm() {
    els.monthlySalary.value = cfg.monthlySalary;
    els.overtimeBase.value = cfg.overtimeBase;
    els.overtimeMultiplier.value = cfg.overtimeMultiplier;
    els.weekendOvertimeMultiplier.value = Number.isFinite(cfg.weekendOvertimeMultiplier)
      ? cfg.weekendOvertimeMultiplier
      : 2;
    els.holidayOvertimeMultiplier.value = Number.isFinite(cfg.holidayOvertimeMultiplier)
      ? cfg.holidayOvertimeMultiplier
      : 3;
    els.sickLeaveRatio.value = Number.isFinite(cfg.sickLeaveRatio)
      ? Math.round(cfg.sickLeaveRatio * 100)
      : 80;
    els.workStart.value = cfg.workStart;
    els.workEnd.value = cfg.workEnd;
    els.lunchStart.value = cfg.lunchStart;
    els.lunchEnd.value = cfg.lunchEnd;
    els.eveningStart.value = cfg.eveningStart;
    els.eveningEnd.value = cfg.eveningEnd;
    const workdays = Array.isArray(cfg.workdays) && cfg.workdays.length
      ? cfg.workdays
      : [1, 2, 3, 4, 5];
    els.workdays.querySelectorAll('input').forEach((input) => {
      input.checked = workdays.includes(Number(input.value));
    });
    els.autoWorkdayOt.checked = Boolean(cfg.autoWorkdayOt);
    els.autoRestOt.checked = Boolean(cfg.autoRestOt);
    els.dockEnabled.checked = cfg.dockEnabled !== false;
    els.holidayApiEnabled.checked = Boolean(cfg.holidayApiEnabled);
    holidayApiKeySet = Boolean(cfg.holidayApiKeySet);
    holidayApiKeyCleared = false;
    els.holidayApiKey.value = '';
    els.holidayApiKey.placeholder = holidayApiKeySet
      ? '已保存（留空保持不变）'
      : '在 tianapi.com 注册后获取';
    els.alwaysOnTop.checked = Boolean(cfg.alwaysOnTop);
    els.minimizeToTray.checked = Boolean(cfg.minimizeToTray);
    selectAccent(cfg.accent);
  }

  function bind() {
    document.querySelectorAll('.swatch').forEach((swatch) => {
      swatch.addEventListener('click', () => selectAccent(swatch.dataset.accent));
    });

    document.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => {
        updatePreview();
        if (els.error.textContent) els.error.textContent = '';
      });
    });

    // 保证鼠标滚轮在小屏幕/内容超出时一定可以滚动设置页
    const content = $('content');
    content.addEventListener('wheel', (event) => {
      if (content.scrollHeight <= content.clientHeight) return;
      event.preventDefault();
      content.scrollTop += event.deltaY;
    }, { passive: false });

    els.saveBtn.addEventListener('click', save);
    els.cancelBtn.addEventListener('click', () => window.api.closeSettings());
    els.closeBtn.addEventListener('click', () => window.api.closeSettings());

    els.holidayOpenUrl.addEventListener('click', openHolidayUrl);
    els.holidayImport.addEventListener('click', importHolidays);
    els.holidayFolder.addEventListener('click', openHolidayFolder);
    els.holidayClear.addEventListener('click', clearHolidays);
    els.holidayApiSync.addEventListener('click', syncHolidayApi);
    els.holidayApiClearKey.addEventListener('click', clearHolidayApiKey);
    els.holidayApiDocs.addEventListener('click', openHolidayApiDocs);
    els.leaveBtn.addEventListener('click', () => window.api.openLeaveDialog());
    els.holidayApiKey.addEventListener('input', () => {
      if (els.holidayApiKey.value.trim()) holidayApiKeyCleared = false;
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        window.api.closeSettings();
      } else if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
        save();
      }
    });
  }

  async function init() {
    cfg = await window.api.getConfig();
    fillForm();
    const year = new Date().getFullYear();
    els.holidayUrl.value = `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;
    updatePreview();
    initialAutostart = await window.api.getAutostart();
    els.autostart.checked = initialAutostart;
    bind();
    await refreshHolidayStatus();
    window.api.onConfigChanged((next) => {
      cfg = next;
    });
    window.api.onHolidaysChanged(() => {
      refreshHolidayStatus();
    });
    window.api.onHolidayApiChanged(() => {
      refreshHolidayApiStatus();
    });
  }

  init();
})();
