'use strict';

const https = require('node:https');

const API_ENDPOINT = 'https://apis.tianapi.com/jiejiari/index';
const MAX_BODY = 8 * 1024 * 1024;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function normalizeDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function emptyData() {
  return { holidays: {}, workdays: [], statutory: [] };
}

function addHoliday(data, date, name) {
  const key = normalizeDate(date);
  if (!key) return;
  if (!data.holidays[key]) {
    data.holidays[key] = String(name || '节假日').trim() || '节假日';
  }
}

function addWorkday(data, date) {
  const key = normalizeDate(date);
  if (!key) return;
  if (!data.workdays.includes(key)) data.workdays.push(key);
}

function addStatutory(data, date) {
  const key = normalizeDate(date);
  if (!key) return;
  if (!data.statutory.includes(key)) data.statutory.push(key);
}

function mergeData(target, source) {
  Object.assign(target.holidays, source.holidays);
  for (const date of source.workdays) {
    if (!target.workdays.includes(date)) target.workdays.push(date);
  }
  for (const date of source.statutory) {
    if (!target.statutory.includes(date)) target.statutory.push(date);
  }
}

function toDateList(value) {
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) result.push(...toDateList(item));
    return result;
  }
  if (typeof value !== 'string') return [];
  return value
    .split(/[|,，、;；\s]+/)
    .map((item) => normalizeDate(item))
    .filter(Boolean);
}

function parseResponse(json) {
  if (!json || typeof json !== 'object') {
    throw new Error('接口返回格式不正确');
  }
  const code = Number(json.code);
  if (code !== 200) {
    const error = new Error(`天聚数行接口错误 ${json.code || ''}: ${json.msg || '未知错误'}`);
    error.code = Number.isFinite(code) ? code : 0;
    throw error;
  }
  const list = json.result && Array.isArray(json.result.list)
    ? json.result.list
    : Array.isArray(json.result)
      ? json.result
      : [];
  if (list.length === 0) {
    const error = new Error('接口没有返回节假日数据');
    error.code = 250;
    throw error;
  }

  const data = emptyData();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = item.name || '节假日';
    const itemDates = toDateList(item.date);
    const vacationDates = toDateList(item.vacation);
    const remarkDates = toDateList(item.remark);
    const wageDates = toDateList(item.wage);
    const wageNumber = Number(item.wage);
    const daycode = Number(item.daycode);
    const isNotWork = Number(item.isnotwork);

    // 按年查询返回的是假期条目：date 可能不存在，
    // vacation/remark/wage 是 "2026-01-01|2026-01-02" 这样的字符串。
    for (const date of vacationDates) addHoliday(data, date, name);
    for (const date of remarkDates) addWorkday(data, date);
    for (const date of wageDates) {
      addHoliday(data, date, name);
      addStatutory(data, date);
    }
    if (wageNumber >= 3 && itemDates.length > 0) {
      for (const date of itemDates) {
        addHoliday(data, date, name);
        addStatutory(data, date);
      }
    }

    for (const date of itemDates) {
      const weekday = new Date(`${date}T00:00:00`).getDay();
      const isWeekend = weekday === 0 || weekday === 6;
      // daycode=0 普通工作日、1 节假日、2 双休日、3 调休上班。
      // 普通周末本身由“周一至周日”规则处理，不能当成节假日。
      const isMakeupWorkday = daycode === 3 || (isNotWork === 0 && isWeekend);
      if (isMakeupWorkday) {
        addWorkday(data, date);
      } else if (daycode === 1 || wageNumber >= 3) {
        addHoliday(data, date, name);
      }
    }
  }

  // 调休上班日优先，避免同一天同时被标记为休息日
  for (const date of data.workdays) {
    delete data.holidays[date];
    data.statutory = data.statutory.filter((item) => item !== date);
  }

  data.workdays.sort();
  data.statutory.sort();
  if (Object.keys(data.holidays).length === 0 && data.workdays.length === 0) {
    const error = new Error('接口没有识别到节假日或调休日');
    error.code = 250;
    throw error;
  }
  return data;
}

function requestJson(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'salary-widget/1.0',
        Accept: 'application/json',
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) {
          req.destroy(new Error('接口返回内容过大'));
        }
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`接口 HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`接口返回不是有效 JSON：${err.message}`));
        }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('接口请求超时')));
    req.on('error', reject);
  });
}

async function query(key, type, date) {
  const url = `${API_ENDPOINT}?key=${encodeURIComponent(key)}&type=${type}&date=${encodeURIComponent(date)}&mode=0`;
  const json = await requestJson(url);
  return parseResponse(json);
}

async function fetchYear(key, year) {
  if (!key) throw new Error('请先填写天聚数行 API Key');
  // 一次同步只发起一次 HTTP 请求；这样“每日最多 3 次成功调用”与实际请求一致。
  return query(key, 1, String(year));
}

module.exports = {
  fetchYear,
  parseResponse,
  normalizeDate,
  API_ENDPOINT,
};
