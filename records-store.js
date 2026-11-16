'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEAVE_TYPES = new Set(['paid', 'sick', 'personal']);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function validDateKey(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1])
    && date.getMonth() === Number(match[2]) - 1
    && date.getDate() === Number(match[3]);
}

function firstDayOfPreviousMonth(now) {
  return new Date(now.getFullYear(), now.getMonth() - 1, 1);
}

function validTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function createRecordsStore({ dataDir, log, onChange }) {
  const file = path.join(dataDir, 'records.json');
  let data = { leaves: {}, ot: {} };
  let saveTimer = null;

  function prune() {
    const cutoff = dateKey(firstDayOfPreviousMonth(new Date()));
    for (const key of Object.keys(data.leaves)) {
      if (key < cutoff) delete data.leaves[key];
    }
    for (const key of Object.keys(data.ot)) {
      if (key < cutoff) delete data.ot[key];
    }
  }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      data = { leaves: {}, ot: {} };
      if (raw && raw.leaves && typeof raw.leaves === 'object') {
        for (const [key, value] of Object.entries(raw.leaves)) {
          if (!validDateKey(key) || !value || !LEAVE_TYPES.has(value.type)) continue;
          data.leaves[key] = {
            type: value.type,
            start: validTime(value.start) ? value.start : '',
            end: validTime(value.end) ? value.end : '',
            updatedAt: Number(value.updatedAt) || 0,
          };
        }
      }
      if (raw && raw.ot && typeof raw.ot === 'object') {
        for (const [key, value] of Object.entries(raw.ot)) {
          if (!validDateKey(key) || !value) continue;
          const ms = Number(value.ms);
          if (Number.isFinite(ms) && ms > 0) data.ot[key] = { ms: Math.round(ms) };
        }
      }
      prune();
    } catch {
      data = { leaves: {}, ot: {} };
    }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    prune();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({
        version: 1,
        leaves: data.leaves,
        ot: data.ot,
      }, null, 2), 'utf8');
      fs.renameSync(temp, file);
    } catch (err) {
      if (log) log('records save failed', err.message);
    }
    if (onChange) onChange(payload());
  }

  function payload() {
    prune();
    return {
      leaves: { ...data.leaves },
      ot: { ...data.ot },
    };
  }

  function setLeave(date, type, start, end) {
    if (!validDateKey(date)) throw new Error('日期格式不正确');
    if (!LEAVE_TYPES.has(type)) throw new Error('请假类型不正确');
    if (start && !validTime(start)) throw new Error('开始时间格式不正确');
    if (end && !validTime(end)) throw new Error('结束时间格式不正确');
    if (start && end && start >= end) throw new Error('结束时间需要晚于开始时间');
    data.leaves[date] = {
      type,
      start: start || '',
      end: end || '',
      updatedAt: Date.now(),
    };
    save();
    return payload();
  }

  function removeLeave(date) {
    if (!validDateKey(date)) throw new Error('日期格式不正确');
    if (data.leaves[date]) {
      delete data.leaves[date];
      save();
    }
    return payload();
  }

  function addOvertime(date, ms) {
    if (!validDateKey(date)) return payload();
    const value = Math.round(Number(ms));
    if (!Number.isFinite(value) || value <= 0) return payload();
    const previous = data.ot[date]?.ms || 0;
    data.ot[date] = { ms: previous + value };
    save();
    return payload();
  }

  return {
    file,
    load,
    payload,
    setLeave,
    removeLeave,
    addOvertime,
  };
}

module.exports = {
  createRecordsStore,
  LEAVE_TYPES,
};
